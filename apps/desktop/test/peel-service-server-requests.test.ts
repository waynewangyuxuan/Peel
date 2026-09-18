import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppServerServerRequest } from "@peel/codex-app-server";
import { PeelService } from "../src/main/peel-service";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function service(options: { now?: () => number } = {}): Promise<PeelService> {
  const directory = await mkdtemp(join(tmpdir(), "peel-server-request-test-"));
  directories.push(directory);
  return new PeelService(directory, options);
}

function request(id: number, method: string, params: Record<string, unknown> = {}): AppServerServerRequest {
  return { id, method, params };
}

describe("PeelService ServerRequest routing", () => {
  it("classifies all ten stable methods and promptly rejects unsupported host capabilities", async () => {
    const peel = await service();
    const reject = vi.spyOn(peel.client, "rejectServerRequest").mockImplementation(() => undefined);
    const requests = [
      request(1, "item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn" }),
      request(2, "item/fileChange/requestApproval", { threadId: "thread", turnId: "turn" }),
      request(3, "item/tool/requestUserInput", { threadId: "thread", turnId: "turn", questions: [] }),
      request(4, "mcpServer/elicitation/request", { threadId: "thread", turnId: "turn", mode: "url", url: "https://example.com" }),
      request(5, "item/permissions/requestApproval", { threadId: "thread", turnId: "turn", permissions: {} }),
      request(6, "item/tool/call", { threadId: "thread", turnId: "turn", arguments: { secret: "hidden" } }),
      request(7, "account/chatgptAuthTokens/refresh", { previousAccountId: "private" }),
      request(8, "attestation/generate", {}),
      request(9, "applyPatchApproval", { conversationId: "thread" }),
      request(10, "execCommandApproval", { conversationId: "thread" }),
    ];

    for (const candidate of requests) peel.client.emit("serverRequest", candidate);

    expect((await peel.bootstrap()).pendingRequests.map((candidate) => candidate.id)).toEqual([1, 2, 3, 4, 5]);
    expect(reject.mock.calls.map(([id, code, message, data]) => ({ id, code, message, data }))).toEqual([
      { id: 6, code: -32601, message: "Peel does not support the item/tool/call host capability", data: { kind: "unsupported_host_capability", method: "item/tool/call" } },
      { id: 7, code: -32601, message: "Peel does not support the account/chatgptAuthTokens/refresh host capability", data: { kind: "unsupported_host_capability", method: "account/chatgptAuthTokens/refresh" } },
      { id: 8, code: -32601, message: "Peel does not support the attestation/generate host capability", data: { kind: "unsupported_host_capability", method: "attestation/generate" } },
      { id: 9, code: -32601, message: "Peel does not support the applyPatchApproval host capability", data: { kind: "unsupported_host_capability", method: "applyPatchApproval" } },
      { id: 10, code: -32601, message: "Peel does not support the execCommandApproval host capability", data: { kind: "unsupported_host_capability", method: "execCommandApproval" } },
    ]);
    expect(JSON.stringify(reject.mock.calls)).not.toContain("hidden");
    expect(JSON.stringify(reject.mock.calls)).not.toContain("private");
  });

  it("uses the response contract that belongs to each visible request", async () => {
    const peel = await service();
    const command = vi.spyOn(peel.client, "approveCommand").mockImplementation(() => undefined);
    const file = vi.spyOn(peel.client, "approveFileChange").mockImplementation(() => undefined);
    const userInput = vi.spyOn(peel.client, "answerUserInput").mockImplementation(() => undefined);
    const permissions = vi.spyOn(peel.client, "grantPermissions").mockImplementation(() => undefined);
    const elicitation = vi.spyOn(peel.client, "respondMcpElicitation").mockImplementation(() => undefined);
    peel.client.emit("serverRequest", request(1, "item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn" }));
    peel.client.emit("serverRequest", request(2, "item/fileChange/requestApproval", { threadId: "thread", turnId: "turn" }));
    peel.client.emit("serverRequest", request(3, "item/tool/requestUserInput", { threadId: "thread", turnId: "turn", questions: [{ id: "direction" }] }));
    peel.client.emit("serverRequest", request(4, "item/permissions/requestApproval", { threadId: "thread", turnId: "turn", permissions: { network: { enabled: true }, fileSystem: null } }));
    peel.client.emit("serverRequest", request(5, "mcpServer/elicitation/request", { threadId: "thread", turnId: "turn", mode: "form", requestedSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } }));
    peel.client.emit("serverRequest", request(6, "item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn", proposedExecpolicyAmendment: { command: "npm test" } }));
    peel.client.emit("serverRequest", request(7, "item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn", proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }] }));
    peel.client.emit("serverRequest", request(8, "mcpServer/elicitation/request", { threadId: "thread", turnId: "turn", mode: "openai/form", requestedSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false } }));

    peel.respondServerRequest({ id: 1, kind: "command", decision: "acceptForSession" });
    peel.respondServerRequest({ id: 2, kind: "file-change", decision: "decline" });
    peel.respondServerRequest({ id: 3, kind: "user-input", answers: { direction: ["Keep it focused"] } });
    peel.respondServerRequest({ id: 4, kind: "permissions", decision: "grant", scope: "session" });
    peel.respondServerRequest({ id: 5, kind: "mcp-elicitation", action: "accept", content: { project: "Peel" } });
    peel.respondServerRequest({ id: 6, kind: "command", decision: "acceptProposedExecpolicyAmendment" });
    peel.respondServerRequest({ id: 7, kind: "command", decision: { applyProposedNetworkPolicyAmendment: 0 } });
    expect(() => peel.respondServerRequest({ id: 8, kind: "mcp-elicitation", action: "accept", content: { count: 0, extra: true } })).toThrow(/does not match/);
    peel.respondServerRequest({ id: 8, kind: "mcp-elicitation", action: "accept", content: { count: 2 } });

    expect(command.mock.calls).toEqual([
      [1, "acceptForSession"],
      [6, { acceptWithExecpolicyAmendment: { execpolicy_amendment: { command: "npm test" } } }],
      [7, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } }],
    ]);
    expect(file).toHaveBeenCalledWith(2, "decline");
    expect(userInput).toHaveBeenCalledWith(3, { direction: ["Keep it focused"] });
    expect(permissions).toHaveBeenCalledWith(4, { network: { enabled: true } }, "session");
    expect(elicitation.mock.calls).toEqual([
      [5, "accept", { project: "Peel" }],
      [8, "accept", { count: 2 }],
    ]);
    expect((await peel.bootstrap()).pendingRequests).toEqual([]);
  });

  it("validates method-specific payloads and never answers a request with another schema", async () => {
    const peel = await service();
    const command = vi.spyOn(peel.client, "approveCommand").mockImplementation(() => undefined);
    peel.client.emit("serverRequest", request(1, "item/tool/requestUserInput", { threadId: "thread", turnId: "turn", questions: [{ id: "required" }] }));

    expect(() => peel.respondServerRequest({ id: 1, kind: "command", decision: "accept" })).toThrow(/does not match/);
    expect(() => peel.respondServerRequest({ id: 1, kind: "user-input", answers: {} })).toThrow(/Answer every/);
    expect(command).not.toHaveBeenCalled();
    expect((await peel.bootstrap()).pendingRequests).toHaveLength(1);
  });

  it("deduplicates pending requests and cleans them up for external, late, and reconnect resolution", async () => {
    const peel = await service();
    const pendingEvents: AppServerServerRequest[][] = [];
    peel.on("pendingRequests", (pending) => pendingEvents.push(pending));
    const original = request(1, "item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn", command: "one" });
    peel.client.emit("serverRequest", original);
    peel.client.emit("serverRequest", { ...original, params: { ...original.params, command: "replacement" } });
    expect((await peel.bootstrap()).pendingRequests).toHaveLength(1);
    expect((await peel.bootstrap()).pendingRequests[0]?.params).toMatchObject({ command: "replacement" });

    peel.client.emit("notification", { method: "serverRequest/resolved", params: { threadId: "thread", requestId: 1 } });
    peel.client.emit("notification", { method: "serverRequest/resolved", params: { threadId: "thread", requestId: 1 } });
    expect((await peel.bootstrap()).pendingRequests).toEqual([]);

    peel.client.emit("serverRequest", request(2, "item/fileChange/requestApproval", { threadId: "thread", turnId: "turn" }));
    peel.transport.emit("disconnected", new Error("fixture disconnect"));
    expect((await peel.bootstrap()).pendingRequests).toEqual([]);
    expect(pendingEvents.at(-1)).toEqual([]);
  });

  it("keeps Turn errors, Thread warnings, and global diagnostics in separate scopes", async () => {
    const peel = await service();
    peel.client.emit("notification", { method: "error", params: { threadId: "thread", turnId: "turn", error: { message: "Retryable failure" }, willRetry: true } });
    peel.client.emit("notification", { method: "warning", params: { threadId: "thread", message: "Review the generated change" } });
    peel.client.emit("notification", { method: "configWarning", params: { summary: "Configuration needs attention", details: "Update the deprecated key", path: "/private/config.toml" } });

    const notices = (await peel.bootstrap()).notices;
    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", threadId: "thread", turnId: "turn", message: "Retryable failure", willRetry: true }),
      expect.objectContaining({ kind: "warning", threadId: "thread", turnId: null, message: "Review the generated change" }),
      expect.objectContaining({ kind: "warning", threadId: null, turnId: null, message: "Configuration needs attention — Update the deprecated key" }),
    ]));
    expect(JSON.stringify(notices)).not.toContain("/private/config.toml");
  });

  it("refreshes recurring diagnostics and retains only the latest 50 session entries", async () => {
    const peel = await service({ now: () => 1_000 });
    const recurring = { method: "deprecationNotice", params: { summary: "Pagination changed", details: "Use bounded history", path: "/private/config.toml" } };
    peel.client.emit("notification", recurring);
    peel.client.emit("notification", recurring);

    let notices = (await peel.bootstrap()).notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ createdAt: 1_001, message: "Pagination changed — Use bounded history", threadId: null });

    for (let index = 0; index < 50; index += 1) {
      peel.client.emit("notification", { method: "warning", params: { threadId: `thread-${index}`, message: `Warning ${index}` } });
    }
    notices = (await peel.bootstrap()).notices;
    expect(notices).toHaveLength(50);
    expect(notices.some((notice) => notice.message === "Pagination changed — Use bounded history")).toBe(false);
    expect(notices.at(-1)).toMatchObject({ message: "Warning 49", threadId: "thread-49" });
    expect(JSON.stringify(notices)).not.toContain("/private/config.toml");
  });
});
