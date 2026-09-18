import type { AppServerServerRequest, CodexThread, CodexTurn, ReducedThread, ThreadItem, UserInput } from "@peel/codex-app-server";
import type { WorkspaceDiffSummary } from "@peel/git-workspace";
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";

import type { CodexNotice, ForkDraft, ServerRequestResponseInput, SpaceNode } from "../shared/contracts";
import { Icon } from "./icons";
import { itemText, itemTextFromKeys } from "./lib";
import { startPcmRecorder, type RecorderSession } from "./audio";
import { HighlightedCode, MarkdownContent } from "./Markdown";
import { voiceFailurePresentation, type VoiceFailurePresentation } from "./voice-error";
import { requestTurnId, ServerRequestCard } from "./ServerRequestCard";
import { commitTranscriptUpdates, recordItemRender, recordTranscriptBackfill, recordTranscriptRange, recordTurnRender, transcriptSnapshotMode } from "./transcript-performance";
import {
  TRANSCRIPT_BACKFILL_THRESHOLD_PX,
  appendTranscriptRange,
  initialTranscriptRange,
  prependTranscriptRange,
  rangeContains,
  type TranscriptRange,
  type TranscriptScrollAnchor,
} from "./transcript-window";

interface TranscriptProps {
  thread: CodexThread;
  reduced: ReducedThread | null;
  node: SpaceNode;
  diff: WorkspaceDiffSummary | null;
  draft: string;
  requests: AppServerServerRequest[];
  notices: CodexNotice[];
  highlightTurnId: string | null;
  hasSavedScroll: boolean;
  restoreScrollTop: number;
  restoreScrollAnchor: TranscriptScrollAnchor | null;
  onHighlightScrolled(turnId: string): void;
  onDraft(value: string): void;
  onScroll(value: { scrollTop: number; scrollAnchor: TranscriptScrollAnchor | null }): void;
  onSend(input: UserInput[]): Promise<void>;
  onBranch(turn: CodexTurn): void;
  onRequestResponse(input: ServerRequestResponseInput): Promise<void>;
  onDiff(): void;
  onOpenCodex(): void;
}

const EMPTY_REQUESTS: AppServerServerRequest[] = [];
const EMPTY_NOTICES: CodexNotice[] = [];

function groupByTurn<T>(items: T[], turnIdOf: (item: T) => string | null): Map<string | null, T[]> {
  const grouped = new Map<string | null, T[]>();
  for (const item of items) {
    const turnId = turnIdOf(item);
    const group = grouped.get(turnId);
    if (group) group.push(item);
    else grouped.set(turnId, [item]);
  }
  return grouped;
}

function measureViewportAnchor(element: HTMLElement): TranscriptScrollAnchor | null {
  const viewport = element.getBoundingClientRect();
  const probeX = Math.min(viewport.right - 2, viewport.left + viewport.width / 2);
  for (const offset of [2, 18, 48]) {
    const candidate = document.elementFromPoint(probeX, Math.min(viewport.bottom - 2, viewport.top + offset));
    const target = candidate?.closest<HTMLElement>("[data-turn-id]");
    const turnId = target?.dataset.turnId;
    if (target && turnId && element.contains(target)) {
      return { turnId, offset: target.getBoundingClientRect().top - viewport.top };
    }
  }
  const turns = [...element.querySelectorAll<HTMLElement>("[data-turn-id]")];
  const target = turns.find((turn) => turn.getBoundingClientRect().bottom > viewport.top + 1) ?? turns.at(-1);
  const turnId = target?.dataset.turnId;
  if (!target || !turnId) return null;
  return { turnId, offset: target.getBoundingClientRect().top - viewport.top };
}

function restoreViewportAnchor(element: HTMLElement, anchor: TranscriptScrollAnchor): void {
  const target = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.turnId)}"]`);
  if (!target) return;
  const viewportTop = element.getBoundingClientRect().top;
  element.scrollTop += target.getBoundingClientRect().top - viewportTop - anchor.offset;
}

export function Transcript({
  thread,
  reduced,
  node,
  diff,
  draft,
  requests,
  notices,
  highlightTurnId,
  hasSavedScroll,
  restoreScrollTop,
  restoreScrollAnchor,
  onHighlightScrolled,
  onDraft,
  onScroll,
  onSend,
  onBranch,
  onRequestResponse,
  onDiff,
  onOpenCodex,
}: TranscriptProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const fullTranscriptMount = transcriptSnapshotMode() === "baseline";
  const initialRange = useRef<TranscriptRange | null>(null);
  if (!initialRange.current) initialRange.current = initialTranscriptRange({
    turnIds: thread.turns.map((turn) => turn.id),
    fullMount: fullTranscriptMount,
    highlightTurnId,
    restoreAnchor: restoreScrollAnchor,
    hasSavedScroll,
    restoreScrollTop,
  });
  const [mountedRange, setMountedRange] = useState<TranscriptRange>(initialRange.current);
  const tailWindow = useRef(mountedRange.end >= thread.turns.length);
  const rangeBusy = useRef(false);
  const restoreAllHistory = useRef(false);
  const pendingRangeChange = useRef<{
    anchor: TranscriptScrollAnchor | null;
    startedAt: number;
    direction: "prepend" | "append";
    addedTurns: number;
  } | null>(null);
  const stableViewportAnchor = useRef<TranscriptScrollAnchor | null>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const observedRange = useRef<TranscriptRange>({ start: mountedRange.start, end: mountedRange.end });
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
  const followBottom = useRef(!hasSavedScroll && !highlightTurnId);
  const restoredScroll = useRef(false);
  const acknowledgedHighlight = useRef<string | null>(null);
  draftRef.current = draft;

  const totalTurns = thread.turns.length;
  const mountedStart = fullTranscriptMount ? 0 : Math.min(mountedRange.start, totalTurns);
  const mountedEnd = fullTranscriptMount || tailWindow.current
    ? totalTurns
    : Math.min(mountedRange.end, totalTurns);
  const mountedTurns = thread.turns.slice(mountedStart, mountedEnd);

  const rememberViewportAnchor = useCallback((): TranscriptScrollAnchor | null => {
    const element = scroller.current;
    const anchor = element ? measureViewportAnchor(element) : null;
    stableViewportAnchor.current = anchor;
    return anchor;
  }, []);

  const changeMountedRange = useCallback((direction: "prepend" | "append"): void => {
    if (fullTranscriptMount || rangeBusy.current) return;
    const current = { start: mountedStart, end: mountedEnd };
    const next = direction === "prepend"
      ? prependTranscriptRange(current)
      : appendTranscriptRange(current, totalTurns);
    if (next.start === current.start && next.end === current.end) return;
    pendingRangeChange.current = {
      anchor: rememberViewportAnchor(),
      startedAt: performance.now(),
      direction,
      addedTurns: current.start - next.start + next.end - current.end,
    };
    rangeBusy.current = true;
    if (next.end >= totalTurns) tailWindow.current = true;
    startTransition(() => setMountedRange(next));
  }, [fullTranscriptMount, mountedEnd, mountedStart, rememberViewportAnchor, totalTurns]);

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
    element.style.height = `${Math.min(130, Math.max(32, element.scrollHeight))}px`;
  }, [draft]);

  useLayoutEffect(() => {
    if (fullTranscriptMount || !highlightTurnId) return;
    const targetIndex = thread.turns.findIndex((turn) => turn.id === highlightTurnId);
    if (targetIndex < 0 || rangeContains({ start: mountedStart, end: mountedEnd }, targetIndex)) return;
    const next = initialTranscriptRange({
      turnIds: thread.turns.map((turn) => turn.id),
      fullMount: false,
      highlightTurnId,
      restoreAnchor: null,
      hasSavedScroll: false,
      restoreScrollTop: 0,
    });
    tailWindow.current = next.end >= totalTurns;
    setMountedRange(next);
  }, [fullTranscriptMount, highlightTurnId, mountedEnd, mountedStart, thread.turns, totalTurns]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const pending = pendingRangeChange.current;
    if (!element || !pending) return;
    let residualAnchorDeltaPx = 0;
    if (pending.anchor) {
      const target = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(pending.anchor.turnId)}"]`);
      if (target) {
        const viewportTop = element.getBoundingClientRect().top;
        const currentOffset = target.getBoundingClientRect().top - viewportTop;
        element.scrollTop += currentOffset - pending.anchor.offset;
        residualAnchorDeltaPx = Math.abs(target.getBoundingClientRect().top - viewportTop - pending.anchor.offset);
      }
    }
    recordTranscriptBackfill({
      threadId: thread.id,
      direction: pending.direction,
      durationMs: performance.now() - pending.startedAt,
      addedTurns: pending.addedTurns,
      anchorDeltaPx: residualAnchorDeltaPx,
    });
    pendingRangeChange.current = null;
    rangeBusy.current = false;
    stableViewportAnchor.current = pending.anchor ?? measureViewportAnchor(element);
  }, [mountedRange.end, mountedRange.start, thread.id]);

  useLayoutEffect(() => {
    recordTranscriptRange(thread.id, mountedTurns.length, totalTurns);
  }, [mountedTurns.length, thread.id, totalTurns]);

  useEffect(() => {
    if (fullTranscriptMount || tailWindow.current || mountedEnd >= totalTurns) return;
    const timer = window.setTimeout(() => changeMountedRange("append"), 32);
    return () => window.clearTimeout(timer);
  }, [changeMountedRange, fullTranscriptMount, mountedEnd, totalTurns]);

  useEffect(() => {
    if (!restoreAllHistory.current || fullTranscriptMount) return;
    if (mountedStart <= 0) {
      restoreAllHistory.current = false;
      return;
    }
    const timer = window.setTimeout(() => changeMountedRange("prepend"), 16);
    return () => window.clearTimeout(timer);
  }, [changeMountedRange, fullTranscriptMount, mountedStart]);

  useLayoutEffect(() => {
    commitTranscriptUpdates(thread.id);
  }, [thread, reduced, thread.id]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !followBottom.current) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && element.contains(selection.anchorNode)) return;
    element.scrollTop = element.scrollHeight;
    rememberViewportAnchor();
  }, [thread, reduced]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (!highlightTurnId) {
      acknowledgedHighlight.current = null;
      if (restoredScroll.current) return;
      if (!hasSavedScroll) element.scrollTop = element.scrollHeight;
      else if (restoreScrollAnchor) restoreViewportAnchor(element, restoreScrollAnchor);
      else element.scrollTop = restoreScrollTop;
      followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
      restoredScroll.current = true;
      rememberViewportAnchor();
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
    rememberViewportAnchor();
  }, [hasSavedScroll, highlightTurnId, mountedEnd, mountedStart, onHighlightScrolled, rememberViewportAnchor, restoreScrollAnchor, restoreScrollTop, thread.id]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let initialized = false;
    const observer = new ResizeObserver(() => {
      if (!initialized) {
        initialized = true;
        rememberViewportAnchor();
        return;
      }
      if (followBottom.current) {
        element.scrollTop = element.scrollHeight;
        rememberViewportAnchor();
        return;
      }
      const anchor = stableViewportAnchor.current;
      if (anchor) restoreViewportAnchor(element, anchor);
      rememberViewportAnchor();
    });
    resizeObserver.current = observer;
    element.querySelectorAll<HTMLElement>("[data-turn-id]").forEach((turn) => observer.observe(turn));
    observedRange.current = { start: mountedStart, end: mountedEnd };
    return () => {
      observer.disconnect();
      if (resizeObserver.current === observer) resizeObserver.current = null;
    };
  }, [rememberViewportAnchor, thread.id]);

  useEffect(() => {
    const element = scroller.current;
    const observer = resizeObserver.current;
    if (!element || !observer) return;
    const previous = observedRange.current;
    const additions = previous.end < mountedStart || previous.start > mountedEnd
      ? thread.turns.slice(mountedStart, mountedEnd)
      : [
        ...thread.turns.slice(mountedStart, Math.min(previous.start, mountedEnd)),
        ...thread.turns.slice(Math.max(previous.end, mountedStart), mountedEnd),
      ];
    for (const turn of additions) {
      const target = element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"]`);
      if (target) observer.observe(target);
    }
    observedRange.current = { start: mountedStart, end: mountedEnd };
  }, [mountedEnd, mountedStart, thread.turns]);

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
  const reducedByTurn = useMemo(() => new Map(reduced?.turns.map((turn) => [turn.turn.id, turn]) ?? []), [reduced?.turns]);
  const requestsByTurn = useMemo(() => groupByTurn(requests, requestTurnId), [requests]);
  const noticesByTurn = useMemo(() => groupByTurn(notices, (notice) => notice.turnId), [notices]);
  return <div className="transcript-column">
    <div
      className="transcript"
      ref={scroller}
      data-mounted-turns={mountedTurns.length}
      data-total-turns={totalTurns}
      onScroll={(event) => {
      const element = event.currentTarget;
      followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
      const scrollAnchor = rememberViewportAnchor();
      onScroll({ scrollTop: element.scrollTop, scrollAnchor });
      if (element.scrollTop <= TRANSCRIPT_BACKFILL_THRESHOLD_PX && mountedStart > 0) changeMountedRange("prepend");
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
      {mountedStart > 0 && <button
        type="button"
        className="transcript-history-boundary"
        onClick={() => {
          restoreAllHistory.current = true;
          changeMountedRange("prepend");
        }}
      >Load earlier messages <span>{mountedStart} remaining</span></button>}
      {mountedTurns.map((turn) => <MemoizedTurnView
        key={turn.id}
        turn={turn}
        reduced={reducedByTurn.get(turn.id) ?? null}
        highlighted={turn.id === highlightTurnId}
        onBranch={onBranch}
        onOpenCodex={onOpenCodex}
        requests={requestsByTurn.get(turn.id) ?? EMPTY_REQUESTS}
        notices={noticesByTurn.get(turn.id) ?? EMPTY_NOTICES}
        onRequestResponse={onRequestResponse}
      />)}
      {mountedEnd < totalTurns && <div className="transcript-history-progress" role="status">Restoring newer messages…</div>}
      {(noticesByTurn.get(null) ?? EMPTY_NOTICES).map((notice) => <NoticeCard key={notice.id} notice={notice}/>)}
      {(requestsByTurn.get(null) ?? EMPTY_REQUESTS).map((request) => <ServerRequestCard key={String(request.id)} request={request} onRespond={onRequestResponse}/>)}
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

interface TurnViewProps {
  turn: CodexTurn;
  reduced: ReducedThread["turns"][number] | null;
  highlighted: boolean;
  requests: AppServerServerRequest[];
  notices: CodexNotice[];
  onBranch(turn: CodexTurn): void;
  onOpenCodex(): void;
  onRequestResponse(input: ServerRequestResponseInput): Promise<void>;
}

function TurnView({ turn, reduced, highlighted, requests, notices, onBranch, onOpenCodex, onRequestResponse }: TurnViewProps): ReactNode {
  recordTurnRender(turn.id);
  const items = reduced?.items ?? turn.items.map((item) => ({
    item,
    completed: true,
    streamedText: "",
    streamedReasoningContent: "",
    streamedReasoningSummarySections: [],
  }));
  const branch = useCallback(() => onBranch(turn), [onBranch, turn]);
  return <section className={`turn ${highlighted ? "highlighted" : ""}`} data-turn-id={turn.id}>
    {items.map(({ item, streamedText, streamedReasoningContent, completed }) => <MemoizedItemView
      key={item.id}
      item={item}
      streamedText={streamedText}
      streamedReasoningContent={streamedReasoningContent}
      streaming={!completed}
      onOpenCodex={onOpenCodex}
    />) }
    {notices.map((notice) => <NoticeCard key={notice.id} notice={notice}/>)}
    {turn.error !== null && turn.error !== undefined && <TurnErrorDetail error={turn.error}/>}
    {requests.map((request) => <ServerRequestCard key={String(request.id)} request={request} onRespond={onRequestResponse}/>)}
    <TurnActions status={turn.status} onBranch={branch}/>
  </section>;
}

const MemoizedTurnView = memo(TurnView, turnViewPropsEqual);

export function turnViewPropsEqual(previous: TurnViewProps, next: TurnViewProps): boolean {
  return previous.turn === next.turn
    && previous.reduced === next.reduced
    && previous.highlighted === next.highlighted
    && previous.onBranch === next.onBranch
    && previous.onOpenCodex === next.onOpenCodex
    && previous.onRequestResponse === next.onRequestResponse
    && structurallyEqualLists(previous.requests, next.requests)
    && structurallyEqualLists(previous.notices, next.notices);
}

function structurallyEqualLists(left: unknown[], right: unknown[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index] || safeJson(value) === safeJson(right[index]));
}

export function TurnActions({ status, onBranch }: { status: CodexTurn["status"]; onBranch(): void }): ReactNode {
  return <div className="turn-actions">
    <span>{status === "inProgress" ? "Working" : status === "failed" ? "Needs attention" : status === "interrupted" ? "Stopped" : ""}</span>
    {status === "completed" && <button type="button" onClick={onBranch}><Icon name="branch" size={14}/> Branch from here</button>}
  </div>;
}

export function ItemView({ item, streamedText, streamedReasoningContent = "", streaming, onOpenCodex }: {
  item: ThreadItem;
  streamedText: string;
  streamedReasoningContent?: string;
  streaming: boolean;
  onOpenCodex(): void;
}): ReactNode {
  recordItemRender(item.id);
  const completedText = item.type === "reasoning"
    ? itemTextFromKeys(item, ["summary", "content", "text", "message"], "\n\n")
    : itemText(item);
  const text = completedText + streamedText;
  if (item.type === "userMessage") return <article className="message user-message"><MarkdownContent text={text || "User message"} className="user-markdown" performanceId={item.id}/></article>;
  if (item.type === "agentMessage") return <article className="message agent-message"><MarkdownContent text={text} streaming={streaming} performanceId={item.id}/></article>;
  if (item.type === "plan") return <ActivityDisclosure icon="more" label={streaming ? "Planning" : "Plan"} state={activityState(item, streaming)} defaultOpen={streaming}>
    <MarkdownContent text={text || "Plan"} streaming={streaming} performanceId={item.id}/>
  </ActivityDisclosure>;
  if (item.type === "reasoning") return <ActivityDisclosure icon="reasoning" label={streaming ? "Thinking" : "Reasoning"} state={activityState(item, streaming)} defaultOpen={streaming} kind="reasoning">
    <MarkdownContent text={text || streamedReasoningContent || "Reasoning activity"} streaming={streaming} performanceId={item.id}/>
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
    <MarkdownContent text={text || safeJson(item)} streaming={streaming} performanceId={item.id}/>
  </ActivityDisclosure>;
  if (item.type === "error") return <ActivityDisclosure icon="warning" label="Something needs attention" state="failed">
    <MarkdownContent text={text || String(item.message ?? "Codex reported an error")} performanceId={item.id}/>
  </ActivityDisclosure>;
  return <ActivityDisclosure icon="more" label="Additional Codex activity" state={activityState(item, streaming)} kind="technical">
    <TechnicalOutput sections={[{ label: item.type, value: text || safeJson(item) }]}/>
    <button className="open-codex-item" onClick={onOpenCodex}>Open in Codex <Icon name="external" size={12}/></button>
  </ActivityDisclosure>;
}

const MemoizedItemView = memo(ItemView);

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
  if (!text.trim()) return "";
  const normalizedCommand = command.trim();
  if (text.trim() === normalizedCommand) return "";
  if (text.startsWith(`${normalizedCommand}\n`)) return text.slice(normalizedCommand.length + 1);
  return text;
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

function NoticeCard({ notice }: { notice: CodexNotice }): ReactNode {
  return <aside className={`codex-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
    <strong>{notice.kind === "error" ? "Codex encountered a problem" : "Codex warning"}</strong>
    <p>{notice.message}</p>
    {notice.willRetry && <small>Codex will retry this Turn.</small>}
  </aside>;
}

function TurnErrorDetail({ error }: { error: unknown }): ReactNode {
  const record = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : {};
  const message = typeof record.message === "string" ? record.message : typeof error === "string" ? error : "This Turn did not complete.";
  return <aside className="codex-notice error persisted-turn-error" role="alert">
    <strong>Turn failed</strong>
    <p>{message}</p>
    <small>The failure detail remains available in this conversation.</small>
  </aside>;
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
