import assert from "node:assert/strict";
import {appendFile, readFile, readdir, stat, writeFile, rename, open, statfs} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";

type SoakOptions = {
  page: any; other: any; directory: string; state: string; native: any; report: any; processes: {name: string; child: {pid?: number}}[];
  execution(): Promise<any>; ledger(): Promise<any>; waitFor(ready: () => Promise<boolean>, timeout?: number): Promise<void>;
  send(page: any, text: string): Promise<void>; waitQueue(text: string[]): Promise<void>; closeSockets(): void;
};
const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${name} must be ${minimum}..${maximum}`);
  return value;
};
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export async function qualifyDirectSoak(options: SoakOptions) {
  const {page, other, directory, state, native, report, processes, execution, ledger, waitFor, send, waitQueue, closeSockets} = options;
  const durationSeconds = integer("REMOTE_QA_SOAK_SECONDS", 120, 10, 86400);
  const cycleIntervalSeconds = integer("REMOTE_QA_SOAK_INTERVAL_SECONDS", 300, 1, 3600);
  const maxCycles = integer("REMOTE_QA_SOAK_MAX_CYCLES", 1000, 2, 10000);
  const nativeLifetime = native.lifetimeSeconds ?? 1800;
  assert.ok(durationSeconds + 120 < nativeLifetime, "The exact fixture's declared lifetime must exceed the soak plus setup and cleanup margin");
  assert.ok(process.env.REMOTE_QA_ARTIFACT && report.deploymentManifestSha256, "Soak requires a verified exact artifact");
  let envelope: any = null;
  if(durationSeconds>1800 || process.env.REMOTE_QA_SOAK_REQUIRE_ENVELOPE === "1") {
    const group=(await readFile("/proc/self/cgroup","utf8")).trim().split("\n").find(value=>value.startsWith("0::"))?.slice(3);
    assert.ok(group,"Long soak requires cgroup v2");
    const base=join("/sys/fs/cgroup",group);
    const memoryBytes=Number((await readFile(join(base,"memory.max"),"utf8")).trim()), tasks=Number((await readFile(join(base,"pids.max"),"utf8")).trim());
    const [quota,period]=(await readFile(join(base,"cpu.max"),"utf8")).trim().split(" ").map(Number);
    const filesystem=await statfs(directory), mountBytes=filesystem.blocks*filesystem.bsize;
    assert.ok(Number.isFinite(memoryBytes) && memoryBytes>0 && memoryBytes<=6*1024**3,"Long soak requires cgroup MemoryMax <= 6 GiB");
    assert.ok(Number.isFinite(tasks) && tasks>0 && tasks<=512,"Long soak requires cgroup TasksMax <= 512");
    assert.ok(Number.isFinite(quota) && quota>0 && period>0 && quota/period<=2,"Long soak requires cgroup CPUQuota <= 200%");
    assert.ok(filesystem.type===0x1021994 && mountBytes>0 && mountBytes<=2*1024**3,"Long soak requires a dedicated tmpfs output mount <= 2 GiB");
    envelope={cgroup:group,memoryBytes,tasks,cpuCores:quota/period,outputMountBytes:mountBytes,filesystem:"tmpfs"};
  }
  const limits = {browserRssMiB:3072,nativeRssMiB:integer("REMOTE_QA_SOAK_NATIVE_RSS_MIB",512,1,8192),runnerRssMiB:512,processes:96,fileDescriptors:4096,stateMiB:512,profileMiB:2048,cycleSeconds:75};
  const both = [page, other], started = performance.now();
  const fault = process.env.REMOTE_QA_SOAK_FAULT;
  assert.ok(!fault || fault === "duplicate", "Unknown soak fault injection");
  const initialReceipts = Object.values((await ledger()).receipts) as any[];
  const initialCompleted = initialReceipts.filter(value => value.state === "completed").length;
  const initialPermissionCount = await page.getByRole("article", {name:"Your message",exact:true}).filter({hasText:/^permission$/}).count();
  const initialAcceptedPermissionCount = await page.getByText("accepted:permission", {exact:true}).count();
  const transcriptWindow = async (target: any) => {
    const notice = target.locator("[data-omitted-messages]");
    return {messages: await target.locator("article[data-turn-id]").count(), omitted: await notice.count() ? Number(await notice.first().getAttribute("data-omitted-messages")) : 0, users: (await target.getByRole("article",{name:"Your message",exact:true}).allTextContents()).map((text: string) => text.trim())};
  };
  const initialWindow = await transcriptWindow(page);
  const initialMessages = initialWindow.messages + initialWindow.omitted;
  const data: any = {schema:1,resourceEnforcement:envelope ? "Verified cgroup CPU/memory/task limits and bounded tmpfs; sampled process RSS/FD/disk thresholds every 5 seconds; no general product capacity or IO qualification" : "Sampled soft thresholds every 5 seconds; no hard capacity or CPU/IO qualification",startedAt:new Date().toISOString(),durationSeconds,cycleIntervalSeconds,maxCycles,nativeLifetime,limits,envelope,faultInjection:fault ?? null,fixtureSha256:report.nativeFixtureSha256,artifactSha256:report.artifactSha256,deploymentManifestSha256:report.deploymentManifestSha256,helperSha256:hash(await readFile(import.meta.filename)),cycles:0,checks:0,checkpoints:[],notQualified:["A short pilot is not a 24-hour soak","Synthetic ACP permissions do not execute a tool","Resource bounds apply to this configured workload, not general product capacity","No trusted TLS, physical device, paid inference or provider outage evidence"]};
  report.soak = data;
  let stopped = false;
  let activeCycle: Promise<void> | undefined;
  const alive = () => assert.ok(!stopped,"Soak stopped");
  const guardedSend = async (target: any, text: string) => {alive();await send(target,text);};
  const check = (name: string, value: unknown) => {assert.ok(value, name); data.checks++;};
  const save = async () => {
    const temporary=join(directory,"soak-checkpoint.json.tmp"), file=await open(temporary,"w",0o600);
    try {await file.writeFile(JSON.stringify(data,null,2));await file.sync();} finally {await file.close();}
    await rename(temporary,join(directory,"soak-checkpoint.json"));
    const parent=await open(directory,"r");try {await parent.sync();}finally{await parent.close();}
  };
  const identities=new Map<number,string>();
  for(const item of processes) if(item.child.pid) {const raw=await readFile(`/proc/${item.child.pid}/stat`,"utf8");identities.set(item.child.pid,raw.slice(raw.lastIndexOf(")")+2).split(" ")[19]);}
  const treeBytes = async (path: string): Promise<number> => {
    let total = 0;
    for (const entry of await readdir(path,{withFileTypes:true})) {
      const target = join(path,entry.name);
      try {total += entry.isDirectory() ? await treeBytes(target) : entry.isFile() ? (await stat(target)).size : 0;} catch(error: any) {if(error.code !== "ENOENT") throw error;}
    }
    return total;
  };
  const resources = async () => {
    const snapshot: {pid:number;parent:number;rss:number;ticks:number;fds:number;startTicks:string}[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const raw = await readFile(`/proc/${entry}/stat`,"utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        if(fields[0] === "Z") continue;
        snapshot.push({startTicks:fields[19],pid:Number(entry),parent:Number(fields[1]),rss:Number(fields[21])*4096,ticks:Number(fields[11])+Number(fields[12]),fds:0});
      } catch {}
    }
    const family = async (role: string, pid?: number) => {
      assert.ok(pid && snapshot.some(value => value.pid === pid), "Required soak process is running");
      assert.equal(snapshot.find(value=>value.pid===pid)!.startTicks,identities.get(pid),"Soak process identity changed");
      const owned = new Set([pid]);
      for(let previous=-1;previous!==owned.size;){previous=owned.size;for(const value of snapshot) if(owned.has(value.parent)) owned.add(value.pid);}
      const rows = snapshot.filter(value => owned.has(value.pid));
      for (const row of rows) {
        row.fds = await readdir(`/proc/${row.pid}/fd`).then(values => values.length, () => 0);
        if(envelope) {
          try {const groups=await readFile(`/proc/${row.pid}/cgroup`,"utf8");assert.equal(groups.trim().split("\n").find(value=>value.startsWith("0::"))?.slice(3),envelope.cgroup,`Observed ${role} descendant PID ${row.pid} (${(await readFile(`/proc/${row.pid}/comm`,"utf8")).trim()}) escaped the resource cgroup`);}
          catch(error: any) {if(error.code!=="ENOENT") throw error;}
        }
      }
      return {processes:rows.length,cgroupVerifiedProcesses:envelope ? rows.length : null,rssMiB:rows.reduce((sum,row)=>sum+row.rss,0)/1048576,ticks:rows.reduce((sum,row)=>sum+row.ticks,0),fileDescriptors:rows.reduce((sum,row)=>sum+row.fds,0)};
    };
    const browser = await family("chrome",processes.find(value => value.name === "chrome")?.child.pid), host = await family("native",processes.find(value => value.name === "native")?.child.pid);
    const sylFamily=await family("syl",processes.find(value=>value.name==="syl")?.child.pid);
    const runnerRssMiB = process.memoryUsage().rss / 1048576;
    const stateMiB = await treeBytes(state)/1048576, profileMiB = await treeBytes(join(directory,"chrome-profile"))/1048576;
    check("browser_rss_limit",browser.rssMiB <= limits.browserRssMiB);check("native_rss_limit",host.rssMiB <= limits.nativeRssMiB);check("runner_rss_limit",runnerRssMiB <= limits.runnerRssMiB);
    check("process_count_limit",browser.processes + host.processes + sylFamily.processes <= limits.processes);check("file_descriptor_limit",browser.fileDescriptors + host.fileDescriptors + sylFamily.fileDescriptors <= limits.fileDescriptors);
    check("state_disk_limit",stateMiB <= limits.stateMiB);check("profile_disk_limit",profileMiB <= limits.profileMiB);
    return {browser,host,syl:sylFamily,runnerRssMiB,stateMiB,profileMiB};
  };
  const release = async () => {alive();await writeFile(join(state,"release-turn"),"synthetic-direct-session",{mode:0o600});};
  const reconnect = async (target: any) => {alive();await target.reload();alive(); await target.getByRole("button",{name:"Connect",exact:true}).click(); await target.getByRole("textbox",{name:"Message the agent",exact:true}).waitFor();};
  const cycle = async (index: number) => {
    assert.ok(!stopped,"Soak stopped");
    const cycleStart=performance.now(), first=`SOAK_${index}_A`, second=`SOAK_${index}_B`;
    alive();await page.getByRole("button",{name:"Pause queue",exact:true}).click();
    for(const target of both) await target.getByRole("button",{name:"Resume queue",exact:true}).waitFor();
    await guardedSend(page,first);await waitQueue([first]);await guardedSend(other,second);await waitQueue([first,second]);
    check("paused_queue_contains_distinct_device_origins",new Set((await execution()).queue.map((entry:any)=>entry.originDeviceId)).size===2 && (await execution()).activeTurn===null);
    alive();await page.getByRole("button",{name:"Resume queue",exact:true}).click();
    await waitFor(async () => (await execution()).activeTurn?.entry.text===first);
    for(const target of both) await target.getByText(`accepted:${first}`,{exact:true}).waitFor();
    const activeTurn=(await execution()).activeTurn.turnId, receiptCount=Object.keys((await ledger()).receipts).length;
    await reconnect(other);await waitQueue([second]);
    check("reload_keeps_active_turn_and_receipts",(await execution()).activeTurn.turnId===activeTurn && Object.keys((await ledger()).receipts).length===receiptCount);
    alive();closeSockets();
    for(const target of both) await target.getByText("Reconnecting to your computer…",{exact:true}).waitFor();
    for(const target of both) await target.getByText("Reconnecting to your computer…",{exact:true}).waitFor({state:"hidden"});
    await waitQueue([second]);
    check("network_reconnect_keeps_active_turn_and_receipts",(await execution()).activeTurn.turnId===activeTurn && Object.keys((await ledger()).receipts).length===receiptCount);
    await release();await waitFor(async () => (await execution()).activeTurn?.entry.text===second);await waitQueue([]);
    for(const target of both) await target.getByText(`accepted:${second}`,{exact:true}).waitFor();
    await release();await waitFor(async () => (await execution()).activeTurn===null);
    if(fault === "duplicate" && index === 1) await page.getByText(`accepted:${first}`,{exact:true}).evaluate((element: HTMLElement) => element.after(element.cloneNode(true)));
    for(const target of both) {
      await waitFor(async()=>await target.getByRole("button",{name:"Model",exact:true}).isEnabled());
      for(const marker of [first,second]) check("exactly_once_transcript",await target.getByRole("article",{name:"Your message",exact:true}).getByText(marker,{exact:true}).count()===1 && await target.getByText(`accepted:${marker}`,{exact:true}).count()===1);
    }
    await guardedSend(index%2 ? page : other,"permission");
    for(const target of both) await target.getByRole("button",{name:"Allow once",exact:true}).waitFor();
    alive();await (index%2 ? other : page).getByRole("button",{name:index%2 ? "Allow once" : "Deny",exact:true}).click();
    for(const target of both) await target.getByRole("button",{name:"Allow once",exact:true}).waitFor({state:"hidden"});
    await release();await waitFor(async () => (await execution()).activeTurn===null);
    const receipts=Object.values((await ledger()).receipts) as any[];
    const expectedMessages=initialMessages+2*(receipts.filter(value=>value.state==="completed").length-initialCompleted);
    const windows=[];
    for(const target of both) {
      await waitFor(async()=>await target.getByRole("button",{name:"Model",exact:true}).isEnabled());
      const view=await transcriptWindow(target);
      const markers=view.users.filter((text: string)=>/^SOAK_\d+_[AB]$/.test(text));
      check("permission_transcript_not_duplicated",new Set(markers).size===markers.length && view.users.filter((text: string)=>text==="permission").length<=initialPermissionCount+index && await target.getByText("accepted:permission",{exact:true}).count()<=initialAcceptedPermissionCount+index);
      check("transcript_window_accounts_for_every_message",view.messages+view.omitted===expectedMessages);
      windows.push(view);
    }
    check("devices_show_the_same_transcript_window",windows[0].omitted===windows[1].omitted && windows[0].users.join("\n")===windows[1].users.join("\n"));
    check("completed_receipts_exactly_once",receipts.filter(value=>value.state==="completed").length===initialCompleted+index*3);
    check("queue_fully_drained",(await execution()).queue.length===0 && (await execution()).activeTurn===null);
    check("no_browser_errors",report.errors.length===0);
    check("cycle_deadline",performance.now()-cycleStart<=limits.cycleSeconds*1000);
    const checkpoint={cycle:index,at:new Date().toISOString(),elapsedSeconds:(performance.now()-started)/1000,cycleSeconds:(performance.now()-cycleStart)/1000,completedReceipts:initialCompleted+index*3,transcriptWindow:{visible:windows[0].messages,omitted:windows[0].omitted,expected:expectedMessages},resources:await resources()};
    alive();data.cycles=index;data.checkpoints.push(checkpoint);
    await appendFile(join(directory,"soak-checkpoints.jsonl"),JSON.stringify(checkpoint)+"\n",{mode:0o600});await save();
  };
  let resourceTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseMonitor: (() => void) | undefined;
  const monitor = (async () => {
    while(!stopped) {
      const sample = {at:new Date().toISOString(),elapsedSeconds:(performance.now()-started)/1000,resources:await resources()};
      data.latestResources=sample;
      data.resourceSamples=(data.resourceSamples ?? 0)+1;
      await appendFile(join(directory,"soak-resources.jsonl"),JSON.stringify(sample)+"\n",{mode:0o600});
      if(!stopped) await new Promise<void>(resolveSample=>{releaseMonitor=resolveSample;resourceTimer=setTimeout(resolveSample,5000);});
    }
  })();
  monitor.catch(()=>{});
  try {
    await save();
    while(data.cycles<maxCycles && performance.now()-started<durationSeconds*1000) {
      const nextStart=performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      activeCycle=cycle(data.cycles+1);
      await Promise.race([activeCycle,monitor,new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;reject(new Error("Soak cycle deadline"));},limits.cycleSeconds*1000);})]).finally(()=>clearTimeout(timer));
      const remaining=Math.min(nextStart+cycleIntervalSeconds*1000,started+durationSeconds*1000)-performance.now();
      if(data.cycles<maxCycles && remaining>0) {let idleTimer: ReturnType<typeof setTimeout> | undefined; await Promise.race([monitor,new Promise(resolveWait=>{idleTimer=setTimeout(resolveWait,remaining);})]).finally(()=>clearTimeout(idleTimer));}
    }
    check("at_least_two_cycles_exercised",data.cycles>=2);
    data.stopReason=data.cycles>=maxCycles ? "cycle_limit" : "duration_reached";
    data.elapsedSeconds=(performance.now()-started)/1000;
    data.qualifiedDuration=data.elapsedSeconds>=durationSeconds && data.stopReason==="duration_reached";
    if(durationSeconds>1800) check("requested_duration_completed",data.qualifiedDuration);
    data.result="passed";
  } catch(error) {
    stopped=true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settling=Promise.allSettled(both.map(target=>target.close())).then(async()=>{await activeCycle?.catch(()=>{});return true;});
    data.cycleSettledBeforeFinalCheckpoint=await Promise.race([settling,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);clearTimeout(timer);
    data.result="failed";data.failure=error instanceof Error ? error.message : String(error);throw error;}
  finally {stopped=true;clearTimeout(resourceTimer);releaseMonitor?.();await monitor.catch(()=>{});data.finishedAt=new Date().toISOString();await save();}
}
