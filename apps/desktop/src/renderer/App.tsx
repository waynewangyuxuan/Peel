import type { AppServerServerRequest, ThreadListResponse, UserInput } from "@peel/codex-app-server";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { THREAD_SEARCH_CACHE_TTL_MS, type ForkDraft, type PeelState, type Point, type SpaceNode, type SpaceRecord, type ThreadSnapshot } from "../shared/contracts";
import { emptyState, suggestedChildPosition } from "../shared/state";
import { ForkComposer, Transcript } from "./Transcript";
import { Overview } from "./Overview";
import { Icon } from "./icons";
import { clip, itemText, latestCompletedTurn, relativeTime } from "./lib";
import { mergeThreadPage, threadMatches } from "./thread-search";

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
  const [highlightTarget, setHighlightTarget] = useState<{ threadId: string; turnId: string } | null>(null);
  const [showThreadPicker, setShowThreadPicker] = useState(false);
  const [newChatBusy, setNewChatBusy] = useState(false);
  const [diffThreadId, setDiffThreadId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const refreshTimers = useRef(new Map<string, number>());
  const refreshPending = useRef(new Set<string>());
  const highlightTimer = useRef<number | null>(null);

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
    return () => {
      offConnection();
      offNotification();
      offRequest();
      offFlush();
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    };
  }, [installState, mutate, readThread]);

  const activeSpace = state?.activeSpaceId ? state.spaces[state.activeSpaceId] ?? null : null;
  const activeNode = activeSpace && state?.activeThreadId ? activeSpace.nodes[state.activeThreadId] ?? null : null;
  const activeSnapshot = activeNode ? threads[activeNode.threadId] ?? null : null;

  const startNewChat = useCallback(async (): Promise<void> => {
    if (!connected || newChatBusy) return;
    setNewChatBusy(true);
    setShowThreadPicker(false);
    try {
      installState(await window.peel.startNewChat(activeNode?.cwd ? { cwd: activeNode.cwd } : {}));
      setThreads({});
      setForkDraft(null);
    } catch (error) {
      setToast(userFacingError(error, "The new Chat could not be created. Try again."));
    } finally {
      setNewChatBusy(false);
    }
  }, [activeNode?.cwd, connected, installState, newChatBusy]);

  useEffect(() => {
    if (!connected || !activeNode) return;
    const threadId = activeNode.threadId;
    let cancelled = false;
    void readThread(threadId).then((snapshot) => {
      if (cancelled || stateRef.current.activeThreadId !== threadId || stateRef.current.viewMode !== "focus") return;
      const latest = latestCompletedTurn(snapshot.thread);
      const currentState = stateRef.current;
      const spaceId = currentState.activeSpaceId;
      const node = spaceId ? currentState.spaces[spaceId]?.nodes[threadId] : null;
      if (latest && node && node.lastViewedTurnId !== latest.id) {
        mutate((draft) => { draft.spaces[spaceId!]!.nodes[threadId]!.lastViewedTurnId = latest.id; }, 500);
      }
    }).catch((error) => setToast(messageOf(error)));
    return () => { cancelled = true; };
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); void startNewChat(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setShowThreadPicker(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forkBusy, forkDraft, mutate, startNewChat]);

  if (!state) return <div className="launch-screen"><div className="peel-mark">P</div><span>Opening Peel…</span></div>;

  const selectThread = (threadId: string, focusTurnId?: string): void => {
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
      highlightTimer.current = null;
    }
    mutate((draft) => {
      draft.activeThreadId = threadId;
      draft.viewMode = "focus";
    }, 0);
    setHighlightTarget(focusTurnId ? { threadId, turnId: focusTurnId } : null);
  };

  const acknowledgeHighlightScroll = (threadId: string, turnId: string): void => {
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => {
      highlightTimer.current = null;
      setHighlightTarget((current) => current?.threadId === threadId && current.turnId === turnId ? null : current);
    }, 1800);
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
      connected={connected}
      onSelect={(space) => {
        mutate((draft) => { draft.activeSpaceId = space.id; draft.activeThreadId = space.rootThreadId; draft.viewMode = "focus"; }, 0);
        setForkDraft(null);
      }}
      newChatBusy={newChatBusy}
      onNewChat={() => void startNewChat()}
      onSearch={() => setShowThreadPicker(true)}
    />
    <main className="workspace">
      {!activeSpace || !activeNode ? <Welcome connected={connected} error={connectionError} newChatBusy={newChatBusy} onNewChat={() => void startNewChat()} onSearch={() => setShowThreadPicker(true)} /> : <>
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
          onDiff={() => setDiffThreadId(activeNode.threadId)}
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
            highlightTurnId={highlightTarget?.threadId === activeNode.threadId ? highlightTarget.turnId : null}
            restoreScrollTop={state.threadViews[activeNode.threadId]?.scrollTop ?? 0}
            onHighlightScrolled={(turnId) => acknowledgeHighlightScroll(activeNode.threadId, turnId)}
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
            onDiff={() => setDiffThreadId(activeNode.threadId)}
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
          onDiff={setDiffThreadId}
        />}
      </>}
    </main>
    {showThreadPicker && <ThreadPicker connected={connected} onClose={() => setShowThreadPicker(false)} onStart={async (threadId) => {
      installState(await window.peel.startSpace({ threadId }));
      setShowThreadPicker(false);
      setThreads({});
    }}/>} 
    {diffThreadId && activeSpace?.nodes[diffThreadId] && <DiffDrawer node={activeSpace.nodes[diffThreadId]} onClose={() => setDiffThreadId(null)} />}
    {toast && <div className="toast" onAnimationEnd={() => setToast(null)}>{toast}</div>}
  </div>;
}

function SpaceSidebar({ state, connected, newChatBusy, onSelect, onNewChat, onSearch }: {
  state: PeelState;
  connected: boolean;
  newChatBusy: boolean;
  onSelect(space: SpaceRecord): void;
  onNewChat(): void;
  onSearch(): void;
}): ReactNode {
  const spaces = Object.values(state.spaces).filter((space) => !space.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  return <aside className="space-sidebar">
    <div className="drag-region"/>
    <div className="brand"><span className="peel-mark small">P</span><strong>Peel</strong></div>
    <div className="sidebar-heading"><span>Spaces</span><div className="sidebar-entry-actions">
      <button onClick={onSearch} disabled={!connected} title="Search existing Codex Chats (⌘K)" aria-label="Search Chats"><Icon name="search"/></button>
      <button className="new-chat-trigger" onClick={onNewChat} disabled={!connected || newChatBusy} title="New Chat (⌘N)" aria-label="New Chat"><Icon name={newChatBusy ? "spinner" : "plus"}/></button>
    </div></div>
    <nav>{spaces.map((space) => {
      const directionCount = Object.keys(space.nodes).length;
      return <button
        key={space.id}
        className={space.id === state.activeSpaceId ? "selected" : ""}
        onClick={() => onSelect(space)}
        title={space.name}
        aria-label={`${space.name}, ${directionCount} direction${directionCount === 1 ? "" : "s"}`}
      >
        <span className="space-glyph"><Icon name="branch" size={14}/></span>
        <span className="space-copy"><strong>{space.name}</strong><small>{directionCount} direction{directionCount === 1 ? "" : "s"}</small></span>
      </button>;
    })}</nav>
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
        : <button className="space-name title-disclosure" title={space.name} data-full-title={space.name} aria-label={`Current Space: ${space.name}. Double-click to rename.`} onDoubleClick={() => setEditingSpace(true)}><span>{space.name}</span></button>}
      <span>/</span>
      {editingThread ? <input autoFocus defaultValue={node.title} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== node.title) void onRenameThread(name); setEditingThread(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}/>
        : <button className="thread-name title-disclosure" title={node.title} data-full-title={node.title} aria-label={`Current Thread: ${node.title}. Double-click to rename.`} onDoubleClick={() => setEditingThread(true)}><span>{node.title}</span></button>}
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
  const [phase, setPhase] = useState<"initial" | "search" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const activeTerm = useRef("");
  const recentPage = useRef<ThreadListResponse | null>(null);
  const completedQueries = useRef(new Map<string, { expiresAt: number; response: ThreadListResponse }>());
  const normalizedTerm = term.trim();
  activeTerm.current = normalizedTerm;

  useEffect(() => {
    if (!connected) return;
    const requestVersion = ++version.current;
    const query = normalizedTerm;
    const cachedQuery = completedQueries.current.get(query.toLocaleLowerCase());
    const cached = cachedQuery && cachedQuery.expiresAt > Date.now() ? cachedQuery.response : null;
    const provisional = query && recentPage.current
      ? { data: recentPage.current.data.filter((thread) => threadMatches(thread, query)), nextCursor: null, backwardsCursor: null }
      : null;
    const immediate = cached ?? (query ? provisional : recentPage.current);
    if (immediate) setResult(immediate);
    setError(null);
    const timer = window.setTimeout(() => {
      setPhase(immediate ? "search" : "initial");
      window.peel.searchThreads({ term: query, cursor: null }).then((response) => {
        if (version.current !== requestVersion || activeTerm.current !== query) return;
        if (!query) recentPage.current = response;
        completedQueries.current.set(query.toLocaleLowerCase(), {
          expiresAt: Date.now() + THREAD_SEARCH_CACHE_TTL_MS,
          response,
        });
        setResult(response);
      }).catch((reason) => {
        if (version.current === requestVersion) setError(messageOf(reason));
      }).finally(() => {
        if (version.current === requestVersion) setPhase(null);
      });
    }, query ? 120 : 0);
    return () => {
      window.clearTimeout(timer);
      if (version.current === requestVersion) version.current += 1;
    };
  }, [connected, normalizedTerm]);

  const loadMore = async (): Promise<void> => {
    const cursor = result?.nextCursor;
    if (!cursor || phase) return;
    const requestVersion = version.current;
    const query = normalizedTerm;
    setPhase("more");
    setError(null);
    try {
      const page = await window.peel.searchThreads({ term: query, cursor });
      if (version.current !== requestVersion || activeTerm.current !== query) return;
      setResult((current) => current ? mergeThreadPage(current, page) : page);
    } catch (reason) {
      if (version.current === requestVersion) setError(messageOf(reason));
    } finally {
      if (version.current === requestVersion) setPhase(null);
    }
  };

  const loaded = result?.data.length ?? 0;
  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="thread-picker">
      <div className="picker-header"><div><div className="eyebrow">Existing Codex Chat</div><h2>Search Chats</h2></div><button className="icon-button" aria-label="Close Chat picker" onClick={onClose}><Icon name="close"/></button></div>
      <div className="search-box"><Icon name="search"/><input aria-label="Search Codex Chats" autoFocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search titles or messages…"/></div>
      {!connected && <div className="picker-state error">Codex is not connected. {" "}<small>The App Server must be available to search real Chats.</small></div>}
      <div className="thread-results" aria-busy={phase !== null}>{result?.data.map((thread) => <button className="thread-result" key={thread.id} onClick={() => void onStart(thread.id)}>
        <span className={`result-status ${thread.status.type === "active" ? "active" : ""}`}/>
        <span><strong>{thread.name || clip(thread.preview, 64) || "Untitled Chat"}</strong><small>{clip(thread.preview, 120) || thread.cwd}</small><em>{relativeTime(thread.updatedAt)} · {thread.turns?.length ?? 0} turns</em></span>
        <Icon name="chevron"/>
      </button>)}
        {phase === "initial" && loaded === 0 && <div className="picker-results-state" role="status"><span className="mini-spinner"/>Loading recent Codex Chats…</div>}
        {phase === "search" && <div className="picker-results-state subtle" role="status"><span className="mini-spinner"/>Searching all Codex Chats…</div>}
        {phase === "more" && <div className="picker-results-state subtle" role="status"><span className="mini-spinner"/>Loading more Chats…</div>}
        {error && <div className="picker-results-state error" role="alert">{error}<small>Your current results are still available. Try again.</small></div>}
        {result && loaded === 0 && phase === null && !error && <div className="picker-results-state">No matching Chats.</div>}
        {result && loaded > 0 && <div className="picker-pagination" aria-live="polite">
          <span>{loaded} Chat{loaded === 1 ? "" : "s"} loaded</span>
          {result.nextCursor
            ? <button className="load-more" disabled={phase !== null} onClick={() => void loadMore()}>{phase === "more" ? "Loading…" : "Load more"}</button>
            : <span>{phase === "search" ? "Checking full history" : error ? "Results may be incomplete" : "End of results"}</span>}
        </div>}
      </div>
      <footer>Opening a Chat creates its own one-root Space. Peel won’t move it into or read a Project.</footer>
    </section>
  </div>;
}

function DiffDrawer({ node, onClose }: { node: SpaceNode; onClose(): void }): ReactNode {
  const [value, setValue] = useState<{ summary: WorkspaceDiffSummary; patch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void window.peel.getDiff(node.cwd).then(setValue).catch((reason) => setError(messageOf(reason))); }, [node.cwd]);
  return <div className="drawer-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="diff-drawer">
      <header><div><div className="eyebrow">Workspace changes</div><h2>{node.worktreeName || "Current workspace"}</h2></div><button className="icon-button" aria-label="Close Diff" onClick={onClose}><Icon name="close"/></button></header>
      {error && <div className="drawer-error">{error}</div>}
      {!value && !error && <div className="drawer-loading">Reading Git changes…</div>}
      {value && <>
        <div className="diff-summary"><span><strong>{value.summary.changedFileCount}</strong> changed files <span className="additions">+{value.summary.additions}</span><span className="deletions">−{value.summary.deletions}</span></span><small>Compared with <b>{value.summary.baseBranch}</b></small></div>
        <div className="file-list">{value.summary.files.map((file) => <div key={`${file.previousPath}-${file.path}`}><span className={`file-status ${file.status}`}>{file.status[0]?.toUpperCase()}</span><span>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</span><em><b>+{file.additions ?? "–"}</b> <i>−{file.deletions ?? "–"}</i></em></div>)}</div>
        <pre className="diff-patch">{value.patch || "No textual diff. Binary or metadata-only changes may still be listed above."}</pre>
        <footer><button onClick={() => void window.peel.openTarget({ kind: "worktree", cwd: node.cwd })}><Icon name="folder"/> Open worktree</button><button onClick={() => void window.peel.openTarget({ kind: "codex", cwd: node.cwd, threadId: node.threadId })}><Icon name="external"/> Open in Codex</button><button className="primary-button" onClick={() => void window.peel.openTarget({ kind: "editor", cwd: node.cwd })}>Open in editor</button></footer>
      </>}
    </aside>
  </div>;
}

function Welcome({ connected, error, newChatBusy, onNewChat, onSearch }: {
  connected: boolean;
  error: string | null;
  newChatBusy: boolean;
  onNewChat(): void;
  onSearch(): void;
}): ReactNode {
  return <div className="welcome"><div className="welcome-art"><span/><span/><span/><i/><i/></div><div className="eyebrow">Spatial work for Codex</div><h1>Keep every good direction<br/>within reach.</h1><p>Begin with a fresh Codex Chat now, or find one you already started. Every real Fork stays visible and easy to return to.</p><div className="welcome-actions"><button className="primary-button large" onClick={onNewChat} disabled={!connected || newChatBusy}><Icon name={newChatBusy ? "spinner" : "plus"}/> {newChatBusy ? "Creating…" : "New Chat"}</button><button className="secondary-button large" onClick={onSearch} disabled={!connected}><Icon name="search"/> Search Chats</button></div>{!connected && <div className="connection-error">Codex is unavailable{error ? ` — ${error}` : ""}</div>}<small>⌘N creates immediately · ⌘K searches existing Chats</small></div>;
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

function userFacingError(error: unknown, fallback: string): string {
  return messageOf(error)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || fallback;
}
