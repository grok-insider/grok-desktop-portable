import { afterEach, expect, it, vi } from "vitest";
import { applicationServerKey, asNotificationStatus, asPushBinding, asPushConfiguration, asPushRegistrations, bindingConfirmed, workerSupportsPush } from "./pushNotifications";

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it("requires a valid uncompressed VAPID key and explicit enabled configuration",()=>{
  const bytes = new Uint8Array(65);bytes[0]=4;
  const key = btoa(String.fromCharCode(...bytes)).replaceAll("=","").replaceAll("+","-").replaceAll("/","_");
  expect(applicationServerKey(key)).toEqual(bytes);
  expect(asPushConfiguration({enabled:true,applicationServerKey:key}).enabled).toBe(true);
  for(const value of [undefined,{}, {enabled:"yes"},{enabled:true,applicationServerKey:"invalid"}])expect(()=>asPushConfiguration(value)).toThrow();
  expect(asPushConfiguration({enabled:false})).toEqual({enabled:false});
});
it("rejects unbounded or contradictory account registrations and host state",()=>{
  const row={id:"id",endpoint:"https://push.example/id",active:true,generation:1,expiresAt:Date.now()+60000};
  expect(asPushRegistrations({subscriptions:[row]})).toEqual([row]);
  expect(()=>asPushRegistrations({subscriptions:[row,row]})).toThrow();
  expect(()=>asPushRegistrations({subscriptions:[{...row,endpoint:"javascript:alert(1)"}]})).toThrow();
  expect(()=>asPushRegistrations({subscriptions:Array(101).fill(row)})).toThrow();
  expect(()=>asNotificationStatus({outcome:"notificationStatus",enabled:true,registrations:[{...row,generation:1.5}]})).toThrow();
});
it("confirms only the same identity and generation with a live authoritative expiry",()=>{
  const binding=asPushBinding({id:"id",bindingToken:"synthetic-binding-token",generation:1,expiresAt:Date.now()+120000});
  const response={outcome:"notificationsConfigured",id:"id",generation:1,expiresAt:Date.now()+30*86400000,active:true};
  expect(bindingConfirmed(response,binding)).toBe(true);
  for(const value of [{...response,generation:2},{...response,id:"other"},{...response,active:false},{...response,expiresAt:Date.now()-1}])expect(bindingConfirmed(value,binding)).toBe(false);
  expect(()=>asPushBinding({...binding,expiresAt:Date.now()-1})).toThrow();
});
it("times out an old service worker and closes message ports",async()=>{
  vi.useFakeTimers();const close=vi.fn();const postMessage=vi.fn();
  vi.stubGlobal("MessageChannel",class {port1={close,onmessage:null};port2={close};});
  const result=workerSupportsPush({postMessage} as unknown as ServiceWorker,new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2000);
  await expect(result).resolves.toBe(false);expect(close).toHaveBeenCalledTimes(2);expect(postMessage).toHaveBeenCalledOnce();
});
it("requires affirmative worker capability and aborts a pending handshake",async()=>{
  const ports:{onmessage:((event:{data:unknown})=>void)|null;close:()=>void}[]=[];
  vi.stubGlobal("MessageChannel",class {port1={close:vi.fn(),onmessage:null};port2={close:vi.fn()};constructor(){ports.push(this.port1);}});
  const worker={postMessage:vi.fn()} as unknown as ServiceWorker;
  const controller=new AbortController();
  const supported=workerSupportsPush(worker,controller.signal);
  ports[0].onmessage?.({data:{kind:"remotePushCapabilities",version:1,enabled:true}});
  await expect(supported).resolves.toBe(true);
  const stale=workerSupportsPush(worker,controller.signal);controller.abort();
  await expect(stale).resolves.toBe(false);
});
