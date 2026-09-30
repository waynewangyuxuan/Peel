import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { MarkdownContent } from "./Markdown";
import { StreamdownPrototype } from "./StreamdownPrototype";
import {
  buildBenchmarkTurns,
  expectedCopiedCode,
  oversizedMarkdown,
  renderingCorpus,
  streamingBenchmarkText,
  type BenchmarkTurn,
} from "./rendering-benchmark-corpus";

export type BenchmarkRenderer = "current" | "streamdown";

export interface RenderingBenchmarkResult {
  renderer: BenchmarkRenderer;
  environment: {
    userAgent: string;
    productionBuild: boolean;
    threadReadMs: number;
  };
  firstContent: { coldMs: number; warmMs: number };
  transcriptMounts: Array<{
    turns: number;
    reducerMs: number;
    markdownAndCommitMs: number;
    commitAndPaintMs: number;
    paintAfterCommitMs: number;
    domNodes: number;
    heapDeltaBytes: number | null;
    heapRetainedAfterUnmountBytes: number | null;
    longTaskMs: number;
  }>;
  sessionSwitch: {
    fromTurns: number;
    toTurns: number;
    markdownAndCommitMs: number;
    commitAndPaintMs: number;
    paintAfterCommitMs: number;
    domNodes: number;
  };
  streaming: {
    updates: number;
    totalMs: number;
    p95FrameMs: number;
    p99FrameMs: number;
    longTaskMs: number;
    historicalRowRenders: number;
    tailRowRenders: number;
    domNodes: number;
  };
  correctness: {
    katexBlocks: number;
    remoteImages: number;
    unsafeScriptExecuted: boolean;
    unsafeImageExecuted: boolean;
    corpusCases: number;
    embeddedImages: number;
    clippedMathBlocks: number;
    pageFits: boolean;
    partialTextPresent: boolean;
    safeLinksHardened: boolean;
    remoteImageLinkPresent: boolean;
    exactCodeText: boolean;
    codeCopyControl: boolean;
    oversizedFallback: boolean;
    errorFallback: boolean;
  };
}

interface ViewState {
  renderer: BenchmarkRenderer;
  turns: BenchmarkTurn[];
  streamingTail: boolean;
  corpus: boolean;
  oversized: boolean;
  simulateFailure: boolean;
  version: number;
}

interface RenderTiming {
  markdownAndCommitMs: number;
  commitAndPaintMs: number;
  paintAfterCommitMs: number;
}

const initialView: ViewState = {
  renderer: "current",
  turns: [],
  streamingTail: false,
  corpus: false,
  oversized: false,
  simulateFailure: false,
  version: 0,
};

const rowRenderCounts = new Map<string, number>();

export function RenderingBenchmarkApp(): ReactNode {
  const [view, setView] = useState<ViewState>(initialView);
  const [status, setStatus] = useState("Ready");
  const [lastResult, setLastResult] = useState<RenderingBenchmarkResult | null>(null);
  const commitResolvers = useRef(new Map<number, { started: number; resolve: (duration: number) => void }>());
  const version = useRef(0);

  useLayoutEffect(() => {
    const pending = commitResolvers.current.get(view.version);
    if (pending) {
      commitResolvers.current.delete(view.version);
      pending.resolve(performance.now() - pending.started);
    }
  }, [view]);

  const renderAndPaint = useCallback(async (next: Omit<ViewState, "version">): Promise<RenderTiming> => {
    const nextVersion = ++version.current;
    const started = performance.now();
    const committed = new Promise<number>((resolve) => commitResolvers.current.set(nextVersion, { started, resolve }));
    flushSync(() => setView({ ...next, version: nextVersion }));
    const markdownAndCommitMs = await committed;
    await animationFrame();
    await animationFrame();
    const commitAndPaintMs = performance.now() - started;
    return { markdownAndCommitMs, commitAndPaintMs, paintAfterCommitMs: commitAndPaintMs - markdownAndCommitMs };
  }, []);

  const runSuite = useCallback(async (renderer: BenchmarkRenderer): Promise<RenderingBenchmarkResult> => {
    setStatus(`Running ${renderer}…`);
    const longTasks = new LongTaskCollector();
    longTasks.start();
    const empty = (): Omit<ViewState, "version"> => ({ ...initialView, renderer });

    await renderAndPaint(empty());
    const coldMs = (await renderAndPaint({ ...empty(), turns: buildBenchmarkTurns(10) })).commitAndPaintMs;
    await renderAndPaint(empty());
    const warmMs = (await renderAndPaint({ ...empty(), turns: buildBenchmarkTurns(10) })).commitAndPaintMs;

    const transcriptMounts: RenderingBenchmarkResult["transcriptMounts"] = [];
    for (const turns of [10, 100, 500]) {
      await renderAndPaint(empty());
      const heapBefore = heapSize();
      const reducerStarted = performance.now();
      const messages = buildBenchmarkTurns(turns);
      const reducerMs = performance.now() - reducerStarted;
      const longTaskStart = longTasks.snapshot();
      const renderTiming = await renderAndPaint({ ...empty(), turns: messages });
      const heapAfterMount = heapSize();
      const domNodes = benchmarkNodeCount();
      await renderAndPaint(empty());
      forceGarbageCollection();
      await animationFrame();
      transcriptMounts.push({
        turns,
        reducerMs,
        ...renderTiming,
        domNodes,
        heapDeltaBytes: heapDelta(heapBefore, heapAfterMount),
        heapRetainedAfterUnmountBytes: heapDelta(heapBefore, heapSize()),
        longTaskMs: longTasks.snapshot() - longTaskStart,
      });
    }

    await renderAndPaint({ ...empty(), turns: buildBenchmarkTurns(10) });
    const sessionSwitchTiming = await renderAndPaint({ ...empty(), turns: buildBenchmarkTurns(500) });
    const sessionSwitch = {
      fromTurns: 10,
      toTurns: 500,
      ...sessionSwitchTiming,
      domNodes: benchmarkNodeCount(),
    };

    const baseTurns = buildBenchmarkTurns(100);
    const tailId = baseTurns.at(-1)!.id;
    await renderAndPaint({ ...empty(), turns: baseTurns, streamingTail: true });
    rowRenderCounts.clear();
    const frameIntervals: number[] = [];
    const updateCount = 36;
    const streamStarted = performance.now();
    const streamLongTaskStart = longTasks.snapshot();
    let previousFrame = streamStarted;
    for (let index = 1; index <= updateCount; index += 1) {
      const end = Math.max(1, Math.floor(streamingBenchmarkText.length * index / updateCount));
      const turns = [...baseTurns.slice(0, -1), { ...baseTurns.at(-1)!, text: streamingBenchmarkText.slice(0, end) }];
      await renderAndPaint({ ...empty(), turns, streamingTail: true });
      const now = performance.now();
      frameIntervals.push(now - previousFrame);
      previousFrame = now;
    }
    const totalMs = performance.now() - streamStarted;
    await animationFrame();
    const streamLongTaskMs = longTasks.snapshot() - streamLongTaskStart;
    const streamDomNodes = benchmarkNodeCount();
    const historicalRowRenders = [...rowRenderCounts.entries()]
      .filter(([id]) => id !== tailId)
      .reduce((sum, [, count]) => sum + count, 0);

    await renderAndPaint({ ...empty(), corpus: true });
    const correctnessRoot = document.querySelector("[data-benchmark-surface]")!;
    const mathBlocks = [...correctnessRoot.querySelectorAll<HTMLElement>(".katex-display")];
    const unsafeWindow = window as Window & { __peelUnsafeHtmlExecuted?: boolean; __peelUnsafeImageExecuted?: boolean };
    const links = [...correctnessRoot.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')];
    const codeBlocks = [...correctnessRoot.querySelectorAll<HTMLElement>("pre code")];
    const copyControl = correctnessRoot.querySelector<HTMLButtonElement>(
      renderer === "current" ? ".copy-code" : '[data-streamdown="code-block-copy-button"]',
    );
    copyControl?.click();
    await animationFrame();
    const correctness = {
      katexBlocks: mathBlocks.length,
      remoteImages: correctnessRoot.querySelectorAll('img[src^="http"]').length,
      unsafeScriptExecuted: unsafeWindow.__peelUnsafeHtmlExecuted === true,
      unsafeImageExecuted: unsafeWindow.__peelUnsafeImageExecuted === true,
      corpusCases: correctnessRoot.querySelectorAll("[data-corpus-case]").length,
      embeddedImages: correctnessRoot.querySelectorAll('img[src^="data:image/"]').length,
      clippedMathBlocks: mathBlocks.filter(mathBlockIsClipped).length,
      pageFits: document.documentElement.scrollWidth === document.documentElement.clientWidth,
      partialTextPresent: correctnessRoot.textContent?.includes("unfinished emphasis") ?? false,
      safeLinksHardened: links.length > 0 && links.every((link) => link.target === "_blank" && link.rel.includes("noopener")),
      remoteImageLinkPresent: links.some((link) => link.href === "https://example.com/remote.png"),
      exactCodeText: codeBlocks.some((code) => code.innerText.trimEnd() === expectedCopiedCode),
      codeCopyControl: Boolean(copyControl),
      oversizedFallback: false,
      errorFallback: false,
    };
    await renderAndPaint({ ...empty(), oversized: true });
    correctness.oversizedFallback = Boolean(document.querySelector('[data-rendering-fallback="oversized"]'));
    if (renderer === "streamdown") {
      await renderAndPaint({ ...empty(), simulateFailure: true });
      correctness.errorFallback = Boolean(document.querySelector('[data-rendering-fallback="error"]'));
    }

    longTasks.stop();
    const result: RenderingBenchmarkResult = {
      renderer,
      environment: {
        userAgent: navigator.userAgent,
        productionBuild: import.meta.env.PROD,
        threadReadMs: 0,
      },
      firstContent: { coldMs, warmMs },
      transcriptMounts,
      sessionSwitch,
      streaming: {
        updates: updateCount,
        totalMs,
        p95FrameMs: percentile(frameIntervals, .95),
        p99FrameMs: percentile(frameIntervals, .99),
        longTaskMs: streamLongTaskMs,
        historicalRowRenders,
        tailRowRenders: rowRenderCounts.get(tailId) ?? 0,
        domNodes: streamDomNodes,
      },
      correctness,
    };
    setLastResult(result);
    setStatus(`Completed ${renderer}`);
    return result;
  }, [renderAndPaint]);

  useLayoutEffect(() => {
    window.__peelRenderingBenchmark = { runSuite };
    return () => { delete window.__peelRenderingBenchmark; };
  }, [runSuite]);

  const content = useMemo(() => {
    if (view.simulateFailure) return <StreamdownPrototype text="Fallback remains readable." simulateFailure/>;
    if (view.oversized) return <Renderer renderer={view.renderer} text={oversizedMarkdown}/>;
    if (view.corpus) {
      return <div data-benchmark-corpus>{renderingCorpus.map((entry) =>
        <section key={entry.id} data-corpus-case={entry.id}>
          <h2>{entry.label}</h2>
          <Renderer renderer={view.renderer} text={entry.markdown} streaming={entry.streaming ?? false}/>
        </section>)}</div>;
    }
    return <div data-benchmark-transcript>{view.turns.map((turn, index) =>
      <BenchmarkRow
        key={turn.id}
        renderer={view.renderer}
        streaming={view.streamingTail && index === view.turns.length - 1}
        turn={turn}
      />)}</div>;
  }, [view]);

  return <main className="rendering-benchmark">
    <header>
      <div><strong>Peel rendering benchmark</strong><span data-benchmark-status>{status}</span></div>
      <div className="rendering-benchmark-actions">
        <button onClick={() => void runSuite("current")}>Run current</button>
        <button onClick={() => void runSuite("streamdown")}>Run Streamdown</button>
      </div>
    </header>
    <div className="rendering-benchmark-surface" data-benchmark-surface>{content}</div>
    {lastResult && <pre className="rendering-benchmark-result" data-benchmark-result>{JSON.stringify(lastResult, null, 2)}</pre>}
  </main>;
}

const BenchmarkRow = memo(function BenchmarkRow({ renderer, turn, streaming }: {
  renderer: BenchmarkRenderer;
  turn: BenchmarkTurn;
  streaming: boolean;
}): ReactNode {
  rowRenderCounts.set(turn.id, (rowRenderCounts.get(turn.id) ?? 0) + 1);
  return <article className="turn agent-message" data-benchmark-row={turn.id}>
    <Renderer renderer={renderer} text={turn.text} streaming={streaming}/>
  </article>;
});

function Renderer({ renderer, text, streaming = false }: {
  renderer: BenchmarkRenderer;
  text: string;
  streaming?: boolean;
}): ReactNode {
  return renderer === "current"
    ? <MarkdownContent text={text} streaming={streaming}/>
    : <StreamdownPrototype text={text} streaming={streaming}/>;
}

class LongTaskCollector {
  total = 0;
  private observer: PerformanceObserver | null = null;

  start(): void {
    if (!("PerformanceObserver" in window) || !PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
    this.observer = new PerformanceObserver((entries) => {
      this.total += entries.getEntries().reduce((sum, entry) => sum + entry.duration, 0);
    });
    this.observer.observe({ entryTypes: ["longtask"] });
  }

  stop(): void {
    this.snapshot();
    this.observer?.disconnect();
    this.observer = null;
  }

  snapshot(): number {
    if (this.observer) {
      this.total += this.observer.takeRecords().reduce((sum, entry) => sum + entry.duration, 0);
    }
    return this.total;
  }
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function benchmarkNodeCount(): number {
  return document.querySelector("[data-benchmark-surface]")?.querySelectorAll("*").length ?? 0;
}

function heapSize(): number | null {
  return (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
}

function heapDelta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : after - before;
}

function forceGarbageCollection(): void {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}

function mathBlockIsClipped(element: HTMLElement): boolean {
  const container = element.getBoundingClientRect();
  const visibleMath = element.querySelector<HTMLElement>(".katex-html");
  if (!visibleMath) return true;
  const range = document.createRange();
  range.selectNodeContents(visibleMath);
  const content = range.getBoundingClientRect();
  return content.top < container.top - .5 || content.bottom > container.bottom + .5;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)]!;
}
