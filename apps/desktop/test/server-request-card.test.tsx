import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AppServerServerRequest } from "@peel/codex-app-server";
import { requestThreadId, requestTurnId, ServerRequestCard } from "../src/renderer/ServerRequestCard";

const respond = async (): Promise<void> => undefined;

function render(method: string, params: Record<string, unknown>): string {
  return renderToStaticMarkup(<ServerRequestCard request={{ id: method, method, params }} onRespond={respond}/>);
}

describe("ServerRequestCard", () => {
  it("renders method-specific accessible surfaces for all five interactive request routes", () => {
    const command = render("item/commandExecution/requestApproval", { kind: "writeStdin", command: "continue", reason: "Interactive process", proposedExecpolicyAmendment: { command: "continue" }, proposedNetworkPolicyAmendments: [{ host: "example.com" }] });
    expect(command).toContain("Terminal input approval");
    expect(command).toContain("Allow matching commands");
    expect(command).toContain("Apply proposed network rule");
    expect(render("item/fileChange/requestApproval", { reason: "Apply the fix", grantRoot: "/private/root" })).toContain("additional write access");
    expect(render("item/tool/requestUserInput", { questions: [{ id: "choice", question: "Which direction?", isOther: true, isSecret: false, options: [{ label: "Focused", description: "Keep scope narrow" }] }] })).toContain("Which direction?");
    const permissions = render("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { read: ["/secret/read"], write: ["/secret/write"], entries: [{ access: "read", path: { type: "path", path: "/secret/entry-read" } }, { access: "write", path: { type: "path", path: "/secret/entry-write" } }, { access: "deny", path: { type: "path", path: "/secret/entry-deny" } }] } } });
    expect(permissions).toContain("Allow network access");
    expect(permissions).toContain("Read access to 2 additional locations");
    expect(permissions).toContain("Write access to 2 additional locations");
    expect(permissions).toContain("Keep 1 location denied");
    expect(render("mcpServer/elicitation/request", { mode: "form", serverName: "Design MCP", message: "Choose a project", requestedSchema: { type: "object", properties: { project: { type: "string", title: "Project" } }, required: ["project"] } })).toContain("Design MCP request");
    expect(render("mcpServer/elicitation/request", { mode: "openai/form", serverName: "Structured MCP", message: "Provide JSON", requestedSchema: { type: "object" } })).toContain("JSON response");
  });

  it("keeps local paths and unsupported hidden request material out of Transcript markup", () => {
    const permission = render("item/permissions/requestApproval", { permissions: { fileSystem: { read: ["/secret/read"], write: ["/secret/write"], entries: [{ access: "read", path: { type: "path", path: "/secret/entry" } }] } } });
    expect(permission).toContain("additional location");
    expect(permission).not.toContain("/secret/read");
    expect(permission).not.toContain("/secret/write");
    expect(permission).not.toContain("/secret/entry");
    expect(render("item/tool/call", { arguments: { token: "never-render-this" } })).toBe("");
    expect(render("account/chatgptAuthTokens/refresh", { previousAccountId: "never-render-account" })).toBe("");
    expect(render("attestation/generate", { token: "never-render-attestation" })).toBe("");
  });

  it("extracts exact Thread and Turn placement without assigning host requests to the active Chat", () => {
    const scoped: AppServerServerRequest = { id: 1, method: "item/tool/requestUserInput", params: { threadId: "thread-a", turnId: "turn-b" } };
    expect(requestThreadId(scoped)).toBe("thread-a");
    expect(requestTurnId(scoped)).toBe("turn-b");
    expect(requestThreadId({ id: 2, method: "attestation/generate", params: {} })).toBeNull();
    expect(requestTurnId({ id: 2, method: "attestation/generate", params: {} })).toBeNull();
  });
});
