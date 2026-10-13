export const SHARE_BODY_BYTES = 1024 * 1024;
export const SHARE_TTL_MS = 60 * 60 * 1000;
export const SHARE_QUEUE_LIMIT = 3;
const encoder = new TextEncoder();

function failure(message) { return new Error(message); }
function bytes(text) { return encoder.encode(text).length; }

export async function parseSharedRequest(request) {
  if (Number(request.headers.get("content-length") ?? 0) > SHARE_BODY_BYTES) throw failure("share_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw failure("empty_share");
  const buffer = new Uint8Array(SHARE_BODY_BYTES);
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > SHARE_BODY_BYTES) {await reader.cancel(); throw failure("share_too_large");}
      buffer.set(result.value, size - result.value.byteLength);
    }
  } finally {reader.releaseLock();}
  const form = await new Response(buffer.subarray(0, size), {headers: {"content-type": request.headers.get("content-type") ?? ""}}).formData();
  const field = (name, limit) => {
    const values = form.getAll(name);
    if (values.length > 1 || (values[0] !== undefined && typeof values[0] !== "string")) throw failure("invalid_share");
    const text = values[0] ?? "";
    if (bytes(text) > limit) throw failure("share_too_large");
    return text;
  };
  const title = field("title", 1024);
  const text = field("text", 128 * 1024);
  const url = field("url", 16 * 1024);
  const files = [];
  for (const file of form.getAll("files")) {
    if (typeof file === "string" || files.length >= 3 || file.size > 200_000 || bytes(file.name) > 1024) throw failure("share_too_large");
    files.push({name: file.name, type: file.type, data: await file.arrayBuffer()});
  }
  if (!title.trim() && !text.trim() && !url.trim() && files.length === 0) throw failure("empty_share");
  return {title, text, url, files};
}

function validContent(content) {
  return content && typeof content.title === "string" && bytes(content.title) <= 1024 && typeof content.text === "string" && bytes(content.text) <= 128 * 1024 && typeof content.url === "string" && bytes(content.url) <= 16 * 1024 && Array.isArray(content.files) && content.files.length <= 3 && content.files.every((file) => file && typeof file.name === "string" && bytes(file.name) <= 1024 && typeof file.type === "string" && file.type.length <= 512 && file.data instanceof ArrayBuffer && file.data.byteLength <= 200_000) && Boolean(content.title.trim() || content.text.trim() || content.url.trim() || content.files.length);
}

function database() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {settled = true; reject(failure("share_storage_unavailable"));}, 5000);
    const request = indexedDB.open("grok-share-inbox-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("inbox", {keyPath: "id"});
    request.onsuccess = () => {clearTimeout(timer); if (settled) request.result.close(); else {settled = true; resolve(request.result);}};
    request.onerror = request.onblocked = () => {clearTimeout(timer); settled = true; reject(failure("share_storage_unavailable"));};
  });
}

async function change(run) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("inbox", "readwrite");
      const store = transaction.objectStore("inbox");
      const request = store.getAll();
      let result;
      let error;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(error ?? failure("share_storage_unavailable"));
      request.onsuccess = () => {
        const now = Date.now();
        const entries = request.result.filter((entry) => {
          if (!validContent(entry.content) || !["pending", "claimed"].includes(entry.state) || !Number.isFinite(entry.createdAt) || entry.createdAt > now || now - entry.createdAt >= SHARE_TTL_MS) {store.delete(entry.id); return false;}
          return true;
        });
        try {result = run(store, entries, now);} catch (reason) {error = reason; transaction.abort();}
      };
    });
  } finally {db.close();}
}

async function digest(content) {
  const files = [];
  for (const file of content.files) files.push({name: file.name, type: file.type, hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", file.data)), (byte) => byte.toString(16).padStart(2, "0")).join("")});
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({...content, files})))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enqueueSharedContent(content) {
  if (!validContent(content)) throw failure("invalid_share");
  const hash = await digest(content);
  return change((store, entries, now) => {
    const duplicate = entries.find((entry) => entry.digest === hash && now - entry.createdAt < 10_000);
    if (duplicate) return duplicate.id;
    if (entries.length >= SHARE_QUEUE_LIMIT) throw failure("share_inbox_full");
    const id = crypto.randomUUID();
    store.add({id, createdAt: now, digest: hash, content, state: "pending"});
    return id;
  });
}

export async function readShareInbox() {
  return change((_store, entries) => entries.sort((a, b) => a.createdAt - b.createdAt));
}

export async function claimShare(id) {
  return change((store, entries) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry || entry.state !== "pending") throw failure("share_already_claimed");
    const claimId = crypto.randomUUID();
    store.put({...entry, state: "claimed", claimId});
    return claimId;
  });
}

export async function recoverShare(id, claimId) {
  return change((store, entries) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry || entry.state !== "claimed" || entry.claimId !== claimId) throw failure("share_changed");
    store.put({...entry, state: "pending", claimId: undefined});
  });
}

export async function removeShare(id, claimId) {
  return change((store, entries) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    if (claimId !== undefined && (entry.state !== "claimed" || entry.claimId !== claimId)) throw failure("share_changed");
    store.delete(id);
  });
}
