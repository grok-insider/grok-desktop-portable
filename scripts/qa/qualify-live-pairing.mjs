import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';

assert.equal(process.argv.length,3,'Usage: node scripts/qa/qualify-live-pairing.mjs <new-private-output>');
const output=resolve(process.argv[2]);
const expectedNative=process.env.REMOTE_QA_NATIVE_SHA256;
const expectedShell=process.env.REMOTE_QA_SHELL_ID;
assert.match(expectedNative??'',/^[a-f0-9]{64}$/,'REMOTE_QA_NATIVE_SHA256 is required');
assert.match(expectedShell??'',/^[a-f0-9]{64}$/,'REMOTE_QA_SHELL_ID is required');
const chromeBinary=process.env.REMOTE_QA_CHROME;
const playwright=process.env.REMOTE_QA_PLAYWRIGHT;
assert.ok(chromeBinary?.startsWith('/nix/store/') && playwright,'REMOTE_QA_CHROME and REMOTE_QA_PLAYWRIGHT are required');
await mkdir(output,{mode:0o700});
const origin='https://grok.fabrials.com';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={schema:1,startedAt:new Date().toISOString(),origin,scope:'Two independent paired browsers against deployed PWA and station over trusted Tailscale TLS',checks:[],notQualified:['Active turn or inference','Physical mobile interaction','Push','Keyboard and suspension','Full descendant-process inventory after cleanup']};
const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
const waitFor=async(fn,ms=20000)=>{const end=Date.now()+ms;while(!await fn()){assert.ok(Date.now()<end,'readiness deadline');await new Promise(r=>setTimeout(r,100));}};
let syl,browser,chrome,seq=0;
const ownedPairings=[];
const pages=[];
const spawnFailures=[];
const cli='/home/friend/.local/state/nix/profiles/spanreed-remote-qa/bin/spanreed-qa';
const initialDevices=[];
const cleanEnv={...process.env};
for(const name of Object.keys(cleanEnv)) if(/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(name)) delete cleanEnv[name];
const mainPid=()=>Number(execFileSync('systemctl',['--user','show','spanreed-remote-qa.service','--property=MainPID','--value'],{encoding:'utf8',timeout:5000}).trim());
const procIdentity=async pid=>{
  assert.ok(pid>1,'QA service must be running');
  const status=await readFile(`/proc/${pid}/stat`,'utf8');
  return {pid,startTicks:status.slice(status.lastIndexOf(')')+2).split(' ')[19],sha256:hash(await readFile(`/proc/${pid}/exe`))};
};
const waitExit=async(child,name)=>{
  if(!child) return;
  const ended=()=>child.exitCode!==null || child.signalCode!==null;
  if(!ended()) child.kill('SIGTERM');
  try{await waitFor(async()=>ended(),5000);}
  catch{child.kill('SIGKILL');await waitFor(async()=>ended(),5000);}
  report.cleanup??={};report.cleanup[name]=ended();
};
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
const collectPairings=async page=>{
  if(page.isClosed() || new URL(page.url()).origin!==origin) return;
  const ids=await page.evaluate(()=>new Promise((resolveIds,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Pairing ID inventory deadline')),5000);
    const request=indexedDB.open('grok-direct-hosts-v1');
    let missing=false;
    request.onupgradeneeded=()=>{missing=true;request.transaction.abort();};
    request.onerror=request.onblocked=()=>{clearTimeout(timer);if(missing) resolveIds([]);else reject(new Error('Pairing ID inventory unavailable'));};
    request.onsuccess=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('profiles')){db.close();clearTimeout(timer);resolveIds([]);return;}
      const tx=db.transaction('profiles','readonly'),read=tx.objectStore('profiles').getAll();
      let ids=[];
      read.onsuccess=()=>{ids=read.result.filter(value=>value.endpoint==='https://station.taila8c477.ts.net').map(value=>value.pair?.sessionId);};
      tx.oncomplete=()=>{db.close();clearTimeout(timer);resolveIds(ids);};
      tx.onabort=tx.onerror=()=>{db.close();clearTimeout(timer);reject(new Error('Pairing ID inventory failed'));};
    };
  }));
  for(const id of ids){
    assert.match(id??'',/^[A-Za-z0-9_-]{1,128}$/,'Valid own pairing identifier');
    assert.ok(!initialDevices.includes(id),'Ephemeral context cannot own a preexisting pairing');
    if(!ownedPairings.includes(id)) ownedPairings.push(id);
  }
};
const devices=()=>execFileSync(cli,['remote','devices'],{env:cleanEnv,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore']}).trim().split('\n').filter(Boolean);
const pending=new Map();
const rpc=(method,params)=>new Promise((resolveResult,reject)=>{
  const id=++seq;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Syl RPC timeout'));},15000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolveResult(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  syl.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
const persist=async()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
try{
  report.runnerSha256=hash(await readFile(new URL(import.meta.url)));
  report.nativeSha256=hash(await readFile('/home/friend/.local/state/nix/profiles/spanreed-remote-qa/bin/spanreed'));
  check('selected_native_matches_expected_hash',report.nativeSha256===expectedNative);
  report.serviceBefore=await procIdentity(mainPid());
  check('running_service_matches_selected_native',report.serviceBefore.sha256===expectedNative);
  initialDevices.push(...devices());
  const sylFd=openSync(join(output,'syl.log'),'wx',0o600);
  syl=spawn('syl',['mcp'],{env:{...cleanEnv,SYL_MCP_PROFILE:'visual',SYL_NESTED_RES:'2560x1440'},stdio:['pipe','pipe',sylFd]});closeSync(sylFd);
  syl.on('error',()=>spawnFailures.push('syl'));
  createInterface({input:syl.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const item=pending.get(value.id);if(item){pending.delete(value.id);value.error?item.reject(new Error(value.error.message)):item.resolve(value.result);}});
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'deployed-live-pairing',version:'1'}});
  const nested=await rpc('tools/call',{name:'gui_open',arguments:{target:'nested',app:'foot'}});
  const display=nested.content?.map(x=>x.text??'').join(' ').match(/display=(wayland-\d+)/)?.[1];
  assert.ok(display,'real hidden compositor');
  const profile=join(output,'profile');await mkdir(profile,{mode:0o700});
  const fd=openSync(join(output,'chrome.log'),'wx',0o600);
  chrome=spawn(chromeBinary,[
    `--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--ozone-platform=wayland','--password-store=basic','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--no-proxy-server','--start-fullscreen','--window-size=2560,1440','about:blank'
  ],{env:{...cleanEnv,WAYLAND_DISPLAY:display},detached:true,stdio:['ignore',fd,fd]});closeSync(fd);
  chrome.on('error',()=>spawnFailures.push('chrome'));
  let port;await waitFor(async()=>{assert.equal(chrome.exitCode,null);try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);return !!port;}catch{return false;}});
  const {chromium}=await import(playwright);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  report.browser=browser.version();
  for(let i=0;i<2;i++){
    const context=await browser.newContext({viewport:{width:2560,height:1440}});
    await context.grantPermissions(['local-network-access'],{origin});
    const pair=execFileSync(cli,['remote','private-pair','https://station.taila8c477.ts.net','--web-origin',origin],{env:cleanEnv,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']});
    const link=pair.split('\n').find(x=>x.startsWith(origin+'/#directPair='));assert.ok(link);
    const page=await context.newPage();page.setDefaultTimeout(20000);
    pages.push(page);
    const response=await page.goto(link,{waitUntil:'networkidle',timeout:30000});
    report.shellId=await page.locator('meta[name="grok-shell-build"]').getAttribute('content');
    check(`browser_${i+1}_expected_shell_loaded`,report.shellId===expectedShell);
    check(`browser_${i+1}_trusted_public_tls`,response.status()===200&&await page.evaluate(()=>isSecureContext));
    await page.getByRole('button',{name:'Pair and connect',exact:true}).click();
    await waitFor(async()=>{await collectPairings(page);return ownedPairings.length===i+1;});
    await page.getByRole('button',{name:'Computers',exact:true}).waitFor();
    await page.getByRole('button',{name:'Add a project',exact:true}).waitFor();
    assert.ok(devices().includes(ownedPairings[i]),'Own persisted pairing exists on host');
    check(`browser_${i+1}_noise_pairing_completed`,true);
    await waitFor(()=>page.getByRole('button',{name:'Add a project',exact:true}).isEnabled());
    check(`browser_${i+1}_can_control`,true);
    check(`browser_${i+1}_no_controller_conflict`,!(await page.locator('body').innerText()).includes('Another browser tab has control'));
    check(`browser_${i+1}_pairing_fragment_consumed`,!new URL(page.url()).hash.includes('directPair'));
  }
  check('both_independent_browsers_remain_writers',await pages[0].getByRole('button',{name:'Add a project',exact:true}).isEnabled()&&await pages[1].getByRole('button',{name:'Add a project',exact:true}).isEnabled());
  await pages[0].reload({waitUntil:'networkidle'});
  await pages[0].getByRole('button',{name:'Connect',exact:true}).click();
  await pages[0].getByRole('button',{name:'Add a project',exact:true}).waitFor();
  await waitFor(()=>pages[0].getByRole('button',{name:'Add a project',exact:true}).isEnabled());
  check('reload_reconnects_without_new_pairing',true);
  check('peer_remains_writer_after_reconnect',await pages[1].getByRole('button',{name:'Add a project',exact:true}).isEnabled());
  for(let i=0;i<pages.length;i++){
    await pages[i].getByRole('button',{name:'Forget this browser',exact:true}).click();
    await pages[i].getByRole('heading',{name:'Your computers',exact:true}).waitFor();
    check(`browser_${i+1}_forget_confirmed_in_ui`,await pages[i].getByRole('button',{name:'Connect',exact:true}).count()===0);
    check(`browser_${i+1}_pairing_revoked_at_host`,!devices().includes(ownedPairings[i]));
    if(i===0) check('peer_remains_writable_after_other_pairing_revoked',await pages[1].getByRole('button',{name:'Add a project',exact:true}).isEnabled());
  }
  check('preexisting_pairings_preserved',initialDevices.every(id=>devices().includes(id)));
  report.serviceAfter=await procIdentity(mainPid());
  check('running_service_identity_unchanged',JSON.stringify(report.serviceBefore)===JSON.stringify(report.serviceAfter));
  report.result='passed';
}catch(error){report.result='failed';report.failure=String(error?.message??error).replace(/#directPair=[^\s"'<>]+/g,'#directPair=[redacted]');process.exitCode=1;}
finally{
  for(const page of pages) await collectPairings(page).catch(()=>{report.cleanupFailed=true;});
  for(const id of ownedPairings){try{if(!devices().includes(id)) continue;execFileSync(cli,['remote','revoke',id],{env:cleanEnv,timeout:10000,stdio:'ignore'});}catch{report.cleanupFailed=true;}}
  const chromeGroup=chrome?.pid ? await groupMembers(chrome.pid) : [];
  await browser?.close().catch(()=>{});
  await waitExit(chrome,'chrome').catch(()=>{report.cleanupFailed=true;});
  for(const member of chromeGroup){
    const remaining=await groupMembers(chrome.pid);
    if(remaining.some(value=>value.pid===member.pid && value.startTicks===member.startTicks)){
      try{process.kill(member.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH') report.cleanupFailed=true;}
    }
  }
  if(chrome?.pid) await waitFor(async()=>!(await groupMembers(chrome.pid)).length,5000).then(()=>{report.chromeProcessGroupEmpty=true;}).catch(()=>{report.cleanupFailed=true;});
  if(syl){await rpc('tools/call',{name:'gui_close',arguments:{}}).catch(()=>{report.cleanupFailed=true;});await waitExit(syl,'syl').catch(()=>{report.cleanupFailed=true;});}
  try{
    const remaining=devices();
    assert.ok(initialDevices.every(id=>remaining.includes(id)) && ownedPairings.every(id=>!remaining.includes(id)));
    report.unattributedNewPairings=remaining.filter(id=>!initialDevices.includes(id)).length;
    assert.equal(report.unattributedNewPairings,0,'Unexpected pairings require manual reconciliation');
    report.testPairingsRemoved=true;
  }catch{report.cleanupFailed=true;}
  if(!chrome || report.chromeProcessGroupEmpty) await rm(join(output,'profile'),{recursive:true,force:true}).catch(()=>{report.cleanupFailed=true;});
  if(spawnFailures.length){report.spawnFailures=spawnFailures;report.cleanupFailed=true;}
  if(report.cleanupFailed){report.result='failed';process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({result:report.result,checks:report.checks.length,failure:report.failure,output,cleanupFailed:report.cleanupFailed??false}));
}
