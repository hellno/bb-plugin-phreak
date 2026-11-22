// Messages between the Phreak panel (browser) and server.ts over the
// /session WebSocket. Types and constants only: no logic, safe to import from
// both app.tsx and server.ts.
//
// Binary frames carry PCM16 mono little-endian at SAMPLE_RATE:
//   browser → server: mic audio, ~40 ms per frame.
//   server → browser: assistant audio for the item named by the latest
//   `audio_start` frame.
// Text frames carry the JSON messages below.

export const PLUGIN_ID = "phreak";
export const SAMPLE_RATE = 24_000;
export const SESSION_PATH = "session"; // → /api/v1/plugins/phreak/http/session?threadId=…

export type SessionState = "connecting" | "listening" | "thinking" | "speaking" | "reconnecting" | "ended";

/** Outcome of a send or stop, shown verbatim in the panel. */
export type Delivery = "sent" | "queued" | "stopped" | "refused" | "unknown" | "failed";

export type ServerMessage =
  | { type: "status"; state: SessionState; detail?: string }
  /** Following binary frames belong to this assistant audio item. */
  | { type: "audio_start"; itemId: string }
  /** User started speaking: flush playback, then reply with `played`. */
  | { type: "interrupt" }
  | { type: "caption"; role: "user" | "assistant"; itemId: string; text: string; final: boolean }
  /** End of user speech → first assistant audio byte, measured on the server. */
  | { type: "latency"; ms: number }
  | { type: "action"; tool: "send_to_chat" | "stop_agent"; delivery: Delivery; text?: string; threadId: string; detail?: string }
  | { type: "error"; message: string }
  | { type: "ended"; reason: string };

export type ClientMessage =
  | { type: "mute"; muted: boolean }
  /** Answer to `interrupt`: how much of the item was actually heard. */
  | { type: "played"; itemId: string; ms: number }
  | { type: "end" };
