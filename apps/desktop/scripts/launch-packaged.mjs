import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "../out/Peel-darwin-arm64/Peel.app");
await access(join(bundle, "Contents/MacOS/Peel"), fsConstants.X_OK);

const child = spawn("/usr/bin/open", ["-n", bundle, ...(process.argv.length > 2 ? ["--args", ...process.argv.slice(2)] : [])], {
  detached: true,
  stdio: "ignore",
});
await new Promise((resolvePromise, rejectPromise) => {
  child.once("error", rejectPromise);
  child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`LaunchServices exited with code ${code ?? "unknown"}`)));
});
child.unref();
process.stdout.write(`${JSON.stringify({ ok: true, bundle, launch: "LaunchServices", bundleId: "com.peel.desktop" })}\n`);
