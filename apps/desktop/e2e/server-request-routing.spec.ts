import { _electron as electron, expect, test } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");

test("routes every stable server request and keeps failures in the producing conversation", async ({}, testInfo) => {
  const scratch = await mkdtemp(join(tmpdir(), "peel-request-routing-"));
  const userData = join(scratch, "data");
  const rpcLog = join(scratch, "peel-mock-rpc.jsonl");
  await mkdir(userData);
  await chmod(codexMock, 0o755);
  const app = await electron.launch({
    args: [desktop],
    env: {
      ...process.env,
      PEEL_RENDERER_URL: "",
      PEEL_USER_DATA_PATH: userData,
      PEEL_CODEX_BINARY: codexMock,
      TMPDIR: scratch,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  try {
    const page = await app.firstWindow();
    const search = page.locator(".space-sidebar").getByRole("button", { name: "Search Chats", exact: true });
    await expect(search).toBeEnabled();
    await search.click();
    await page.locator(".thread-result").first().click();
    await page.getByLabel("Message").fill("Exercise every server request route");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const turn = page.locator('[data-turn-id="turn-4"]');
    await expect(turn.locator(".request-card")).toHaveCount(8);
    await expect(page.locator(".transcript > .request-card")).toHaveCount(0);
    await expect(turn).toContainText("npm test --replacement");
    await expect(turn).not.toContainText("never-render");
    await expect(turn.locator(".codex-notice.error")).toContainText("The service briefly failed");
    await expect(turn.locator(".codex-notice.error")).toContainText("Codex will retry this Turn");
    await expect(page.locator(".transcript > .codex-notice.warning")).toContainText("Review the permissions before continuing");
    await expect(page.locator(".host-diagnostics")).toContainText("Codex configuration notice");
    await expect(page.locator(".host-diagnostics")).not.toContainText("/private/fixture/config.toml");

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1000, 720));
    await expect.poll(async () => await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual({ width: 1000, height: 720 });
    expect(await turn.locator(".request-card").evaluateAll((cards) => {
      const transcript = document.querySelector(".transcript")!.getBoundingClientRect();
      return cards.every((card) => {
        const bounds = card.getBoundingClientRect();
        return bounds.left >= transcript.left - .5 && bounds.right <= transcript.right + .5;
      }) && document.documentElement.scrollWidth === document.documentElement.clientWidth;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("method-specific-request-cards.png") });

    await turn.locator(".request-command-approval").filter({ hasText: "npm test --replacement" }).getByRole("button", { name: "Allow once" }).click();
    await turn.locator(".request-command-approval").filter({ hasText: "npm run focused" }).getByRole("button", { name: "Allow matching commands" }).click();
    await turn.locator(".request-command-approval").filter({ hasText: "curl https://example.com" }).getByRole("button", { name: "Apply proposed network rule" }).click();
    await turn.locator(".request-file-change-approval").filter({ hasText: "Apply reviewed patch" }).getByRole("button", { name: "Decline" }).click();
    await turn.locator(".request-user-input").getByText("Focused", { exact: true }).click();
    await turn.locator(".request-user-input").getByRole("button", { name: "Submit answers" }).click();
    await turn.locator(".request-permissions").getByRole("button", { name: "Allow for session" }).click();
    await turn.locator(".request-mcp-elicitation").getByLabel("Project *").fill("Peel");
    await turn.locator(".request-mcp-elicitation").getByRole("button", { name: "Submit", exact: true }).click();
    await expect(turn.locator(".request-card")).toHaveCount(1);
    await expect(turn.locator(".request-card")).toContainText("Externally resolved request");
    await expect(turn.locator(".request-card")).toHaveCount(0, { timeout: 7_000 });

    await expect(turn.locator(".persisted-turn-error")).toContainText("Persistent fixture Turn failure", { timeout: 7_000 });
    await page.screenshot({ path: testInfo.outputPath("turn-failure-and-warning-routing.png") });

    await expect.poll(async () => responseMap(rpcLog)).toMatchObject({
      "401": { result: { decision: "accept" } },
      "402": { result: { decision: "decline" } },
      "403": { result: { answers: { direction: { answers: ["Focused"] } } } },
      "404": { result: { permissions: { network: { enabled: true } }, scope: "session" } },
      "405": { result: { action: "accept", content: { project: "Peel" }, _meta: null } },
      "407": { error: { code: -32601, data: { kind: "unsupported_host_capability", method: "item/tool/call" } } },
      "408": { error: { code: -32601, data: { kind: "unsupported_host_capability", method: "account/chatgptAuthTokens/refresh" } } },
      "409": { error: { code: -32601, data: { kind: "unsupported_host_capability", method: "attestation/generate" } } },
      "410": { error: { code: -32601, data: { kind: "unsupported_host_capability", method: "applyPatchApproval" } } },
      "411": { error: { code: -32601, data: { kind: "unsupported_host_capability", method: "execCommandApproval" } } },
      "412": { result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: { command: "npm run focused" } } } } },
      "413": { result: { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } } } },
    });
  } finally {
    await app.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

async function responseMap(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, "utf8").catch(() => "");
  const entries = source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: { id?: number | string } });
  return Object.fromEntries(entries
    .filter((entry) => entry.method === "fixture/server-response" && entry.params?.id !== undefined)
    .map((entry) => [String(entry.params!.id), entry.params]));
}
