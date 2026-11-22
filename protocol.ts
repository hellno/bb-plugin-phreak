// Messages between the Phreak panel (browser) and server.ts over the
// /session WebSocket. Types and constants only: no logic, safe to import from
// both app.tsx and server.ts.
//
// Binary frames carry PCM16 mono little-endian at SAMPLE_RATE:
//   browser → server: mic audio, ~40 ms per frame (zeros while muted, so
//   voice detection still sees silence).
//   server → browser: assistant audio for the item named by the latest
//   `audio_start` frame.
// Text frames carry the JSON messages below.

export const PLUGIN_ID = "phreak";
export const SAMPLE_RATE = 24_000;
export const SESSION_PATH = "session"; // route "/session" → /api/v1/plugins/phreak/http/session?threadId=…

/**
 * `thinking` is sent when the user stops speaking; the panel measures latency
 * from receiving it to the first audible output.
 */
export type SessionState = "connecting" | "listening" | "thinking" | "speaking" | "reconnecting";

/**
 * Outcome of a send or stop, shown verbatim in the panel.
 * `submitted`: a steer bb accepted; the agent may still decline it.
 * `stopping`: bb accepted the stop but the thread has not settled yet.
 */
export type Delivery = "sent" | "queued" | "submitted" | "stopped" | "stopping" | "refused" | "unknown" | "failed";

export type ServerMessage =
  | { type: "status"; state: SessionState; detail?: string }
  /** Following binary frames belong to this assistant audio item. */
  | { type: "audio_start"; itemId: string }
  /** Flush all playback, then reply with `played`. Sent on barge-in and on reconnect. */
  | { type: "interrupt" }
  /** `text` is the full text so far for this item. An empty user caption at commit reserves its place. */
  | { type: "caption"; role: "user" | "assistant"; itemId: string; text: string; final: boolean }
  | { type: "action"; tool: "send_to_chat" | "stop_agent"; delivery: Delivery; text?: string; threadId: string; detail?: string }
  /** A problem the session survives. */
  | { type: "error"; message: string }
  /** Terminal: the session is over and the socket closes. */
  | { type: "ended"; reason: string };

export type ClientMessage =
  /** Answer to `interrupt`: how much of every flushed item was heard (0 if none). */
  | { type: "played"; items: { itemId: string; ms: number }[] }
  | { type: "end" };
