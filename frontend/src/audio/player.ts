function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const float = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    float[i] = pcm[i] / 32768;
  }
  return float;
}

function resampleFloat32(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const low = Math.floor(sourceIndex);
    const high = Math.min(low + 1, input.length - 1);
    const t = sourceIndex - low;
    output[i] = input[low] * (1 - t) + input[high] * t;
  }

  return output;
}

type QueueChunk = {
  data: Float32Array;
  offset: number;
};

export class StreamingPcmPlayer {
  private audioContext: AudioContext;
  private processorNode: ScriptProcessorNode;
  private queue: QueueChunk[] = [];
  private started = false;
  private readonly inputSampleRate: number;

  constructor(inputSampleRate = 24_000) {
    this.inputSampleRate = inputSampleRate;
    this.audioContext = new AudioContext();
    this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
      this.readInto(output);
    };
  }

  async start(): Promise<void> {
    if (!this.started) {
      this.processorNode.connect(this.audioContext.destination);
      this.started = true;
    }
    if (this.audioContext.state !== "running") {
      await this.audioContext.resume();
    }
  }

  enqueuePcm16(pcm: Int16Array): void {
    const floatChunk = pcm16ToFloat32(pcm);
    const resampledChunk = resampleFloat32(
      floatChunk,
      this.inputSampleRate,
      this.audioContext.sampleRate
    );
    this.queue.push({
      data: resampledChunk,
      offset: 0
    });
  }

  stopAndFlush(): void {
    this.queue = [];
  }

  async destroy(): Promise<void> {
    this.stopAndFlush();
    this.processorNode.disconnect();
    this.processorNode.onaudioprocess = null;
    await this.audioContext.close();
  }

  private readInto(output: Float32Array): void {
    let writeOffset = 0;
    while (writeOffset < output.length && this.queue.length > 0) {
      const current = this.queue[0];
      const remainingOutput = output.length - writeOffset;
      const remainingChunk = current.data.length - current.offset;
      const toCopy = Math.min(remainingOutput, remainingChunk);

      output.set(current.data.subarray(current.offset, current.offset + toCopy), writeOffset);
      current.offset += toCopy;
      writeOffset += toCopy;

      if (current.offset >= current.data.length) {
        this.queue.shift();
      }
    }
  }
}
