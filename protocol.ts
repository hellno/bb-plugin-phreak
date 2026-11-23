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

export type ActionTool = "send_to_chat" | "unsend_message" | "draft_message" | "stop_agent" | "answer_question" | "start_thread";

/**
 * What came of an action, given as is to the model and the panel. `status` is bb's where it has one: the delivery
 * (sent, queued), the thread's status after a stop or of a new thread, or the card's (submitted, answered,
 * interrupted); else withdrawn or drafted. Otherwise it is refused (bb was not asked), failed (bb refused) or
 * unknown (bb did not answer). `threadId` is the thread start_thread started.
 */
export type ActionResult = { status: string; text?: string; detail?: string; threadId?: string };

export type ServerMessage =
  | { type: "status"; state: SessionState }
  /** Following binary frames belong to this assistant audio item. */
  | { type: "audio_start"; itemId: string }
  /** Flush all playback, then reply with `played`. Sent on barge-in and on reconnect. */
  | { type: "interrupt" }
  /** `text` is the full text so far for this item. An empty user caption at commit reserves its place; a final empty one says no words came. */
  | { type: "caption"; role: "user" | "assistant"; itemId: string; text: string; final: boolean }
  | ({ type: "action"; tool: ActionTool } & ActionResult)
  /** Text for the panel to add to its thread's composer, after any draft there; the panel answers `drafted`. */
  | { type: "draft"; id: string; text: string }
  /** How many look_up lookups are in flight, sent whenever that changes. */
  | { type: "lookups"; running: number }
  /** A problem the session survives. */
  | { type: "error"; message: string }
  /** Terminal: the session is over and the socket closes. */
  | { type: "ended"; reason: string };

export type Played = { itemId: string; ms: number }[];

/** The mic and its noise gate, sent every few seconds and logged by the server at the session's end. Levels in dBFS. */
export type MicReport = {
  device: string;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  frames: number;
  openFrames: number;
  opens: number;
  strictOpens: number;
  rejected: number;
  relearned: number;
  floorDb: number;
  firstFloorDb: number | null;
  maxFloorDb: number;
  speechPeakDb: number;
  noisePeakDb: number;
};

export type ClientMessage =
  /** Answer to `interrupt`: how much of every flushed item was heard (0 if none). */
  | { type: "played"; items: Played }
  /** Answer to `draft` once the composer took it, or the composer's error. */
  | { type: "drafted"; id: string; ok: boolean; error?: string }
  /** How the mic and its noise gate are doing. */
  | { type: "mic"; report: MicReport };
