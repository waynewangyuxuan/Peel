import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
const localLinks = [...new Set(links.filter((target) => !/^(?:https?:|#)/.test(target)))];

for (const target of localLinks) {
  const normalized = target.replace(/^<|>$/g, "").split("#", 1)[0];
  await access(join(repositoryRoot, normalized), fsConstants.R_OK);
}

const expectedCommands = [
  "npm install --legacy-peer-deps",
  "npm run start:desktop",
  "npm run launch --workspace @peel/desktop",
  "npm run build",
  "npm test",
  "npm run test:e2e --workspace @peel/desktop",
  "npm run package:desktop",
  "npm run verify:package --workspace @peel/desktop",
];
for (const command of expectedCommands) {
  if (!readme.includes(command)) throw new Error(`README is missing documented command: ${command}`);
}
if (rootPackage.scripts["start:desktop"] !== "npm run package:desktop && npm run launch --workspace @peel/desktop") {
  throw new Error("README launch description no longer matches the root start:desktop script");
}
for (const script of ["build", "test:e2e", "package", "launch", "verify:package"]) {
  if (!desktopPackage.scripts[script]) throw new Error(`Desktop package is missing documented script: ${script}`);
}

const imageFacts = [];
let totalImageBytes = 0;
for (const path of ["docs/assets/peel-focus.png", "docs/assets/peel-overview.png"]) {
  const bytes = await readFile(join(repositoryRoot, path));
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${path} is not a PNG`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== 1600 || height !== 1000) throw new Error(`${path} is ${width}x${height}, expected 1600x1000`);
  totalImageBytes += bytes.byteLength;
  imageFacts.push({ path, width, height, bytes: bytes.byteLength });
}
if (totalImageBytes > 750_000) throw new Error(`README screenshots total ${totalImageBytes} bytes, expected at most 750000`);

process.stdout.write(`${JSON.stringify({ ok: true, localLinks: localLinks.length, commands: expectedCommands.length, images: imageFacts, totalImageBytes })}\n`);
