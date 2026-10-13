import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directory = process.env.FABRIALS_REMOTE_CRYPTO_DIST;
if (!directory) throw new Error("FABRIALS_REMOTE_CRYPTO_DIST must point to the compiled Noise WASM package; remote builds cannot omit encryption.");
for (const name of ["fabrials_remote_noise.js", "fabrials_remote_noise_bg.wasm"]) accessSync(resolve(directory, name), constants.R_OK);
const build = spawnSync("corepack", ["pnpm", "--filter", "@grok-desktop-portable/web", "build"], {stdio: "inherit", env: {...process.env, VITE_REMOTE: "1", FABRIALS_REMOTE_CRYPTO_DIST: resolve(directory)}});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const verify = spawnSync(process.execPath, ["scripts/check-pwa-build.mjs", "apps/web/dist", "--require-crypto"], {stdio: "inherit"});
if (verify.error) throw verify.error;
if (verify.status !== 0) process.exit(verify.status ?? 1);
const assemble = spawnSync(process.execPath, ["scripts/prepare-public.mjs"], {stdio: "inherit"});
if (assemble.error) throw assemble.error;
process.exit(assemble.status ?? 1);
