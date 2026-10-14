import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,stat,rm,readdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';

assert.equal(process.argv.length,3,'Usage: node scripts/qa/qualify-deployed-update.mjs <new-private-output>');
for(const name of ['REMOTE_QA_PREVIOUS_SHELL_ID','REMOTE_QA_SHELL_ID']) assert.match(process.env[name]??'',/^[a-f0-9]{64}$/,`${name} is required`);
const chromeBinary=process.env.REMOTE_QA_CHROME;
const playwright=process.env.REMOTE_QA_PLAYWRIGHT;
assert.ok(chromeBinary?.startsWith('/nix/store/')&&playwright,'REMOTE_QA_CHROME and REMOTE_QA_PLAYWRIGHT are required');
const output=resolve(process.argv[2]);
await mkdir(output,{mode:0o700});
const origin='https://grok.fabrials.com';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={schema:1,startedAt:new Date().toISOString(),origin,scope:'Deployed shell update and browser rollback with trusted TLS in hidden Syl Sway',checks:[],notQualified:['Private pairing, drafts and active turns across this upgrade','Android installation and suspension','Inference and push','Hardware GPU performance'],phases:[]};
const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
const waitFor=async(fn,ms=20000)=>{const end=Date.now()+ms;while(!await fn()){assert.ok(Date.now()<end,'readiness deadline');await new Promise(r=>setTimeout(r,100));}};
let syl,browser,chrome,seq=0;
const spawnFailures=[];
const cleanEnv={...process.env};
for(const name of Object.keys(cleanEnv)) if(/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(name)) delete cleanEnv[name];
const groupMembers=async group=>{
  const members=[];
  for(const entry of await readdir('/proc')){
    if(!/^[0-9]+$/.test(entry)) continue;
    try{
      const status=await readFile(`/proc/${entry}/stat`,'utf8');
      const fields=status.slice(status.lastIndexOf(')')+2).split(' ');
      if(Number(fields[2])===group && fields[0]!=='Z') members.push({pid:Number(entry),startTicks:fields[19]});
    }catch{}
  }
  return members;
};
const waitExit=async child=>{
  if(!child?.pid) return;
  const ended=()=>child.exitCode!==null || child.signalCode!==null;
  if(!ended()) child.kill('SIGTERM');
  try{await waitFor(async()=>ended(),5000);}
  catch{child.kill('SIGKILL');await waitFor(async()=>ended(),5000);}
};
const deadline=async(promise,ms)=>{
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('operation deadline')),ms);})]);}
  finally{clearTimeout(timer);}
};
const pending=new Map();
const rpc=(method,params)=>new Promise((resolveResult,reject)=>{
  const id=++seq;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Syl RPC timeout'));},15000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolveResult(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  syl.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
const persist=async()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const signal=async name=>{await writeFile(join(output,`${name}.ready`),new Date().toISOString(),{mode:0o600});await persist();console.log(JSON.stringify({phase:name,output}));};
const awaitFile=async name=>waitFor(async()=>{try{await stat(join(output,name));return true;}catch{return false;}},7200000);
try{
  report.runnerSha256=hash(await readFile(new URL(import.meta.url)));
  const sylFd=openSync(join(output,'syl.log'),'wx',0o600);
  syl=spawn('syl',['mcp'],{env:{...cleanEnv,SYL_MCP_PROFILE:'visual',SYL_NESTED_RES:'2560x1440'},stdio:['pipe','pipe',sylFd]});closeSync(sylFd);
  syl.on('error',()=>spawnFailures.push('syl'));
  syl.stdin.on('error',()=>spawnFailures.push('syl-stdin'));
  createInterface({input:syl.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const item=pending.get(value.id);if(item){pending.delete(value.id);value.error?item.reject(new Error(value.error.message)):item.resolve(value.result);}});
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'deployed-shell-update',version:'1'}});
  const nested=await rpc('tools/call',{name:'gui_open',arguments:{target:'nested',app:'foot'}});
  const display=nested.content?.map(x=>x.text??'').join(' ').match(/display=(wayland-\d+)/)?.[1];
  assert.ok(display,'real hidden compositor');
  const profile=join(output,'profile');await mkdir(profile,{mode:0o700});
  const fd=openSync(join(output,'chrome.log'),'wx',0o600);
  chrome=spawn(chromeBinary,[
    `--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--ozone-platform=wayland','--password-store=basic','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--no-proxy-server','--start-fullscreen','--window-size=2560,1440','about:blank'
  ],{env:{...cleanEnv,WAYLAND_DISPLAY:display},detached:true,stdio:['ignore',fd,fd]});closeSync(fd);
  chrome.on('error',()=>spawnFailures.push('chrome'));
  let port;await waitFor(async()=>{assert.equal(spawnFailures.length,0,'Child process failed to start');assert.equal(chrome.exitCode,null);try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);return !!port;}catch{return false;}});
  const {chromium}=await import(playwright);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  report.browser=browser.version();
  const context=browser.contexts()[0];
  const page=await context.newPage();page.setDefaultTimeout(20000);
  await page.setViewportSize({width:2560,height:1440});
  const response=await page.goto(origin,{waitUntil:'networkidle',timeout:30000});
  check('initial_trusted_https',response.status()===200&&await page.evaluate(()=>isSecureContext));
  const security=await response.securityDetails();report.tls=security;
  const shell=()=>page.locator('meta[name="grok-shell-build"]').getAttribute('content');
  const old=await shell();check('baseline_source_identity',/^[a-f0-9]{64}$/.test(old)&&old===process.env.REMOTE_QA_PREVIOUS_SHELL_ID);
  report.baseline={shellId:old,htmlSha256:hash(await response.body())};
  await page.waitForFunction(async()=>Boolean((await navigator.serviceWorker.getRegistration())?.active));
  await page.reload({waitUntil:'networkidle'});
  check('baseline_controlled',await page.evaluate(()=>Boolean(navigator.serviceWorker.controller)));
  check('baseline_stable_after_reload',await shell()===old);
  report.phases.push({name:'baseline',at:new Date().toISOString(),shellId:old});
  await page.screenshot({path:join(output,'baseline.png')});
  await signal('baseline');
  await awaitFile('deployment-ready');
  await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update();});
  await page.getByRole('button',{name:'Update and reload',exact:true}).waitFor();
  check('update_requires_explicit_action',await shell()===old);
  await page.screenshot({path:join(output,'update-offered.png')});
  await page.getByRole('button',{name:'Update and reload',exact:true}).click();
  await page.waitForFunction(previous=>document.querySelector('meta[name="grok-shell-build"]')?.getAttribute('content')!==previous,old);
  const next=await shell();check('new_shell_has_distinct_identity',/^[a-f0-9]{64}$/.test(next)&&next!==old&&next===process.env.REMOTE_QA_SHELL_ID);
  report.candidate={shellId:next};
  for(const [name,id] of [['baseline',old],['candidate',next]]){
    const res=await context.request.get(`${origin}/sources/${id}.json`);check(`${name}_source_metadata_available`,res.status()===200);
    const metadata=await res.json();check(`${name}_metadata_bound_to_shell`,metadata.shellId===id);
    report[name].sourceArchive=metadata.archive;
    for(const kind of ['archive','license','notices']){
      const item=metadata[kind];assert.match(item.path,/^\/sources\/[a-f0-9]{64}\./);
      const received=await context.request.get(origin+item.path,{timeout:30000});
      check(`${name}_${kind}_public_bytes`,received.status()===200&&hash(await received.body())===item.sha256);
    }
  }
  await page.getByRole('button',{name:'Restore previous app and reload',exact:true}).waitFor();
  await page.screenshot({path:join(output,'updated.png')});
  await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});
  check('updated_shell_opens_offline',await shell()===next);
  await page.getByRole('button',{name:'Restore previous app and reload',exact:true}).click();
  await page.waitForFunction(previous=>document.querySelector('meta[name="grok-shell-build"]')?.getAttribute('content')===previous,old);
  check('explicit_offline_rollback_restores_prior_shell',await shell()===old);
  await page.screenshot({path:join(output,'rolled-back-offline.png')});
  await context.setOffline(false);
  report.phases.push({name:'updated-and-rolled-back',at:new Date().toISOString(),shellId:next,restoredShellId:old});
  await signal('upgrade');
  report.result='passed';
}catch(error){report.result='failed';report.failure=String(error?.message??error);process.exitCode=1;}
finally{
  const members=chrome?.pid ? await groupMembers(chrome.pid) : [];
  await deadline(browser?.close()??Promise.resolve(),5000).catch(()=>{});
  await waitExit(chrome).catch(()=>{report.cleanupFailed=true;});
  for(const member of members){
    const remaining=await groupMembers(chrome.pid);
    if(remaining.some(value=>value.pid===member.pid&&value.startTicks===member.startTicks)){
      try{process.kill(member.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH') report.cleanupFailed=true;}
    }
  }
  if(chrome?.pid) await waitFor(async()=>!(await groupMembers(chrome.pid)).length,5000).then(()=>{report.chromeProcessGroupEmpty=true;}).catch(()=>{report.cleanupFailed=true;});
  if(syl?.pid){await rpc('tools/call',{name:'gui_close',arguments:{}}).then(result=>{assert.ok(!result?.isError,'Syl compositor close failed');}).catch(()=>{report.cleanupFailed=true;});await waitExit(syl).catch(()=>{report.cleanupFailed=true;});}
  if(!chrome?.pid||report.chromeProcessGroupEmpty) await rm(join(output,'profile'),{recursive:true,force:true}).then(()=>{report.profileRemoved=true;}).catch(()=>{report.cleanupFailed=true;});
  if(spawnFailures.length){report.spawnFailures=spawnFailures;report.result='failed';report.failure??='Child process failed to start';process.exitCode=1;}
  if(report.cleanupFailed){report.result='failed';report.failure??='cleanup failed';process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({result:report.result,checks:report.checks.length,failure:report.failure,output}));
}
