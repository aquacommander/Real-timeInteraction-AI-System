export const WS_PATH = "/ws";
export const AUDIO_ENCODING = "pcm_s16le";
export const CLIENT_AUDIO_FRAME_TYPE = 0x01;
export const SERVER_AUDIO_FRAME_TYPE = 0x02;

export type ClientToServerMessage =
  | {
      type: "client_hello";
      clientId: string;
      timestamp: string;
    }
  | {
      type: "echo_text";
      requestId: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "ping";
      requestId: string;
      timestamp: string;
    }
  | {
      type: "start_listening";
      sampleRate: number;
      chunkSize: number;
      encoding: typeof AUDIO_ENCODING;
      timestamp: string;
    }
  | {
      type: "stop_listening";
      timestamp: string;
    }
  | {
      type: "send_text_prompt";
      requestId: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "barge_in";
      requestId: string;
      energy: number;
      timestamp: string;
    };

export type ServerToClientMessage =
  | {
      type: "server_hello";
      connectionId: string;
      timestamp: string;
      message: string;
    }
  | {
      type: "echo_text_result";
      requestId: string;
      echoedText: string;
      timestamp: string;
    }
  | {
      type: "pong";
      requestId: string;
      timestamp: string;
    }
  | {
      type: "binary_stub_received";
      byteLength: number;
      timestamp: string;
    }
  | {
      type: "listening_ack";
      sampleRate: number;
      chunkSize: number;
      encoding: typeof AUDIO_ENCODING;
      timestamp: string;
    }
  | {
      type: "gemini_session_ready";
      model: string;
      timestamp: string;
    }
  | {
      type: "gemini_text";
      text: string;
      timestamp: string;
    }
  | {
      type: "gemini_turn_complete";
      timestamp: string;
    }
  | {
      type: "model_interrupted";
      timestamp: string;
    }
  | {
      type: "gemini_error";
      message: string;
      timestamp: string;
    }
  | {
      type: "error";
      code: "INVALID_JSON" | "UNKNOWN_MESSAGE" | "INVALID_BINARY_FRAME";
      message: string;
      timestamp: string;
    };
