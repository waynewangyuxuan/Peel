import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AppServerClient } from "../src/client.js";
import type { AppServerNotification, AppServerServerRequest } from "../src/protocol.js";
import { AppServerTransport } from "../src/transport.js";

function waitForNotification(
  transport: AppServerTransport,
  predicate: (notification: AppServerNotification) => boolean,
  timeoutMs = 120_000,
): Promise<AppServerNotification> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for App Server notification`));
    }, timeoutMs);
    const listener = (notification: AppServerNotification): void => {
      if (!predicate(notification)) return;
      cleanup();
      resolvePromise(notification);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      transport.off("notification", listener);
    };
    transport.on("notification", listener);
  });
}

async function main(): Promise<void> {
  if (process.env.PEEL_CODEX_LIVE_SMOKE !== "1") {
    process.stdout.write("Skipped: set PEEL_CODEX_LIVE_SMOKE=1 to run the isolated real-server smoke test.\n");
    return;
  }

  const workspace = await mkdtemp(join(tmpdir(), "peel-appserver-live-"));
  assert.equal(resolve(workspace).startsWith(resolve(tmpdir())), true, "temporary workspace must stay under OS tmp");
  await writeFile(join(workspace, "README.md"), "# Peel App Server live smoke\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=Peel Smoke", "-c", "user.email=smoke@peel.invalid", "commit", "-qm", "fixture"], {
    cwd: workspace,
  });

  const transport = new AppServerTransport({
    codexBinary: process.env.PEEL_CODEX_BINARY || "/opt/homebrew/bin/codex",
    reconnect: false,
    requestTimeoutMs: 30_000,
  });
  const client = new AppServerClient(transport);
  const created: string[] = [];
  const statuses: string[] = [];
  const approvalRequests: string[] = [];
  const unique = `Peel adapter smoke ${Date.now()}`;
  transport.on("notification", (notification: AppServerNotification) => {
    if (notification.method === "thread/status/changed") statuses.push(JSON.stringify(notification.params));
  });
  transport.on("serverRequest", (request: AppServerServerRequest) => {
    approvalRequests.push(request.method);
    client.rejectServerRequest(request.id, -32000, "Live smoke runs with approvalPolicy=never");
  });

  try {
    const initialized = await client.connect();
    assert.equal(client.capabilities.snapshot().detection, "installed-schema");
    const root = await client.startThread({
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
    });
    created.push(root.thread.id);
    await client.setThreadName(root.thread.id, unique);

    const rootCompleted = waitForNotification(
      transport,
      (notification) =>
        notification.method === "turn/completed" &&
        (notification.params as { threadId?: string }).threadId === root.thread.id,
    );
    const diffUpdated = waitForNotification(
      transport,
      (notification) =>
        notification.method === "turn/diff/updated" &&
        (notification.params as { threadId?: string; diff?: string }).threadId === root.thread.id &&
        Boolean((notification.params as { diff?: string }).diff),
    );
    const rootTurnId = await client.startTurn({
      threadId: root.thread.id,
      input: [
        {
          type: "text",
          text: "Create peel-live-smoke.txt in this repository with exactly PEEL_APP_SERVER_SMOKE_OK and a trailing newline. Do not change any other file.",
          text_elements: [],
        },
      ],
    });
    const [completedNotice, diffNotice] = await Promise.all([rootCompleted, diffUpdated]);
    assert.equal((completedNotice.params as { turn?: { id?: string } }).turn?.id, rootTurnId);
    assert.match((diffNotice.params as { diff: string }).diff, /peel-live-smoke\.txt/);
    assert.equal(await readFile(join(workspace, "peel-live-smoke.txt"), "utf8"), "PEEL_APP_SERVER_SMOKE_OK\n");

    const listed = await client.listThreads({ cwd: workspace, limit: 20 });
    assert.equal(listed.data.some((thread) => thread.id === root.thread.id), true);
    const searched = await client.searchThreads(unique, { cwd: workspace, limit: 20 });
    assert.equal(searched.data.some((thread) => thread.id === root.thread.id), true);
    const read = await client.readThread(root.thread.id, true);
    assert.equal(read.turns.some((turn) => turn.id === rootTurnId && turn.status === "completed"), true);

    const child = await client.forkThread({
      threadId: root.thread.id,
      lastTurnId: rootTurnId,
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    created.push(child.thread.id);
    assert.equal(child.thread.forkedFromId, root.thread.id);
    await client.setThreadName(child.thread.id, `${unique} child`);
    const childCompleted = waitForNotification(
      transport,
      (notification) =>
        notification.method === "turn/completed" &&
        (notification.params as { threadId?: string }).threadId === child.thread.id,
    );
    const childTurnId = await client.startTurn({
      threadId: child.thread.id,
      input: [{ type: "text", text: "Reply exactly PEEL_FORK_SMOKE_OK. Do not use tools.", text_elements: [] }],
    });
    const childNotice = await childCompleted;
    assert.equal((childNotice.params as { turn?: { id?: string } }).turn?.id, childTurnId);
    const childRead = await client.readThread(child.thread.id, true);
    assert.equal(childRead.turns.some((turn) => turn.id === childTurnId && turn.status === "completed"), true);
    assert.equal(statuses.some((status) => status.includes(root.thread.id)), true);

    process.stdout.write(
      `${JSON.stringify({
        result: "passed",
        server: initialized.userAgent,
        rootThreadId: root.thread.id,
        exactForkTurnId: rootTurnId,
        childThreadId: child.thread.id,
        childTurnId,
        statusEvents: statuses.length,
        approvalRequests,
        aggregateDiffObserved: true,
      })}\n`,
    );
  } finally {
    for (const threadId of created.reverse()) {
      try {
        await client.deleteThread(threadId);
      } catch {
        // The smoke test owns only these IDs; cleanup failure must not hide the primary result.
      }
    }
    await transport.shutdown().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
