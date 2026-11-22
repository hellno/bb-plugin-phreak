// Messages between the Phreak panel (browser) and server.ts over the
// /session WebSocket. Types and constants only, safe to import from both sides.
//
// Binary frames carry PCM16 mono little-endian at SAMPLE_RATE: mic audio from
// the browser (~40 ms a frame, silence while muted), and assistant audio from
// the server for the item named by the latest `audio_start`. Text frames carry
// the JSON messages below. Closing the socket ends the session.

export const PLUGIN_ID = "phreak";
export const SAMPLE_RATE = 24_000;
export const SESSION_PATH = "session"; // → /api/v1/plugins/phreak/http/session?threadId=…

/** `thinking` is sent when the user stops speaking; the panel measures latency from it to the first audible output. */
export type SessionState = "connecting" | "listening" | "thinking" | "speaking" | "reconnecting";

export type ActionTool = "send_to_chat" | "stop_agent" | "answer_question";

/**
 * What came of a send, stop or answer, given as is to the model and the panel. `status` is bb's: the delivery
 * (sent, queued), the thread's status after a stop, or the card's (submitted, answered, interrupted). Otherwise
 * it is refused (bb was not asked), failed (bb refused) or unknown (bb did not answer).
 */
export type ActionResult = { status: string; text?: string; detail?: string };

export type ServerMessage =
  | { type: "status"; state: SessionState }
  /** Following binary frames belong to this assistant audio item. */
  | { type: "audio_start"; itemId: string }
  /** Flush all playback, then reply with `played`. Sent on barge-in and on reconnect. */
  | { type: "interrupt" }
  /** `text` is the full text so far for this item. An empty user caption at commit reserves its place. */
  | { type: "caption"; role: "user" | "assistant"; itemId: string; text: string; final: boolean }
  | ({ type: "action"; tool: ActionTool } & ActionResult)
  /** A problem the session survives. */
  | { type: "error"; message: string }
  /** Terminal: the session is over and the socket closes. */
  | { type: "ended"; reason: string };

/** Answer to `interrupt`: how much of every flushed item was heard (0 if none). */
export type ClientMessage = { type: "played"; items: { itemId: string; ms: number }[] };
