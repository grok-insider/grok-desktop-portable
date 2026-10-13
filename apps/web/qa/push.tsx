import { createRoot } from "react-dom/client";
import { RemoteNotifications } from "../src/components/RemoteNotifications";
import { ApplicationLayout } from "../src/components/ApplicationLayout";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import type { LightClient } from "../src/services/client";
import type { Operation } from "../src/services/protocol";
import "@fontsource-variable/ibm-plex-sans/index.css";
import "../src/styles.css";

const key = new Uint8Array(65);key[0]=4;
const encodedKey = btoa(String.fromCharCode(...key)).replaceAll("=","").replaceAll("+","-").replaceAll("/","_");
const commands:Operation[]=[];
const accountCalls:{method:string;path:string}[]=[];
const counts={permissions:0,subscriptions:0,unsubscriptions:0};
let permission:NotificationPermission="default";
let permissionResult:NotificationPermission="granted";
let enabled=false;
let registered=false;
let bindingFailure=false;
let subscription:object | null=null;
let connected=true;
let scope="synthetic-host";
const expiresAt=()=>Date.now()+30*86400000;
const browserSubscription={endpoint:"https://push.example/synthetic",options:{applicationServerKey:key.buffer},toJSON:()=>({endpoint:"https://push.example/synthetic",keys:{p256dh:"synthetic",auth:"synthetic"}}),unsubscribe:async()=>{counts.unsubscriptions++;return true;}};
Object.defineProperty(window,"Notification",{configurable:true,value:{get permission(){return permission;},async requestPermission(){counts.permissions++;permission=permissionResult;return permission;}}});
Object.defineProperty(window,"PushManager",{configurable:true,value:class {}});
Object.defineProperty(navigator,"serviceWorker",{configurable:true,value:{controller:{postMessage:(_message:unknown,ports:MessagePort[])=>ports[0].postMessage({kind:"remotePushCapabilities",version:1,enabled:true})},getRegistration:async()=>({pushManager:{getSubscription:async()=>subscription,subscribe:async()=>{counts.subscriptions++;subscription=browserSubscription;return browserSubscription;}}})}});
const fetchOriginal=window.fetch.bind(window);
window.fetch=async(input,init)=>{
  const url=new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if(url.origin !== "https://fabrials.com" || !url.pathname.startsWith("/api/spanreed/remote/push/"))return fetchOriginal(input,init);
  const path=url.pathname.split("/push/")[1];accountCalls.push({method:init?.method??"GET",path});
  if(path === "config")return Response.json({enabled:true,applicationServerKey:encodedKey});
  if(init?.method === "POST"){registered=true;return Response.json({id:"synthetic-registration",bindingToken:"synthetic-binding-token",generation:1,expiresAt:Date.now()+120000});}
  if(init?.method === "DELETE"){enabled=false;registered=false;return Response.json({ok:true});}
  return Response.json({subscriptions:subscription&&registered?[{id:"synthetic-registration",endpoint:browserSubscription.endpoint,active:enabled,generation:1,expiresAt:expiresAt()}]:[]});
};
const client={async send(operation:Operation){
  commands.push(operation);
  if(operation.kind === "configureNotifications"){
    if(bindingFailure)return {ok:false,failure:{kind:"unreachable"}};
    enabled=true;return {ok:true,value:{outcome:"notificationsConfigured",id:"synthetic-registration",generation:1,expiresAt:expiresAt(),active:true}};
  }
  if(operation.kind === "disableNotifications"){enabled=false;return {ok:true,value:{outcome:"acknowledged"}};}
  return {ok:true,value:{outcome:"notificationStatus",enabled:true,registrations:enabled?[{id:"synthetic-registration",generation:1,expiresAt:expiresAt()}]:[]}};
}} as unknown as LightClient;
const root=createRoot(document.getElementById("root")!);
const render=()=>root.render(<ThemeProvider><ApplicationLayout><main className="overflow-y-auto"><RemoteNotifications client={client} hostId={scope} scopeKey={scope} connected={connected} capable connectionVersion={1} /></main></ApplicationLayout></ThemeProvider>);
Object.assign(window,{pushQa:{counts,commands,accountCalls,setPermissionResult(value:NotificationPermission){permissionResult=value;},bindingFailure(value:boolean){bindingFailure=value;},offline(){connected=false;render();},changeScope(value:string){scope=value;render();}}});
render();
