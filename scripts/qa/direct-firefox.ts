import assert from "node:assert/strict";
import {createServer} from "node:http";
import {connect} from "node:net";
import {stat} from "node:fs/promises";
import type {ChildProcess} from "node:child_process";

type Options = {
  firefox: any;
  executablePath: string;
  port: number;
  hosts: string[];
  environment: Record<string,string | undefined>;
  owned(child: ChildProcess): void;
  report: any;
};

export async function openDirectFirefox(options: Options) {
  const {firefox,executablePath,port,hosts,environment,owned,report}=options;
  const allowed=new Set(hosts.map(host=>`${host}:443`));
  const sockets=new Set<any>();
  let browserServer: any;
  let profile: string | undefined;
  const proxy=createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:5000},(_request,response)=>{response.writeHead(405);response.end();});
  report.firefox={mode:"Isolated Playwright Firefox, headless software rendering",proxy:{allowedAuthorities:[...allowed],accepted:0,rejected:0},profileRetired:false};
  proxy.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("error",()=>{});if(sockets.size>64) socket.destroy();});
  proxy.on("connect",(request,socket,head)=>{
    if(!allowed.has(request.url ?? "") || sockets.size>=64) {report.firefox.proxy.rejected++;socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return;}
    report.firefox.proxy.accepted++;
    const upstream=connect({host:"127.0.0.1",port});
    sockets.add(upstream);
    upstream.on("close",()=>{sockets.delete(upstream);socket.destroy();});
    socket.on("close",()=>upstream.destroy());
    upstream.on("error",()=>socket.destroy());
    upstream.once("connect",()=>{socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");if(head.length) upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  });
  const close=async()=>{
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {await Promise.race([browserServer?.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Firefox close deadline")),5000);})]);}
    finally {
      clearTimeout(timer);
      for(const socket of sockets) socket.destroy();
      if(proxy.listening) await new Promise<void>((resolve,reject)=>proxy.close(error=>error ? reject(error) : resolve()));
    }
    if(profile) {
      report.firefox.profileRetired=await stat(profile).then(()=>false,(error:any)=>{if(error.code==="ENOENT")return true;throw error;});
      assert.ok(report.firefox.profileRetired,"Firefox's owned temporary profile was not removed");
    }
  };
  try {
    await new Promise<void>((resolve,reject)=>{proxy.once("error",reject);proxy.listen(0,"127.0.0.1",resolve);});
    const address=proxy.address();assert.ok(address && typeof address!=="string");
    const rejected=await new Promise<string>((resolve,reject)=>{
      const probe=connect({host:"127.0.0.1",port:address.port});
      const timer=setTimeout(()=>{probe.destroy();reject(new Error("Proxy negative control deadline"));},5000);
      probe.on("error",error=>{clearTimeout(timer);reject(error);});
      probe.once("connect",()=>probe.write("CONNECT outside-qualification.invalid:443 HTTP/1.1\r\nHost: outside-qualification.invalid:443\r\n\r\n"));
      probe.once("data",value=>{clearTimeout(timer);resolve(value.toString());probe.destroy();});
    });
    assert.match(rejected,/^HTTP\/1\.1 403 Forbidden\r\n/);
    report.firefox.proxy.outsideAuthorityDenied=true;
    browserServer=await firefox.launchServer({executablePath,headless:true,host:"127.0.0.1",timeout:15000,proxy:{server:`http://127.0.0.1:${address.port}`},env:{...environment,DBUS_SESSION_BUS_ADDRESS:"unix:path=/dev/null"}});
    const child=browserServer.process();owned(child);
    const index=child.spawnargs.indexOf("-profile");
    profile=index>=0 ? child.spawnargs[index+1] : undefined;
    assert.ok(profile,"Firefox must expose its owned profile for cleanup verification");
    const browser=await firefox.connect(browserServer.wsEndpoint(),{timeout:15000});
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:2560,height:1440}});
    return {browser,context,close};
  } catch(error) {await close();throw error;}
}
