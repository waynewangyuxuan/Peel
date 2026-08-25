import type { CodexThread } from "@peel/codex-app-server";
import { useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";

import type { CameraState, Point, SpaceNode, SpaceRecord } from "../shared/contracts";
import { Icon } from "./icons";
import { clip, itemText, latestCompletedTurn, relativeTime } from "./lib";

const CARD_WIDTH = 296;
const CARD_HEIGHT = 188;
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
}

export function Overview({ space, activeThreadId, threads, diffs, onCamera, onNodePosition, onFocus, onRename }: OverviewProps): ReactNode {
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointerId: number; origin: Point; camera: CameraState } | null>(null);
  const drag = useRef<{ pointerId: number; threadId: string; origin: Point; position: Point } | null>(null);
  const nodes = Object.values(space.nodes);
  const bounds = graphBounds(nodes);

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
      onNodePosition(drag.current.threadId, {
        x: drag.current.position.x + (event.clientX - drag.current.origin.x) / space.camera.scale,
        y: drag.current.position.y + (event.clientY - drag.current.origin.y) / space.camera.scale,
      });
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (pan.current?.pointerId === event.pointerId) pan.current = null;
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
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
    };
  };

  return <div className="overview-shell">
    <div className="overview-toolbar">
      <div><span className="eyebrow">Overview</span><strong>{nodes.length} directions</strong></div>
      <div className="zoom-controls"><button onClick={() => onCamera({ ...space.camera, scale: Math.max(MIN_SCALE, space.camera.scale - .1) })}>−</button><span>{Math.round(space.camera.scale * 100)}%</span><button onClick={() => onCamera({ ...space.camera, scale: Math.min(1.45, space.camera.scale + .1) })}>+</button><button onClick={() => onCamera(fitCamera(nodes, viewport.current))}>Fit</button></div>
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
            return <path key={node.threadId} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />;
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
          onPointerDown={(event) => beginNode(event, node)}
          onFocus={onFocus}
          onRename={onRename}
        />)}
      </div>
      <div className="overview-hint">Drag cards to organize · drag the canvas to pan · scroll to zoom</div>
    </div>
  </div>;
}

function OverviewCard({ node, parent, thread, parentThread, diff, active, onPointerDown, onFocus, onRename }: {
  node: SpaceNode;
  parent: SpaceNode | null;
  thread: CodexThread | null;
  parentThread: CodexThread | null;
  diff: WorkspaceDiffSummary | null;
  active: boolean;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onFocus(threadId: string, turnId?: string): void;
  onRename(threadId: string, name: string): Promise<void>;
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
  const forkSnippet = forkTurn?.items.map(itemText).filter(Boolean).at(-1) ?? "";
  const latestUserTurn = thread ? [...thread.turns].reverse().find((turn) => turn.items.some((item) => item.type === "userMessage")) : undefined;
  const latestResultTurn = thread ? [...thread.turns].reverse().find((turn) => turn.status === "completed" && turn.items.some((item) => item.type === "agentMessage")) : undefined;
  const latestUser = latestUserTurn?.items.filter((item) => item.type === "userMessage").map(itemText).filter(Boolean).at(-1) ?? "";
  const latestResult = latestResultTurn?.items.filter((item) => item.type === "agentMessage").map(itemText).filter(Boolean).at(-1) ?? "";
  return <article
    className={`overview-card ${active ? "active" : ""}`}
    style={{ transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0)` }}
    onPointerDown={onPointerDown}
    onDoubleClick={() => onFocus(node.threadId)}
  >
    <div className="card-topline">
      <div className="status-dots">
        {isRunning && <span className="status-dot running" title="Running"/>}
        {needsApproval && <span className="status-dot approval" title="Needs approval"/>}
        {newResult && <span className="status-dot result" title="New result"/>}
        {failed && <span className="status-dot failed" title="Failed"/>}
      </div>
      <span>{relativeTime(thread?.updatedAt ?? node.createdAt)}</span>
    </div>
    {editing ? <input className="card-title-input" autoFocus defaultValue={node.title} aria-label={`Rename ${node.title}`} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== node.title) void onRename(node.threadId, name); setEditing(false); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(false); }}/>
      : <h3 onDoubleClick={(event) => { event.stopPropagation(); setEditing(true); }}>{node.title}</h3>}
    {parent && <button className="card-parent" onClick={(event) => { event.stopPropagation(); onFocus(parent.threadId, node.forkedAtTurnId ?? undefined); }}><Icon name="branch" size={12}/> {parent.title}{forkSnippet ? ` · ${clip(forkSnippet, 44)}` : ""}</button>}
    <div className="card-snippets">
      <button onClick={(event) => { event.stopPropagation(); onFocus(node.threadId, latestUserTurn?.id); }} disabled={!latestUserTurn}><span>You</span>{clip(latestUser || "No user message loaded", 76)}</button>
      <button onClick={(event) => { event.stopPropagation(); onFocus(node.threadId, latestResultTurn?.id); }} disabled={!latestResultTurn}><span>Result</span>{clip(latestResult || "No completed result", 76)}</button>
    </div>
    <div className="card-meta">
      <span>{thread?.turns.length ?? 0} turns</span>
      {node.worktreeName && <span><Icon name="folder" size={12}/>{node.worktreeName}</span>}
      {diff && <span>{diff.changedFileCount} changed</span>}
      {subagentCount > 0 && <span>{subagentCount} subagent{subagentCount === 1 ? "" : "s"} · {subagentRunning ? "Running" : "Done"}</span>}
      <button onClick={(event) => { event.stopPropagation(); onFocus(node.threadId); }}>Open <Icon name="chevron" size={12}/></button>
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
  const padding = 100;
  const scale = Math.max(MIN_SCALE, Math.min(1.1, Math.min((viewport.clientWidth - padding * 2) / (maxX - minX), (viewport.clientHeight - padding * 2) / (maxY - minY))));
  return {
    scale,
    x: (viewport.clientWidth - (maxX - minX) * scale) / 2 - minX * scale,
    y: (viewport.clientHeight - (maxY - minY) * scale) / 2 - minY * scale,
  };
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
