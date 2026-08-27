import type { AppServerServerRequest, CodexThread, CodexTurn, ReducedThread, ThreadItem, UserInput } from "@peel/codex-app-server";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { ApprovalDecisionInput, ForkDraft, SpaceNode } from "../shared/contracts";
import { Icon } from "./icons";
import { itemText } from "./lib";
import { startPcmRecorder, type RecorderSession } from "./audio";
import { MarkdownContent } from "./Markdown";

interface TranscriptProps {
  thread: CodexThread;
  reduced: ReducedThread | null;
  node: SpaceNode;
  diff: WorkspaceDiffSummary | null;
  draft: string;
  approvals: AppServerServerRequest[];
  highlightTurnId: string | null;
  restoreScrollTop: number;
  onHighlightScrolled(turnId: string): void;
  onDraft(value: string): void;
  onScroll(value: number): void;
  onSend(input: UserInput[]): Promise<void>;
  onBranch(turn: CodexTurn): void;
  onApproval(input: ApprovalDecisionInput): Promise<void>;
  onDiff(): void;
  onOpenCodex(): void;
}

export function Transcript({
  thread,
  reduced,
  node,
  diff,
  draft,
  approvals,
  highlightTurnId,
  restoreScrollTop,
  onHighlightScrolled,
  onDraft,
  onScroll,
  onSend,
  onBranch,
  onApproval,
  onDiff,
  onOpenCodex,
}: TranscriptProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<UserInput[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [voice, setVoice] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceLevels, setVoiceLevels] = useState<number[]>(() => Array.from({ length: 17 }, () => 0));
  const [recordingMs, setRecordingMs] = useState(0);
  const recorder = useRef<RecorderSession | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  const followBottom = useRef(true);
  const restoredScroll = useRef(false);
  const acknowledgedHighlight = useRef<string | null>(null);
  draftRef.current = draft;

  useEffect(() => () => {
    mounted.current = false;
    recorder.current?.cancel();
    recorder.current = null;
  }, []);

  useEffect(() => {
    if (voice !== "recording") {
      setRecordingMs(0);
      return;
    }
    const startedAt = performance.now();
    const timer = window.setInterval(() => setRecordingMs(performance.now() - startedAt), 100);
    return () => window.clearInterval(timer);
  }, [voice]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(130, Math.max(38, element.scrollHeight))}px`;
  }, [draft]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !followBottom.current) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && element.contains(selection.anchorNode)) return;
    element.scrollTop = element.scrollHeight;
  }, [thread, reduced]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (!highlightTurnId) {
      acknowledgedHighlight.current = null;
      if (restoredScroll.current) return;
      element.scrollTop = restoreScrollTop;
      followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
      restoredScroll.current = true;
      return;
    }
    if (acknowledgedHighlight.current === highlightTurnId) return;
    const target = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(highlightTurnId)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
    restoredScroll.current = true;
    const viewport = element.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    if (targetBounds.bottom <= viewport.top || targetBounds.top >= viewport.bottom) return;
    acknowledgedHighlight.current = highlightTurnId;
    onHighlightScrolled(highlightTurnId);
  }, [highlightTurnId, onHighlightScrolled, restoreScrollTop, thread.id]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend([
        ...(text ? [{ type: "text" as const, text, text_elements: [] }] : []),
        ...attachments,
      ]);
      setAttachments([]);
    } catch (error) {
      setSendError(userFacingIpcError(error));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const attach = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = [...(event.target.files ?? [])];
    const inputs = await Promise.all(files.map(async (file): Promise<UserInput> => ({
      type: file.type.startsWith("audio/") ? "audio" : "image",
      url: await dataUrl(file),
    })));
    setAttachments((current) => [...current, ...inputs]);
    event.target.value = "";
  };

  const dictate = async (): Promise<void> => {
    setVoiceError(null);
    if (voice === "recording" && recorder.current) {
      setVoice("transcribing");
      setVoiceLevels(Array.from({ length: 17 }, () => 0));
      try {
        const wav = await recorder.current.stop();
        recorder.current = null;
        const result = await window.peel.transcribeWav(wav);
        if (!mounted.current) return;
        const latestDraft = draftRef.current;
        onDraft([latestDraft.trimEnd(), result.text].filter(Boolean).join(latestDraft.trim() ? " " : ""));
      } catch (error) {
        if (!mounted.current) return;
        setVoiceError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mounted.current) setVoice("idle");
      }
      return;
    }
    try {
      const session = await startPcmRecorder((message) => {
        if (!mounted.current) return;
        recorder.current = null;
        setVoice("idle");
        setVoiceLevels(Array.from({ length: 17 }, () => 0));
        setVoiceError(message);
      }, (level) => {
        if (!mounted.current) return;
        setVoiceLevels((current) => [...current.slice(1), level]);
      });
      if (!mounted.current) {
        session.cancel();
        return;
      }
      recorder.current = session;
      setVoiceLevels(Array.from({ length: 17 }, () => 0));
      setVoice("recording");
    } catch (error) {
      if (!mounted.current) return;
      setVoiceError(error instanceof Error ? error.message : String(error));
    }
  };

  const active = reduced?.status.type === "active";
  return <div className="transcript-column">
    <div className="transcript" ref={scroller} onScroll={(event) => {
      const element = event.currentTarget;
      followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
      onScroll(element.scrollTop);
    }}>
      <div className="thread-intro">
        <div className="eyebrow">Thread</div>
        <h1 title={node.title}>{node.title}</h1>
        <p>{thread.cwd}</p>
        <div className="thread-runtime">
          {node.worktreeName && <span><Icon name="folder" size={12}/>{node.worktreeName}</span>}
          {diff && <button onClick={onDiff}>{diff.changedFileCount} changed file{diff.changedFileCount === 1 ? "" : "s"}</button>}
        </div>
      </div>
      {thread.turns.length === 0 && <div className="empty-thread">This Thread has no turns yet.</div>}
      {thread.turns.map((turn) => <TurnView
        key={turn.id}
        turn={turn}
        reduced={reduced?.turns.find((candidate) => candidate.turn.id === turn.id) ?? null}
        highlighted={turn.id === highlightTurnId}
        onBranch={() => onBranch(turn)}
        onOpenCodex={onOpenCodex}
      />)}
      {approvals.map((approval) => <ApprovalCard key={String(approval.id)} request={approval} onDecide={onApproval} />)}
      {active && <div className="working-indicator"><span/><span/><span/> Codex is working</div>}
      <div className="transcript-end" />
    </div>
    <div className="composer-wrap">
      {attachments.length > 0 && <div className="attachment-row">{attachments.map((item, index) =>
        <span className="attachment" key={`${item.type}-${index}`}>{item.type === "audio" ? "Audio" : "Image"}<button onClick={() => setAttachments((all) => all.filter((_, itemIndex) => itemIndex !== index))}><Icon name="close" size={12}/></button></span>)}</div>}
      {sendError && <div className="composer-error" role="alert">{sendError}</div>}
      {voiceError && <div className="composer-error">{voiceError}</div>}
      <div className={`composer ${voice === "recording" ? "is-recording" : ""}`}>
        <textarea
          ref={textarea}
          aria-label="Message"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message Codex"
          rows={1}
        />
        <div className="composer-actions">
          <label className="icon-button" title="Attach image or audio"><Icon name="paperclip"/><input type="file" accept="image/*,audio/*" multiple onChange={(event) => void attach(event)}/></label>
          <button className={`icon-button voice-button ${voice === "recording" ? "recording" : voice === "transcribing" ? "active" : ""}`} onClick={() => void dictate()} disabled={voice === "transcribing"} aria-label={voice === "recording" ? "Stop dictation" : "Dictate into draft"} title={voice === "recording" ? "Stop dictation" : "Dictate into draft"}>
            <Icon name={voice === "recording" ? "stop" : "mic"}/>
          </button>
          {voice === "recording" && <div className="voice-live" aria-label="Live microphone level"><VoiceWaveform levels={voiceLevels}/><span>{formatRecordingTime(recordingMs)}</span></div>}
          {voice === "transcribing" && <span className="voice-transcribing"><span className="mini-spinner"/>Transcribing…</span>}
          <span className="composer-spacer" />
          <button className={`send-button ${sending ? "sending" : ""}`} onClick={() => void submit()} disabled={sending || voice !== "idle" || (!draft.trim() && attachments.length === 0)} aria-label={sending ? "Sending message" : "Send message"} title="Send message"><Icon name={sending ? "spinner" : "arrowUp"}/></button>
        </div>
      </div>
    </div>
  </div>;
}

function VoiceWaveform({ levels }: { levels: number[] }): ReactNode {
  return <span className="voice-waveform" role="img" aria-label="Microphone audio level">{levels.map((level, index) =>
    <i key={index} style={{ transform: `scaleY(${Math.max(.16, level)})` }}/>)}</span>;
}

function formatRecordingTime(value: number): string {
  const totalSeconds = Math.floor(value / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function userFacingIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || "The message could not be sent. Your draft is unchanged; try again.";
}

function TurnView({ turn, reduced, highlighted, onBranch, onOpenCodex }: {
  turn: CodexTurn;
  reduced: ReducedThread["turns"][number] | null;
  highlighted: boolean;
  onBranch(): void;
  onOpenCodex(): void;
}): ReactNode {
  const items = reduced?.items ?? turn.items.map((item) => ({ item, completed: true, streamedText: "" }));
  return <section className={`turn ${highlighted ? "highlighted" : ""}`} data-turn-id={turn.id}>
    {items.map(({ item, streamedText, completed }) => <ItemView key={item.id} item={item} streamedText={streamedText} streaming={!completed} onOpenCodex={onOpenCodex}/>) }
    <div className="turn-actions">
      <span>{turn.status === "inProgress" ? "Running" : turn.status}</span>
      {turn.status === "completed" && <button onClick={onBranch}><Icon name="branch" size={14}/> Branch from here</button>}
    </div>
    {turn.status === "completed" && <PeelHandle onPeel={onBranch}/>} 
  </section>;
}

function PeelHandle({ onPeel }: { onPeel(): void }): ReactNode {
  const gesture = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const down = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    setPreview({ x: event.clientX, y: event.clientY });
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 6) active.moved = true;
    setPreview({ x: event.clientX, y: event.clientY });
  };
  const finish = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false): void => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gesture.current = null;
    setPreview(null);
    if (!cancelled) onPeel();
  };
  return <button
    className="peel-handle"
    aria-label="Peel a branch from this turn"
    title="Drag to peel a new direction"
    onPointerDown={down}
    onPointerMove={move}
    onPointerUp={(event) => finish(event)}
    onPointerCancel={(event) => finish(event, true)}
  >
    <span/>
    {preview && <i className="peel-drag-preview" style={{ left: preview.x + 14, top: preview.y - 18 }}>New direction</i>}
  </button>;
}

export function ItemView({ item, streamedText, streaming, onOpenCodex }: { item: ThreadItem; streamedText: string; streaming: boolean; onOpenCodex(): void }): ReactNode {
  const text = itemText(item) + streamedText;
  if (item.type === "userMessage") return <article className="message user-message"><MarkdownContent text={text || "User message"} className="user-markdown"/></article>;
  if (item.type === "agentMessage") return <article className="message agent-message"><MarkdownContent text={text} streaming={streaming}/></article>;
  if (item.type === "reasoning") return <ActivityDisclosure icon="reasoning" label="Reasoning" state={activityState(item, streaming)} defaultOpen={streaming}>
    <MarkdownContent text={text || "Reasoning activity"} streaming={streaming}/>
  </ActivityDisclosure>;
  if (item.type === "commandExecution") {
    const state = activityState(item, streaming);
    return <ActivityDisclosure icon="terminal" label={commandLabel(item, state)} state={state} defaultOpen={state === "active"}>
      <pre className="activity-output">{text || String(item.command ?? "Command output")}</pre>
    </ActivityDisclosure>;
  }
  if (item.type === "fileChange") {
    const count = Array.isArray(item.changes) ? item.changes.length : 1;
    return <ActivityDisclosure icon="file" label={`Changed ${count} file${count === 1 ? "" : "s"}`} state={activityState(item, streaming)}>
      <pre className="activity-output">{text || JSON.stringify(item.changes ?? {}, null, 2)}</pre>
    </ActivityDisclosure>;
  }
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") return <ActivityDisclosure icon="agent" label="Subagent activity" state={activityState(item, streaming)} defaultOpen={streaming}>
    <MarkdownContent text={text || safeJson(item)} streaming={streaming}/>
  </ActivityDisclosure>;
  if (item.type === "error") return <ActivityDisclosure icon="warning" label="Codex hit an issue" state="failed">
    <MarkdownContent text={text || String(item.message ?? "Codex reported an error")}/>
  </ActivityDisclosure>;
  return <div className="unknown-item"><span>Codex item: {item.type}</span><button onClick={onOpenCodex}>Copy ID & open Codex <Icon name="external" size={12}/></button></div>;
}

type ActivityState = "completed" | "active" | "failed";

function ActivityDisclosure({ icon, label, state, defaultOpen = false, children }: {
  icon: string;
  label: string;
  state: ActivityState;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  return <details className={`activity-item ${state}`} open={defaultOpen}>
    <summary>
      <span className="activity-icon"><Icon name={icon} size={13}/></span>
      <span className="activity-label">{label}</span>
      {state !== "completed" && <span className="activity-status">{state === "active" ? "Working" : "Needs attention"}</span>}
      <Icon name="chevron" size={12}/>
    </summary>
    <div className="activity-body">{children}</div>
  </details>;
}

function activityState(item: ThreadItem, streaming: boolean): ActivityState {
  const status = String(item.status ?? "").toLowerCase();
  if (status.includes("fail") || status.includes("error") || status.includes("declin")) return "failed";
  if (streaming || status.includes("progress") || status.includes("running") || status.includes("started")) return "active";
  return "completed";
}

function commandLabel(item: ThreadItem, state: ActivityState): string {
  const raw = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "command");
  const command = raw.replace(/\s+/g, " ").trim();
  const concise = command.length > 76 ? `${command.slice(0, 75)}…` : command;
  if (state === "active") return `Running ${concise}`;
  if (state === "failed") return `${concise} failed`;
  return `Ran ${concise}`;
}

function ApprovalCard({ request, onDecide }: {
  request: AppServerServerRequest;
  onDecide(input: ApprovalDecisionInput): Promise<void>;
}): ReactNode {
  const params = request.params as Record<string, unknown>;
  const label = request.method.includes("fileChange") ? "File change approval" : "Command approval";
  return <div className="approval-card">
    <div className="approval-title">{label}</div>
    <pre>{String(params.command ?? params.reason ?? "Codex needs your approval to continue.")}</pre>
    <div className="approval-actions">
      <button onClick={() => void onDecide({ id: request.id, method: request.method, decision: "decline" })}>Decline</button>
      <button onClick={() => void onDecide({ id: request.id, method: request.method, decision: "acceptForSession" })}>Allow for task</button>
      <button className="primary" onClick={() => void onDecide({ id: request.id, method: request.method, decision: "accept" })}>Allow</button>
    </div>
  </div>;
}

export function ForkComposer({ fork, parentTitle, parentWorktreeName, error, busy, onChange, onCancel, onCommit }: {
  fork: ForkDraft;
  parentTitle: string;
  parentWorktreeName: string | null;
  error: string | null;
  busy: boolean;
  onChange(next: ForkDraft): void;
  onCancel(): void;
  onCommit(): Promise<void>;
}): ReactNode {
  return <aside className="fork-surface" aria-label="Fork draft">
    <div className="fork-provenance"><Icon name="branch"/> Branched from <strong>{parentTitle}</strong></div>
    <button className="icon-button close-fork" onClick={onCancel} disabled={busy} aria-label="Cancel fork"><Icon name="close"/></button>
    <div className="fork-body">
      <div className="eyebrow">New direction</div>
      <h2>What should change from here?</h2>
      <textarea autoFocus value={fork.prompt} onChange={(event) => onChange({ ...fork, prompt: event.target.value })} placeholder="Describe this direction…" />
      <label className="worktree-choice">
        <input type="checkbox" checked={fork.createWorktree} disabled={Boolean(fork.preparedWorktree)} onChange={(event) => onChange({ ...fork, createWorktree: event.target.checked })}/>
        <span><strong>{fork.preparedWorktree ? `Prepared ${fork.preparedWorktree.name}` : "Create a new worktree"}</strong><small>{fork.preparedWorktree ? "This prepared Worktree will be reused when you retry." : "Isolate code changes for this direction. The Fork tree stays the same."}</small></span>
      </label>
      {!fork.createWorktree && <div className="current-workspace-note"><Icon name="folder"/> {parentWorktreeName ? `Continue in this worktree · ${parentWorktreeName}` : "Continue in the current workspace"}</div>}
      {error && <div className="fork-error"><Icon name="retry"/> {error}</div>}
    </div>
    <div className="fork-footer"><span>{busy ? "First Send in progress · this draft is locked" : "Esc to cancel · no Thread exists yet"}</span><button className="primary-button" disabled={!fork.prompt.trim() || busy} onClick={() => void onCommit()}>{busy ? "Creating…" : "Create & send"}</button></div>
  </aside>;
}

async function dataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment"));
    reader.readAsDataURL(file);
  });
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
