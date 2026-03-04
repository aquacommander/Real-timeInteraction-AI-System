function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const float = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    float[i] = pcm[i] / 32768;
  }
  return float;
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

  constructor() {
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
    this.queue.push({
      data: floatChunk,
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
