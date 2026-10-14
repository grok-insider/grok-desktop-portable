import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const [cryptoDirectory, executable] = process.argv.slice(2);
if (!cryptoDirectory || !executable) throw new Error("Usage: node scripts/test-remote-crypto.mjs <crypto-dist> <native-interop-executable>");
const wasm = await import(pathToFileURL(resolve(cryptoDirectory, "fabrials_remote_noise.js")).href);
await wasm.default({module_or_path: await readFile(resolve(cryptoDirectory, "fabrials_remote_noise_bg.wasm"))});
const encoder = new TextEncoder();

async function withPeer(test) {
  const child = spawn(resolve(executable), [], {stdio: ["pipe", "pipe", "pipe"]});
  const lines = createInterface({input: child.stdout});
  const iterator = lines[Symbol.asyncIterator]();
  let childError;
  child.on("error", (error) => {childError = error;});
  child.stderr.resume();
  const read = async () => {
    let timer;
    try {
      const line = await Promise.race([iterator.next(), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error("Native peer timed out")), 15_000);})]);
      if (childError) throw childError;
      if (line.done) throw new Error("Native peer closed unexpectedly");
      return JSON.parse(line.value);
    } finally {clearTimeout(timer);}
  };
  const send = async (frame) => {
    if (!child.stdin.write(`${JSON.stringify({frame: Buffer.from(frame).toString("base64")})}\n`)) await once(child.stdin, "drain");
  };
  try {
    const first = await read();
    const hostKey = Uint8Array.from(Buffer.from(first.publicKey, "base64"));
    await test({hostKey, read, send});
  } finally {
    lines.close();
    child.stdin.destroy();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
}

async function handshake(peer, hostKey = peer.hostKey, channelId = "interop-channel") {
  const client = new wasm.NoiseClient(wasm.generate_private_key(), hostKey, "interop-host", channelId);
  try {
    await peer.send(client.start());
    const server = await peer.read();
    const last = client.authenticate(Uint8Array.from(Buffer.from(server.frame, "base64")), encoder.encode("synthetic-pairing"));
    await peer.send(last);
    assert.equal((await peer.read()).ready, true);
    return client;
  } catch (error) {client.free(); throw error;}
}

await withPeer(async (peer) => {
  const client = await handshake(peer);
  try {
    const message = Uint8Array.from({length: 2 * 1024 * 1024}, (_, index) => index % 251);
    const outgoing = client.encrypt(message);
    assert.ok(outgoing.length > 1);
    for (const frame of outgoing) await peer.send(frame);
    let received;
    let firstReply;
    for (let index = 0; index < outgoing.length; index += 1) {
      const frame = Uint8Array.from(Buffer.from((await peer.read()).frame, "base64"));
      firstReply ??= frame;
      const next = client.decrypt(frame);
      if (next) received = next;
    }
    assert.deepEqual(received, message);
    assert.throws(() => client.decrypt(firstReply));
  } finally {client.free();}
});
console.log("PASS: native ↔ WASM 2 MiB fragmented roundtrip and replay rejection");

await withPeer(async (peer) => {
  const client = await handshake(peer);
  try {
    for (const frame of client.encrypt(encoder.encode("authentication check"))) await peer.send(frame);
    const ciphertext = Uint8Array.from(Buffer.from((await peer.read()).frame, "base64"));
    ciphertext[ciphertext.length - 1] ^= 1;
    assert.throws(() => client.decrypt(ciphertext));
  } finally {client.free();}
});
console.log("PASS: ciphertext modification rejected");

await withPeer(async (peer) => {
  const wrongKey = peer.hostKey.slice();
  wrongKey[0] ^= 1;
  await assert.rejects(handshake(peer, wrongKey));
});
console.log("PASS: substituted host identity rejected");

await withPeer(async (peer) => {
  await assert.rejects(handshake(peer, peer.hostKey, "wrong-channel"));
});
console.log("PASS: substituted relay channel rejected");
