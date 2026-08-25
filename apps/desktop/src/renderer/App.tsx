import type { AppServerServerRequest, CodexThread, ThreadListResponse, UserInput } from "@peel/codex-app-server";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import type { ForkDraft, PeelState, Point, SpaceNode, SpaceRecord, ThreadSnapshot } from "../shared/contracts";
import { emptyState, suggestedChildPosition } from "../shared/state";
import { ForkComposer, Transcript } from "./Transcript";
import { Overview } from "./Overview";
import { Icon } from "./icons";
import { clip, itemText, latestCompletedTurn, relativeTime } from "./lib";

export function App(): ReactNode {
  const [state, setState] = useState<PeelState | null>(null);
  const stateRef = useRef<PeelState>(emptyState());
  const saveTimer = useRef<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadSnapshot>>({});
  const [diffs, setDiffs] = useState<Record<string, WorkspaceDiffSummary>>({});
  const [approvals, setApprovals] = useState<AppServerServerRequest[]>([]);
  const [forkDraft, setForkDraft] = useState<ForkDraft | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const [highlightTurnId, setHighlightTurnId] = useState<string | null>(null);
  const [showThreadPicker, setShowThreadPicker] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const refreshTimers = useRef(new Map<string, number>());
  const refreshPending = useRef(new Set<string>());

  const installState = useCallback((next: PeelState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const persist = useCallback((next: PeelState, delay = 320): void => {
    installState(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void window.peel.saveState(next).catch((error) => setToast(messageOf(error)));
    }, delay);
  }, [installState]);

  const mutate = useCallback((mutator: (draft: PeelState) => void, delay?: number): void => {
    const next = structuredClone(stateRef.current);
    mutator(next);
    persist(next, delay);
  }, [persist]);

  const readThread = useCallback(async (threadId: string): Promise<ThreadSnapshot> => {
    const snapshot = await window.peel.readThread(threadId);
    setThreads((current) => ({ ...current, [threadId]: snapshot }));
    return snapshot;
  }, []);

  useEffect(() => {
    void window.peel.bootstrap().then((bootstrap) => {
      installState(bootstrap.state);
      setConnected(bootstrap.connected);
      setConnectionError(bootstrap.connectionError);
    }).catch((error) => {
      installState(emptyState());
      setConnectionError(messageOf(error));
    });
    const offConnection = window.peel.onConnection((payload) => {
      setConnected(payload.connected);
      setConnectionError(payload.error);
    });
    const offNotification = window.peel.onCodexNotification((notification) => {
      const params = notification.params as Record<string, unknown>;
      const threadId = typeof params.threadId === "string" ? params.threadId : null;
      if (!threadId) return;
      if (notification.method === "thread/name/updated" && typeof params.name === "string") {
        mutate((draft) => {
          for (const space of Object.values(draft.spaces)) {
            const node = space.nodes[threadId];
            if (!node || node.titleOrigin === "manual") continue;
            node.title = params.name as string;
            node.titleOrigin = "automatic";
          }
        }, 0);
      }
      refreshPending.current.add(threadId);
      const scheduleRefresh = (): void => {
        if (refreshTimers.current.has(threadId)) return;
        refreshPending.current.delete(threadId);
        void readThread(threadId).then((snapshot) => {
          const current = stateRef.current;
          if (current.viewMode !== "focus" || current.activeThreadId !== threadId) return;
          const latest = latestCompletedTurn(snapshot.thread);
          if (!latest || !current.activeSpaceId) return;
          mutate((draft) => { const node = draft.spaces[current.activeSpaceId!]?.nodes[threadId]; if (node) node.lastViewedTurnId = latest.id; }, 400);
        }).catch(() => undefined);
        const timer = window.setTimeout(() => {
          refreshTimers.current.delete(threadId);
          if (refreshPending.current.has(threadId)) scheduleRefresh();
        }, 70);
        refreshTimers.current.set(threadId, timer);
      };
      scheduleRefresh();
    });
    const offRequest = window.peel.onServerRequest((request) => {
      setApprovals((current) => [...current.filter((item) => item.id !== request.id), request]);
    });
    const offFlush = window.peel.onFlushRequest(async () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      await window.peel.saveState(stateRef.current);
    });
    return () => { offConnection(); offNotification(); offRequest(); offFlush(); };
  }, [installState, mutate, readThread]);

  const activeSpace = state?.activeSpaceId ? state.spaces[state.activeSpaceId] ?? null : null;
  const activeNode = activeSpace && state?.activeThreadId ? activeSpace.nodes[state.activeThreadId] ?? null : null;
  const activeSnapshot = activeNode ? threads[activeNode.threadId] ?? null : null;

  useEffect(() => {
    if (!connected || !activeNode) return;
    const threadId = activeNode.threadId;
    let cancelled = false;
    let scrollTimer: number | null = null;
    void readThread(threadId).then((snapshot) => {
      if (cancelled || stateRef.current.activeThreadId !== threadId || stateRef.current.viewMode !== "focus") return;
      const latest = latestCompletedTurn(snapshot.thread);
      const currentState = stateRef.current;
      const spaceId = currentState.activeSpaceId;
      const node = spaceId ? currentState.spaces[spaceId]?.nodes[threadId] : null;
      if (latest && node && node.lastViewedTurnId !== latest.id) {
        mutate((draft) => { draft.spaces[spaceId!]!.nodes[threadId]!.lastViewedTurnId = latest.id; }, 500);
      }
      const scroll = stateRef.current.threadViews[threadId]?.scrollTop ?? 0;
      scrollTimer = window.setTimeout(() => {
        if (cancelled || stateRef.current.activeThreadId !== threadId || stateRef.current.viewMode !== "focus") return;
        const element = document.querySelector<HTMLElement>(".transcript");
        if (element) element.scrollTop = scroll;
      }, 0);
    }).catch((error) => setToast(messageOf(error)));
    return () => {
      cancelled = true;
      if (scrollTimer !== null) window.clearTimeout(scrollTimer);
    };
  }, [activeNode?.threadId, connected, mutate, readThread]);

  useEffect(() => {
    if (!connected || !activeNode || diffs[activeNode.threadId]) return;
    void window.peel.getDiff(activeNode.cwd)
      .then(({ summary }) => setDiffs((current) => ({ ...current, [activeNode.threadId]: summary })))
      .catch(() => undefined);
  }, [activeNode?.cwd, activeNode?.threadId, connected, diffs]);

  useEffect(() => {
    if (!connected || state?.viewMode !== "overview" || !activeSpace) return;
    const missing = Object.keys(activeSpace.nodes).filter((id) => !threads[id]);
    void Promise.allSettled(missing.map(readThread));
    for (const node of Object.values(activeSpace.nodes)) {
      if (diffs[node.threadId]) continue;
      void window.peel.getDiff(node.cwd).then(({ summary }) => setDiffs((current) => ({ ...current, [node.threadId]: summary }))).catch(() => undefined);
    }
  }, [activeSpace?.id, connected, readThread, state?.viewMode]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && forkDraft && !forkBusy) setForkDraft(null);
      if ((event.metaKey || event.ctrlKey) && event.key === "1") { event.preventDefault(); mutate((draft) => { draft.viewMode = "focus"; }, 0); }
      if ((event.metaKey || event.ctrlKey) && event.key === "2") { event.preventDefault(); mutate((draft) => { draft.viewMode = "overview"; }, 0); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setShowThreadPicker(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forkBusy, forkDraft, mutate]);

  if (!state) return <div className="launch-screen"><div className="peel-mark">P</div><span>Opening Peel…</span></div>;

  const selectThread = (threadId: string, focusTurnId?: string): void => {
    mutate((draft) => {
      draft.activeThreadId = threadId;
      draft.viewMode = "focus";
    }, 0);
    setHighlightTurnId(focusTurnId ?? null);
    window.setTimeout(() => setHighlightTurnId(null), 1800);
  };

  const beginFork = (turnId: string): void => {
    if (!activeSpace || !activeNode) return;
    flushSync(() => {
      setForkError(null);
      setForkDraft({
        pendingForkId: crypto.randomUUID(),
        parentThreadId: activeNode.threadId,
        forkedAtTurnId: turnId,
        createdAt: performance.now(),
        position: suggestedChildPosition(activeSpace, activeNode.threadId),
        prompt: "",
        createWorktree: false,
      });
    });
  };

  const commitFork = async (): Promise<void> => {
    if (!activeSpace || !forkDraft || forkBusy) return;
    setForkBusy(true);
    setForkError(null);
    try {
      const result = await window.peel.commitFork({
        spaceId: activeSpace.id,
        draft: forkDraft,
        input: [{ type: "text", text: forkDraft.prompt.trim(), text_elements: [] }],
      });
      if (!result.ok) {
        setForkError(result.message);
        if (result.preparedWorktree || result.preparedFork) {
          const preparedWorktree = result.preparedWorktree;
          const preparedFork = result.preparedFork;
          setForkDraft((current) => current ? {
            ...current,
            ...(preparedWorktree ? { preparedWorktree } : {}),
            ...(preparedFork ? { preparedFork } : {}),
          } : current);
        }
        if (result.stage === "turn" && result.childThreadId) {
          const boot = await window.peel.bootstrap();
          installState(boot.state);
          setForkDraft(null);
          setToast("The branch exists. Its first send failed, so your prompt remains in the new draft.");
        }
        return;
      }
      const bootstrap = await window.peel.bootstrap();
      if (result.persistenceWarning) {
        bootstrap.state.threadViews[result.threadId] = {
          draft: "",
          scrollTop: bootstrap.state.threadViews[result.threadId]?.scrollTop ?? 0,
        };
        await window.peel.saveState(bootstrap.state);
      }
      installState(bootstrap.state);
      setForkDraft(null);
      setToast(result.persistenceWarning ? "Fork sent; local state recovered after a temporary save failure" : result.worktreeName ? `Fork created in ${result.worktreeName}` : "Fork created");
      void readThread(result.threadId);
    } catch (error) {
      setForkError(messageOf(error));
    } finally {
      setForkBusy(false);
    }
  };

  const send = async (inputs: UserInput[]): Promise<void> => {
    if (!activeNode) return;
    await window.peel.sendTurn({ threadId: activeNode.threadId, input: inputs, cwd: activeNode.cwd });
    mutate((draft) => { draft.threadViews[activeNode.threadId] = { draft: "", scrollTop: draft.threadViews[activeNode.threadId]?.scrollTop ?? 0 }; }, 0);
  };

  const currentDraft = activeNode ? state.threadViews[activeNode.threadId]?.draft ?? "" : "";
  const renameThread = async (threadId: string, name: string): Promise<void> => {
    if (!activeSpace) return;
    const spaceId = activeSpace.id;
    await window.peel.setThreadName(threadId, name, spaceId);
    mutate((draft) => {
      const node = draft.spaces[spaceId]?.nodes[threadId];
      if (!node) return;
      node.title = name;
      node.titleOrigin = "manual";
    }, 0);
  };
  return <div className={`app ${state.viewMode} ${forkDraft ? "forking" : ""}`}>
    <SpaceSidebar
      state={state}
      onSelect={(space) => {
        mutate((draft) => { draft.activeSpaceId = space.id; draft.activeThreadId = space.rootThreadId; draft.viewMode = "focus"; }, 0);
        setForkDraft(null);
      }}
      onNew={() => setShowThreadPicker(true)}
    />
    <main className="workspace">
      {!activeSpace || !activeNode ? <Welcome connected={connected} error={connectionError} onStart={() => setShowThreadPicker(true)} /> : <>
        <TopBar
          key={activeNode.threadId}
          space={activeSpace}
          node={activeNode}
          mode={state.viewMode}
          connected={connected}
          onMode={(mode) => mutate((draft) => { draft.viewMode = mode; }, 0)}
          onRenameSpace={(name) => mutate((draft) => { const target = draft.spaces[activeSpace.id]; if (target) { target.name = name; target.updatedAt = Date.now(); } }, 0)}
          onArchive={() => mutate((draft) => {
            draft.spaces[activeSpace.id]!.archived = true;
            const next = Object.values(draft.spaces).find((space) => !space.archived && space.id !== activeSpace.id);
            draft.activeSpaceId = next?.id ?? null;
            draft.activeThreadId = next?.rootThreadId ?? null;
          }, 0)}
          onRenameThread={async (name) => await renameThread(activeNode.threadId, name)}
          onDiff={() => setShowDiff(true)}
          onOpenCodex={() => void window.peel.openTarget({ kind: "codex", cwd: activeNode.cwd, threadId: activeNode.threadId })}
        />
        {state.viewMode === "focus" ? <div className="focus-layout">
          <LineageRail space={activeSpace} activeThreadId={activeNode.threadId} threads={threads} onSelect={selectThread} onRename={renameThread}/>
          {activeSnapshot ? <Transcript
            key={activeNode.threadId}
            thread={activeSnapshot.thread}
            reduced={activeSnapshot.reduced}
            node={activeNode}
            diff={diffs[activeNode.threadId] ?? null}
            draft={currentDraft}
            approvals={approvals.filter((request) => (request.params as Record<string, unknown>).threadId === activeNode.threadId)}
            highlightTurnId={highlightTurnId}
            onDraft={(value) => mutate((draft) => {
              const current = draft.threadViews[activeNode.threadId] ?? { draft: "", scrollTop: 0 };
              draft.threadViews[activeNode.threadId] = { ...current, draft: value };
            })}
            onScroll={(scrollTop) => mutate((draft) => {
              const current = draft.threadViews[activeNode.threadId] ?? { draft: "", scrollTop: 0 };
              draft.threadViews[activeNode.threadId] = { ...current, scrollTop };
            }, 600)}
            onSend={send}
            onBranch={(turn) => beginFork(turn.id)}
            onApproval={async (input) => { await window.peel.decideApproval(input); setApprovals((all) => all.filter((item) => item.id !== input.id)); }}
            onDiff={() => setShowDiff(true)}
            onOpenCodex={() => void window.peel.openTarget({ kind: "codex", cwd: activeNode.cwd, threadId: activeNode.threadId })}
          /> : <ThreadLoading/>}
          {forkDraft && <ForkComposer fork={forkDraft} parentTitle={activeNode.title} parentWorktreeName={activeNode.worktreeName} error={forkError} busy={forkBusy} onChange={setForkDraft} onCancel={() => setForkDraft(null)} onCommit={commitFork}/>}
        </div> : <Overview
          space={activeSpace}
          activeThreadId={activeNode.threadId}
          threads={Object.fromEntries(Object.entries(threads).map(([id, snapshot]) => [id, snapshot.thread]))}
          diffs={diffs}
          onCamera={(camera) => mutate((draft) => { draft.spaces[activeSpace.id]!.camera = camera; }, 400)}
          onNodePosition={(threadId, position) => mutate((draft) => { draft.spaces[activeSpace.id]!.nodes[threadId]!.position = position; }, 400)}
          onFocus={selectThread}
          onRename={renameThread}
        />}
      </>}
    </main>
    {showThreadPicker && <ThreadPicker connected={connected} onClose={() => setShowThreadPicker(false)} onStart={async (threadId) => {
      installState(await window.peel.startSpace({ threadId }));
      setShowThreadPicker(false);
      setThreads({});
    }}/>} 
    {showDiff && activeNode && <DiffDrawer node={activeNode} onClose={() => setShowDiff(false)} />}
    {toast && <div className="toast" onAnimationEnd={() => setToast(null)}>{toast}</div>}
  </div>;
}

function SpaceSidebar({ state, onSelect, onNew }: { state: PeelState; onSelect(space: SpaceRecord): void; onNew(): void }): ReactNode {
  const spaces = Object.values(state.spaces).filter((space) => !space.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  return <aside className="space-sidebar">
    <div className="drag-region"/>
    <div className="brand"><span className="peel-mark small">P</span><strong>Peel</strong></div>
    <div className="sidebar-heading"><span>Spaces</span><button onClick={onNew} title="Start from a Codex Chat"><Icon name="plus"/></button></div>
    <nav>{spaces.map((space) => <button key={space.id} className={space.id === state.activeSpaceId ? "selected" : ""} onClick={() => onSelect(space)}><span className="space-glyph"><Icon name="branch" size={14}/></span><span><strong>{space.name}</strong><small>{Object.keys(space.nodes).length} direction{Object.keys(space.nodes).length === 1 ? "" : "s"}</small></span></button>)}</nav>
    <button className="new-space-button" onClick={onNew}><Icon name="plus"/> New Space <kbd>⌘K</kbd></button>
  </aside>;
}

function TopBar({ space, node, mode, connected, onMode, onRenameSpace, onArchive, onRenameThread, onDiff, onOpenCodex }: {
  space: SpaceRecord;
  node: SpaceNode;
  mode: PeelState["viewMode"];
  connected: boolean;
  onMode(mode: PeelState["viewMode"]): void;
  onRenameSpace(name: string): void;
  onArchive(): void;
  onRenameThread(name: string): Promise<void>;
  onDiff(): void;
  onOpenCodex(): void;
}): ReactNode {
  const [editingThread, setEditingThread] = useState(false);
  const [editingSpace, setEditingSpace] = useState(false);
  const [menu, setMenu] = useState(false);
  return <header className="topbar">
    <div className="topbar-title">
      {editingSpace ? <input autoFocus defaultValue={space.name} onBlur={(event) => { if (event.target.value.trim()) onRenameSpace(event.target.value.trim()); setEditingSpace(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}/>
        : <button className="space-name" onDoubleClick={() => setEditingSpace(true)}>{space.name}</button>}
      <span>/</span>
      {editingThread ? <input autoFocus defaultValue={node.title} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== node.title) void onRenameThread(name); setEditingThread(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}/>
        : <button className="thread-name" onDoubleClick={() => setEditingThread(true)}>{node.title}</button>}
      <span className={`connection ${connected ? "online" : ""}`} title={connected ? "Codex connected" : "Codex unavailable"}/>
    </div>
    <div className="segmented"><button className={mode === "focus" ? "active" : ""} onClick={() => onMode("focus")}><Icon name="chat"/> Focus <kbd>⌘1</kbd></button><button className={mode === "overview" ? "active" : ""} onClick={() => onMode("overview")}><Icon name="map"/> Overview <kbd>⌘2</kbd></button></div>
    <div className="topbar-actions">
      <button onClick={onDiff}><Icon name="diff"/> Diff</button>
      <button onClick={onOpenCodex} title="Copy this Thread ID, then open Codex"><Icon name="external"/> Copy ID & open Codex</button>
      <button className="icon-button" onClick={() => setMenu(!menu)}><Icon name="more"/></button>
      {menu && <div className="topbar-menu"><button onClick={() => { setEditingThread(true); setMenu(false); }}>Rename Thread</button><button onClick={() => { setEditingSpace(true); setMenu(false); }}>Rename Space</button><button className="danger" onClick={onArchive}>Archive Space</button></div>}
    </div>
  </header>;
}

function LineageRail({ space, activeThreadId, threads, onSelect, onRename }: {
  space: SpaceRecord;
  activeThreadId: string;
  threads: Record<string, ThreadSnapshot>;
  onSelect(threadId: string, turnId?: string): void;
  onRename(threadId: string, name: string): Promise<void>;
}): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);
  const ordered = useMemo(() => treeOrder(space), [space]);
  const active = space.nodes[activeThreadId]!;
  return <aside className="lineage-rail">
    {active.parentThreadId && <button className="branched-from" onClick={() => onSelect(active.parentThreadId!, active.forkedAtTurnId ?? undefined)}><Icon name="arrowBack"/><span><small>Branched from</small><strong>{space.nodes[active.parentThreadId]?.title}</strong></span></button>}
    <div className="rail-heading">Lineage</div>
    <div className="lineage-tree">{ordered.map(({ node, depth }) => {
      const thread = threads[node.threadId]?.thread;
      const flags = thread?.status.type === "active" ? thread.status.activeFlags : [];
      const running = thread?.status.type === "active";
      const latest = thread ? latestCompletedTurn(thread) : null;
      const newResult = Boolean(latest && node.lastViewedTurnId !== latest.id);
      const failed = thread?.status.type === "systemError" || thread?.turns.at(-1)?.status === "failed";
      if (editing === node.threadId) return <div className="lineage-rename" key={node.threadId} style={{ paddingLeft: 12 + Math.min(depth, 4) * 18 }}><input autoFocus defaultValue={node.title} aria-label={`Rename ${node.title}`} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== node.title) void onRename(node.threadId, name); setEditing(null); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(null); }}/></div>;
      return <button key={node.threadId} className={node.threadId === activeThreadId ? "active" : ""} title={depth > 4 ? `Depth ${depth} · ${node.title}` : node.title} style={{ paddingLeft: 12 + Math.min(depth, 4) * 18 }} onClick={() => onSelect(node.threadId)} onDoubleClick={(event) => { event.preventDefault(); setEditing(node.threadId); }}>
        <span className={`node-dot ${running ? "running" : ""} ${flags.length ? "attention" : ""} ${newResult ? "new-result" : ""} ${failed ? "failed" : ""}`}/>
        <span><strong>{node.title}</strong><small>{relativeTime(thread?.updatedAt ?? node.createdAt)}</small></span>
      </button>;
    })}</div>
    <div className="rail-footnote"><Icon name="branch" size={13}/> One root · real Forks only</div>
  </aside>;
}

function ThreadPicker({ connected, onClose, onStart }: { connected: boolean; onClose(): void; onStart(threadId: string): Promise<void> }): ReactNode {
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<ThreadListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!connected) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      window.peel.searchThreads(term).then(setResult).catch((reason) => setError(messageOf(reason))).finally(() => setLoading(false));
    }, term ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [connected, term]);
  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="thread-picker">
      <div className="picker-header"><div><div className="eyebrow">New Space</div><h2>Start from a Codex Chat</h2></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></div>
      <div className="search-box"><Icon name="search"/><input autoFocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search titles or messages…"/></div>
      {!connected && <div className="picker-state error">Codex is not connected. {" "}<small>The App Server must be available to search real Chats.</small></div>}
      {error && <div className="picker-state error">{error}</div>}
      {loading && <div className="picker-state">Searching real Codex Chats…</div>}
      <div className="thread-results">{result?.data.map((thread) => <button key={thread.id} onClick={() => void onStart(thread.id)}>
        <span className={`result-status ${thread.status.type === "active" ? "active" : ""}`}/>
        <span><strong>{thread.name || clip(thread.preview, 64) || "Untitled Chat"}</strong><small>{clip(thread.preview, 120) || thread.cwd}</small><em>{relativeTime(thread.updatedAt)} · {thread.turns?.length ?? 0} turns</em></span>
        <Icon name="chevron"/>
      </button>)}</div>
      {result && result.data.length === 0 && !loading && <div className="picker-state">No matching Chats.</div>}
      <footer>Selecting a Chat creates one Space Root. Peel won’t move it into or read a Project.</footer>
    </section>
  </div>;
}

function DiffDrawer({ node, onClose }: { node: SpaceNode; onClose(): void }): ReactNode {
  const [value, setValue] = useState<{ summary: WorkspaceDiffSummary; patch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void window.peel.getDiff(node.cwd).then(setValue).catch((reason) => setError(messageOf(reason))); }, [node.cwd]);
  return <div className="drawer-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="diff-drawer">
      <header><div><div className="eyebrow">Workspace changes</div><h2>{node.worktreeName || "Current workspace"}</h2></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></header>
      {error && <div className="drawer-error">{error}</div>}
      {!value && !error && <div className="drawer-loading">Reading Git changes…</div>}
      {value && <>
        <div className="diff-summary"><strong>{value.summary.changedFileCount}</strong> changed files <span className="additions">+{value.summary.additions}</span><span className="deletions">−{value.summary.deletions}</span></div>
        <div className="file-list">{value.summary.files.map((file) => <div key={`${file.previousPath}-${file.path}`}><span className={`file-status ${file.status}`}>{file.status[0]?.toUpperCase()}</span><span>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</span><em><b>+{file.additions ?? "–"}</b> <i>−{file.deletions ?? "–"}</i></em></div>)}</div>
        <pre className="diff-patch">{value.patch || "No textual diff. Binary or metadata-only changes may still be listed above."}</pre>
        <footer><button onClick={() => void window.peel.openTarget({ kind: "worktree", cwd: node.cwd })}><Icon name="folder"/> Open worktree</button><button onClick={() => void window.peel.openTarget({ kind: "codex", cwd: node.cwd, threadId: node.threadId })}><Icon name="external"/> Open in Codex</button><button className="primary-button" onClick={() => void window.peel.openTarget({ kind: "editor", cwd: node.cwd })}>Open in editor</button></footer>
      </>}
    </aside>
  </div>;
}

function Welcome({ connected, error, onStart }: { connected: boolean; error: string | null; onStart(): void }): ReactNode {
  return <div className="welcome"><div className="welcome-art"><span/><span/><span/><i/><i/></div><div className="eyebrow">Spatial work for Codex</div><h1>Keep every good direction<br/>within reach.</h1><p>Start with any existing Codex Chat. Peel turns its real Forks into a space you can understand, return to, and continue.</p><button className="primary-button large" onClick={onStart} disabled={!connected}><Icon name="search"/> Choose a Codex Chat</button>{!connected && <div className="connection-error">Codex is unavailable{error ? ` — ${error}` : ""}</div>}<small>No Project setup. No graph vocabulary required.</small></div>;
}

function ThreadLoading(): ReactNode {
  return <div className="thread-loading"><div/><div/><div/></div>;
}

function treeOrder(space: SpaceRecord): Array<{ node: SpaceNode; depth: number }> {
  const result: Array<{ node: SpaceNode; depth: number }> = [];
  const visit = (threadId: string, depth: number): void => {
    const node = space.nodes[threadId];
    if (!node) return;
    result.push({ node, depth });
    Object.values(space.nodes).filter((candidate) => candidate.parentThreadId === threadId).sort((a, b) => a.createdAt - b.createdAt).forEach((child) => visit(child.threadId, depth + 1));
  };
  visit(space.rootThreadId, 0);
  return result;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
