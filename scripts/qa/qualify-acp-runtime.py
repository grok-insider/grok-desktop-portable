import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODELS = [
    {"id": "grok-synthetic", "object": "model", "created": 1, "owned_by": "test", "context_length": 131072, "supportsReasoningEffort": True, "reasoningEffort": "low", "reasoningEfforts": [{"value": "low", "label": "Low"}, {"value": "high", "label": "High"}]},
    {"id": "relay/custom", "object": "model", "created": 1, "owned_by": "test", "context_length": 131072},
]


class Provider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    turns = []
    lock = threading.Lock()

    def log_message(self, *_):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            self.reply(200, {"object": "list", "data": MODELS})
        else:
            self.reply(404, {"error": "fixture_route_unavailable"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2 * 1024 * 1024:
            self.reply(413, {})
            return
        body = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.endswith("/chat/completions"):
            self.reply(404, {"error": "fixture_route_unavailable"})
            return
        control = threading.Event()
        with self.lock:
            self.turns.append(control)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            event = {"id": "synthetic", "object": "chat.completion.chunk", "created": 1, "model": body.get("model", "grok-synthetic"), "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Synthetic output"}, "finish_reason": None}]}
            self.wfile.write(b"data: " + json.dumps(event).encode() + b"\n\n")
            self.wfile.flush()
            control.wait(20)
            event["choices"][0] = {"index": 0, "delta": {}, "finish_reason": "stop"}
            self.wfile.write(b"data: " + json.dumps(event).encode() + b"\n\ndata: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.close_connection = True


class Acp:
    def __init__(self, process):
        self.process = process
        self.selector = selectors.DefaultSelector()
        self.selector.register(process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.replies = {}
        self.updates = []
        self.counter = 0

    def send(self, method, params, notify=False):
        self.counter += 1
        value = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notify:
            value["id"] = self.counter
        self.process.stdin.write(json.dumps(value).encode() + b"\n")
        self.process.stdin.flush()
        return self.counter

    def pump(self, seconds=0.1):
        if b"\n" not in self.buffer:
            if not self.selector.select(seconds):
                return
            part = os.read(self.process.stdout.fileno(), 65536)
            if not part:
                raise RuntimeError("agent_closed")
            self.buffer += part
            if len(self.buffer) > 4 * 1024 * 1024:
                raise RuntimeError("agent_frame_too_large")
        while b"\n" in self.buffer:
            raw, self.buffer = self.buffer.split(b"\n", 1)
            value = json.loads(raw)
            if "method" not in value and "id" in value:
                self.replies[value["id"]] = value
            elif "id" in value:
                self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": value["id"], "error": {"code": -32601, "message": "Fixture denies client tools"}}).encode() + b"\n")
                self.process.stdin.flush()
            else:
                self.updates.append(value)

    def wait(self, condition, seconds=15):
        deadline = time.monotonic() + seconds
        while not condition():
            if time.monotonic() >= deadline:
                raise TimeoutError("acp_fixture_deadline")
            self.pump()

    def call(self, method, params):
        request = self.send(method, params)
        self.wait(lambda: request in self.replies)
        return self.replies.pop(request)


def run(program):
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{provider.server_port}/v1"
    report = {"schema": 1, "scope": "official-cli-local-synthetic-provider", "programSha256": hashlib.sha256(program.read_bytes()).hexdigest(), "paidInference": False, "privateProfileMounted": False, "checks": {}}
    with tempfile.TemporaryDirectory(prefix="remote-runtime-") as root:
        env = {key: os.environ[key] for key in ["PATH", "LANG"] if key in os.environ}
        env.update({"HOME": root, "GROK_HOME": root, "XAI_API_KEY": "synthetic-not-a-secret", "GROK_MODELS_BASE_URL": endpoint, "GROK_XAI_API_BASE_URL": endpoint, "GROK_CLI_CHAT_PROXY_BASE_URL": endpoint, "GROK_TELEMETRY_ENABLED": "false", "GROK_TELEMETRY_MIXPANEL_ENABLED": "false", "GROK_TELEMETRY_TRACE_UPLOAD": "false", "GROK_FEEDBACK_ENABLED": "false", "OTEL_SDK_DISABLED": "true", "GROK_DISABLE_AUTOUPDATER": "1"})
        report["version"] = subprocess.check_output([program, "--version"], env=env, timeout=10, text=True).strip()
        process = subprocess.Popen([program, "agent", "--no-leader", "--model", "grok-synthetic", "stdio"], cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        acp = Acp(process)
        try:
            acp.call("initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}}})
            acp.call("authenticate", {"methodId": "xai.api_key"})
            opened = acp.call("session/new", {"cwd": root, "mcpServers": []})
            session = opened.get("result", {}).get("sessionId")
            if not session:
                raise RuntimeError("session_new_failed")
            catalogue = opened["result"].get("models", {}).get("availableModels", [])
            report["models"] = [{"id": model.get("modelId"), "name": model.get("name")} for model in catalogue]
            report["initialConfigOptions"] = opened["result"].get("configOptions", [])
            changed = acp.call("session/set_config_option", {"sessionId": session, "configId": "reasoning_effort", "value": "high"})
            report["effortResult"] = changed
            report["checks"]["effortConfirmed"] = any(option.get("id") == "reasoning_effort" and option.get("currentValue") == "high" for option in changed.get("result", {}).get("configOptions", []))
            custom = acp.call("session/set_config_option", {"sessionId": session, "configId": "model", "value": "relay/custom"})
            report["customResult"] = custom
            report["checks"]["customModelConfirmed"] = any(option.get("id") == "model" and option.get("currentValue") == "relay/custom" for option in custom.get("result", {}).get("configOptions", []))
            invalid = acp.call("session/set_config_option", {"sessionId": session, "configId": "model", "value": "model-that-does-not-exist"})
            report["invalidModelError"] = invalid.get("error")
            acp.call("session/set_config_option", {"sessionId": session, "configId": "model", "value": "grok-synthetic"})
            prompt = lambda target: {"sessionId": session, "prompt": [{"type": "text", "text": "Reply with a short synthetic answer without tools."}], "_meta": {"promptId": target}}
            cancel = lambda target: acp.send("session/cancel", {"sessionId": session, "_meta": {"promptId": target, "rewindIfNoOutput": True, "cancelSubagents": False, "cancelTrigger": "dashboard_stop"}}, notify=True)
            first = acp.send("session/prompt", prompt("turn-qualification-first"))
            acp.wait(lambda: len(Provider.turns) >= 1)
            cancel("turn-qualification-first")
            acp.wait(lambda: first in acp.replies)
            report["checks"]["targetCancelled"] = acp.replies[first].get("result", {}).get("stopReason") == "cancelled"
            second = acp.send("session/prompt", prompt("turn-qualification-second"))
            acp.wait(lambda: len(Provider.turns) >= 2)
            cancel("turn-qualification-first")
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                acp.pump()
            report["checks"]["staleCancelDidNotEndSuccessor"] = second not in acp.replies
            Provider.turns[-1].set()
            acp.wait(lambda: second in acp.replies)
            report["checks"]["successorCompleted"] = acp.replies[second].get("result", {}).get("stopReason") == "end_turn"
        finally:
            acp.selector.close()
            for turn in Provider.turns:
                turn.set()
            process.stdin.close()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            provider.shutdown()
        report["status"] = "passed" if report["checks"] and all(report["checks"].values()) else "failed"
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("program", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not str(args.program.resolve()).startswith("/nix/store/") or args.program.read_bytes()[:4] != b"\x7fELF":
        parser.error("Use the unwrapped official ELF binary from the Nix store")
    try:
        report = run(args.program)
    except Exception as error:
        report = {"status": "failed", "error": type(error).__name__, "paidInference": False}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report.get(key) for key in ["version", "status", "checks", "error"]}))
    raise SystemExit(0 if report["status"] == "passed" else 1)
