import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, session, shell } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ApprovalDecisionInput,
  CommitForkInput,
  DictationAudioInput,
  OpenTargetInput,
  PeelState,
  SearchThreadsInput,
  SendTurnInput,
  StartNewChatInput,
  StartSpaceInput,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";
import { PeelService } from "./peel-service";
import { VoiceService } from "./voice-service";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const configuredUserDataPath = process.env.PEEL_USER_DATA_PATH || argumentValue("--peel-user-data-path");
const configuredCodexBinary = process.env.PEEL_CODEX_BINARY || argumentValue("--peel-codex-binary");
const configuredVoiceHelper = process.env.PEEL_VOICE_HELPER || argumentValue("--peel-voice-helper");
const configuredStateFailureMarker = process.env.PEEL_TEST_STATE_FAILURE_MARKER || argumentValue("--peel-test-state-failure-marker");
const configuredTmpdir = argumentValue("--peel-test-tmpdir");
const quitAfterVoiceVerification = process.argv.includes("--peel-test-quit-after-voice");
if (configuredUserDataPath) app.setPath("userData", configuredUserDataPath);
if (configuredTmpdir) process.env.TMPDIR = configuredTmpdir;
let window: BrowserWindow | null = null;
let service: PeelService | null = null;
let quitting = false;
let allowWindowClose = false;
let flushResolver: (() => void) | null = null;

function appRoot(): string {
  return app.isPackaged ? app.getAppPath() : join(currentDirectory, "../..");
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function rendererUrl(): string {
  const development = process.env.PEEL_RENDERER_URL;
  return development || `file://${join(appRoot(), "dist/renderer/index.html")}`;
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#e9e9e6",
    show: false,
    webPreferences: {
      preload: join(appRoot(), "dist/preload/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    if (allowWindowClose || !window) return;
    event.preventDefault();
    void flushRenderer().finally(() => {
      if (!window) return;
      allowWindowClose = true;
      window.destroy();
      window = null;
      allowWindowClose = false;
    });
  });
  await window.loadURL(rendererUrl());
}

async function flushRenderer(): Promise<void> {
  if (!window || window.isDestroyed()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      flushResolver = null;
      resolve();
    }, 2_000);
    flushResolver = () => {
      clearTimeout(timer);
      flushResolver = null;
      resolve();
    };
    window?.webContents.send(IPC.flushRequest);
  });
}

function registerIpc(peel: PeelService, voice: VoiceService): void {
  ipcMain.on(IPC.flushComplete, () => flushResolver?.());
  ipcMain.handle(IPC.bootstrap, async () => await peel.bootstrap());
  ipcMain.handle(IPC.searchThreads, async (_event, input: SearchThreadsInput) => await peel.searchThreads(input));
  ipcMain.handle(IPC.readThread, async (_event, threadId: string) => await peel.readThread(threadId));
  ipcMain.handle(IPC.startNewChat, async (_event, input: StartNewChatInput) => await peel.startNewChat(input));
  ipcMain.handle(IPC.startSpace, async (_event, input: StartSpaceInput) => await peel.startSpace(input));
  ipcMain.handle(IPC.saveState, async (_event, state: PeelState) => await peel.saveState(state));
  ipcMain.handle(IPC.sendTurn, async (_event, input: SendTurnInput) => await peel.sendTurn(input));
  ipcMain.handle(IPC.commitFork, async (_event, input: CommitForkInput) => await peel.commitFork(input));
  ipcMain.handle(IPC.setThreadName, async (_event, threadId: string, name: string, spaceId: string) =>
    await peel.setThreadName(threadId, name, spaceId));
  ipcMain.handle(IPC.getWorkspace, async (_event, cwd: string) => await peel.git.inspect(cwd));
  ipcMain.handle(IPC.getDiff, async (_event, cwd: string) => ({
    summary: await peel.git.getDiffSummary(cwd),
    patch: await peel.git.getDiff(cwd),
  }));
  ipcMain.handle(IPC.transcribeWav, async (_event, bytes: ArrayBuffer) => {
    const result = await voice.transcribe(new Uint8Array(bytes));
    if (quitAfterVoiceVerification) setTimeout(() => app.quit(), 1_500);
    return result;
  });
  ipcMain.handle(IPC.decideApproval, (_event, input: ApprovalDecisionInput) => peel.decideApproval(input));
  ipcMain.handle(IPC.copyText, (_event, text: string) => { clipboard.writeText(text); });
  ipcMain.handle(IPC.beginDictation, async (_event, threadId: string) => await peel.dictation.begin(threadId));
  ipcMain.handle(IPC.appendDictationAudio, async (_event, input: DictationAudioInput) => await peel.dictation.append(input));
  ipcMain.handle(IPC.finishDictation, async (_event, threadId: string) => await peel.dictation.finish(threadId));
  ipcMain.handle(IPC.cancelDictation, async (_event, threadId: string) => await peel.dictation.cancel(threadId));
  ipcMain.handle(IPC.openTarget, async (_event, input: OpenTargetInput) => {
    if (input.kind === "codex") {
      if (input.threadId) clipboard.writeText(input.threadId);
      await shell.openExternal("https://chatgpt.com/codex");
      return;
    }
    if (input.path && existsSync(input.path)) {
      await shell.openPath(input.path);
      return;
    }
    await shell.openPath(input.cwd);
  });
  peel.on("notification", (payload) => window?.webContents.send(IPC.codexNotification, payload));
  peel.on("serverRequest", (payload) => window?.webContents.send(IPC.serverRequest, payload));
  peel.on("connection", (payload) => window?.webContents.send(IPC.connection, payload));
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  service = new PeelService(configuredUserDataPath || app.getPath("userData"), {
    ...(configuredCodexBinary ? { codexBinary: configuredCodexBinary } : {}),
    ...(configuredStateFailureMarker ? { stateFailureMarker: configuredStateFailureMarker } : {}),
  });
  const voiceHelperPath = configuredVoiceHelper || (app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked/native/bin/peel-speech")
    : join(appRoot(), "native/bin/peel-speech"));
  const voice = new VoiceService(voiceHelperPath);
  registerIpc(service, voice);
  await createWindow();
  void service.connect();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  void flushRenderer()
    .finally(() => service?.shutdown())
    .finally(() => {
      allowWindowClose = true;
      window?.destroy();
      window = null;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
