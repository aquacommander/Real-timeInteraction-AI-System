import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { GeminiLiveBridge } from "./geminiLive.js";
import { log } from "./logger.js";
import {
  AUDIO_ENCODING,
  CLIENT_AUDIO_FRAME_TYPE,
  SERVER_AUDIO_FRAME_TYPE,
  WS_PATH,
  type ClientToServerMessage,
  type ServerToClientMessage
} from "./protocol.js";

const port = Number(process.env.PORT ?? 8080);
const geminiApiKey = process.env.GEMINI_API_KEY ?? "";
const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";
const vertexProject = process.env.GOOGLE_CLOUD_PROJECT ?? "";
const vertexLocation = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
const geminiModel =
  process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025";
const geminiSystemInstruction =
  process.env.GEMINI_SYSTEM_INSTRUCTION ??
  "You are a concise and helpful real-time voice assistant. Keep answers brief and natural.";

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

function sendJson(socket: WebSocket, message: ServerToClientMessage): void {
  socket.send(JSON.stringify(message));
}

function isJsonMessage(data: RawData): data is Buffer {
  return Buffer.isBuffer(data);
}

type ConnectionState = {
  listening: boolean;
  receivedAudioFrames: number;
  receivedAudioBytes: number;
  inputSampleRate: number;
  gemini: GeminiLiveBridge | null;
  geminiReady: boolean;
  suppressMicForwarding: boolean;
};

function cleanupGemini(state: ConnectionState): void {
  state.gemini?.close();
  state.gemini = null;
  state.geminiReady = false;
}

function sendFramedBinary(socket: WebSocket, frameType: number, payload: Buffer): void {
  const outbound = Buffer.alloc(1 + payload.length);
  outbound.writeUInt8(frameType, 0);
  payload.copy(outbound, 1);
  socket.send(outbound, { binary: true });
}

wss.on("connection", (socket, request) => {
  const connectionId = randomUUID();
  const connectedAt = new Date().toISOString();
  const state: ConnectionState = {
    listening: false,
    receivedAudioFrames: 0,
    receivedAudioBytes: 0,
    inputSampleRate: 16_000,
    gemini: null,
    geminiReady: false,
    suppressMicForwarding: false
  };

  log("INFO", "ws.connection.opened", {
    connectionId,
    remoteAddress: request.socket.remoteAddress
  });

  sendJson(socket, {
    type: "server_hello",
    connectionId,
    timestamp: connectedAt,
    message: "WebSocket connected"
  });

  if (!useVertex && !geminiApiKey) {
    sendJson(socket, {
      type: "gemini_error",
      message: "Missing GEMINI_API_KEY in backend environment",
      timestamp: new Date().toISOString()
    });
  } else if (useVertex && !vertexProject) {
    sendJson(socket, {
      type: "gemini_error",
      message: "Missing GOOGLE_CLOUD_PROJECT for Vertex AI mode",
      timestamp: new Date().toISOString()
    });
  } else {
    const geminiBridge = new GeminiLiveBridge({
      apiKey: geminiApiKey,
      useVertex,
      project: vertexProject,
      location: vertexLocation,
      model: geminiModel,
      systemInstruction: geminiSystemInstruction,
      callbacks: {
        onReady: () => {
          state.geminiReady = true;
          log("INFO", "gemini.session.ready", {
            connectionId,
            model: geminiModel
          });
          sendJson(socket, {
            type: "gemini_session_ready",
            model: geminiModel,
            timestamp: new Date().toISOString()
          });
        },
        onAudioChunk: (audioPcm16) => {
          sendFramedBinary(socket, SERVER_AUDIO_FRAME_TYPE, audioPcm16);
        },
        onText: (text) => {
          sendJson(socket, {
            type: "gemini_text",
            text,
            timestamp: new Date().toISOString()
          });
        },
        onTurnComplete: () => {
          state.suppressMicForwarding = false;
          sendJson(socket, {
            type: "gemini_turn_complete",
            timestamp: new Date().toISOString()
          });
        },
        onInterrupted: () => {
          state.suppressMicForwarding = false;
          sendJson(socket, {
            type: "model_interrupted",
            timestamp: new Date().toISOString()
          });
        },
        onError: (message) => {
          state.suppressMicForwarding = false;
          log("ERROR", "gemini.session.error", {
            connectionId,
            message
          });
          sendJson(socket, {
            type: "gemini_error",
            message,
            timestamp: new Date().toISOString()
          });
        },
        onClose: (reason) => {
          state.suppressMicForwarding = false;
          log("INFO", "gemini.session.closed", {
            connectionId,
            reason
          });
          sendJson(socket, {
            type: "gemini_error",
            message: `Gemini session closed: ${reason}`,
            timestamp: new Date().toISOString()
          });
        }
      }
    });
    state.gemini = geminiBridge;
    void geminiBridge.connect().catch((error: Error) => {
      log("ERROR", "gemini.session.connect_failed", {
        connectionId,
        error: error.message
      });
      sendJson(socket, {
        type: "gemini_error",
        message: `Gemini connection failed: ${error.message}`,
        timestamp: new Date().toISOString()
      });
    });
  }

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (bytes.length < 2) {
        sendJson(socket, {
          type: "error",
          code: "INVALID_BINARY_FRAME",
          message: "Binary frame too small",
          timestamp: new Date().toISOString()
        });
        return;
      }

      const frameType = bytes.readUInt8(0);
      const payload = bytes.subarray(1);

      if (frameType !== CLIENT_AUDIO_FRAME_TYPE) {
        sendJson(socket, {
          type: "error",
          code: "INVALID_BINARY_FRAME",
          message: `Unknown binary frame type ${frameType}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      state.receivedAudioFrames += 1;
      state.receivedAudioBytes += payload.byteLength;
      if (!state.suppressMicForwarding) {
        state.gemini?.sendAudioChunk(payload, state.inputSampleRate);
      }

      if (state.receivedAudioFrames % 25 === 0) {
        log("INFO", "audio.mic.progress", {
          connectionId,
          receivedFrames: state.receivedAudioFrames,
          receivedBytes: state.receivedAudioBytes
        });
        sendJson(socket, {
          type: "binary_stub_received",
          byteLength: payload.byteLength,
          timestamp: new Date().toISOString()
        });
      }
      return;
    }

    if (!isJsonMessage(data)) {
      sendJson(socket, {
        type: "error",
        code: "INVALID_JSON",
        message: "Expected JSON text payload",
        timestamp: new Date().toISOString()
      });
      return;
    }

    const raw = data.toString("utf-8");
    let parsed: ClientToServerMessage;

    try {
      parsed = JSON.parse(raw) as ClientToServerMessage;
    } catch {
      sendJson(socket, {
        type: "error",
        code: "INVALID_JSON",
        message: "Invalid JSON payload",
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (parsed.type === "client_hello") {
      log("INFO", "ws.client.hello", {
        connectionId,
        clientId: parsed.clientId
      });
      return;
    }

    if (parsed.type === "echo_text") {
      log("INFO", "ws.text.echo", {
        connectionId,
        requestId: parsed.requestId
      });

      sendJson(socket, {
        type: "echo_text_result",
        requestId: parsed.requestId,
        echoedText: parsed.text,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (parsed.type === "ping") {
      sendJson(socket, {
        type: "pong",
        requestId: parsed.requestId,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (parsed.type === "start_listening") {
      state.listening = true;
      state.inputSampleRate = parsed.sampleRate;
      log("INFO", "audio.listening.started", {
        connectionId,
        sampleRate: parsed.sampleRate,
        chunkSize: parsed.chunkSize,
        encoding: parsed.encoding
      });

      sendJson(socket, {
        type: "listening_ack",
        sampleRate: parsed.sampleRate,
        chunkSize: parsed.chunkSize,
        encoding: AUDIO_ENCODING,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (parsed.type === "stop_listening") {
      state.listening = false;
      state.suppressMicForwarding = false;
      state.gemini?.sendAudioStreamEnd();
      log("INFO", "audio.listening.stopped", {
        connectionId
      });
      return;
    }

    if (parsed.type === "send_text_prompt") {
      if (!state.geminiReady) {
        sendJson(socket, {
          type: "gemini_error",
          message: "Gemini session is not ready yet",
          timestamp: new Date().toISOString()
        });
        return;
      }
      // Pause mic forwarding while handling a deterministic text turn.
      state.suppressMicForwarding = true;
      state.gemini?.sendAudioStreamEnd();
      state.gemini?.sendTextPrompt(parsed.text);
      log("INFO", "gemini.text.prompt", {
        connectionId,
        requestId: parsed.requestId
      });
      return;
    }

    sendJson(socket, {
      type: "error",
      code: "UNKNOWN_MESSAGE",
      message: "Unsupported message type",
      timestamp: new Date().toISOString()
    });
  });

  socket.on("close", (code, reason) => {
    cleanupGemini(state);
    log("INFO", "ws.connection.closed", {
      connectionId,
      code,
      reason: reason.toString(),
      receivedAudioFrames: state.receivedAudioFrames,
      receivedAudioBytes: state.receivedAudioBytes
    });
  });

  socket.on("error", (error) => {
    cleanupGemini(state);
    log("ERROR", "ws.connection.error", {
      connectionId,
      error: error.message
    });
  });
});

httpServer.listen(port, () => {
  log("INFO", "server.started", {
    port,
    wsPath: WS_PATH
  });
});
