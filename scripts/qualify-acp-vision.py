import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import struct
import subprocess
import tempfile
import time
import zlib


DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"]


def fixture():
    values = secrets.SystemRandom().sample(range(10), 8)
    width, height = 512, 320
    pixels = bytearray([255] * width * height * 3)
    for index, value in enumerate(values):
        left, top = (index % 4) * 128 + 40, (index // 4) * 160 + 38
        for y in range(5):
            for x in range(3):
                if DIGITS[value][y * 3 + x] == "1":
                    for dy in range(16):
                        for dx in range(16):
                            offset = ((top + y * 16 + dy) * width + left + x * 16 + dx) * 3
                            pixels[offset:offset + 3] = b"\0\0\0"
    raw = b"".join(b"\0" + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return png, "".join(map(str, values))


class Client:
    def __init__(self, process):
        self.process = process
        self.selector = selectors.DefaultSelector()
        self.selector.register(process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.next_id = 0
        self.denied_requests = 0
        self.dropped = 0
        self.tool_calls = 0

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        self.process.stdin.flush()

    def call(self, method, params, deadline=30):
        self.next_id += 1
        request_id = self.next_id
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        stop = time.monotonic() + deadline
        texts = []
        while time.monotonic() < stop:
            if b"\n" not in self.buffer:
                if not self.selector.select(0.2):
                    continue
                part = os.read(self.process.stdout.fileno(), 65536)
                if not part:
                    raise RuntimeError("agent_closed")
                self.buffer += part
                if len(self.buffer) > 8 * 1024 * 1024:
                    raise RuntimeError("oversized_agent_line")
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            message = json.loads(line)
            if message.get("id") == request_id and "method" not in message:
                if "error" in message:
                    raise RuntimeError("acp_error_" + str(message["error"].get("code")))
                return message.get("result", {}), "".join(texts)
            if "id" in message and "method" in message:
                self.denied_requests += 1
                self.send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "Tools are unavailable in this synthetic vision test"}})
            params = message.get("params", {})
            update = params.get("update", {})
            if update.get("sessionUpdate") == "tool_call":
                self.tool_calls += 1
            if update.get("sessionUpdate") == "agent_message_chunk":
                text = update.get("content", {}).get("text", "")
                if isinstance(text, str) and sum(map(len, texts)) + len(text) <= 65536:
                    texts.append(text)
            inner = params.get("params", {}).get("update", {})
            if update.get("sessionUpdate") == "image_dropped" or inner.get("sessionUpdate") == "image_dropped":
                self.dropped += 1
        raise TimeoutError("acp_timeout")


def run(program, model):
    key = os.environ.get("FABRIALS_LOCAL_DEV_KEY")
    if not key:
        raise RuntimeError("local_dev_credential_required")
    program = str(Path(program).resolve(strict=True))
    if not program.startswith("/nix/store/"):
        raise RuntimeError("unwrapped_store_binary_required")
    report = {"schema": 1, "scope": "official-acp-synthetic-provider-vision", "model": model, "programSha256": hashlib.sha256(Path(program).read_bytes()).hexdigest(), "trials": [], "privateProfileMounted": False, "permissionRequestsDenied": True}
    with tempfile.TemporaryDirectory(prefix="remote-vision-") as directory:
        Path(directory, "grok").mkdir()
        Path(directory, "project").mkdir()
        environment = {name: os.environ[name] for name in ["HOME", "USER", "LANG"] if name in os.environ}
        environment.update({"PATH": "/nix/var/nix/profiles/default/bin", "GROK_HOME": "/work/grok", "XAI_API_KEY": key, "GROK_XAI_API_BASE_URL": "https://ai.fabrials.com/v1", "GROK_CLI_CHAT_PROXY_BASE_URL": "https://ai.fabrials.com/v1"})
        command = ["bwrap", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--ro-bind", "/nix", "/nix", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf", "--ro-bind", "/etc/ssl", "/etc/ssl", "--bind", directory, "/work", "--chdir", "/work/project", program, "agent", "--no-leader", "--model", model, "stdio"]
        command[0] = "/run/current-system/sw/bin/bwrap"
        process = subprocess.Popen(command, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        client = Client(process)
        try:
            result, _ = client.call("initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}}, "_meta": {"clientIdentifier": "remote-vision-qualification"}})
            report["advertisedImage"] = result.get("agentCapabilities", {}).get("promptCapabilities", {}).get("image")
            client.call("authenticate", {"methodId": "xai.api_key"})
            for _ in range(2):
                png, expected = fixture()
                session, _ = client.call("session/new", {"cwd": "/work/project", "mcpServers": []})
                started = time.monotonic()
                result, answer = client.call("session/prompt", {"sessionId": session["sessionId"], "prompt": [{"type": "text", "text": "Read the eight digits in the attached image: top row left to right, then bottom row left to right. Reply with only the eight digits, no spaces. Do not use tools or inspect files."}, {"type": "image", "mimeType": "image/png", "data": base64.b64encode(png).decode()}]}, deadline=120)
                observed = re.sub(r"\s", "", answer)
                report["trials"].append({"imageSha256": hashlib.sha256(png).hexdigest(), "expectedDigits": expected, "answerMatches": observed == expected, "answerLength": len(observed), "durationSeconds": round(time.monotonic() - started, 3), "stopReason": result.get("stopReason")})
            report["deniedToolRequests"] = client.denied_requests
            report["observedToolCalls"] = client.tool_calls
            report["imageDroppedEvents"] = client.dropped
            report["passed"] = len(report["trials"]) == 2 and all(trial["answerMatches"] for trial in report["trials"]) and client.denied_requests == 0 and client.tool_calls == 0 and client.dropped == 0
        except Exception as error:
            report["passed"] = False
            report["errorType"] = type(error).__name__
            if str(error).startswith(("acp_error_", "acp_timeout", "agent_closed", "oversized_agent_line")):
                report["failure"] = str(error)
        finally:
            client.selector.close()
            process.stdin.close()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=2)
            report["childStopped"] = process.poll() is not None
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--program", required=True)
    parser.add_argument("--model", default="grok-4.7-build")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = run(args.program, args.model)
    report["scriptSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    with open(args.output, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(json.dumps(report))
    raise SystemExit(0 if report["passed"] else 1)
