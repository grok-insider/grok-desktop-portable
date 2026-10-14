import assert from "node:assert/strict";
import {spawn, execFileSync, type ChildProcess} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile, rm, readdir} from "node:fs/promises";
import {closeSync, openSync, realpathSync} from "node:fs";
import {createInterface} from "node:readline";
import {resolve, join} from "node:path";

const [outputArgument, artifactArgument] = process.argv.slice(2);
assert.ok(outputArgument && artifactArgument, "Usage: bun scripts/qa/qualify-terminal-continuity.ts <new-private-output> <frozen-vercel-output>");
const directory = resolve(outputArgument), artifact = resolve(artifactArgument);
assert.ok(directory.length < 70, "Use a short output path for the Unix socket fixture");
const terminalName = "remote-continuity-" + createHash("sha256").update(directory).digest("hex").slice(0,12);
const binary = process.env.REMOTE_QA_NATIVE;
assert.ok(binary, "REMOTE_QA_NATIVE must select the exact native candidate");
const program = process.env.REMOTE_QA_GROK;
assert.ok(program, "REMOTE_QA_GROK must select the official unwrapped Grok ELF");
const chrome = process.env.REMOTE_QA_CHROME;
assert.ok(chrome?.startsWith("/nix/store/") && chrome.includes("google-chrome-"), "An unwrapped store Chrome binary is required");
assert.ok(program.startsWith("/nix/store/"), "Official binary required");
const key = "synthetic-not-a-secret";
const python = realpathSync("/run/current-system/sw/bin/python3");
await mkdir(directory, {mode: 0o700});
const native = join(directory, "native"), state = join(native, "state"), grok = join(native, "grok"), project = join(native, "terminal-project");
for (const path of [native, grok, project, join(native, "home")]) await mkdir(path, {mode: 0o700});
const report: any = {schema: 1, startedAt: new Date().toISOString(), scope: "terminal-pwa-official-shared-leader", model: "grok-synthetic", checks: [], errors: [], providerRequests: 0, privateProfileMounted: false, explicitLeaderFlag: true, credentialRole: "synthetic", paidInference: false, notQualified: ["Production TLS trust: isolated laboratory certificate", "Tailscale", "Real Android/Windows/Apple", "Long-running battery, suspend and load", "Publications and push", "Service-worker and WebSocket egress inventory", "Full descendant-process inventory after cleanup"]};
const processes: ChildProcess[] = [];
let browser: any, page: any, server: any, syl: ChildProcess | undefined;
let nativePort = 0;
let provider: any;
const sessionId = crypto.randomUUID();
const upstreams = new Set<WebSocket>();
const check = (name: string, value: unknown) => {assert.ok(value, name); report.checks.push(name);};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sanitized = (value: string) => value.replaceAll(key, "[redacted]");
const inspectHistory = async () => {
  const rows: any[] = [];
  const scan = async (base: string) => {for (const entry of await readdir(base, {withFileTypes:true}).catch(()=>[])) {
    const path = join(base,entry.name);
    if(entry.isDirectory()) await scan(path);
    else if(entry.name === "updates.jsonl") {
      const bytes=await readFile(path);assert.ok(bytes.length < 4 * 1024 * 1024,"synthetic transcript size");
      const updates=bytes.toString().trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
      await writeFile(join(directory,`synthetic-updates-${rows.length}.jsonl`),bytes,{mode:0o600});
      rows.push({sha256:hash(bytes),updates:updates.map(value=>{const update=value.params?.update??value.update??{};return {keys:Object.keys(value),kind:update.sessionUpdate,contentType:update.content?.type,contentKeys:Object.keys(update.content??{}),imageBytes:update.content?.data?.length,imageSha256:update.content?.type==="image"?hash(Buffer.from(update.content.data,"base64")):undefined,hidden:update._meta?.hideFromScrollback};})});
    }
  }};
  await scan(join(grok,"sessions"));report.historyEvidence=rows;
};
const waitFor = async (ready: () => Promise<boolean>, timeout = 20000) => {const stop = Date.now() + timeout; while (!await ready()) {assert.ok(Date.now() < stop, "qualification readiness deadline"); await Bun.sleep(100);}};
const nativeEnv: Record<string, string> = {PATH: process.env.PATH ?? "", LANG: "C.UTF-8", HOME: join(native, "home"), USER: "synthetic", GROK_HOME: grok, FABRIALS_AGENT_STATE_DIR: state, FABRIALS_AGENT_PROGRAM: join(directory, "agent-launcher"), FABRIALS_LOCAL_DEV_KEY: key};
const cleanEnv = {...process.env};
for (const name of Object.keys(cleanEnv)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(name)) delete cleanEnv[name];
const start = (name: string, command: string, args: string[], env: Record<string,string | undefined>, cwd?: string) => {
  const fd = openSync(join(directory, `${name}.log`), "wx", 0o600);
  const child = spawn(command, args, {env, cwd, detached: true, stdio: ["ignore", fd, fd]});
  closeSync(fd); processes.push(child); return child;
};
const cli = (...args: string[]) => execFileSync(binary, args, {env: nativeEnv, cwd: project, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"]});
let nextRpc = 0;
const pending = new Map<number, {resolve(value: any): void; reject(error: Error): void}>();
const rpc = (method: string, params: object) => new Promise<any>((resolveReply, reject) => {
  const id = ++nextRpc;
  const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Syl ${method} deadline`));}, 15000);
  pending.set(id, {resolve: value => {clearTimeout(timer); resolveReply(value);}, reject: error => {clearTimeout(timer); reject(error);}});
  syl!.stdin!.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
});
try {
  report.spanreedSha256 = hash(await readFile(binary));
  report.grokSha256 = hash(await readFile(program));
  check("official_grok_1_0_52_hash", report.grokSha256 === "1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11");
  report.origin = "https://grok.fabrials.com";
  const manifest: Array<{path: string; sha256: string}> = [];
  const scan = async (base: string, prefix = "") => {for (const entry of await readdir(base, {withFileTypes: true})) {const path = join(base, entry.name), name = prefix + entry.name; if (entry.isDirectory()) await scan(path, name + "/"); else if (entry.isFile()) manifest.push({path: name, sha256: hash(await readFile(path))});}};
  await scan(join(artifact, "static"));
  report.artifactFiles = manifest.sort((a,b) => a.path.localeCompare(b.path));
  report.artifactManifestSha256 = hash(Buffer.from(JSON.stringify(report.artifactFiles)));
  const deployment = JSON.parse(await readFile(join(artifact, "config.json"), "utf8"));
  const turns: string[] = [];
  provider = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models")) return Response.json({object:"list",data:[{id:"grok-synthetic",object:"model",created:1,owned_by:"fixture",context_length:131072}]});
    if (!url.pathname.endsWith("/chat/completions")) return Response.json({error:"fixture_route_unavailable"},{status:404});
    const payload = await request.json() as any;
    const last = payload.messages?.filter((m:any)=>m.role === "user").at(-1);
    const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((c:any)=>c.text ?? "").join(" ");
    const marker = ["TERMINAL_FIRST", "BROWSER_SECOND", "TERMINAL_THIRD", "BROWSER_APPROVAL", "TERMINAL_DENIAL"].find(value=>text.includes(value));
    await writeFile(join(directory,`request-${turns.length}.json`),JSON.stringify({path:url.pathname,model:payload.model,userText:text,marker}),{mode:0o600});
    if (!marker) return Response.json({error:"unexpected_fixture_prompt"},{status:400});
    turns.push(marker);report.providerRequests=turns.length;
    const response = {id:`fixture-${turns.length}`,object:"chat.completion.chunk",created:1,model:"grok-synthetic",choices:[{index:0,delta:{role:"assistant",content:`${marker}_OK`},finish_reason:null}]};
    let reason = "stop";
    if(["BROWSER_APPROVAL","TERMINAL_DENIAL"].includes(marker) && payload.messages.at(-1)?.role !== "tool") {
      assert.ok(payload.tools.some((t:any)=>t.function?.name === "run_terminal_command"),"official shell tool available");
      response.choices[0].delta = {role:"assistant",tool_calls:[{index:0,id:`fixture-${marker.toLowerCase()}`,type:"function",function:{name:"run_terminal_command",arguments:JSON.stringify({command:"printf 'PERMISSION_ONCE\\n' >> effect.txt",description:"Write one synthetic test marker into the isolated workspace."})}}]} as any;
      reason = "tool_calls";
    }
    const done = {...response,choices:[{index:0,delta:{},finish_reason:reason}]};
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
  }});
  const agentEnv = {SHELL:realpathSync("/run/current-system/sw/bin/bash"),GROK_SHELL:realpathSync("/run/current-system/sw/bin/bash"),PATH:process.env.PATH ?? "",LANG:"C.UTF-8",TERM:"xterm-256color",COLORTERM:"truecolor",HOME:join(native,"home"),USER:"synthetic",GROK_HOME:grok,GROK_LEADER_SOCKET:join(grok,"leader.sock"),XAI_API_KEY:key,GROK_MODELS_BASE_URL:`http://127.0.0.1:${provider.port}/v1`,GROK_XAI_API_BASE_URL:`http://127.0.0.1:${provider.port}/v1`,GROK_CLI_CHAT_PROXY_BASE_URL:`http://127.0.0.1:${provider.port}/v1`,GROK_TELEMETRY_ENABLED:"false",GROK_TELEMETRY_MIXPANEL_ENABLED:"false",GROK_TELEMETRY_TRACE_UPLOAD:"false",GROK_FEEDBACK_ENABLED:"false",OTEL_SDK_DISABLED:"true",GROK_DISABLE_AUTOUPDATER:"1",GROK_PROMPT_SUGGESTIONS:"false",GROK_TURN_SUMMARY:"0",GROK_DEFAULT_PERMISSION_MODE:"ask"};
  const launcher = `#!${python}\nimport os,sys\nroot=${JSON.stringify(native)}\nprogram=${JSON.stringify(program)}\nargs=sys.argv[1:]\nif args == ['terminal']: args=['--leader','--model','grok-synthetic','--session-id',${JSON.stringify(sessionId)},'--no-alt-screen']\nelif args == ['agent','--leader','stdio']: args=['agent','--leader','--model','grok-synthetic','stdio']\nelif args != ['--version']: raise SystemExit('Unexpected qualification agent argv')\nenv=${JSON.stringify(agentEnv)}\ncommand=['/run/current-system/sw/bin/bwrap','--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--die-with-parent','--new-session','--ro-bind','/nix','/nix','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/etc','--ro-bind','/etc/resolv.conf','/etc/resolv.conf','--ro-bind','/etc/ssl','/etc/ssl','--bind',root,root,'--chdir',root+'/terminal-project',program,*args]\nos.execve(command[0],command,env)\n`;
  await writeFile(nativeEnv.FABRIALS_AGENT_PROGRAM, launcher, {mode: 0o700});
  const openssl = process.env.REMOTE_QA_OPENSSL;
  assert.ok(openssl, "REMOTE_QA_OPENSSL is required");
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-subj", "/CN=grok.fabrials.com", "-addext", "subjectAltName=DNS:grok.fabrials.com,DNS:terminal-fixture.test"], {stdio: "ignore", env: cleanEnv});
  cli("agent", "workspace", "add", project);
  start("native", binary, ["remote", "private-serve", "https://terminal-fixture.test", "--web-origin", "https://grok.fabrials.com"], nativeEnv, project);
  await waitFor(async () => {const text = await readFile(join(directory, "native.log"), "utf8"); nativePort = Number(text.match(/127\.0\.0\.1:(\d+)/)?.[1]); return nativePort > 0;});
  cli("remote", "roots", "authorize", project);
  const pairing = cli("remote", "private-pair", "https://terminal-fixture.test", "--web-origin", "https://grok.fabrials.com").match(/https:\/\/grok\.fabrials\.com\/#directPair=[^\s]+/)?.[0];
  assert.ok(pairing, "direct pairing produced a fragment URL");
  server = Bun.serve<{upstream?: WebSocket; queued: string[]}>({hostname: "127.0.0.1", port: 0, tls: {key: Bun.file(join(directory,"key.pem")), cert: Bun.file(join(directory,"cert.pem"))}, async fetch(request, serving) {
    const url = new URL(request.url);
    if (url.hostname === "terminal-fixture.test" && url.pathname === "/remote") {if (serving.upgrade(request, {data: {queued: []}, headers: {"sec-websocket-protocol": "fabrials.remote.v1"}})) return; return new Response(null,{status:400});}
    if (url.hostname !== "grok.fabrials.com" || url.pathname.includes("..")) return new Response(null,{status:404});
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(artifact,"static",path));
    if (!await file.exists()) return new Response(null,{status:404});
    const headers = new Headers({"cache-control":"no-store",...(path.endsWith(".js") ? {"content-type":"text/javascript"} : {})});
    for (const route of deployment.routes ?? []) if (route.src && !route.has && route.headers && new RegExp(`^${route.src}$`).test(url.pathname)) for (const [name,value] of Object.entries(route.headers)) headers.set(name,String(value));
    return new Response(file,{headers});
  }, websocket: {
    open(socket) {const upstream = new WebSocket(`ws://127.0.0.1:${nativePort}/remote`,{headers:{Host:"terminal-fixture.test",Origin:"https://grok.fabrials.com","Sec-WebSocket-Protocol":"fabrials.remote.v1"}});socket.data.upstream=upstream;upstreams.add(upstream);upstream.onopen=()=>{for(const message of socket.data.queued)upstream.send(message);socket.data.queued=[];};upstream.onmessage=event=>socket.send(event.data);upstream.onclose=()=>{upstreams.delete(upstream);socket.close();};upstream.onerror=()=>socket.close();},
    message(socket,message) {const text=typeof message === "string"?message:message.toString();if(socket.data.upstream?.readyState===1)socket.data.upstream.send(text);else if(socket.data.queued.length<16)socket.data.queued.push(text);else socket.close();},
    close(socket) {socket.data.upstream?.close();},
  }});
  const sylLog = openSync(join(directory,"syl.log"),"wx",0o600);
  syl = spawn("syl",["mcp"],{env:{...cleanEnv,SYL_MCP_PROFILE:"full",SYL_NESTED_RES:"2560x1440"},stdio:["pipe","pipe",sylLog]});closeSync(sylLog);
  createInterface({input:syl.stdout!}).on("line",line=>{const value=JSON.parse(line),entry=pending.get(value.id);if(entry){pending.delete(value.id);if(value.error)entry.reject(new Error(value.error.message));else entry.resolve(value.result);}});
  await rpc("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"terminal-continuity",version:"1"}});
  const tui = async (name:string,args={}) => {
    const value = await rpc("tools/call",{name,arguments:args});
    assert.ok(!value.isError,`Syl ${name} failed`);
    const output = value.content?.map((item:any)=>item.text??"").join("\n") ?? "";
    return name === "tui_capture" ? output + "\n" + execFileSync("tmux",["capture-pane","-p","-t",terminalName,"-S","-120"],{encoding:"utf8"}) : output;
  };
  await tui("tui_open",{cmd:"'" + nativeEnv.FABRIALS_AGENT_PROGRAM.replaceAll("'", "'\"'\"'") + "' terminal",cwd:project,cols:140,rows:40,name:terminalName});
  let frame = "";
  await waitFor(async()=>{frame=await tui("tui_capture");return frame.includes("Shift+Tab:mode");},20000);
  await writeFile(join(directory,"terminal-start.txt"),frame,{mode:0o600});
  console.log(JSON.stringify({phase:"terminal_started",directory}));
  check("terminal_prompt_ready",frame.includes("Shift+Tab:mode"));
  frame = await tui("tui_capture");
  await writeFile(join(directory,"terminal-before-send.txt"),frame,{mode:0o600});
  const observe = (text:string)=>text.match(/observation[=: ]+(obs-[A-Za-z0-9_-]+)/)?.[1];
  await tui("tui_send",{text:"TERMINAL_FIRST",observation:observe(frame)});
  frame=await tui("tui_capture");
  await tui("tui_send",{key:"Enter",observation:observe(frame)});
  await waitFor(async()=>{frame=await tui("tui_capture");return frame.includes("TERMINAL_FIRST_OK");},30000);
  check("real_terminal_completed_first_turn",true);
  await writeFile(join(directory,"terminal-first.txt"),frame,{mode:0o600});
  const nested = await rpc("tools/call",{name:"gui_open",arguments:{target:"nested",app:"foot"}});
  const display=nested.content?.map((item:any)=>item.text??"").join(" ").match(/display=(wayland-\d+)/)?.[1];assert.ok(display,"real hidden Syl compositor required");
  const profile=join(directory,"chrome-profile");await mkdir(profile,{mode:0o700});
  start("chrome",chrome!,[`--user-data-dir=${profile}`,"--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--ozone-platform=wayland","--password-store=basic","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-sync","--no-proxy-server","--ignore-certificate-errors",`--host-resolver-rules=MAP grok.fabrials.com 127.0.0.1:${server.port}, MAP terminal-fixture.test 127.0.0.1:${server.port}`,"--start-fullscreen","--window-size=2560,1440","about:blank"],{...cleanEnv,WAYLAND_DISPLAY:display});
  let cdpPort=0;await waitFor(async()=>{try{cdpPort=Number((await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]);return cdpPort>0;}catch{return false;}});
  const {chromium}=await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "playwright-core");
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);report.browser=browser.version();
  const context=browser.contexts()[0];page=await context.newPage();page.setDefaultTimeout(30000);await page.setViewportSize({width:2560,height:1440});
  page.on("pageerror",(error:Error)=>report.errors.push(sanitized(error.message)));
  const forbiddenRequests:string[]=[];
  await context.route(/^https?:\/\//,(route:any)=>{const host=new URL(route.request().url()).hostname;if(["grok.fabrials.com","terminal-fixture.test"].includes(host))return route.continue();forbiddenRequests.push(host);return route.abort();});
  await page.goto(pairing);await page.getByRole("button",{name:"Pair and connect",exact:true}).click();
  await page.getByRole("button",{name:"Open project terminal-project",exact:true}).click();
  await writeFile(join(directory,"browser-sessions.txt"),await page.locator("body").innerText(),{mode:0o600});
  await page.getByRole("button",{name:/TERMINAL_FIRST/}).first().click();
  await page.getByText("TERMINAL_FIRST_OK",{exact:true}).waitFor();
  check("browser_loaded_existing_live_terminal_session",true);
  const input=page.getByRole("textbox",{name:"Message the agent",exact:true});
  await input.fill("BROWSER_SECOND");await input.press("Enter");
  await page.getByText("BROWSER_SECOND_OK",{exact:true}).waitFor();
  await waitFor(async()=>{frame=await tui("tui_capture");return frame.includes("BROWSER_SECOND_OK");},15000);
  check("browser_turn_appeared_in_live_terminal",true);
  await writeFile(join(directory,"terminal-second.txt"),frame,{mode:0o600});
  await tui("tui_send",{text:"TERMINAL_THIRD",observation:observe(frame)});
  frame=await tui("tui_capture");await tui("tui_send",{key:"Enter",observation:observe(frame)});
  await page.getByText("TERMINAL_THIRD_OK",{exact:true}).waitFor();
  check("terminal_followup_appeared_live_in_browser",true);
  await page.reload();await page.getByRole("button",{name:"Connect",exact:true}).click();
  await page.getByText("TERMINAL_THIRD_OK",{exact:true}).waitFor();
  for(const marker of ["TERMINAL_FIRST","BROWSER_SECOND","TERMINAL_THIRD"]) check(`${marker}_once_after_reload`,await page.getByText(marker+"_OK",{exact:true}).count()===1);
  check("exactly_three_provider_calls_without_replay",JSON.stringify(turns)===JSON.stringify(["TERMINAL_FIRST","BROWSER_SECOND","TERMINAL_THIRD"]));
  await input.fill("BROWSER_APPROVAL");await input.press("Enter");
  await waitFor(async()=>{frame=await tui("tui_capture");return frame.includes("effect.txt");},15000);
  await writeFile(join(directory,"terminal-permission.txt"),frame,{mode:0o600});
  await writeFile(join(directory,"browser-permission.txt"),await page.locator("body").innerText(),{mode:0o600});
  check("same_approval_visible_in_terminal_and_browser",frame.includes("effect.txt") && await page.getByRole("button",{name:"Allow once",exact:true}).count()===1);
  await page.reload();await page.getByRole("button",{name:"Connect",exact:true}).click();
  await page.getByRole("button",{name:"Allow once",exact:true}).waitFor();
  check("browser_reconnect_preserved_terminal_permission",true);
  frame=await tui("tui_capture");
  await Bun.sleep(1000);
  frame=await tui("tui_capture");
  assert.ok(frame.includes("1 (●) Yes, and don't ask again"),"known initial permission choice");
  await tui("tui_send",{key:"Down",observation:observe(frame)});
  await waitFor(async()=>{frame=await tui("tui_capture");return frame.includes("2 (●) Yes, proceed");},5000);
  assert.ok(frame.includes("2 (●) Yes, proceed"),"single-request approval must be selected");
  assert.ok(!frame.includes("1 (●)"),"never select always-approve");
  await tui("tui_send",{key:"Enter",observation:observe(frame)});
  await page.getByText("BROWSER_APPROVAL_OK",{exact:true}).waitFor({timeout:30000});
  check("terminal_approval_completes_browser_turn",true);
  check("tool_effect_exactly_once",await readFile(join(project,"effect.txt"),"utf8")==="PERMISSION_ONCE\n");
  check("external_terminal_decision_cleared_browser_permission",await page.getByRole("button",{name:"Allow once",exact:true}).count()===0);
  frame=await tui("tui_capture");await tui("tui_send",{text:"TERMINAL_DENIAL",observation:observe(frame)});
  frame=await tui("tui_capture");await tui("tui_send",{key:"Enter",observation:observe(frame)});
  await page.getByRole("button",{name:"Deny",exact:true}).waitFor();
  frame=await tui("tui_capture");
  check("same_tool_requires_fresh_approval",frame.includes("effect.txt") && frame.includes("Yes, proceed"));
  await page.getByRole("button",{name:"Deny",exact:true}).click();
  await waitFor(async()=>{frame=await tui("tui_capture");return frame.includes("Turn cancelled because a permission was denied");},15000);
  await page.getByText("Connected to host. Ready.",{exact:true}).waitFor();
  check("browser_denial_cleared_pending_approval",await page.getByRole("button",{name:"Allow once",exact:true}).count()===0);
  check("browser_denial_resolves_terminal_request",true);
  check("denied_identical_tool_left_one_original_effect",await readFile(join(project,"effect.txt"),"utf8")==="PERMISSION_ONCE\n");
  check("five_user_turns_six_provider_requests_no_replay",JSON.stringify(turns)===JSON.stringify(["TERMINAL_FIRST","BROWSER_SECOND","TERMINAL_THIRD","BROWSER_APPROVAL","BROWSER_APPROVAL","TERMINAL_DENIAL"]));
  await page.screenshot({path:join(directory,"continuity.png")});
  check("no_unexpected_intercepted_http_requests",forbiddenRequests.length===0);
  check("no_uncaught_browser_errors",report.errors.length===0);
  report.providerRequests=turns.length;
  await inspectHistory();
  report.passed=true;
} catch(error) {
  try {await writeFile(join(directory,"terminal-failure.txt"),execFileSync("tmux",["capture-pane","-p","-t",terminalName,"-S","-120"],{encoding:"utf8"}),{mode:0o600});}catch{}
  report.passed=false;report.failure=sanitized(error instanceof Error?error.message:String(error));process.exitCode=1;
  await inspectHistory().catch((error:Error)=>{report.historyEvidenceFailure=sanitized(error.message);});
  if(page){await page.screenshot({path:join(directory,"failure.png"),timeout:5000}).catch((error:Error)=>{report.screenshotFailure=sanitized(error.message);});await writeFile(join(directory,"failure-page.txt"),sanitized(await page.locator("body").innerText({timeout:5000}).catch((error:Error)=>`unavailable: ${error.message}`)),{mode:0o600});}
} finally {
  await browser?.close().catch(()=>{});
  try {cli("remote","private-stop");} catch {}
  for(const child of [...processes].reverse())if(child.exitCode===null&&child.signalCode===null&&child.pid){try{process.kill(-child.pid,"SIGTERM");}catch{}}
  for(const socket of upstreams)socket.close();server?.stop(true);
  provider?.stop(true);
  if(syl){await rpc("tools/call",{name:"tui_close",arguments:{}}).catch(()=>{});await rpc("tools/call",{name:"gui_close",arguments:{}}).catch(()=>{});syl.kill("SIGTERM");processes.push(syl);}
  for(const child of processes)if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise<void>(resolveDone=>child.once("exit",()=>resolveDone())),Bun.sleep(3000)]);
  for(const child of processes)if(child.exitCode===null&&child.signalCode===null&&child.pid){try{if(child===syl)child.kill("SIGKILL");else process.kill(-child.pid,"SIGKILL");}catch{}}
  for(const child of processes)if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise<void>(resolveDone=>child.once("exit",()=>resolveDone())),Bun.sleep(3000)]);
  report.ownedSubprocessesExited=processes.every(child=>child.exitCode!==null||child.signalCode!==null);
  if(!report.ownedSubprocessesExited){report.passed=false;report.cleanupFailure="owned_subprocess_exit_unconfirmed";process.exitCode=1;}
  await rm(native,{recursive:true,force:true});await rm(join(directory,"chrome-profile"),{recursive:true,force:true});await rm(join(directory,"agent-launcher"),{force:true});await rm(join(directory,"key.pem"),{force:true});
  report.temporaryStateRemoved=true;report.finishedAt=new Date().toISOString();report.scriptSha256=hash(await readFile(new URL(import.meta.url)));
  await writeFile(join(directory,"report.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failure:report.failure,receipt:join(directory,"report.json")}));
}
