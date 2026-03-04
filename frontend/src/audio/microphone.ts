export type MicChunkHandler = (pcm16: Int16Array) => void;

export type MicStartResult = {
  sampleRate: number;
  chunkSize: number;
};

export function resamplePcm16(
  input: Int16Array,
  inputSampleRate: number,
  outputSampleRate: number
): Int16Array {
  if (inputSampleRate === outputSampleRate) {
    return new Int16Array(input);
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const indexLow = Math.floor(sourceIndex);
    const indexHigh = Math.min(indexLow + 1, input.length - 1);
    const t = sourceIndex - indexLow;
    const interpolated = input[indexLow] * (1 - t) + input[indexHigh] * t;
    output[i] = Math.round(interpolated);
  }

  return output;
}

function floatToPcm16(floatBuffer: Float32Array): Int16Array {
  const pcm = new Int16Array(floatBuffer.length);
  for (let i = 0; i < floatBuffer.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, floatBuffer[i]));
    pcm[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  return pcm;
}

export class MicrophoneStreamer {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;

  async start(onChunk: MicChunkHandler): Promise<MicStartResult> {
    if (this.audioContext) {
      throw new Error("Microphone already started");
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this.audioContext = new AudioContext();
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      onChunk(floatToPcm16(input));
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    await this.audioContext.resume();

    return {
      sampleRate: this.audioContext.sampleRate,
      chunkSize: this.processorNode.bufferSize
    };
  }

  async stop(): Promise<void> {
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}
