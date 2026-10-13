import {createServer} from "node:http";
import {createReadStream,existsSync,readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {resolve,join,extname,sep} from "node:path";
import assert from "node:assert/strict";

const artifact=process.argv[2]&&resolve(process.argv[2]);
const evidence=process.argv[3]&&resolve(process.argv[3]);
if(!artifact||!evidence||existsSync(evidence)||!process.env.PLAYWRIGHT_MODULE||!process.env.BROWSER_CDP)throw new Error("need flagged artifact, new evidence path, PLAYWRIGHT_MODULE and BROWSER_CDP");
const source=readFileSync(new URL("../apps/web/scripts/push-worker.js",import.meta.url),"utf8");
const worker=readFileSync(join(artifact,"sw.js"),"utf8");
assert(worker.includes(source.replace(/^export /gm,"")),"worker must contain exact tested source");
const server=createServer((request,response)=>{
  const url=new URL(request.url,"http://localhost");
  if(url.pathname==="/__push-worker.js"){response.writeHead(200,{"content-type":"text/javascript","cache-control":"no-store"}).end(source);return;}
  if(url.pathname==="/__push-test.html"||url.pathname==="/"){response.writeHead(200,{"content-type":"text/html"}).end("<!doctype html><title>Push worker laboratory</title><main>Synthetic push worker qualification</main>");return;}
  if(url.pathname==="/favicon.ico"){response.writeHead(204).end();return;}
  let path;try{path=resolve(artifact,`.${decodeURIComponent(url.pathname)}`);}catch{response.writeHead(400).end();return;}
  if(!path.startsWith(artifact+sep)||!existsSync(path)){response.writeHead(404).end();return;}
  response.writeHead(200,{"content-type":({".js":"text/javascript",".html":"text/html",".css":"text/css",".webmanifest":"application/manifest+json"})[extname(path)]??"application/octet-stream","cache-control":"no-store"});
  const stream=createReadStream(path);stream.on("error",()=>response.destroy());stream.pipe(response);
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const origin=`http://127.0.0.1:${server.address().port}`;
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
const browser=await chromium.connectOverCDP(process.env.BROWSER_CDP);
const context=await browser.newContext();const page=await context.newPage();
const report={sourceSha256:createHash("sha256").update(source).digest("hex"),workerSha256:createHash("sha256").update(worker).digest("hex"),browser:browser.version(),tests:[],errors:[],limitations:["No provider delivery or OS notification displayed","Worker handlers tested with synthetic event scope; actual worker installation and handshake separately exercised","No mobile suspension or process-death qualification"]};
page.on("pageerror",error=>report.errors.push(String(error)));
try{
  await page.goto(`${origin}/__push-test.html`);
  report.tests.push(...await page.evaluate(async()=>{
    const api=await import("/__push-worker.js");const checks=[];const check=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
    const notice=id=>({kind:"remote_attention",eventId:id.toString(16).padStart(32,"0"),expiresAt:Date.now()+60000});
    const concurrent=await Promise.all(Array.from({length:8},()=>api.claimPushNotice(notice(1))));
    check("concurrent duplicate has one persistent claimant",concurrent.filter(Boolean).length===1);
    const claims=await Promise.all(Array.from({length:260},(_,index)=>api.claimPushNotice(notice(index+2))));
    check("persistent event table bounded to256",claims.filter(Boolean).length===255);
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open("grok-remote-push.v1",1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const transaction=db.transaction("events","readwrite");transaction.oncomplete=resolve;transaction.onerror=reject;const store=transaction.objectStore("events");const request=store.getAll();request.onsuccess=()=>{for(const row of request.result)store.put({...row,expiresAt:Date.now()-1});};});db.close();
    check("expired records free capacity",await api.claimPushNotice(notice(1000)));
    let denied=false;try{await api.claimPushNotice(notice(1001),{open(){throw new Error("denied");}});}catch{denied=true;}check("denied storage fails closed",denied);
    const listeners={};const shown=[];const opened=[];const resolutions=[];let active=true;
    const scope={indexedDB,registration:{scope:location.origin+"/",showNotification:async(title,options)=>shown.push({title,options})},location:{origin:location.origin},clients:{openWindow:async(url)=>opened.push(url)},fetch:async(url,init)=>{resolutions.push({url,credentials:init.credentials,body:JSON.parse(init.body)});return Response.json({active});},addEventListener:(name,handler)=>listeners[name]=handler};
    api.installRemotePushWorker(scope);
    const dispatch=async(name,event)=>{let work;listeners[name]({...event,waitUntil(value){work=value;}});await work;};
    const value=notice(1100);await dispatch("push",{data:{text:()=>JSON.stringify(value)}});
    check("fixed generic notice after account resolution",shown.length===1&&shown[0].title==="Grok Remote"&&shown[0].options.body==="There is activity in your sessions."&&resolutions[0].credentials==="include");
    await dispatch("push",{data:{text:()=>JSON.stringify(value)}});check("duplicate push is suppressed by actual IndexedDB",shown.length===1&&resolutions.length===1);
    active=false;await dispatch("notificationclick",{notification:{data:value,close(){}}});check("revocation is rechecked at click",opened.length===0&&resolutions.length===2);
    active=true;await dispatch("notificationclick",{notification:{data:value,close(){}}});check("valid click opens only origin root",opened.length===1&&opened[0]===location.origin+"/");
    await dispatch("notificationclick",{notification:{data:{...value,action:"approve",url:"https://example.invalid"},close(){}}});check("content-bearing click cannot execute or navigate",opened.length===1&&resolutions.length===3);
    return checks;
  }));
  await page.reload();
  assert.equal(await page.evaluate(async()=>{const api=await import("/__push-worker.js");return api.claimPushNotice({kind:"remote_attention",eventId:(1000).toString(16).padStart(32,"0"),expiresAt:Date.now()+60000});}),false);
  report.tests.push("dedup survives page reload");
  await page.evaluate(async()=>{await navigator.serviceWorker.register("/sw.js",{scope:"/"});await navigator.serviceWorker.ready;});
  await page.reload();
  const capability=await page.evaluate(()=>new Promise(resolve=>{const channel=new MessageChannel();const timer=setTimeout(()=>resolve(null),3000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};navigator.serviceWorker.controller.postMessage({kind:"remotePushCapabilities"},[channel.port2]);}));
  assert.deepEqual(capability,{kind:"remotePushCapabilities",version:1,enabled:true});report.tests.push("actual installed worker confirms capability");
  assert.deepEqual(report.errors,[]);report.result="passed";
}catch(error){report.result="failed";report.failure=String(error);process.exitCode=1;}
finally{await context.close();await browser.close();await new Promise(done=>server.close(done));writeFileSync(evidence,JSON.stringify(report,null,2));}
