import type { CodexThread } from "@peel/codex-app-server";
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";

import type { CameraState, Point, SpaceNode, SpaceRecord } from "../shared/contracts";
import { clip, itemText, latestCompletedTurn, plainTextPreview, relativeTime } from "./lib";

const CARD_WIDTH = 294;
const CARD_HEIGHT = 205;
const MIN_SCALE = .08;

interface OverviewProps {
  space: SpaceRecord;
  activeThreadId: string | null;
  threads: Record<string, CodexThread>;
  diffs: Record<string, WorkspaceDiffSummary>;
  onCamera(camera: CameraState): void;
  onNodePosition(threadId: string, position: Point): void;
  onFocus(threadId: string, turnId?: string): void;
  onRename(threadId: string, name: string): Promise<void>;
  onDiff(threadId: string): void;
}

export function Overview({ space, activeThreadId, threads, diffs, onCamera, onNodePosition, onFocus, onRename, onDiff }: OverviewProps): ReactNode {
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointerId: number; origin: Point; camera: CameraState } | null>(null);
  const drag = useRef<{ pointerId: number; threadId: string; origin: Point; position: Point; moved: boolean } | null>(null);
  const initializedSpace = useRef<string | null>(null);
  const suppressOpen = useRef(false);
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const nodes = Object.values(space.nodes);
  const bounds = graphBounds(nodes);
  const emphasizedPath = useMemo(() => pathToRoot(space, hoveredThreadId ?? activeThreadId), [activeThreadId, hoveredThreadId, space]);
  const untouchedInitialCamera = space.camera.x === 0
    && space.camera.y === 0
    && space.camera.scale === .86
    && space.nodes[space.rootThreadId]?.position.x === 0
    && space.nodes[space.rootThreadId]?.position.y === 0;

  useLayoutEffect(() => {
    if (!untouchedInitialCamera || initializedSpace.current === space.id) return;
    initializedSpace.current = space.id;
    const frame = requestAnimationFrame(() => onCamera(fitCamera(nodes, viewport.current)));
    return () => cancelAnimationFrame(frame);
  }, [nodes.length, onCamera, space.id, untouchedInitialCamera]);

  const beginPan = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".overview-card")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, camera: space.camera };
  };
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    if (pan.current?.pointerId === event.pointerId) {
      onCamera({
        ...pan.current.camera,
        x: pan.current.camera.x + event.clientX - pan.current.origin.x,
        y: pan.current.camera.y + event.clientY - pan.current.origin.y,
      });
    }
    if (drag.current?.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - drag.current.origin.x, event.clientY - drag.current.origin.y) > 4) drag.current.moved = true;
      onNodePosition(drag.current.threadId, {
        x: drag.current.position.x + (event.clientX - drag.current.origin.x) / space.camera.scale,
        y: drag.current.position.y + (event.clientY - drag.current.origin.y) / space.camera.scale,
      });
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (pan.current?.pointerId === event.pointerId) pan.current = null;
    if (drag.current?.pointerId === event.pointerId) {
      suppressOpen.current = drag.current.moved;
      drag.current = null;
      setDraggingThreadId(null);
      if (suppressOpen.current) requestAnimationFrame(() => { suppressOpen.current = false; });
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const wheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const oldScale = space.camera.scale;
    const nextScale = Math.max(MIN_SCALE, Math.min(1.45, oldScale * Math.exp(-event.deltaY * 0.0012)));
    const worldX = (pointer.x - space.camera.x) / oldScale;
    const worldY = (pointer.y - space.camera.y) / oldScale;
    onCamera({
      scale: nextScale,
      x: pointer.x - worldX * nextScale,
      y: pointer.y - worldY * nextScale,
    });
  };

  const beginNode = (event: PointerEvent<HTMLElement>, node: SpaceNode): void => {
    if ((event.target as HTMLElement).closest("button, input, h3")) return;
    event.stopPropagation();
    viewport.current?.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      threadId: node.threadId,
      origin: { x: event.clientX, y: event.clientY },
      position: node.position,
      moved: false,
    };
    setDraggingThreadId(node.threadId);
  };

  return <div className="overview-shell">
    <div className="overview-toolbar">
      <div className="overview-identity"><strong>{space.name}</strong><span>{nodes.length} direction{nodes.length === 1 ? "" : "s"} · deterministic Thread context</span></div>
      <div className="zoom-controls">
        <button aria-label="Zoom out" title="Zoom out" onClick={() => onCamera({ ...space.camera, scale: Math.max(MIN_SCALE, space.camera.scale - .1) })}>−</button>
        <span aria-label={`Zoom ${Math.round(space.camera.scale * 100)} percent`}>{Math.round(space.camera.scale * 100)}%</span>
        <button aria-label="Zoom in" title="Zoom in" onClick={() => onCamera({ ...space.camera, scale: Math.min(1.45, space.camera.scale + .1) })}>+</button>
        <button className="fit-button" aria-label="Fit" title="Fit Overview" onClick={() => onCamera(fitCamera(nodes, viewport.current))}>Fit</button>
      </div>
    </div>
    <div
      className="overview-viewport"
      ref={viewport}
      onPointerDown={beginPan}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onWheel={wheel}
    >
      <div className="overview-world" style={{ transform: `translate3d(${space.camera.x}px, ${space.camera.y}px, 0) scale(${space.camera.scale})` }}>
        <svg className="overview-edges" style={{ left: bounds.minX, top: bounds.minY }} width={bounds.width} height={bounds.height} viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}>
          {nodes.filter((node) => node.parentThreadId && space.nodes[node.parentThreadId]).map((node) => {
            const parent = space.nodes[node.parentThreadId!]!;
            const x1 = parent.position.x + CARD_WIDTH;
            const y1 = parent.position.y + CARD_HEIGHT / 2;
            const x2 = node.position.x;
            const y2 = node.position.y + CARD_HEIGHT / 2;
            const bend = Math.max(50, (x2 - x1) / 2);
            return <path className={emphasizedPath.has(node.threadId) ? "active" : ""} key={node.threadId} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />;
          })}
        </svg>
        {nodes.map((node) => <OverviewCard
          key={node.threadId}
          node={node}
          parent={node.parentThreadId ? space.nodes[node.parentThreadId] ?? null : null}
          thread={threads[node.threadId] ?? null}
          parentThread={node.parentThreadId ? threads[node.parentThreadId] ?? null : null}
          diff={diffs[node.threadId] ?? null}
          active={node.threadId === activeThreadId}
          dragging={node.threadId === draggingThreadId}
          onPointerDown={(event) => beginNode(event, node)}
          onOpen={() => { if (!suppressOpen.current) onFocus(node.threadId); }}
          onFocusTurn={(turnId) => onFocus(node.threadId, turnId)}
          onFocusParent={(threadId, turnId) => onFocus(threadId, turnId)}
          onRename={onRename}
          onDiff={() => onDiff(node.threadId)}
          onHover={(hovered) => setHoveredThreadId(hovered ? node.threadId : null)}
        />)}
      </div>
      <div className="overview-hint">Drag cards to build spatial memory · double-click a title to rename · click a card to focus</div>
    </div>
  </div>;
}

function OverviewCard({ node, parent, thread, parentThread, diff, active, dragging, onPointerDown, onOpen, onFocusTurn, onFocusParent, onRename, onDiff, onHover }: {
  node: SpaceNode;
  parent: SpaceNode | null;
  thread: CodexThread | null;
  parentThread: CodexThread | null;
  diff: WorkspaceDiffSummary | null;
  active: boolean;
  dragging: boolean;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onOpen(): void;
  onFocusTurn(turnId?: string): void;
  onFocusParent(threadId: string, turnId?: string): void;
  onRename(threadId: string, name: string): Promise<void>;
  onDiff(): void;
  onHover(hovered: boolean): void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const latestTurn = thread ? latestCompletedTurn(thread) : null;
  const isRunning = thread?.status.type === "active";
  const flags = thread?.status.type === "active" ? thread.status.activeFlags : [];
  const needsApproval = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput");
  const newResult = Boolean(latestTurn && node.lastViewedTurnId !== latestTurn.id);
  const failed = thread?.status.type === "systemError" || thread?.turns.at(-1)?.status === "failed";
  const subagents = thread?.turns.flatMap((turn) => turn.items).filter((item) => item.type === "collabAgentToolCall" || item.type === "subAgentActivity") ?? [];
  const subagentCount = subagents.length;
  const subagentRunning = subagents.some((item) => ["running", "inProgress", "active"].includes(String(item.status ?? "")));
  const forkTurn = parentThread?.turns.find((turn) => turn.id === node.forkedAtTurnId);
  const forkSnippet = plainTextPreview(forkTurn?.items.map(itemText).filter(Boolean).at(-1) ?? "");
  const latestUserTurn = thread ? [...thread.turns].reverse().find((turn) => turn.items.some((item) => item.type === "userMessage")) : undefined;
  const latestResultTurn = thread ? [...thread.turns].reverse().find((turn) => turn.status === "completed" && turn.items.some((item) => item.type === "agentMessage")) : undefined;
  const latestUser = plainTextPreview(latestUserTurn?.items.filter((item) => item.type === "userMessage").map(itemText).filter(Boolean).at(-1) ?? "");
  const latestResult = plainTextPreview(latestResultTurn?.items.filter((item) => item.type === "agentMessage").map(itemText).filter(Boolean).at(-1) ?? "");
  const statuses = failed ? [{ label: "Failed", tone: "failed" }]
    : needsApproval ? [{ label: "Needs approval", tone: "approval" }, ...(newResult ? [{ label: "New result", tone: "result" }] : [])]
      : isRunning ? [{ label: "Running", tone: "running" }, ...(newResult ? [{ label: "New result", tone: "result" }] : [])]
        : newResult ? [{ label: "New result", tone: "result" }]
          : [{ label: "Idle", tone: "idle" }];
  return <article
    className={`overview-card ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}
    style={{ transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0)` }}
    onPointerDown={onPointerDown}
    onPointerEnter={() => onHover(true)}
    onPointerLeave={() => onHover(false)}
    onClick={onOpen}
    role="group"
    aria-label={node.title}
  >
    <div className="overview-card-surface">
      <button className="card-open-button" aria-label={`Open ${node.title}`} onClick={(event) => { event.stopPropagation(); onOpen(); }}/>
      <div className="card-heading">
        <div className="card-title-wrap">
          <div className="card-kicker">{parent ? "Forked Thread" : "Space Root"}</div>
          {editing ? <input className="card-title-input" autoFocus defaultValue={node.title} aria-label={`Rename ${node.title}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== node.title) void onRename(node.threadId, name); setEditing(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(false); }}/>
            : <h3 title={node.title} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); setEditing(true); }}>{node.title}</h3>}
        </div>
        <div className="card-status-group">{statuses.map((status) => <div className={`card-status ${status.tone}`} key={status.tone}><i className={`status-dot ${status.tone}`}/>{status.label}</div>)}</div>
      </div>
      {parent ? <button className="card-origin" onClick={(event) => { event.stopPropagation(); onFocusParent(parent.threadId, node.forkedAtTurnId ?? undefined); }}>
        <strong>Branched from {parent.title}</strong>{forkSnippet && <span> · “{clip(forkSnippet, 52)}”</span>}
      </button> : <div className="card-origin"><strong>Registered root chat</strong><span> · existing Codex Thread brought into this Space</span></div>}
      <div className="card-facts">
        <button onClick={(event) => { event.stopPropagation(); onFocusTurn(latestUserTurn?.id); }} disabled={!latestUserTurn}><span>Latest user</span><b>{clip(latestUser || "No user message loaded", 92)}</b></button>
        <button onClick={(event) => { event.stopPropagation(); onFocusTurn(latestResultTurn?.id); }} disabled={!latestResultTurn}><span>Latest result</span><b>{clip(latestResult || "No completed result", 92)}</b></button>
      </div>
      <footer className="card-footer">
        <div className="card-foot-facts"><span>{thread?.turns.length ?? 0} turns</span><i>·</i><span>{relativeTime(thread?.updatedAt ?? node.createdAt)}</span></div>
        <div className="card-pills">
          {(node.worktreeName || diff) && <button
            className="card-pill"
            aria-label={`Open changes for ${node.worktreeName ?? "workspace"}`}
            title={`${node.worktreeName ?? "Workspace"}${diff ? ` · ${diff.changedFileCount} changed file${diff.changedFileCount === 1 ? "" : "s"}` : ""}`}
            onClick={(event) => { event.stopPropagation(); onDiff(); }}
          >{node.worktreeName ?? "Workspace"}{diff ? ` · ${diff.changedFileCount}f` : ""}</button>}
          {subagentCount > 0 && <span className="card-pill" title={`${subagentCount} subagent${subagentCount === 1 ? "" : "s"} · ${subagentRunning ? "Running" : "Done"}`}>{subagentCount} subagent{subagentCount === 1 ? "" : "s"} · {subagentRunning ? "Running" : "Done"}</span>}
        </div>
      </footer>
    </div>
  </article>;
}

function fitCamera(nodes: SpaceNode[], viewport: HTMLDivElement | null): CameraState {
  if (!viewport || nodes.length === 0) return { x: 120, y: 120, scale: 1 };
  const xs = nodes.map((node) => node.position.x);
  const ys = nodes.map((node) => node.position.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs) + CARD_WIDTH;
  const maxY = Math.max(...ys) + CARD_HEIGHT;
  const paddingX = Math.min(110, viewport.clientWidth * .1);
  const paddingY = Math.min(105, viewport.clientHeight * .12);
  const scale = Math.max(MIN_SCALE, Math.min(1, Math.min((viewport.clientWidth - paddingX * 2) / (maxX - minX), (viewport.clientHeight - paddingY * 2) / (maxY - minY))));
  return {
    scale,
    x: (viewport.clientWidth - (maxX - minX) * scale) / 2 - minX * scale,
    y: (viewport.clientHeight - (maxY - minY) * scale) / 2 - minY * scale,
  };
}

function pathToRoot(space: SpaceRecord, threadId: string | null): Set<string> {
  const path = new Set<string>();
  let cursor = threadId ? space.nodes[threadId] : undefined;
  while (cursor) {
    path.add(cursor.threadId);
    cursor = cursor.parentThreadId ? space.nodes[cursor.parentThreadId] : undefined;
  }
  return path;
}

function graphBounds(nodes: SpaceNode[]): { minX: number; minY: number; width: number; height: number } {
  if (nodes.length === 0) return { minX: -160, minY: -160, width: 320, height: 320 };
  const margin = 180;
  const minX = Math.min(...nodes.map((node) => node.position.x)) - margin;
  const minY = Math.min(...nodes.map((node) => node.position.y)) - margin;
  const maxX = Math.max(...nodes.map((node) => node.position.x + CARD_WIDTH)) + margin;
  const maxY = Math.max(...nodes.map((node) => node.position.y + CARD_HEIGHT)) + margin;
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}
