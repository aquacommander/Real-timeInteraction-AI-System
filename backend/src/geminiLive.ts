import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";

type GeminiLiveBridgeCallbacks = {
  onReady: () => void;
  onAudioChunk: (audioPcm16: Buffer) => void;
  onText: (text: string) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onError: (message: string) => void;
  onClose: (reason: string) => void;
};

type GeminiLiveBridgeOptions = {
  apiKey?: string;
  useVertex?: boolean;
  project?: string;
  location?: string;
  model: string;
  systemInstruction: string;
  callbacks: GeminiLiveBridgeCallbacks;
};

type LiveSession = {
  sendRealtimeInput: (params: {
    audio?: { data: string; mimeType: string };
    audioStreamEnd?: boolean;
    text?: string;
  }) => void;
  sendClientContent: (params: { turns?: unknown; turnComplete?: boolean }) => void;
  close: () => void;
};

export class GeminiLiveBridge {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly systemInstruction: string;
  private readonly callbacks: GeminiLiveBridgeCallbacks;
  private session: LiveSession | null = null;
  private connected = false;

  constructor(options: GeminiLiveBridgeOptions) {
    if (options.useVertex) {
      this.ai = new GoogleGenAI({
        vertexai: true,
        project: options.project,
        location: options.location ?? "us-central1"
      });
    } else {
      this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    }
    this.model = options.model;
    this.systemInstruction = options.systemInstruction;
    this.callbacks = options.callbacks;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const session = (await this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.systemInstruction
      },
      callbacks: {
        onopen: () => {
          this.connected = true;
          this.callbacks.onReady();
        },
        onmessage: (message: LiveServerMessage) => {
          this.handleServerMessage(message);
        },
        onerror: (errorEvent: { message?: string }) => {
          const message = errorEvent.message || "Gemini Live stream error";
          this.callbacks.onError(message);
        },
        onclose: (event: { reason?: string }) => {
          this.connected = false;
          this.callbacks.onClose(event.reason || "Gemini Live connection closed");
        }
      }
    })) as unknown as LiveSession;

    this.session = session;
  }

  sendAudioChunk(audioPcm16: Buffer, sampleRate: number): void {
    if (!this.session) {
      return;
    }
    this.session.sendRealtimeInput({
      audio: {
        data: audioPcm16.toString("base64"),
        mimeType: `audio/pcm;rate=${sampleRate}`
      }
    });
  }

  sendAudioStreamEnd(): void {
    if (!this.session) {
      return;
    }
    this.session.sendRealtimeInput({
      audioStreamEnd: true
    });
  }

  sendTextPrompt(text: string): void {
    if (!this.session) {
      return;
    }
    this.session.sendClientContent({
      turns: text,
      turnComplete: true
    });
  }

  close(): void {
    this.connected = false;
    this.session?.close();
    this.session = null;
  }

  private handleServerMessage(message: LiveServerMessage): void {
    const content = message.serverContent;
    if (content?.interrupted) {
      this.callbacks.onInterrupted();
    }

    if (content?.turnComplete) {
      this.callbacks.onTurnComplete();
    }

    const parts = content?.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const audioChunk = Buffer.from(part.inlineData.data, "base64");
        this.callbacks.onAudioChunk(audioChunk);
      }
      if (part.text) {
        this.callbacks.onText(part.text);
      }
    }
  }
}
