import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { DetectedAppServerSchema } from "./capabilities.js";
import { allowlistedEnvironment } from "./transport.js";

const execFileAsync = promisify(execFile);

function methodNames(source: string): Set<string> {
  return new Set([...source.matchAll(/"method":\s*"([^"]+)"/g)].map((match) => match[1]!).filter(Boolean));
}

async function generate(binary: string, output: string, experimental: boolean): Promise<void> {
  await execFileAsync(
    binary,
    ["app-server", "generate-ts", "--out", output, ...(experimental ? ["--experimental"] : [])],
    { env: allowlistedEnvironment(), maxBuffer: 16 * 1024 * 1024 },
  );
}

/**
 * Side-effect-free startup detection against the exact executable that owns
 * the stdio session. Generated files live only in OS tmp and are always removed.
 */
export async function detectInstalledAppServerSchema(binary: string): Promise<DetectedAppServerSchema> {
  const root = await mkdtemp(join(tmpdir(), "peel-appserver-detect-"));
  const stable = join(root, "stable");
  const experimental = join(root, "experimental");
  try {
    await Promise.all([generate(binary, stable, false), generate(binary, experimental, true)]);
    const [stableRequests, experimentalRequests, stableEvents, experimentalEvents] = await Promise.all([
      readFile(join(stable, "ClientRequest.ts"), "utf8"),
      readFile(join(experimental, "ClientRequest.ts"), "utf8"),
      readFile(join(stable, "ServerNotification.ts"), "utf8"),
      readFile(join(experimental, "ServerNotification.ts"), "utf8"),
    ]);
    const stableMethods = methodNames(stableRequests);
    const allExperimentalMethods = methodNames(experimentalRequests);
    const stableNotifications = methodNames(stableEvents);
    const allExperimentalNotifications = methodNames(experimentalEvents);
    return {
      stableMethods,
      experimentalMethods: new Set(
        [...allExperimentalMethods].filter((method) => !stableMethods.has(method)),
      ),
      stableNotifications,
      experimentalNotifications: new Set(
        [...allExperimentalNotifications].filter((method) => !stableNotifications.has(method)),
      ),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
