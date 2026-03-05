import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { MicrophoneStreamer, resamplePcm16 } from "./audio/microphone";
import { StreamingPcmPlayer } from "./audio/player";
import {
  AUDIO_ENCODING,
  CLIENT_AUDIO_FRAME_TYPE,
  SERVER_AUDIO_FRAME_TYPE,
  type AgentUiState,
  type ClientToServerMessage,
  type ServerToClientMessage,
  createClientId
} from "./protocol";

const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080/ws";

type LogEntry = {
  id: string;
  direction: "outbound" | "inbound" | "system";
  message: string;
  timestamp: string;
};

const BARGE_IN_ENERGY_THRESHOLD = 0.04;
const BARGE_IN_CONSECUTIVE_FRAMES = 4;
const BARGE_IN_COOLDOWN_MS = 1500;
const BARGE_IN_ARM_DELAY_MS = 700;
const CAMERA_SNAPSHOT_MIME = "image/jpeg";

function nowIso(): string {
  return new Date().toISOString();
}

function id(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(16).slice(2);
}

function getNormalizedEnergy(pcm16: Int16Array): number {
  if (pcm16.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < pcm16.length; i += 1) {
    const normalized = pcm16[i] / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / pcm16.length);
}

export default function App() {
  const [status, setStatus] = useState<AgentUiState>("disconnected");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [micChunkCount, setMicChunkCount] = useState(0);
  const [receivedAudioBytes, setReceivedAudioBytes] = useState(0);
  const [lastAckBytes, setLastAckBytes] = useState<number | null>(null);
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [promptText, setPromptText] = useState("Give me one fun fact about space.");
  const [snapshotQuestion, setSnapshotQuestion] = useState("What do you see in this image?");
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [snapshotPreviewDataUrl, setSnapshotPreviewDataUrl] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicrophoneStreamer | null>(null);
  const playerRef = useRef<StreamingPcmPlayer | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const speakingFallbackTimerRef = useRef<number | null>(null);
  const statusRef = useRef<AgentUiState>("disconnected");
  const micInputSampleRateRef = useRef<number>(16_000);
  const consecutiveSpeechFramesRef = useRef(0);
  const lastBargeInAtRef = useRef(0);
  const canBargeInRef = useRef(false);
  const bargeInArmAtRef = useRef(0);
  const modelInputSampleRate = 16_000;
  const clientId = useMemo(() => createClientId(), []);

  const pushLog = (entry: Omit<LogEntry, "id" | "timestamp">): void => {
    const next: LogEntry = {
      id: id(),
      timestamp: nowIso(),
      ...entry
    };
    setLogs((prev) => [next, ...prev].slice(0, 50));
  };

  const clearSpeakingFallback = (): void => {
    if (speakingFallbackTimerRef.current !== null) {
      window.clearTimeout(speakingFallbackTimerRef.current);
      speakingFallbackTimerRef.current = null;
    }
  };

  const armSpeakingFallback = (): void => {
    clearSpeakingFallback();
    speakingFallbackTimerRef.current = window.setTimeout(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN && isMicEnabled) {
        setStatus("listening");
      }
    }, 450);
  };

  const sendMicFrame = (pcm16: Int16Array): void => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const resampled = resamplePcm16(pcm16, micInputSampleRateRef.current, modelInputSampleRate);
    const pcmBytes = new Uint8Array(resampled.buffer, resampled.byteOffset, resampled.byteLength);
    const frame = new Uint8Array(1 + pcmBytes.byteLength);
    frame[0] = CLIENT_AUDIO_FRAME_TYPE;
    frame.set(pcmBytes, 1);
    socket.send(frame);
    setMicChunkCount((count) => count + 1);

    if (statusRef.current === "speaking" && canBargeInRef.current) {
      if (Date.now() < bargeInArmAtRef.current) {
        return;
      }
      const energy = getNormalizedEnergy(resampled);
      if (energy >= BARGE_IN_ENERGY_THRESHOLD) {
        consecutiveSpeechFramesRef.current += 1;
      } else {
        consecutiveSpeechFramesRef.current = 0;
      }

      const nowMs = Date.now();
      if (
        consecutiveSpeechFramesRef.current >= BARGE_IN_CONSECUTIVE_FRAMES &&
        nowMs - lastBargeInAtRef.current >= BARGE_IN_COOLDOWN_MS
      ) {
        lastBargeInAtRef.current = nowMs;
        consecutiveSpeechFramesRef.current = 0;
        canBargeInRef.current = false;
        playerRef.current?.stopAndFlush();
        clearSpeakingFallback();
        setStatus("listening");
        sendJson({
          type: "barge_in",
          requestId: id(),
          energy,
          timestamp: nowIso()
        });
        pushLog({
          direction: "system",
          message: `Barge-in triggered (energy=${energy.toFixed(4)})`
        });
      }
    }
  };

  const sendJson = (message: ClientToServerMessage): void => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      pushLog({
        direction: "system",
        message: "Cannot send: socket is not open"
      });
      return;
    }

    socket.send(JSON.stringify(message));
    pushLog({
      direction: "outbound",
      message: JSON.stringify(message)
    });
  };

  const startMicrophone = async (): Promise<void> => {
    if (isMicEnabled) {
      return;
    }

    const mic = new MicrophoneStreamer();
    const startResult = await mic.start((pcm16) => {
      sendMicFrame(pcm16);
    });
    micInputSampleRateRef.current = startResult.sampleRate;

    micRef.current = mic;
    setIsMicEnabled(true);
    setStatus("listening");

    sendJson({
      type: "start_listening",
      sampleRate: modelInputSampleRate,
      chunkSize: startResult.chunkSize,
      encoding: AUDIO_ENCODING,
      timestamp: nowIso()
    });
  };

  const stopMicrophone = async (): Promise<void> => {
    if (!micRef.current) {
      return;
    }
    sendJson({
      type: "stop_listening",
      timestamp: nowIso()
    });
    await micRef.current.stop();
    micRef.current = null;
    setIsMicEnabled(false);
  };

  const stopCamera = (): void => {
    const stream = cameraStreamRef.current;
    if (!stream) {
      setIsCameraEnabled(false);
      return;
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
    }
    setIsCameraEnabled(false);
  };

  const startCamera = async (): Promise<void> => {
    if (cameraStreamRef.current) {
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });
      cameraStreamRef.current = stream;
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = stream;
        await cameraVideoRef.current.play();
      }
      setCameraError(null);
      setIsCameraEnabled(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start camera";
      setCameraError(message);
      setIsCameraEnabled(false);
      pushLog({
        direction: "system",
        message: `Camera start failed: ${message}`
      });
    }
  };

  const connect = (): void => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    setStatus("connecting");
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
      playerRef.current = playerRef.current ?? new StreamingPcmPlayer();
      pushLog({
        direction: "system",
        message: `Connected to ${wsUrl}`
      });

      sendJson({
        type: "client_hello",
        clientId,
        timestamp: nowIso()
      });

      startMicrophone().catch((error: Error) => {
        pushLog({
          direction: "system",
          message: `Microphone start failed: ${error.message}`
        });
        socket.close(4001, "Microphone permission required");
      });
    };

    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === "string") {
        let parsed: ServerToClientMessage;
        try {
          parsed = JSON.parse(event.data) as ServerToClientMessage;
        } catch {
          pushLog({
            direction: "system",
            message: `Received invalid JSON: ${event.data}`
          });
          return;
        }

        if (parsed.type === "binary_stub_received") {
          setLastAckBytes(parsed.byteLength);
        }

        if (parsed.type === "gemini_session_ready") {
          setActiveModel(parsed.model);
          canBargeInRef.current = false;
          bargeInArmAtRef.current = 0;
          if (micRef.current) {
            setStatus("listening");
          }
        }

        if (parsed.type === "gemini_turn_complete" && micRef.current) {
          canBargeInRef.current = false;
          consecutiveSpeechFramesRef.current = 0;
          setStatus("listening");
        }

        if (parsed.type === "model_interrupted") {
          canBargeInRef.current = false;
          consecutiveSpeechFramesRef.current = 0;
          playerRef.current?.stopAndFlush();
          if (micRef.current) {
            setStatus("listening");
          }
        }

        if (parsed.type === "gemini_error") {
          canBargeInRef.current = false;
          consecutiveSpeechFramesRef.current = 0;
          setActiveModel(null);
          playerRef.current?.stopAndFlush();
          clearSpeakingFallback();
          if (micRef.current) {
            setStatus("listening");
          } else {
            setStatus("disconnected");
          }
          pushLog({
            direction: "system",
            message: `Gemini error: ${parsed.message}`
          });
        }

        if (parsed.type === "snapshot_received") {
          pushLog({
            direction: "system",
            message: `Snapshot received by backend (${parsed.imageBytes} bytes, ${parsed.mimeType})`
          });
        }

        pushLog({
          direction: "inbound",
          message: JSON.stringify(parsed)
        });
        return;
      }

      const bytes = new Uint8Array(event.data);
      if (bytes.length < 2) {
        pushLog({
          direction: "system",
          message: "Received malformed binary frame"
        });
        return;
      }

      const frameType = bytes[0];
      const payload = bytes.subarray(1);

      if (frameType !== SERVER_AUDIO_FRAME_TYPE) {
        pushLog({
          direction: "system",
          message: `Received unknown frame type ${frameType}`
        });
        return;
      }

      if (payload.byteLength % 2 !== 0) {
        pushLog({
          direction: "system",
          message: "Received invalid PCM payload (odd byte length)"
        });
        return;
      }

      // payload starts at offset 1 in the framed packet, so copy into aligned buffer first.
      const alignedPcmBytes = new Uint8Array(payload.byteLength);
      alignedPcmBytes.set(payload);
      const pcm = new Int16Array(alignedPcmBytes.buffer);
      playerRef.current?.enqueuePcm16(pcm);
      void playerRef.current?.start();
      canBargeInRef.current = true;
      bargeInArmAtRef.current = Date.now() + BARGE_IN_ARM_DELAY_MS;
      setStatus("speaking");
      armSpeakingFallback();
      setReceivedAudioBytes((current) => current + payload.byteLength);

      pushLog({
        direction: "inbound",
        message: `Received audio frame (${payload.byteLength} bytes)`
      });
    };

    socket.onclose = async (event) => {
      canBargeInRef.current = false;
      consecutiveSpeechFramesRef.current = 0;
      clearSpeakingFallback();
      await stopMicrophone();
      playerRef.current?.stopAndFlush();
      setStatus("disconnected");
      pushLog({
        direction: "system",
        message: `Disconnected (code=${event.code}, reason=${event.reason || "n/a"})`
      });
      socketRef.current = null;
    };

    socket.onerror = () => {
      pushLog({
        direction: "system",
        message: "WebSocket error occurred"
      });
    };
  };

  const disconnect = (): void => {
    canBargeInRef.current = false;
    consecutiveSpeechFramesRef.current = 0;
    clearSpeakingFallback();
    socketRef.current?.close(1000, "Client disconnect");
    socketRef.current = null;
    setStatus("disconnected");
  };

  const sendTextPrompt = (event: FormEvent): void => {
    event.preventDefault();
    triggerTextPrompt();
  };

  const triggerTextPrompt = (): void => {
    const trimmed = promptText.trim();
    if (!trimmed) {
      return;
    }
    sendJson({
      type: "send_text_prompt",
      requestId: id(),
      text: trimmed,
      timestamp: nowIso()
    });
    // Wait for first model audio chunk before entering speaking mode.
    if (micRef.current) {
      setStatus("listening");
    }
  };

  const sendSnapshotPrompt = (): void => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      pushLog({
        direction: "system",
        message: "Cannot send snapshot: socket is not open"
      });
      return;
    }

    const video = cameraVideoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || !cameraStreamRef.current) {
      pushLog({
        direction: "system",
        message: "Cannot send snapshot: camera is not active"
      });
      return;
    }

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      pushLog({
        direction: "system",
        message: "Cannot send snapshot: 2D canvas context not available"
      });
      return;
    }

    context.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL(CAMERA_SNAPSHOT_MIME, 0.9);
    setSnapshotPreviewDataUrl(dataUrl);

    const base64Prefix = `data:${CAMERA_SNAPSHOT_MIME};base64,`;
    const imageBase64 = dataUrl.startsWith(base64Prefix) ? dataUrl.slice(base64Prefix.length) : "";
    if (!imageBase64) {
      pushLog({
        direction: "system",
        message: "Cannot send snapshot: image encoding failed"
      });
      return;
    }

    sendJson({
      type: "send_snapshot_prompt",
      requestId: id(),
      question: snapshotQuestion.trim() || "What do you see in this image?",
      mimeType: CAMERA_SNAPSHOT_MIME,
      imageBase64,
      timestamp: nowIso()
    });

    if (micRef.current) {
      setStatus("listening");
    }
  };

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    return () => {
      clearSpeakingFallback();
      stopCamera();
      socketRef.current?.close(1000, "Unmount cleanup");
      void micRef.current?.stop();
      void playerRef.current?.destroy();
    };
  }, []);

  return (
    <main className="app">
      <h1>Live Agents - Milestone 5</h1>
      <p className="subtitle">Gemini Live multimodal conversation relay (audio + snapshot)</p>

      <section className="panel">
        <div className="row">
          <span className={`status status-${status}`}>{status.toUpperCase()}</span>
          <code>{wsUrl}</code>
        </div>
        <div className="row">
          <button onClick={connect} disabled={status === "connecting" || status === "listening" || status === "speaking"}>
            Connect
          </button>
          <button onClick={disconnect} disabled={status === "disconnected"}>
            Disconnect
          </button>
          <button
            onClick={triggerTextPrompt}
            disabled={status === "disconnected" || status === "connecting" || status === "speaking"}
          >
            Send Text Prompt
          </button>
        </div>
      </section>

      <section className="panel">
        <form onSubmit={sendTextPrompt} className="row">
          <input
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
            placeholder="Text fallback prompt to Gemini"
          />
          <button
            type="submit"
            disabled={status === "disconnected" || status === "connecting" || status === "speaking"}
          >
            Ask Gemini
          </button>
        </form>
        <div className="row snapshot-row">
          <input
            value={snapshotQuestion}
            onChange={(event) => setSnapshotQuestion(event.target.value)}
            placeholder="Snapshot question (e.g. What do you see?)"
          />
          <button type="button" onClick={() => void startCamera()} disabled={isCameraEnabled}>
            Start Camera
          </button>
          <button type="button" onClick={stopCamera} disabled={!isCameraEnabled}>
            Stop Camera
          </button>
          <button
            type="button"
            onClick={sendSnapshotPrompt}
            disabled={!isCameraEnabled || status === "disconnected" || status === "connecting" || status === "speaking"}
          >
            Send Snapshot
          </button>
        </div>
        {cameraError ? <p className="meta error-text">Camera error: {cameraError}</p> : null}
        <div className="camera-grid">
          <div className="camera-panel">
            <p className="meta">Camera preview</p>
            <video ref={cameraVideoRef} autoPlay muted playsInline className="camera-video" />
          </div>
          <div className="camera-panel">
            <p className="meta">Latest snapshot</p>
            {snapshotPreviewDataUrl ? (
              <img src={snapshotPreviewDataUrl} alt="Captured snapshot" className="snapshot-image" />
            ) : (
              <p className="meta">No snapshot captured yet.</p>
            )}
          </div>
        </div>
        <canvas ref={captureCanvasRef} className="hidden-canvas" />
        <p className="meta">
          Client ID: <code>{clientId}</code>
        </p>
        <p className="meta">
          Active model: <strong>{activeModel ?? "not ready yet"}</strong>
        </p>
        <p className="meta">
          Mic chunks sent: <strong>{micChunkCount}</strong>
        </p>
        <p className="meta">
          Audio bytes received: <strong>{receivedAudioBytes}</strong>
        </p>
        <p className="meta">
          Last backend audio ack:{" "}
          <strong>{lastAckBytes !== null ? `${lastAckBytes} bytes` : "none yet"}</strong>
        </p>
        <p className="meta">
          Mic permission: <strong>{isMicEnabled ? "granted" : "not active"}</strong>
        </p>
        <p className="meta">
          Camera: <strong>{isCameraEnabled ? "active" : "not active"}</strong>
        </p>
      </section>

      <section className="panel">
        <h2>Message Log</h2>
        <ul className="log-list">
          {logs.map((entry) => (
            <li key={entry.id} className={`log-${entry.direction}`}>
              <span>{entry.timestamp}</span>
              <code>{entry.message}</code>
            </li>
          ))}
          {logs.length === 0 && <li className="empty">No messages yet.</li>}
        </ul>
      </section>
    </main>
  );
}
