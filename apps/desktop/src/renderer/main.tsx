import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./polish.css";

const root = createRoot(document.getElementById("root")!);

if (new URLSearchParams(window.location.search).has("rendering-benchmark")) {
  void import("./RenderingBenchmark").then(({ RenderingBenchmarkApp }) => root.render(<RenderingBenchmarkApp/>));
} else {
  const application: ReactNode = <StrictMode><App/></StrictMode>;
  root.render(application);
}
