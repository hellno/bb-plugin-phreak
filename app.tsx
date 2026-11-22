// Phreak's panel (SPEC §4.8): Start/End, mute, status, live captions and one
// result line per send or stop, for the thread it sits beside.
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useTabVisible,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { SessionAudio } from "./audio";
import {
  PLUGIN_ID,
  SESSION_PATH,
  type ClientMessage,
  type Delivery,
  type ServerMessage,
  type SessionState,
} from "./protocol";

const MAX_ENTRIES = 100;

type CaptionMessage = Extract<ServerMessage, { type: "caption" }>;
type ActionMessage = Extract<ServerMessage, { type: "action" }>;
/** Server messages the view renders; audio and `ended` are handled by Session. */
type ViewMessage = Exclude<ServerMessage, { type: "audio_start" | "interrupt" | "ended" }>;

type SessionEvent =
  | { type: "message"; message: ViewMessage }
  | { type: "playing"; playing: boolean }
  | { type: "closed"; reason: string };

// Same-origin route, as in Voice Mode's session.ts (steveafrost/bb-plugin-voice-mode, MIT).
function sessionUrl(threadId: string): string {
  const url = new URL(`/api/v1/plugins/${PLUGIN_ID}/http/${SESSION_PATH}`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("threadId", threadId);
  return url.toString();
}

/** One voice session: the socket to server.ts plus the session's audio. */
class Session {
  private readonly audio: SessionAudio;
  private readonly ws: WebSocket;
  private opened = false;
  private muted = false;
  private closed = false;

  // Must run inside the Start click: SessionAudio needs the user gesture.
  constructor(
    threadId: string,
    private readonly emit: (event: SessionEvent) => void,
  ) {
    this.audio = new SessionAudio((playing) => this.report({ type: "playing", playing }));
    this.ws = new WebSocket(sessionUrl(threadId));
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      this.opened = true;
      if (this.muted) this.send({ type: "mute", muted: true });
    };
    this.ws.onmessage = (event) => this.receive(event.data);
    this.ws.onclose = (event) =>
      this.close(event.reason || (this.opened ? "The connection to Phreak closed." : "Could not reach the Phreak server."));
    this.audio
      .startMic((frame) => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
      })
      .catch((error: unknown) => this.end(`Microphone unavailable: ${errorText(error)}`));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.audio.setMuted(muted);
    this.send({ type: "mute", muted });
  }

  /** Ends the session from this side; the server is told first. */
  end(reason: string): void {
    this.send({ type: "end" });
    this.close(reason);
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) return this.audio.play(data);
    const message = parseMessage(data);
    if (message === null) return;
    switch (message.type) {
      case "audio_start":
        return this.audio.startItem(message.itemId);
      case "interrupt": {
        const heard = this.audio.interrupt();
        if (heard !== null) this.send({ type: "played", ...heard });
        return;
      }
      case "ended":
        return this.close(message.reason);
      default:
        this.report({ type: "message", message });
    }
  }

  private send(message: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private report(event: SessionEvent): void {
    if (!this.closed) this.emit(event);
  }

  private close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    // Detached first, so a dying socket can never touch the next session's view.
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.close();
    this.audio.close();
    this.emit({ type: "closed", reason });
  }
}

function parseMessage(data: unknown): ServerMessage | null {
  try {
    return JSON.parse(String(data)) as ServerMessage;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Entry =
  | { kind: "caption"; key: string; role: CaptionMessage["role"]; text: string; final: boolean }
  | { kind: "action"; key: string; action: ActionMessage };

interface View {
  live: boolean;
  state: SessionState | null; // null until the first Start
  detail: string | null;
  latencyMs: number | null;
  playing: boolean;
  muted: boolean;
  entries: Entry[];
  seq: number;
  error: string | null;
  endReason: string | null;
}

const IDLE: View = {
  live: false,
  state: null,
  detail: null,
  latencyMs: null,
  playing: false,
  muted: false,
  entries: [],
  seq: 0,
  error: null,
  endReason: null,
};

type ViewEvent = SessionEvent | { type: "start" } | { type: "mute"; muted: boolean };

function reduce(view: View, event: ViewEvent): View {
  switch (event.type) {
    case "start":
      return { ...IDLE, live: true, state: "connecting" };
    case "mute":
      return { ...view, muted: event.muted };
    case "playing":
      return { ...view, playing: event.playing };
    case "closed":
      return { ...view, live: false, state: "ended", detail: null, playing: false, muted: false, endReason: event.reason };
    case "message":
      return applyMessage(view, event.message);
  }
}

function applyMessage(view: View, message: ViewMessage): View {
  switch (message.type) {
    case "status":
      return { ...view, state: message.state, detail: message.detail ?? null };
    case "latency":
      return { ...view, latencyMs: message.ms };
    case "error":
      return { ...view, error: message.message };
    case "caption":
      return { ...view, entries: upsertCaption(view.entries, message) };
    case "action":
      return {
        ...view,
        seq: view.seq + 1,
        entries: append(view.entries, { kind: "action", key: `a:${view.seq}`, action: message }),
      };
  }
}

function upsertCaption(entries: Entry[], { itemId, role, text, final }: CaptionMessage): Entry[] {
  const next: Entry = { kind: "caption", key: `c:${itemId}`, role, text, final };
  const index = entries.findIndex((entry) => entry.key === next.key);
  if (index === -1) return append(entries, next);
  const current = entries[index];
  if (current.kind === "caption" && current.final && !final) return entries;
  return entries.map((entry, i) => (i === index ? next : entry));
}

function append(entries: Entry[], entry: Entry): Entry[] {
  return [...entries, entry].slice(-MAX_ENTRIES);
}

const STATE_LABEL: Record<SessionState, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  reconnecting: "Reconnecting…",
  ended: "Ended",
};

const DELIVERY_LABEL: Record<Delivery, string> = {
  sent: "Sent",
  queued: "Queued",
  stopped: "Stopped",
  refused: "Refused",
  unknown: "Delivery unknown",
  failed: "Failed",
};

const BUTTON =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const PRIMARY = "bg-foreground text-background hover:bg-foreground/90";
const DESTRUCTIVE = "bg-destructive text-destructive-foreground hover:bg-destructive/90";
const OUTLINE = "border border-input bg-transparent hover:bg-state-hover aria-pressed:bg-state-active";

function PhreakTab({ threadId }: ExperimentalThreadTabProps) {
  // Keyed so a thread change unmounts the panel, which ends its session.
  return <PhreakPanel key={threadId} threadId={threadId} />;
}

function PhreakPanel({ threadId }: { threadId: string }) {
  const visible = experimental_useTabVisible();
  const [view, dispatch] = useReducer(reduce, IDLE);
  const session = useRef<Session | null>(null);

  const end = useCallback((reason: string) => {
    session.current?.end(reason);
    session.current = null;
  }, []);

  const start = () => {
    end("Restarted.");
    dispatch({ type: "start" });
    session.current = new Session(threadId, dispatch);
  };

  const toggleMute = () => {
    const muted = !view.muted;
    session.current?.setMuted(muted);
    dispatch({ type: "mute", muted });
  };

  // The panel owns the mic: bb keeps hidden tabs mounted, so hiding ends the
  // session too, not only unmounting.
  useEffect(() => {
    if (!visible) end("The Phreak panel was hidden.");
  }, [visible, end]);
  useEffect(() => () => end("The Phreak panel was closed."), [end]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-sm">
      <div className="flex items-center gap-2">
        {view.live ? (
          <button type="button" className={`${BUTTON} ${DESTRUCTIVE}`} onClick={() => end("You ended the session.")}>
            <Icon name="Square" className="size-4" />
            End
          </button>
        ) : (
          <button type="button" className={`${BUTTON} ${PRIMARY}`} onClick={start}>
            <Icon name="Mic" className="size-4" />
            Start
          </button>
        )}
        <button
          type="button"
          className={`${BUTTON} ${OUTLINE}`}
          aria-pressed={view.muted}
          disabled={!view.live}
          onClick={toggleMute}
        >
          {view.muted ? "Unmute" : "Mute"}
        </button>
      </div>
      <StatusLine view={view} />
      {view.error === null ? null : (
        <p role="alert" className="break-words text-destructive">
          {view.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <ol className="flex flex-col gap-3">
          {view.entries.map((entry) =>
            entry.kind === "caption" ? (
              entry.text === "" ? null : <CaptionLine key={entry.key} entry={entry} />
            ) : (
              <ActionLine key={entry.key} action={entry.action} threadId={threadId} />
            ),
          )}
        </ol>
      </div>
    </div>
  );
}

function StatusLine({ view }: { view: View }) {
  // The server says "listening" once it has sent the audio; playback can lag behind.
  const state = view.state === "listening" && view.playing ? "speaking" : view.state;
  const extra = view.live ? view.detail : view.endReason;
  return (
    <p className="text-muted-foreground" aria-live="polite">
      {state === null ? "Press Start to talk this thread through." : STATE_LABEL[state]}
      {extra ? ` · ${extra}` : null}
      {view.latencyMs === null ? null : ` · latency ${view.latencyMs} ms`}
    </p>
  );
}

function CaptionLine({ entry }: { entry: Extract<Entry, { kind: "caption" }> }) {
  return (
    <li>
      <div className="text-xs font-medium text-muted-foreground">{entry.role === "user" ? "You" : "Phreak"}</div>
      <p className={entry.final ? "break-words" : "break-words text-muted-foreground"}>{entry.text}</p>
    </li>
  );
}

function ActionLine({ action, threadId }: { action: ActionMessage; threadId: string }) {
  const failed = action.delivery === "unknown" || action.delivery === "failed";
  return (
    <li className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">
        <span className={failed ? "font-medium text-destructive" : "font-medium text-foreground"}>
          {DELIVERY_LABEL[action.delivery]}
        </span>
        {` · ${action.tool === "send_to_chat" ? "message" : "stop"} → `}
        {action.threadId === threadId ? "this thread" : <code>{action.threadId}</code>}
      </div>
      {action.text ? <p className="mt-1 whitespace-pre-wrap break-words">{action.text}</p> : null}
      {action.detail ? <p className="mt-1 text-xs text-muted-foreground">{action.detail}</p> : null}
    </li>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "phreak",
    title: "Phreak",
    tooltip: "Talk this thread through by voice",
    icon: "Mic",
    layout: "flush",
    component: PhreakTab,
  });
});
