import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import time


def probe(program, timeout):
    executable = shutil.which(program)
    if not executable:
        raise ValueError("agent_program_unavailable")
    identity = Path(executable).resolve()
    with tempfile.TemporaryDirectory(prefix="remote-acp-capabilities-") as temporary:
        environment = dict(os.environ, GROK_HOME=temporary)
        for name in ["GROK_LEADER_SOCKET", "XAI_API_KEY", "GROK_API_KEY", "FABRIALS_LOCAL_DEV_KEY", "AI_RELAY_VIRTUAL_KEY", "GROK_CODE_XAI_API_KEY", "FIRECRAWL_API_KEY", "EXA_API_KEY"]:
            environment.pop(name, None)
        version = subprocess.run([executable, "--version"], env=environment, cwd=temporary, capture_output=True, timeout=timeout, check=True)
        process = subprocess.Popen([executable, "agent", "--no-leader", "stdio"], env=environment, cwd=temporary, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        started = time.monotonic()
        request = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "_meta": {"x.ai/userMessageEcho": True}}, "_meta": {"clientIdentifier": "remote-capability-evaluation"}}}
        response = None
        try:
            process.stdin.write(json.dumps(request).encode() + b"\n")
            process.stdin.flush()
            buffered = b""
            while time.monotonic() - started < timeout:
                if not selector.select(0.2):
                    continue
                part = os.read(process.stdout.fileno(), 8192)
                if not part:
                    raise RuntimeError("agent_closed_before_initialize")
                buffered += part
                if len(buffered) > 131072:
                    raise RuntimeError("agent_response_exceeds_bound")
                while b"\n" in buffered:
                    line, buffered = buffered.split(b"\n", 1)
                    message = json.loads(line)
                    if message.get("id") == 1:
                        response = message
                        break
                if response is not None:
                    break
            if response is None:
                raise TimeoutError("initialize_timeout")
        finally:
            selector.close()
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
        result = response.get("result", {})
        capabilities = result.get("agentCapabilities", {})
        prompt = capabilities.get("promptCapabilities", {})
        return {"schema": 1, "scope": "official-cli-initialize-only-isolated-home", "program": str(identity), "programSha256": hashlib.sha256(identity.read_bytes()).hexdigest(), "version": version.stdout.decode("utf8", errors="replace").strip()[:256], "protocolVersion": result.get("protocolVersion"), "loadSession": capabilities.get("loadSession") is True, "promptCapabilities": {key: prompt.get(key) is True for key in ["image", "audio", "embeddedContext"]}, "errorCode": response.get("error", {}).get("code"), "sentMethods": ["initialize"], "inferencePerformed": False, "realImageUnderstanding": "not_tested", "childStopped": process.poll() is not None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--program", default="grok")
    parser.add_argument("--timeout", type=float, default=20)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 60:
        parser.error("timeout must be between 1 and 60 seconds")
    with open(args.output, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        try:
            result = probe(args.program, args.timeout)
        except Exception as error:
            result = {"schema": 1, "status": "failed", "errorType": type(error).__name__, "inferencePerformed": False}
        result["scriptSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        json.dump(result, output, indent=2)
        output.write("\n")
    print(json.dumps({key: result.get(key) for key in ["version", "promptCapabilities", "errorCode", "status"]}))
    raise SystemExit(1 if result.get("status") == "failed" or result.get("errorCode") is not None else 0)


if __name__ == "__main__":
    main()
