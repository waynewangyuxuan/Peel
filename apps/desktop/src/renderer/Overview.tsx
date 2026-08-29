import type { CodexThread } from "@peel/codex-app-server";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";

import type { CameraState, Point, SpaceNode, SpaceRecord } from "../shared/contracts";
import { clip, itemText, latestCompletedTurn, plainTextPreview, relativeTime } from "./lib";
import { resolveSemanticZoomMode, semanticContentScale, type SemanticZoomMode } from "./overview-zoom";

const CARD_WIDTH = 294;
const CARD_HEIGHT = 205;
const MIN_SCALE = .08;
const MAX_SCALE = 1.45;
const WHEEL_COMMIT_DELAY_MS = 150;
const CAMERA_ANIMATION_MS = 260;

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

interface PanGesture {
  pointerId: number;
  origin: Point;
  camera: CameraState;
}

interface NodeGesture {
  pointerId: number;
  threadId: string;
  origin: Point;
  position: Point;
  current: Point;
  moved: boolean;
}

export function Overview({ space, activeThreadId, threads, diffs, onCamera, onNodePosition, onFocus, onRename, onDiff }: OverviewProps): ReactNode {
  const shell = useRef<HTMLDivElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const world = useRef<HTMLDivElement | null>(null);
  const zoomValue = useRef<HTMLSpanElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const edges = useRef(new Map<string, SVGPathElement>());
  const positions = useRef(new Map<string, Point>());
  const camera = useRef<CameraState>(space.camera);
  const zoomMode = useRef<SemanticZoomMode>(resolveSemanticZoomMode(space.camera.scale));
  const pan = useRef<PanGesture | null>(null);
  const drag = useRef<NodeGesture | null>(null);
  const initializedSpace = useRef<string | null>(null);
  const suppressOpen = useRef(false);
  const cameraFrame = useRef<number | null>(null);
  const pendingCamera = useRef<CameraState | null>(null);
  const nodeFrame = useRef<number | null>(null);
  const pendingNode = useRef<{ threadId: string; position: Point } | null>(null);
  const wheelCommitTimer = useRef<number | null>(null);
  const cameraAnimation = useRef<number | null>(null);
  const onCameraRef = useRef(onCamera);
  const onNodePositionRef = useRef(onNodePosition);
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);

  const nodes = useMemo(() => Object.values(space.nodes), [space.nodes]);
  const bounds = useMemo(() => graphBounds(nodes), [nodes]);
  const emphasizedPath = useMemo(
    () => pathToRoot(space, hoveredThreadId ?? activeThreadId),
    [activeThreadId, hoveredThreadId, space],
  );

  useEffect(() => {
    onCameraRef.current = onCamera;
  }, [onCamera]);

  useEffect(() => {
    onNodePositionRef.current = onNodePosition;
  }, [onNodePosition]);

  const applyCamera = useCallback((next: CameraState): void => {
    camera.current = next;
    if (world.current) world.current.style.transform = cameraTransform(next);
    if (zoomValue.current) {
      const percentage = Math.round(next.scale * 100);
      zoomValue.current.textContent = `${percentage}%`;
      zoomValue.current.setAttribute("aria-label", `Zoom ${percentage} percent`);
    }

    const nextMode = resolveSemanticZoomMode(next.scale, zoomMode.current);
    zoomMode.current = nextMode;
    if (shell.current) {
      shell.current.dataset.zoomMode = nextMode;
      shell.current.style.setProperty("--camera-scale", next.scale.toFixed(4));
      shell.current.style.setProperty("--semantic-scale", semanticContentScale(next.scale, nextMode).toFixed(4));
    }
  }, []);

  const syncEdges = useCallback((): void => {
    for (const node of nodes) {
      if (!node.parentThreadId) continue;
      const edge = edges.current.get(node.threadId);
      const parentPosition = positions.current.get(node.parentThreadId);
      const nodePosition = positions.current.get(node.threadId);
      if (edge && parentPosition && nodePosition) edge.setAttribute("d", edgeCurve(parentPosition, nodePosition));
    }
  }, [nodes]);

  const applyNodePosition = useCallback((threadId: string, position: Point): void => {
    positions.current.set(threadId, position);
    const card = cards.current.get(threadId);
    if (card) card.style.transform = nodeTransform(position);
    syncEdges();
  }, [syncEdges]);

  const flushCameraFrame = useCallback((): void => {
    if (cameraFrame.current !== null) cancelAnimationFrame(cameraFrame.current);
    cameraFrame.current = null;
    const next = pendingCamera.current;
    pendingCamera.current = null;
    if (next) applyCamera(next);
  }, [applyCamera]);

  const queueCamera = useCallback((next: CameraState): void => {
    pendingCamera.current = next;
    if (cameraFrame.current !== null) return;
    cameraFrame.current = requestAnimationFrame(() => {
      cameraFrame.current = null;
      const pending = pendingCamera.current;
      pendingCamera.current = null;
      if (pending) applyCamera(pending);
    });
  }, [applyCamera]);

  const flushNodeFrame = useCallback((): void => {
    if (nodeFrame.current !== null) cancelAnimationFrame(nodeFrame.current);
    nodeFrame.current = null;
    const pending = pendingNode.current;
    pendingNode.current = null;
    if (pending) applyNodePosition(pending.threadId, pending.position);
  }, [applyNodePosition]);

  const queueNodePosition = useCallback((threadId: string, position: Point): void => {
    pendingNode.current = { threadId, position };
    if (nodeFrame.current !== null) return;
    nodeFrame.current = requestAnimationFrame(() => {
      nodeFrame.current = null;
      const pending = pendingNode.current;
      pendingNode.current = null;
      if (pending) applyNodePosition(pending.threadId, pending.position);
    });
  }, [applyNodePosition]);

  const cancelCameraAnimation = useCallback((): void => {
    if (cameraAnimation.current !== null) cancelAnimationFrame(cameraAnimation.current);
    cameraAnimation.current = null;
  }, []);

  const animateCamera = useCallback((target: CameraState): void => {
    cancelCameraAnimation();
    flushCameraFrame();
    if (wheelCommitTimer.current !== null) window.clearTimeout(wheelCommitTimer.current);
    wheelCommitTimer.current = null;

    const start = camera.current;
    const startedAt = performance.now();
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / CAMERA_ANIMATION_MS);
      const eased = 1 - Math.pow(1 - progress, 4);
      applyCamera({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        scale: start.scale + (target.scale - start.scale) * eased,
      });
      if (progress < 1) {
        cameraAnimation.current = requestAnimationFrame(tick);
        return;
      }
      cameraAnimation.current = null;
      applyCamera(target);
      onCameraRef.current(target);
    };
    cameraAnimation.current = requestAnimationFrame(tick);
  }, [applyCamera, cancelCameraAnimation, flushCameraFrame]);

  useLayoutEffect(() => {
    positions.current = new Map(nodes.map((node) => [node.threadId, node.position]));
    for (const node of nodes) {
      const card = cards.current.get(node.threadId);
      if (card) card.style.transform = nodeTransform(node.position);
    }
    syncEdges();

    const untouchedInitialCamera = space.camera.x === 0
      && space.camera.y === 0
      && space.camera.scale === .86
      && space.nodes[space.rootThreadId]?.position.x === 0
      && space.nodes[space.rootThreadId]?.position.y === 0;

    if (untouchedInitialCamera && initializedSpace.current !== space.id) {
      initializedSpace.current = space.id;
      const frame = requestAnimationFrame(() => {
        const fitted = fitCamera(nodes, viewport.current);
        applyCamera(fitted);
        onCameraRef.current(fitted);
      });
      return () => cancelAnimationFrame(frame);
    }

    initializedSpace.current = space.id;
    applyCamera(space.camera);
    return undefined;
  }, [applyCamera, nodes, space.camera, space.id, space.nodes, space.rootThreadId, syncEdges]);

  useEffect(() => () => {
    if (cameraFrame.current !== null) cancelAnimationFrame(cameraFrame.current);
    if (nodeFrame.current !== null) cancelAnimationFrame(nodeFrame.current);
    if (cameraAnimation.current !== null) cancelAnimationFrame(cameraAnimation.current);
    if (wheelCommitTimer.current !== null) window.clearTimeout(wheelCommitTimer.current);
  }, []);

  const beginPan = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".overview-card")) return;
    cancelCameraAnimation();
    flushCameraFrame();
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      camera: camera.current,
    };
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    if (pan.current?.pointerId === event.pointerId) {
      queueCamera({
        ...pan.current.camera,
        x: pan.current.camera.x + event.clientX - pan.current.origin.x,
        y: pan.current.camera.y + event.clientY - pan.current.origin.y,
      });
    }

    if (drag.current?.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - drag.current.origin.x, event.clientY - drag.current.origin.y) > 4) drag.current.moved = true;
      const next = {
        x: drag.current.position.x + (event.clientX - drag.current.origin.x) / camera.current.scale,
        y: drag.current.position.y + (event.clientY - drag.current.origin.y) / camera.current.scale,
      };
      drag.current.current = next;
      queueNodePosition(drag.current.threadId, next);
    }
  };

  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (pan.current?.pointerId === event.pointerId) {
      flushCameraFrame();
      pan.current = null;
      onCameraRef.current(camera.current);
    }

    if (drag.current?.pointerId === event.pointerId) {
      flushNodeFrame();
      const completed = drag.current;
      suppressOpen.current = completed.moved;
      drag.current = null;
      setDraggingThreadId(null);
      onNodePositionRef.current(completed.threadId, completed.current);
      if (suppressOpen.current) requestAnimationFrame(() => { suppressOpen.current = false; });
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const wheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    cancelCameraAnimation();
    flushCameraFrame();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const previous = camera.current;
    const nextScale = clamp(previous.scale * Math.exp(-event.deltaY * 0.0012), MIN_SCALE, MAX_SCALE);
    const worldX = (pointer.x - previous.x) / previous.scale;
    const worldY = (pointer.y - previous.y) / previous.scale;
    queueCamera({
      scale: nextScale,
      x: pointer.x - worldX * nextScale,
      y: pointer.y - worldY * nextScale,
    });

    if (wheelCommitTimer.current !== null) window.clearTimeout(wheelCommitTimer.current);
    wheelCommitTimer.current = window.setTimeout(() => {
      flushCameraFrame();
      wheelCommitTimer.current = null;
      onCameraRef.current(camera.current);
    }, WHEEL_COMMIT_DELAY_MS);
  };

  const beginNode = (event: PointerEvent<HTMLElement>, node: SpaceNode): void => {
    if ((event.target as HTMLElement).closest("button, input, h3")) return;
    event.stopPropagation();
    flushNodeFrame();
    viewport.current?.setPointerCapture(event.pointerId);
    const position = positions.current.get(node.threadId) ?? node.position;
    drag.current = {
      pointerId: event.pointerId,
      threadId: node.threadId,
      origin: { x: event.clientX, y: event.clientY },
      position,
      current: position,
      moved: false,
    };
    setDraggingThreadId(node.threadId);
  };

  const zoomAtCenter = (nextScale: number): void => {
    const target = cameraAroundViewportCenter(camera.current, clamp(nextScale, MIN_SCALE, MAX_SCALE), viewport.current);
    animateCamera(target);
  };

  return <div
    className="overview-shell"
    ref={shell}
    data-zoom-mode={zoomMode.current}
    style={{
      "--camera-scale": space.camera.scale,
      "--semantic-scale": semanticContentScale(space.camera.scale, zoomMode.current),
    } as CSSProperties}
  >
    <div className="overview-toolbar">
      <div className="overview-identity">
        <strong>{space.name}</strong>
        <span>{nodes.length} direction{nodes.length === 1 ? "" : "s"}</span>
      </div>
      <div className="zoom-controls">
        <button aria-label="Zoom out" title="Zoom out" onClick={() => zoomAtCenter(camera.current.scale - .12)}>−</button>
        <span ref={zoomValue} aria-label={`Zoom ${Math.round(space.camera.scale * 100)} percent`}>{Math.round(space.camera.scale * 100)}%</span>
        <button aria-label="Zoom in" title="Zoom in" onClick={() => zoomAtCenter(camera.current.scale + .12)}>+</button>
        <button className="fit-button" aria-label="Fit" title="Fit Overview" onClick={() => animateCamera(fitCamera(nodes, viewport.current))}>Fit</button>
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
      <div className="overview-world" ref={world} style={{ transform: cameraTransform(space.camera) }}>
        <svg className="overview-edges" style={{ left: bounds.minX, top: bounds.minY }} width={bounds.width} height={bounds.height} viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}>
          {nodes.filter((node) => node.parentThreadId && space.nodes[node.parentThreadId]).map((node) => {
            const parent = space.nodes[node.parentThreadId!]!;
            return <path
              ref={(element: SVGPathElement | null) => {
                if (element) edges.current.set(node.threadId, element);
                else edges.current.delete(node.threadId);
              }}
              className={emphasizedPath.has(node.threadId) ? "active" : ""}
              key={node.threadId}
              d={edgeCurve(parent.position, node.position)}
            />;
          })}
        </svg>
        {nodes.map((node) => <OverviewCard
          key={node.threadId}
          cardRef={(element) => {
            if (element) cards.current.set(node.threadId, element);
            else cards.current.delete(node.threadId);
          }}
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
    </div>
  </div>;
}

function OverviewCard({ cardRef, node, parent, thread, parentThread, diff, active, dragging, onPointerDown, onOpen, onFocusTurn, onFocusParent, onRename, onDiff, onHover }: {
  cardRef(element: HTMLElement | null): void;
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
  const flags = thread?.status.type === "active" ? thread.status.activeFlags ?? [] : [];
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
  const primaryStatus = statuses[0]!;
  const compactSummary = latestResult || latestUser || forkSnippet || "No activity yet";

  return <article
    ref={cardRef}
    className={`overview-card ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}
    style={{ transform: nodeTransform(node.position) }}
    onPointerDown={onPointerDown}
    onPointerEnter={() => onHover(true)}
    onPointerLeave={() => onHover(false)}
    onClick={onOpen}
    role="group"
    aria-label={node.title}
  >
    <div className="overview-card-surface">
      <button className="card-open-button" aria-label={`Open ${node.title}`} onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onOpen(); }}/>

      <div className="card-detail">
        <div className="card-heading">
          <div className="card-title-wrap">
            {!parent && <div className="card-root-label">Root</div>}
            {editing ? <input
              className="card-title-input"
              autoFocus
              defaultValue={node.title}
              aria-label={`Rename ${node.title}`}
              onPointerDown={(event: PointerEvent<HTMLInputElement>) => event.stopPropagation()}
              onClick={(event: ReactMouseEvent<HTMLInputElement>) => event.stopPropagation()}
              onDoubleClick={(event: ReactMouseEvent<HTMLInputElement>) => event.stopPropagation()}
              onBlur={(event: ReactFocusEvent<HTMLInputElement>) => {
                const name = event.target.value.trim();
                if (name && name !== node.title) void onRename(node.threadId, name);
                setEditing(false);
              }}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditing(false);
              }}
            /> : <h3
              title={node.title}
              onClick={(event: ReactMouseEvent<HTMLHeadingElement>) => event.stopPropagation()}
              onDoubleClick={(event: ReactMouseEvent<HTMLHeadingElement>) => { event.stopPropagation(); setEditing(true); }}
            >{node.title}</h3>}
          </div>
          <div className="card-status-group">{statuses.map((status) => <div className={`card-status ${status.tone}`} key={status.tone}><i className={`status-dot ${status.tone}`}/>{status.label}</div>)}</div>
        </div>

        {parent && <button className="card-origin" onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onFocusParent(parent.threadId, node.forkedAtTurnId ?? undefined); }}>
          <strong>Branched from {parent.title}</strong>{forkSnippet && <span> · “{clip(forkSnippet, 52)}”</span>}
        </button>}

        <div className="card-facts">
          <button onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onFocusTurn(latestUserTurn?.id); }} disabled={!latestUserTurn}><span>Latest user</span><b>{clip(latestUser || "No user message loaded", 92)}</b></button>
          <button onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onFocusTurn(latestResultTurn?.id); }} disabled={!latestResultTurn}><span>Latest result</span><b>{clip(latestResult || "No completed result", 92)}</b></button>
        </div>

        <footer className="card-footer">
          <div className="card-foot-facts"><span>{thread?.turns.length ?? 0} turns</span><i>·</i><span>{relativeTime(thread?.updatedAt ?? node.createdAt)}</span></div>
          <div className="card-pills">
            {(node.worktreeName || diff) && <button
              className="card-pill"
              aria-label={`Open changes for ${node.worktreeName ?? "workspace"}`}
              title={`${node.worktreeName ?? "Workspace"}${diff ? ` · ${diff.changedFileCount} changed file${diff.changedFileCount === 1 ? "" : "s"}` : ""}`}
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onDiff(); }}
            >{node.worktreeName ?? "Workspace"}{diff ? ` · ${diff.changedFileCount}f` : ""}</button>}
            {subagentCount > 0 && <span className="card-pill" title={`${subagentCount} subagent${subagentCount === 1 ? "" : "s"} · ${subagentRunning ? "Running" : "Done"}`}>{subagentCount} subagent{subagentCount === 1 ? "" : "s"} · {subagentRunning ? "Running" : "Done"}</span>}
          </div>
        </footer>
      </div>

      <div className="card-compact" aria-hidden="true">
        <div className="compact-heading"><i className={`status-dot ${primaryStatus.tone}`}/><strong>{node.title}</strong><span>{primaryStatus.label}</span></div>
        {parent && <small>From {parent.title}</small>}
        <p>{clip(compactSummary, 110)}</p>
        <footer><span>{thread?.turns.length ?? 0} turns</span><i>·</i><span>{relativeTime(thread?.updatedAt ?? node.createdAt)}</span>{diff && <><i>·</i><span>{diff.changedFileCount} files</span></>}</footer>
      </div>

      <div className="card-map" aria-hidden="true">
        <i className={`status-dot ${primaryStatus.tone}`}/>
        <strong>{node.title}</strong>
        {primaryStatus.tone !== "idle" && <span>{primaryStatus.label}</span>}
      </div>
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
  const scale = Math.max(MIN_SCALE, Math.min(1, Math.min(
    (viewport.clientWidth - paddingX * 2) / (maxX - minX),
    (viewport.clientHeight - paddingY * 2) / (maxY - minY),
  )));
  return {
    scale,
    x: (viewport.clientWidth - (maxX - minX) * scale) / 2 - minX * scale,
    y: (viewport.clientHeight - (maxY - minY) * scale) / 2 - minY * scale,
  };
}

function cameraAroundViewportCenter(current: CameraState, nextScale: number, viewport: HTMLDivElement | null): CameraState {
  if (!viewport) return { ...current, scale: nextScale };
  const pointer = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  const worldX = (pointer.x - current.x) / current.scale;
  const worldY = (pointer.y - current.y) / current.scale;
  return {
    scale: nextScale,
    x: pointer.x - worldX * nextScale,
    y: pointer.y - worldY * nextScale,
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

function edgeCurve(parent: Point, child: Point): string {
  const x1 = parent.x + CARD_WIDTH;
  const y1 = parent.y + CARD_HEIGHT / 2;
  const x2 = child.x;
  const y2 = child.y + CARD_HEIGHT / 2;
  const bend = Math.max(50, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function cameraTransform(camera: CameraState): string {
  return `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`;
}

function nodeTransform(position: Point): string {
  return `translate3d(${position.x}px, ${position.y}px, 0)`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
