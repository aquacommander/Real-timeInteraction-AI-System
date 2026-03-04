# Live Agents Hackathon Project

Milestone 1:
- Monorepo scaffolding (`frontend` + `backend`)
- WebSocket text + binary protocol

Milestone 2:
- Browser microphone capture (Web Audio API)
- PCM16 frame streaming to backend over WebSocket
- Mocked backend audio stream for immediate playback tests
- UI states: disconnected, connecting, listening, speaking

Milestone 3:
- Backend Gemini Live session via `@google/genai`
- Realtime audio relay (mic audio in, Gemini audio out)
- Optional text prompt trigger for deterministic testing
