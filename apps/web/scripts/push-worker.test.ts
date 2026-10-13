import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function worker() {
  const listeners:Record<string,(event:unknown)=>void>={};
  const claim=vi.fn(async()=>true);
  const fetch=vi.fn(async()=>Response.json({active:true}));
  const request=vi.fn((_name:string,_options:unknown,run:()=>Promise<unknown>)=>run());
  const showNotification=vi.fn(async()=>{});const openWindow=vi.fn(async()=>{});
  const scope={fetch,indexedDB:{},navigator:{locks:{request}},registration:{scope:"https://remote.fabrials.com/",showNotification},location:{origin:"https://remote.fabrials.com"},clients:{openWindow,matchAll:async()=>[]},addEventListener:(name:string,handler:(event:unknown)=>void)=>{listeners[name]=handler;}};
  const source=readFileSync("scripts/push-worker.js","utf8").replace(/^export /gm,"")+"\nclaimPushNotice=claim;installRemotePushWorker(scope);";
  runInNewContext(source,{scope,claim,Response,URL,AbortController,TextEncoder,setTimeout,clearTimeout,Date,JSON,Error,Number});
  const notice=()=>({kind:"remote_attention",eventId:"a".repeat(32),expiresAt:Date.now()+30000});
  const push=async(value:unknown,raw=false)=>{const waitUntil=vi.fn();listeners.push({data:{text:()=>raw ? value : JSON.stringify(value)},waitUntil});await waitUntil.mock.calls[0][0];};
  const click=async(value:unknown)=>{const waitUntil=vi.fn();const close=vi.fn();listeners.notificationclick({notification:{data:value,close},waitUntil});await waitUntil.mock.calls[0][0];return close;};
  return {listeners,claim,fetch,request,showNotification,openWindow,notice,push,click};
}
it("displays only a fixed generic notice after authenticated resolution",async()=>{
  const test=worker();const notice=test.notice();await test.push(notice);
  expect(test.fetch).toHaveBeenCalledWith("https://fabrials.com/api/spanreed/remote/push/resolve",expect.objectContaining({method:"POST",credentials:"include",cache:"no-store",redirect:"error",body:JSON.stringify({eventId:notice.eventId})}));
  expect(test.request).toHaveBeenCalledWith("grok-remote-account:https://fabrials.com",expect.objectContaining({mode:"exclusive"}),expect.any(Function));
  expect(test.showNotification).toHaveBeenCalledWith("Grok Remote",{body:"There is activity in your sessions.",tag:`grok-remote-${notice.eventId}`,data:notice,renotify:false});
  expect(test.openWindow).not.toHaveBeenCalled();
});
it("rejects malformed, oversized, expired and content-bearing payloads without resolving",async()=>{
  const test=worker();const notice=test.notice();
  for(const value of [null,[],{}, {...notice,text:"private conversation"},{...notice,expiresAt:Date.now()-1},{...notice,expiresAt:Date.now()+61000},{...notice,eventId:"https://evil.example"},{...notice,kind:"approve"}])await test.push(value);
  await test.push("x".repeat(1025),true);await test.push("invalid json",true);
  expect(test.claim).not.toHaveBeenCalled();expect(test.fetch).not.toHaveBeenCalled();expect(test.showNotification).not.toHaveBeenCalled();
});
it.each(["duplicate","storage","revoked","offline","unauthorized"])("fails closed on %s",async failure=>{
  const test=worker();
  if(failure === "duplicate")test.claim.mockResolvedValue(false);
  if(failure === "storage")test.claim.mockRejectedValue(new Error("denied"));
  if(failure === "revoked")test.fetch.mockResolvedValue(Response.json({active:false}));
  if(failure === "offline")test.fetch.mockRejectedValue(new Error("offline"));
  if(failure === "unauthorized")test.fetch.mockResolvedValue(new Response(null,{status:401}));
  await test.push(test.notice());expect(test.showNotification).not.toHaveBeenCalled();expect(test.openWindow).not.toHaveBeenCalled();
});
it("rechecks revocation on click and never opens a route after revocation",async()=>{
  const test=worker();const notice=test.notice();await test.push(notice);
  test.fetch.mockResolvedValueOnce(Response.json({active:false}));
  const close=await test.click(notice);expect(close).toHaveBeenCalledOnce();expect(test.fetch).toHaveBeenCalledTimes(2);expect(test.openWindow).not.toHaveBeenCalled();
});
it("opens only the app root after a second valid resolution",async()=>{
  const test=worker();const notice=test.notice();await test.push(notice);await test.click(notice);
  expect(test.fetch).toHaveBeenCalledTimes(2);expect(test.openWindow).toHaveBeenCalledExactlyOnceWith("https://remote.fabrials.com/");
  await test.click({...notice,href:"https://evil.example"});await test.click({...notice,expiresAt:Date.now()-1});
  expect(test.openWindow).toHaveBeenCalledOnce();expect(test.fetch).toHaveBeenCalledTimes(2);
});
it("advertises only the explicit worker protocol capability",()=>{
  const test=worker();const postMessage=vi.fn();
  test.listeners.message({data:{kind:"other"},ports:[{postMessage}]});expect(postMessage).not.toHaveBeenCalled();
  test.listeners.message({data:{kind:"remotePushCapabilities"},ports:[{postMessage}]});expect(postMessage).toHaveBeenCalledExactlyOnceWith({kind:"remotePushCapabilities",version:1,directVersion:1,enabled:true});
});

it("aborts a stalled IndexedDB transaction and closes its database",async()=>{
  vi.useFakeTimers();
  try {
    const transaction={abort:vi.fn(),objectStore:()=>({getAll:()=>({})})};
    const database={close:vi.fn(),transaction:()=>transaction};
    const request:{result:typeof database;onsuccess?:()=>void}={result:database};
    const indexed={open:()=>request};
    const source=readFileSync("scripts/push-worker.js","utf8").replace(/^export /gm,"")+"\nclaimPushNotice";
    const claim=runInNewContext(source,{setTimeout,clearTimeout,Date,Error,Number}) as (notice:unknown,indexed:unknown)=>Promise<boolean>;
    const result=claim({eventId:"a".repeat(32),expiresAt:Date.now()+30000},indexed);
    const rejected=expect(result).rejects.toThrow("push_storage_unavailable");
    request.onsuccess!();
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(transaction.abort).toHaveBeenCalledOnce();expect(database.close).toHaveBeenCalledOnce();
  } finally {vi.useRealTimers();}
});

it("shows a generic direct notice and opens the local app without any account service", async () => {
  const test = worker();
  const notice = {version: 1, kind: "remoteActivity"};
  await test.push(notice);
  expect(test.fetch).not.toHaveBeenCalled();
  expect(test.showNotification).toHaveBeenCalledWith("Grok", expect.objectContaining({body: "There is activity on your computer.", tag: "grok-direct-activity", data: notice}));
  await test.click(notice);
  expect(test.fetch).not.toHaveBeenCalled();
  expect(test.openWindow).toHaveBeenCalledWith("https://remote.fabrials.com/");
});
