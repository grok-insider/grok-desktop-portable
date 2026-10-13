export async function registerShellWorker(onUpdate: (registration: ServiceWorkerRegistration) => void): Promise<void> {
  if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator) || location.pathname.startsWith("/demo")) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {scope: "/", updateViaCache: "none"});
    if (registration.waiting) onUpdate(registration);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) onUpdate(registration);
      });
    });
  } catch {}
}

export async function shellWorkerMessage(message: {kind: "shellStatus" | "rollbackShell"}): Promise<{canRollback?: boolean; ok?: boolean}> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker || typeof MessageChannel === "undefined") return {};
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (value: {canRollback?: boolean; ok?: boolean}) => {clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(value);};
    const timer = setTimeout(() => finish({}), 3000);
    channel.port1.onmessage = event => finish(event.data && typeof event.data === "object" ? event.data : {});
    try {worker.postMessage(message, [channel.port2]);} catch {finish({});}
  });
}
