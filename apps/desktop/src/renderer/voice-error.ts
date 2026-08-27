export interface VoiceFailurePresentation {
  tone: "notice" | "error";
  message: string;
}

const NO_SPEECH_COPY = "I didn’t catch any speech. Try again and speak for a little longer.";

export function voiceFailurePresentation(error: unknown): VoiceFailurePresentation {
  const message = stripErrorWrappers(error);
  if (isNoSpeech(message)) return { tone: "notice", message: NO_SPEECH_COPY };
  if (/permission denied|notallowederror|microphone access (?:was )?denied/i.test(message)) {
    return { tone: "error", message: "Permission denied. Allow microphone access in System Settings, then try again." };
  }
  if (/recognizer interrupted|recognition (?:was )?interrupted/i.test(message)) {
    return { tone: "error", message: "Dictation was interrupted. Your draft is unchanged; try again." };
  }
  return {
    tone: "error",
    message: message || "Dictation could not be completed. Your draft is unchanged; try again.",
  };
}

export function stripErrorWrappers(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  let previous = "";
  while (message !== previous) {
    previous = message;
    message = message
      .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .trim();
  }
  return message;
}

function isNoSpeech(message: string): boolean {
  return /\bno speech (?:(?:was|is) )?(?:detected|recognized)\b/i.test(message)
    || /(?:recording|audio) did not contain usable audio/i.test(message);
}
