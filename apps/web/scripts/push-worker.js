export const PUSH_ACCOUNT_ORIGIN = "https://fabrials.com";
const PUSH_DATABASE = "grok-remote-push.v1";
const PUSH_EVENT_LIMIT = 256;

export function parsePushNotice(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "eventId,expiresAt,kind" || value.kind !== "remote_attention" || typeof value.eventId !== "string" || !/^[a-f0-9]{32}$/.test(value.eventId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 60_000) return null;
  return {kind:"remote_attention",eventId:value.eventId,expiresAt:value.expiresAt};
}

export async function claimPushNotice(notice, indexed = indexedDB, now = Date.now()) {
  const database = await new Promise((resolve,reject) => {
    const request = indexed.open(PUSH_DATABASE,1);
    let abandoned = false;
    const fail = () => {abandoned=true;clearTimeout(timer);reject(new Error("push_storage_unavailable"));};
    const timer = setTimeout(fail,2000);
    request.onupgradeneeded = () => request.result.createObjectStore("events",{keyPath:"eventId"});
    request.onsuccess = () => {clearTimeout(timer);if(abandoned)request.result.close();else resolve(request.result);};
    request.onerror = request.onblocked = fail;
  });
  try {
    return await new Promise((resolve,reject) => {
      const transaction = database.transaction("events","readwrite");
      const timer = setTimeout(() => {try {transaction.abort();} catch {}reject(new Error("push_storage_unavailable"));},2000);
      const store = transaction.objectStore("events");
      const request = store.getAll();
      let accepted = false;
      request.onsuccess = () => {
        let live = 0;
        let duplicate = false;
        for (const row of request.result) {
          if (!Number.isSafeInteger(row.expiresAt) || row.expiresAt <= now || row.expiresAt > now + 60_000) store.delete(row.eventId);
          else {live++;if (row.eventId === notice.eventId) duplicate = true;}
        }
        if (!duplicate && live < PUSH_EVENT_LIMIT && notice.expiresAt > now) {store.put(notice);accepted=true;}
      };
      transaction.oncomplete = () => {clearTimeout(timer);resolve(accepted);};
      transaction.onerror = transaction.onabort = () => {clearTimeout(timer);reject(new Error("push_storage_unavailable"));};
    });
  } finally {database.close();}
}

export async function resolvePushNotice(notice, scope) {
  if (!parsePushNotice(notice)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),5000);
  const run = async () => {
    const response = await scope.fetch(`${PUSH_ACCOUNT_ORIGIN}/api/spanreed/remote/push/resolve`,{method:"POST",credentials:"include",cache:"no-store",redirect:"error",signal:controller.signal,headers:{"content-type":"application/json"},body:JSON.stringify({eventId:notice.eventId})});
    if (!response.ok) return false;
    const result = await response.json();
    return result?.active === true && Boolean(parsePushNotice(notice));
  };
  try {
    return await (scope.navigator?.locks ? scope.navigator.locks.request(`grok-remote-account:${PUSH_ACCOUNT_ORIGIN}`,{mode:"exclusive",signal:controller.signal},run) : run());
  } catch {return false;}
  finally {clearTimeout(timer);}
}

export function installRemotePushWorker(scope) {
  scope.addEventListener("message",event => {
    if (event.data?.kind === "remotePushCapabilities") event.ports?.[0]?.postMessage({kind:"remotePushCapabilities",version:1,directVersion:1,enabled:true});
  });
  scope.addEventListener("push",event => {
    event.waitUntil((async () => {
      try {
        const text = event.data?.text();
        if (typeof text !== "string" || text.length > 1024 || new TextEncoder().encode(text).length > 1024) return;
        const data = JSON.parse(text);
        if (data && typeof data === "object" && Object.keys(data).sort().join(",") === "kind,version" && data.version === 1 && data.kind === "remoteActivity") {
          await scope.registration.showNotification("Grok", {body:"There is activity on your computer.",tag:"grok-direct-activity",data:{version:1,kind:"remoteActivity"},renotify:false});
          return;
        }
        const notice = parsePushNotice(data);
        if (!notice || !await claimPushNotice(notice,scope.indexedDB) || !await resolvePushNotice(notice,scope)) return;
        await scope.registration.showNotification("Grok Remote",{body:"There is activity in your sessions.",tag:`grok-remote-${notice.eventId}`,data:notice,renotify:false});
      } catch {}
    })());
  });
  scope.addEventListener("notificationclick",event => {
    event.notification.close();
    event.waitUntil((async () => {
      try {
        const direct = event.notification.data;
        if (direct?.version === 1 && direct.kind === "remoteActivity") {
          const destination = new URL("/", scope.registration.scope);
          const windows = await scope.clients.matchAll({type:"window",includeUncontrolled:true});
          const existing = windows.find(client => new URL(client.url).origin === destination.origin);
          if (existing) await existing.focus();
          else await scope.clients.openWindow(destination.href);
          return;
        }
        const notice = parsePushNotice(event.notification.data);
        if (!notice || !await resolvePushNotice(notice,scope)) return;
        const destination = new URL("/",scope.registration.scope);
        if (destination.origin !== scope.location.origin) return;
        await scope.clients.openWindow(destination.href);
      } catch {}
    })());
  });
}
