export interface RecorderSession {
  stop(): Promise<ArrayBuffer>;
  cancel(): void;
}

export async function startPcmRecorder(onInterrupted?: (message: string) => void): Promise<RecorderSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: 16_000 });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const samples: Float32Array[] = [];
  let active = true;
  processor.onaudioprocess = (event) => samples.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(context.destination);

  const cleanup = (): void => {
    if (!active) return;
    active = false;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (!active) return;
      cleanup();
      onInterrupted?.("Microphone capture stopped. Your existing draft was left unchanged.");
    }, { once: true });
  }
  return {
    async stop() {
      cleanup();
      return encodeWav(samples, context.sampleRate);
    },
    cancel: cleanup,
  };
}

export function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const raw of chunk) {
      const sample = Math.max(-1, Math.min(1, raw));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
