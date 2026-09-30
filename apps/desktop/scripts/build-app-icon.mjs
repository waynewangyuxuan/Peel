import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const buildRoot = join(desktopRoot, "build");
const source = join(buildRoot, "Peel.svg");
const outputPng = join(buildRoot, "Peel.png");
const outputIcns = join(buildRoot, "Peel.icns");
const scratch = await mkdtemp(join(tmpdir(), "peel-app-icon-"));
const masterPng = join(scratch, "Peel.png");
const iconset = join(scratch, "Peel.iconset");

const representations = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

try {
  await mkdir(buildRoot, { recursive: true });
  await mkdir(iconset, { recursive: true });
  await run("qlmanage", ["-t", "-s", "1024", "-o", scratch, source]);
  await run("sips", ["-z", "1024", "1024", join(scratch, "Peel.svg.png"), "--out", masterPng]);
  await run("sips", ["-z", "1024", "1024", masterPng, "--out", outputPng]);
  await Promise.all(representations.map(async ([filename, size]) => {
    await run("sips", ["-z", String(size), String(size), outputPng, "--out", join(iconset, filename)]);
  }));
  await run("iconutil", ["--convert", "icns", "--output", outputIcns, iconset]);
  process.stdout.write(`${JSON.stringify({ ok: true, source, png: outputPng, icns: outputIcns })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
