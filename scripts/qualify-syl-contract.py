import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid


APP = '''import json,sys,time
from pathlib import Path
path=Path(sys.argv[1])
state={"counter":0,"choice":"blue"}
def report():
 path.write_text(json.dumps(state))
 print("REMOTE_SYL_FIXTURE "+json.dumps(state),flush=True)
report()
for line in sys.stdin:
 command=line.strip()
 if command=="increment":state["counter"]+=1
 elif command=="green":state["choice"]="green"
 elif command=="late":
  time.sleep(1)
  state["counter"]+=1
 report()
'''


class Mcp:
    def __init__(self, output, profile="terminal"):
        self.trace = []
        self.sequence = 0
        self.error_log = (output / "syl-stderr.log").open("x")
        environment = dict(os.environ, SYL_MCP_PROFILE=profile, SYL_MCP_PANEL="0")
        for key in ["SYL_MCP_ALLOW_REAL", "SYL_MCP_ALLOW_GUEST_EXEC", "SYL_MCP_ALLOW_VM", "XAI_API_KEY", "GROK_API_KEY", "FABRIALS_LOCAL_DEV_KEY", "AI_RELAY_VIRTUAL_KEY", "GROK_CODE_XAI_API_KEY"]:
            environment.pop(key, None)
        self.process = subprocess.Popen(["syl", "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.error_log, text=True, bufsize=1, env=environment, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.call("initialize", {"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"remote-syl-evaluation","version":"1"}})
        self.process.stdin.write(json.dumps({"jsonrpc":"2.0","method":"notifications/initialized"}) + "\n")
        self.process.stdin.flush()

    def call(self, method, params):
        self.sequence += 1
        self.process.stdin.write(json.dumps({"jsonrpc":"2.0","id":self.sequence,"method":method,"params":params}) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if not self.selector.select(.2):
                continue
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("syl_disconnected")
            response = json.loads(line)
            if response.get("id") == self.sequence:
                if "error" in response:
                    raise RuntimeError("syl_rpc_error")
                return response["result"]
        raise TimeoutError("syl_timeout")

    def tool(self, name, arguments=None):
        started = time.monotonic()
        result = self.call("tools/call", {"name":name,"arguments":arguments or {}})
        self.trace.append({"name":name,"arguments":arguments or {},"result":result,"durationMs":(time.monotonic()-started)*1000})
        return result

    def close(self):
        self.selector.close()
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=5)
        self.error_log.close()


def body(result):
    return "\n".join(item["text"] for item in result.get("content", []) if item.get("type") == "text")


def capture(client, expected=None):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = client.tool("tui_capture")
        value = body(result)
        token = re.search(r"observation=(\S+)", value)
        if token and (expected is None or expected in value):
            return token.group(1), value
        time.sleep(.1)
    raise RuntimeError("fixture_observation_unavailable")


def send(client, text):
    token, _ = capture(client)
    typed = client.tool("tui_send", {"text":text,"observation":token})
    if typed.get("isError"):
        raise RuntimeError("fixture_type_rejected")
    token, _ = capture(client)
    submitted = client.tool("tui_send", {"key":"enter","observation":token})
    if submitted.get("isError"):
        raise RuntimeError("fixture_submit_rejected")
    return token


def browser_trial(output):
    state = {"counter":0,"choice":"blue"}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path != "/":
                self.send_error(404)
                return
            with lock:
                markup = '<!doctype html><title>Syl synthetic fixture</title><main><h1>Counter ' + str(state["counter"]) + '</h1><h2>Choice ' + state["choice"] + '</h2><form action="/increment" method="post"><button>Increment</button></form><form action="/green" method="post"><button>Choose green</button></form></main>'
            content = markup.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def do_POST(self):
            with lock:
                if self.path == "/increment":
                    state["counter"] += 1
                elif self.path == "/green":
                    state["choice"] = "green"
                else:
                    self.send_error(404)
                    return
                (output / "state.json").write_text(json.dumps(state))
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client = Mcp(output, "browser")
    checks = {}
    failure = None

    def snapshot(expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = client.tool("browser_snapshot")
            value = body(result)
            token = re.search(r"observation=(\S+)", value)
            if not result.get("isError") and token and expected in value:
                return token.group(1), value
            time.sleep(.1)
        raise RuntimeError("browser_observation_unavailable")

    def click(label, expected):
        token, value = snapshot(expected)
        reference = re.search(r'button "' + re.escape(label) + r'" \[ref=(@?e\d+)\]', value)
        if not reference:
            raise RuntimeError("browser_reference_unavailable")
        arguments = {"ref":reference.group(1),"observation":token}
        result = client.tool("browser_click", arguments)
        if result.get("isError"):
            raise RuntimeError("browser_action_refused")
        return arguments

    try:
        client.tool("status")
        opened = client.tool("browser_open", {"url":f"http://127.0.0.1:{server.server_port}/"})
        if opened.get("isError") or "browser=live" not in body(opened):
            raise RuntimeError("browser_open_failed")
        _, observed = snapshot("Counter 0")
        checks["synthetic_observation"] = "Choice blue" in observed
        previous = click("Increment", "Counter 0")
        snapshot("Counter 1")
        checks["authorized_action"] = state["counter"] == 1
        rejected = client.tool("browser_click", previous)
        checks["stale_observation_refused"] = rejected.get("isError") is True and state["counter"] == 1
        click("Choose green", "Counter 1")
        token, _ = snapshot("Choice green")
        checks["second_task"] = state == {"counter":1,"choice":"green"}
        client.tool("browser_close")
        closed = client.tool("browser_click", {"ref":previous["ref"],"observation":token})
        checks["closed_surface_refused"] = closed.get("isError") is True
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
    finally:
        try:
            client.tool("browser_close")
        except Exception:
            pass
        client.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        (output / "trace.json").write_text(json.dumps(client.trace, indent=2))
        report = {"schema":1,"scope":"real-syl-mcp-synthetic-browser-only","checks":checks,"failure":failure,"sylStopped":client.process.poll() is not None,"scriptSha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"notQualified":["Remote browser and Noise transport","Grok ACP tool projection","browser-device revocation","disconnect during an uncertain effect","no automatic replay across host restart","GUI and Android control"]}
        (output / "result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
    return 1 if failure or not all(checks.values()) else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--surface", choices=["terminal","browser"], default="terminal")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(mode=0o700)
    if args.surface == "browser":
        return browser_trial(output)
    if not shutil.which("syl") or not shutil.which("tmux"):
        raise RuntimeError("syl_and_tmux_required")
    fixture = output / "fixture.py"
    fixture.write_text(APP)
    state = output / "state.json"
    session = "remote-eval-" + uuid.uuid4().hex[:12]
    client = Mcp(output)
    checks = {}
    failure = None
    try:
        client.tool("status")
        opened = client.tool("tui_open", {"cmd":shlex.join([sys.executable, str(fixture), str(state)]),"cwd":str(output),"name":session,"cols":100,"rows":24,"record":False})
        if opened.get("isError"):
            raise RuntimeError("fixture_open_failed")
        _, observed = capture(client, '"counter": 0')
        checks["synthetic_observation"] = '"choice": "blue"' in observed
        previous = send(client, "increment")
        capture(client, '"counter": 1')
        checks["authorized_action"] = json.loads(state.read_text())["counter"] == 1
        rejected = client.tool("tui_send", {"key":"enter","observation":previous})
        checks["stale_observation_refused"] = rejected.get("isError") is True and json.loads(state.read_text())["counter"] == 1
        send(client, "green")
        capture(client, '"choice": "green"')
        checks["second_task"] = json.loads(state.read_text()) == {"counter":1,"choice":"green"}
        token, _ = capture(client)
        client.tool("tui_close")
        closed = client.tool("tui_send", {"text":"increment","observation":token})
        checks["closed_surface_refused"] = closed.get("isError") is True
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
    finally:
        try:
            client.tool("tui_close")
        except Exception:
            pass
        client.close()
        owned = subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True)
        if owned.returncode == 0:
            subprocess.run(["tmux", "kill-session", "-t", "=" + session], check=True, capture_output=True)
        (output / "trace.json").write_text(json.dumps(client.trace, indent=2))
        report = {"schema":1,"scope":"real-syl-mcp-synthetic-tui-only","checks":checks,"failure":failure,"sylStopped":client.process.poll() is not None,"scriptSha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"notQualified":["Remote browser and Noise transport","Grok ACP tool projection","browser-device revocation","disconnect during an uncertain effect","no automatic replay across host restart","GUI and Android control"]}
        (output / "result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
    return 1 if failure or not all(checks.values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
