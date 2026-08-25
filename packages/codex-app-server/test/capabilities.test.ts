import assert from "node:assert/strict";
import test from "node:test";

import { CapabilityMatrix, REQUIRED_STABLE_METHODS } from "../src/capabilities.js";

test("stable methods are explicit and optional product concepts stay unavailable by default", () => {
  const matrix = new CapabilityMatrix();
  for (const method of REQUIRED_STABLE_METHODS) assert.equal(matrix.methodStatus(method), "stable");
  assert.equal(matrix.featureStatus("project-association"), "unavailable");
  assert.equal(matrix.featureStatus("realtime-voice"), "unavailable");
  assert.equal(matrix.methodStatus("project/list"), "unavailable");
});

test("installed schema detection gates experimental methods and optional product features stay unavailable", () => {
  const matrix = new CapabilityMatrix({ experimentalApi: true });
  matrix.applySchemaDetection({
    stableMethods: new Set(REQUIRED_STABLE_METHODS.filter((method) => method !== "thread/fork")),
    experimentalMethods: new Set(["thread/fork"]),
    stableNotifications: new Set(),
    experimentalNotifications: new Set(),
  });
  assert.equal(matrix.methodStatus("thread/fork"), "experimental-enabled");
  assert.equal(matrix.featureStatus("paginated-turn-items"), "unavailable");
  assert.equal(matrix.snapshot().detection, "installed-schema");
  matrix.observeRpcFailure("thread/fork", { code: -32601 });
  assert.equal(matrix.methodStatus("thread/fork"), "unavailable");
});

test("failed startup detection is explicit while preserving the declared stable fallback", () => {
  const matrix = new CapabilityMatrix();
  matrix.recordDetectionFallback(new Error("generate-ts unavailable"));
  assert.equal(matrix.snapshot().detection, "fallback-contract");
  assert.equal(matrix.snapshot().detectionError, "generate-ts unavailable");
  assert.equal(matrix.methodStatus("thread/list"), "stable");
});
