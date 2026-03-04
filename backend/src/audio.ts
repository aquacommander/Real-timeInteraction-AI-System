type ToneChunkResult = {
  chunk: Buffer;
  nextPhase: number;
};

export function createPcm16ToneChunk(
  sampleRate: number,
  chunkSamples: number,
  frequencyHz: number,
  phase: number,
  gain = 0.18
): ToneChunkResult {
  const frame = Buffer.alloc(chunkSamples * 2);
  const phaseStep = (2 * Math.PI * frequencyHz) / sampleRate;
  let runningPhase = phase;

  for (let i = 0; i < chunkSamples; i += 1) {
    const sample = Math.sin(runningPhase) * gain;
    const int16 = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
    frame.writeInt16LE(int16, i * 2);
    runningPhase += phaseStep;
    if (runningPhase > Math.PI * 2) {
      runningPhase -= Math.PI * 2;
    }
  }

  return {
    chunk: frame,
    nextPhase: runningPhase
  };
}
