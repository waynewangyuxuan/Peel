import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import "./polish.css";

const rootElement = document.getElementById("root")!;
const query = new URLSearchParams(window.location.search);

async function mount(): Promise<void> {
  const root = createRoot(rootElement);
  if (query.has("rendering-benchmark")) {
    const { RenderingBenchmarkApp } = await import("./RenderingBenchmark");
    root.render(<RenderingBenchmarkApp/>);
    return;
  }

  const delay = Number(query.get("startup-hydration-delay-ms") ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => window.setTimeout(resolve, Math.min(delay, 5_000)));
  const { App } = await import("./App");
  root.render(<StrictMode><App/></StrictMode>);
}

void mount();
