import type { AppServerServerRequest, CodexThread, CodexTurn, ReducedThread, ThreadItem, UserInput } from "@peel/codex-app-server";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { ApprovalDecisionInput, ForkDraft, SpaceNode } from "../shared/contracts";
import { Icon } from "./icons";
import { itemText } from "./lib";
import { startPcmRecorder, type RecorderSession } from "./audio";
import { HighlightedCode, MarkdownContent } from "./Markdown";
import { voiceFailurePresentation, type VoiceFailurePresentation } from "./voice-error";

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
  const [voiceFeedback, setVoiceFeedback] = useState<VoiceFailurePresentation | null>(null);
  const [voiceLevels, setVoiceLevels] = useState<number[]>(() => Array.from({ length: 17 }, () => 0));
  const [recordingMs, setRecordingMs] = useState(0);
  const recorder = useRef<RecorderSession | null>(null);
  const dictationEngine = useRef<"codex-realtime" | "native-fallback" | null>(null);
  const dictationThreadId = useRef<string | null>(null);
  const audioQueue = useRef<Promise<void>>(Promise.resolve());
  const audioError = useRef<unknown>(null);
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
    const activeThreadId = dictationThreadId.current;
    if (activeThreadId) void window.peel.cancelDictation(activeThreadId);
  }, []);

  useEffect(() => () => {
    recorder.current?.cancel();
    recorder.current = null;
    if (dictationThreadId.current === thread.id) void window.peel.cancelDictation(thread.id);
    dictationEngine.current = null;
    dictationThreadId.current = null;
    audioQueue.current = Promise.resolve();
    audioError.current = null;
    if (mounted.current) {
      setVoice("idle");
      setVoiceLevels(Array.from({ length: 17 }, () => 0));
      setRecordingMs(0);
      setVoiceFeedback(null);
    }
  }, [thread.id]);

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
    setVoiceFeedback(null);
    if (voice === "recording" && recorder.current) {
      setVoice("transcribing");
      setVoiceLevels(Array.from({ length: 17 }, () => 0));
      try {
        const wav = await recorder.current.stop();
        recorder.current = null;
        let result;
        if (dictationEngine.current === "codex-realtime") {
          await audioQueue.current;
          if (audioError.current) throw audioError.current;
          result = await window.peel.finishDictation(thread.id);
        } else {
          result = await window.peel.transcribeWav(wav);
        }
        if (!mounted.current) return;
        const latestDraft = draftRef.current;
        onDraft([latestDraft.trimEnd(), result.text].filter(Boolean).join(latestDraft.trim() ? " " : ""));
      } catch (error) {
        const activeThreadId = dictationThreadId.current;
        if (activeThreadId) await window.peel.cancelDictation(activeThreadId);
        if (!mounted.current) return;
        setVoiceFeedback(voiceFailurePresentation(error));
      } finally {
        dictationEngine.current = null;
        dictationThreadId.current = null;
        audioQueue.current = Promise.resolve();
        audioError.current = null;
        if (mounted.current) setVoice("idle");
      }
      return;
    }
    try {
      const started = await window.peel.beginDictation(thread.id);
      dictationEngine.current = started.engine;
      dictationThreadId.current = thread.id;
      audioQueue.current = Promise.resolve();
      audioError.current = null;
      const session = await startPcmRecorder((message) => {
        if (!mounted.current) return;
        recorder.current = null;
        setVoice("idle");
        setVoiceLevels(Array.from({ length: 17 }, () => 0));
        setVoiceFeedback(voiceFailurePresentation(message));
        const activeThreadId = dictationThreadId.current;
        if (activeThreadId) void window.peel.cancelDictation(activeThreadId);
        dictationEngine.current = null;
        dictationThreadId.current = null;
      }, (level) => {
        if (!mounted.current) return;
        setVoiceLevels((current) => [...current.slice(1), level]);
      }, (chunk) => {
        if (dictationEngine.current !== "codex-realtime" || dictationThreadId.current !== thread.id) return;
        audioQueue.current = audioQueue.current
          .then(async () => await window.peel.appendDictationAudio({ threadId: thread.id, ...chunk }))
          .catch((error) => {
            audioError.current ??= error;
            if (!mounted.current || dictationThreadId.current !== thread.id) return;
            recorder.current?.cancel();
            recorder.current = null;
            void window.peel.cancelDictation(thread.id);
            dictationEngine.current = null;
            dictationThreadId.current = null;
            setVoiceLevels(Array.from({ length: 17 }, () => 0));
            setVoiceFeedback(voiceFailurePresentation(error));
            setVoice("idle");
          });
      });
      if (!mounted.current) {
        session.cancel();
        await window.peel.cancelDictation(thread.id);
        return;
      }
      recorder.current = session;
      setVoiceLevels(Array.from({ length: 17 }, () => 0));
      setVoice("recording");
    } catch (error) {
      if (dictationThreadId.current) await window.peel.cancelDictation(dictationThreadId.current);
      dictationEngine.current = null;
      dictationThreadId.current = null;
      audioQueue.current = Promise.resolve();
      audioError.current = null;
      if (!mounted.current) return;
      setVoiceFeedback(voiceFailurePresentation(error));
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
      {voiceFeedback && <div className={voiceFeedback.tone === "notice" ? "composer-notice" : "composer-error"} role={voiceFeedback.tone === "notice" ? "status" : "alert"}>{voiceFeedback.message}</div>}
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
          <button className={`send-button ${sending ? "sending" : ""}`} onClick={() => void submit()} disabled={sending || voice !== "idle" || (!draft.trim() && attachments.length === 0)} aria-label={sending ? "Sending" : "Send"} title="Send message"><Icon name={sending ? "spinner" : "arrowUp"}/></button>
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
      <span>{turn.status === "inProgress" ? "Working" : turn.status === "failed" ? "Needs attention" : turn.status === "interrupted" ? "Stopped" : ""}</span>
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
  if (item.type === "reasoning") return <ActivityDisclosure icon="reasoning" label={streaming ? "Thinking" : "Reasoning"} state={activityState(item, streaming)} defaultOpen={streaming} kind="reasoning">
    <MarkdownContent text={text || "Reasoning activity"} streaming={streaming}/>
  </ActivityDisclosure>;
  if (item.type === "commandExecution") {
    const state = activityState(item, streaming);
    const command = commandText(item);
    const output = commandOutput(text, command);
    return <ActivityDisclosure icon="terminal" label={commandLabel(state)} state={state} defaultOpen={state === "active"} kind="technical">
      <TechnicalOutput sections={[
        { label: "Command", value: command, language: "shell" },
        ...(output ? [{ label: state === "failed" ? "Error output" : "Output", value: output }] : []),
      ]}/>
    </ActivityDisclosure>;
  }
  if (item.type === "fileChange") {
    const sections = fileChangeSections(item, text);
    return <ActivityDisclosure icon="file" label={fileChangeLabel(sections)} state={activityState(item, streaming)} kind="technical">
      <TechnicalOutput sections={sections}/>
    </ActivityDisclosure>;
  }
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") return <ActivityDisclosure icon="agent" label={streaming ? "A subagent is working" : "Worked with a subagent"} state={activityState(item, streaming)} defaultOpen={streaming}>
    <MarkdownContent text={text || safeJson(item)} streaming={streaming}/>
  </ActivityDisclosure>;
  if (item.type === "error") return <ActivityDisclosure icon="warning" label="Something needs attention" state="failed">
    <MarkdownContent text={text || String(item.message ?? "Codex reported an error")}/>
  </ActivityDisclosure>;
  return <ActivityDisclosure icon="more" label="Additional Codex activity" state={activityState(item, streaming)} kind="technical">
    <TechnicalOutput sections={[{ label: item.type, value: text || safeJson(item) }]}/>
    <button className="open-codex-item" onClick={onOpenCodex}>Open in Codex <Icon name="external" size={12}/></button>
  </ActivityDisclosure>;
}

type ActivityState = "completed" | "active" | "failed";

function ActivityDisclosure({ icon, label, state, defaultOpen = false, kind = "standard", children }: {
  icon: string;
  label: string;
  state: ActivityState;
  defaultOpen?: boolean;
  kind?: "standard" | "reasoning" | "technical";
  children: ReactNode;
}): ReactNode {
  return <details className={`activity-item ${state} ${kind}`} open={defaultOpen}>
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

function commandLabel(state: ActivityState): string {
  if (state === "active") return "Running a command";
  if (state === "failed") return "Command needs attention";
  return "Ran a command";
}

function commandText(item: ThreadItem): string {
  return Array.isArray(item.command) ? item.command.map(String).join(" ") : String(item.command ?? "Command");
}

function commandOutput(text: string, command: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed === command.trim()) return "";
  if (trimmed.startsWith(`${command.trim()}\n`)) return trimmed.slice(command.trim().length + 1);
  return trimmed;
}

interface TechnicalSection { label: string; value: string; language?: string }

function TechnicalOutput({ sections }: { sections: TechnicalSection[] }): ReactNode {
  const visible = sections.filter((section) => section.value.trim());
  return <div className="technical-output">{visible.map((section, index) => <section key={`${section.label}-${index}`}>
    <header><span>{section.label}</span><span>{lineCount(section.value)} line{lineCount(section.value) === 1 ? "" : "s"}</span></header>
    <pre><code className={section.language ? `language-${section.language}` : undefined}><HighlightedCode code={section.value} language={section.language ?? "plain text"}/></code></pre>
  </section>)}</div>;
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function fileChangeSections(item: ThreadItem, fallback: string): TechnicalSection[] {
  if (!Array.isArray(item.changes)) return [{ label: "Changes", value: fallback || safeJson(item.changes ?? {}) }];
  return item.changes.map((change, index) => {
    if (!change || typeof change !== "object") return { label: `Change ${index + 1}`, value: String(change) };
    const record = change as Record<string, unknown>;
    const label = typeof record.path === "string" ? record.path : `Change ${index + 1}`;
    const value = [record.diff, record.patch, record.content].find((candidate) => typeof candidate === "string");
    return { label, value: typeof value === "string" ? value : safeJson(record), language: "diff" };
  });
}

function fileChangeLabel(sections: TechnicalSection[]): string {
  if (sections.length === 1 && sections[0]?.label && sections[0].label !== "Changes") return `Updated ${sections[0].label}`;
  return `Updated ${sections.length} file${sections.length === 1 ? "" : "s"}`;
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
