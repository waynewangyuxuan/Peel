export interface RecorderSession {
  stop(): Promise<ArrayBuffer>;
  cancel(): void;
}

export interface PcmAudioChunk {
  bytes: ArrayBuffer;
  sampleRate: number;
  samplesPerChannel: number;
}

export async function startPcmRecorder(
  onInterrupted?: (message: string) => void,
  onLevel?: (level: number) => void,
  onChunk?: (chunk: PcmAudioChunk) => void,
): Promise<RecorderSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: 16_000 });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = .35;
  const processor = context.createScriptProcessor(4096, 1, 1);
  const samples: Float32Array[] = [];
  let active = true;
  let levelFrame = 0;
  let lastLevelAt = 0;
  let smoothedLevel = 0;
  const levelSamples = new Float32Array(analyser.fftSize);
  processor.onaudioprocess = (event) => {
    const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
    samples.push(chunk);
    if (onChunk) {
      onChunk({
        bytes: encodePcm16(chunk),
        sampleRate: context.sampleRate,
        samplesPerChannel: chunk.length,
      });
    }
  };
  source.connect(analyser);
  source.connect(processor);
  processor.connect(context.destination);

  const readLevel = (at: number): void => {
    if (!active) return;
    if (onLevel && at - lastLevelAt >= 40) {
      analyser.getFloatTimeDomainData(levelSamples);
      const measured = pcmAmplitude(levelSamples);
      smoothedLevel = measured > smoothedLevel
        ? smoothedLevel * .42 + measured * .58
        : smoothedLevel * .72 + measured * .28;
      onLevel(smoothedLevel);
      lastLevelAt = at;
    }
    levelFrame = requestAnimationFrame(readLevel);
  };
  if (onLevel) levelFrame = requestAnimationFrame(readLevel);

  const cleanup = (): void => {
    if (!active) return;
    active = false;
    if (levelFrame) cancelAnimationFrame(levelFrame);
    onLevel?.(0);
    processor.disconnect();
    analyser.disconnect();
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

export function pcmAmplitude(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  const aboveFloor = Math.max(0, rms - .008);
  return Math.min(1, Math.pow(aboveFloor / .32, .65));
}

export function encodePcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
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
