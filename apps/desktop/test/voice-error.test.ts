import { describe, expect, it } from "vitest";

import { stripErrorWrappers, voiceFailurePresentation } from "../src/renderer/voice-error";

describe("voice error presentation", () => {
  it("turns the exact wrapped no-speech rejection into a quiet retry notice", () => {
    const result = voiceFailurePresentation(new Error("Error invoking remote method 'peel:voice:transcribe': Error: No speech detected"));
    expect(result).toEqual({
      tone: "notice",
      message: "I didn’t catch any speech. Try again and speak for a little longer.",
    });
  });

  it.each([
    "No speech was recognized. Your existing draft was left unchanged.",
    "The recording did not contain usable audio",
    "Audio did not contain usable audio",
  ])("classifies %s as a retryable listening miss", (message) => {
    expect(voiceFailurePresentation(message).tone).toBe("notice");
  });

  it("removes repeated Electron and Error wrappers", () => {
    expect(stripErrorWrappers("Error invoking remote method 'peel:voice:transcribe': Error: Error invoking remote method 'voice': Error: Forced transcription failure"))
      .toBe("Forced transcription failure");
  });

  it("keeps actual failures distinct and actionable", () => {
    expect(voiceFailurePresentation(new DOMException("Permission denied", "NotAllowedError"))).toEqual({
      tone: "error",
      message: "Permission denied. Allow microphone access in System Settings, then try again.",
    });
    expect(voiceFailurePresentation("recognizer interrupted")).toEqual({
      tone: "error",
      message: "Dictation was interrupted. Your draft is unchanged; try again.",
    });
  });
});
