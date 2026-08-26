import { contextBridge, ipcRenderer } from "electron";
import type { AppServerNotification, AppServerServerRequest, ThreadListResponse } from "@peel/codex-app-server";

import type {
  ApprovalDecisionInput,
  BootstrapPayload,
  CommitForkInput,
  CommitForkResult,
  OpenTargetInput,
  PeelApi,
  PeelState,
  SearchThreadsInput,
  SendTurnInput,
  StartSpaceInput,
  ThreadSnapshot,
  VoiceTranscription,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";

function subscription<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: PeelApi = {
  bootstrap: async () => await ipcRenderer.invoke(IPC.bootstrap) as BootstrapPayload,
  searchThreads: async (input: SearchThreadsInput) => await ipcRenderer.invoke(IPC.searchThreads, input) as ThreadListResponse,
  readThread: async (threadId) => await ipcRenderer.invoke(IPC.readThread, threadId) as ThreadSnapshot,
  startSpace: async (input: StartSpaceInput) => await ipcRenderer.invoke(IPC.startSpace, input) as PeelState,
  saveState: async (state) => await ipcRenderer.invoke(IPC.saveState, state) as PeelState,
  sendTurn: async (input: SendTurnInput) => await ipcRenderer.invoke(IPC.sendTurn, input) as { turnId: string },
  commitFork: async (input: CommitForkInput) => await ipcRenderer.invoke(IPC.commitFork, input) as CommitForkResult,
  setThreadName: async (threadId, name, spaceId) =>
    await ipcRenderer.invoke(IPC.setThreadName, threadId, name, spaceId) as PeelState,
  getWorkspace: async (cwd) => await ipcRenderer.invoke(IPC.getWorkspace, cwd),
  getDiff: async (cwd) => await ipcRenderer.invoke(IPC.getDiff, cwd),
  openTarget: async (input: OpenTargetInput) => { await ipcRenderer.invoke(IPC.openTarget, input); },
  transcribeWav: async (bytes) => await ipcRenderer.invoke(IPC.transcribeWav, bytes) as VoiceTranscription,
  decideApproval: async (input: ApprovalDecisionInput) => { await ipcRenderer.invoke(IPC.decideApproval, input); },
  onCodexNotification: (listener: (payload: AppServerNotification) => void) =>
    subscription(IPC.codexNotification, listener),
  onServerRequest: (listener: (payload: AppServerServerRequest) => void) =>
    subscription(IPC.serverRequest, listener),
  onConnection: (listener) => subscription(IPC.connection, listener),
  onFlushRequest: (listener) => {
    const wrapped = (): void => {
      void listener().finally(() => ipcRenderer.send(IPC.flushComplete));
    };
    ipcRenderer.on(IPC.flushRequest, wrapped);
    return () => ipcRenderer.removeListener(IPC.flushRequest, wrapped);
  },
};

contextBridge.exposeInMainWorld("peel", api);
