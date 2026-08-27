import { describe, expect, it } from "vitest";

import { encodePcm16, encodeWav, pcmAmplitude } from "../src/renderer/audio";

describe("voice dictation recording", () => {
  it("encodes captured microphone PCM as a real mono WAV boundary", () => {
    const wav = encodeWav([new Float32Array([0, .5, -1, 1])], 16_000);
    const bytes = new Uint8Array(wav);
    const view = new DataView(wav);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
  });

  it("maps real PCM energy into stronger live levels for louder input", () => {
    const quiet = pcmAmplitude(new Float32Array([.005, -.005, .004, -.004]));
    const speaking = pcmAmplitude(new Float32Array([.22, -.24, .19, -.21]));
    const loud = pcmAmplitude(new Float32Array([.75, -.8, .7, -.72]));
    expect(quiet).toBe(0);
    expect(speaking).toBeGreaterThan(.5);
    expect(loud).toBeGreaterThan(speaking);
    expect(loud).toBeLessThanOrEqual(1);
  });

  it("encodes raw little-endian PCM16 chunks for Codex Realtime", () => {
    const pcm = encodePcm16(new Float32Array([0, .5, -1, 1]));
    const view = new DataView(pcm);
    expect(pcm.byteLength).toBe(8);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(16_383);
    expect(view.getInt16(4, true)).toBe(-32_768);
    expect(view.getInt16(6, true)).toBe(32_767);
  });
});
