// Phreak's panel (SPEC §4.7): Start/End, mute, status, live captions and one
// result line per send or stop, for the thread it sits beside.
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useTabVisible,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { SessionAudio } from "./audio";
import { PLUGIN_ID, SESSION_PATH } from "./protocol";
import type { ClientMessage, Delivery, ServerMessage, SessionState } from "./protocol";

type CaptionMessage = Extract<ServerMessage, { type: "caption" }>;
type ActionMessage = Extract<ServerMessage, { type: "action" }>;

/** Everything the panel reacts to: server messages as they arrive, plus local events. */
type PanelEvent =
  | ServerMessage
  | { type: "start" }
  | { type: "mute"; muted: boolean }
  | { type: "playing"; playing: boolean }
  | { type: "latency"; ms: number };

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
  private closed = false;
  private thinkingAt: number | null = null; // when your speech ended, until the reply is audible

  // Must run inside the Start click: SessionAudio needs the user gesture.
  constructor(
    threadId: string,
    private readonly emit: (event: PanelEvent) => void,
  ) {
    this.audio = new SessionAudio((playing) => this.report({ type: "playing", playing }));
    this.ws = new WebSocket(sessionUrl(threadId));
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => (this.opened = true);
    this.ws.onmessage = (event) => this.receive(event.data);
    this.ws.onclose = (event) =>
      this.close(event.reason || (this.opened ? "The connection to Phreak closed." : "Could not reach the Phreak server."));
    this.audio
      .startMic((frame) => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
      })
      .catch((error: unknown) => this.end(`Microphone unavailable: ${error instanceof Error ? error.message : error}`));
  }

  mute(muted: boolean): void {
    this.audio.muted = muted;
  }

  /** Ends the session from this side; the server is told first. */
  end(reason: string): void {
    this.send({ type: "end" });
    this.close(reason);
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) return this.play(data);
    let message: ServerMessage;
    try {
      message = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case "audio_start":
        return this.audio.startItem(message.itemId);
      case "interrupt":
        this.thinkingAt = null;
        return this.send({ type: "played", items: this.audio.flush() });
      case "ended":
        return this.close(message.reason);
      case "status":
        if (message.state === "thinking") this.thinkingAt = performance.now();
    }
    this.report(message);
  }

  private play(pcm: ArrayBuffer): void {
    const onset = this.audio.play(pcm);
    if (onset === null || this.thinkingAt === null) return;
    // Measured to the first audible sample, not the first byte (SPEC §4.2).
    this.report({ type: "latency", ms: Math.round(performance.now() - this.thinkingAt + onset * 1000) });
    this.thinkingAt = null;
  }

  private send(message: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  // Once closed, nothing from this session (late socket or audio events) reaches the panel.
  private report(event: PanelEvent): void {
    if (!this.closed) this.emit(event);
  }

  private close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
    this.audio.close();
    this.emit({ type: "ended", reason });
  }
}

type Entry = (CaptionMessage | ActionMessage) & { key: string };

interface View {
  state: SessionState | "ended" | null; // null until the first Start
  detail: string | null; // the status detail, or why the session ended
  latencyMs: number | null;
  playing: boolean;
  muted: boolean;
  entries: Entry[]; // the session's whole transcript: sessions are capped at 60 minutes
  error: string | null;
}

const IDLE: View = { state: null, detail: null, latencyMs: null, playing: false, muted: false, entries: [], error: null };

function reduce(view: View, event: PanelEvent): View {
  switch (event.type) {
    case "start":
      return { ...IDLE, state: "connecting" };
    case "mute":
      return { ...view, muted: event.muted };
    case "playing":
      return { ...view, playing: event.playing };
    case "latency":
      return { ...view, latencyMs: event.ms };
    case "status":
      return { ...view, state: event.state, detail: event.detail ?? null };
    case "error":
      return { ...view, error: event.message };
    case "caption":
      return { ...view, entries: upsertCaption(view.entries, event) };
    case "action":
      return { ...view, entries: [...view.entries, { ...event, key: `a:${view.entries.length}` }] };
    case "ended":
      return { ...view, state: "ended", detail: event.reason, playing: false, muted: false };
    default:
      return view; // audio_start and interrupt only concern the session's audio
  }
}

// Keyed by item, so an empty caption sent at commit holds the utterance's place until its text arrives.
function upsertCaption(entries: Entry[], caption: CaptionMessage): Entry[] {
  const next: Entry = { ...caption, key: `c:${caption.itemId}` };
  const index = entries.findIndex((entry) => entry.key === next.key);
  if (index === -1) return [...entries, next];
  const current = entries[index];
  if (current.type === "caption" && current.final && !caption.final) return entries;
  return entries.map((entry, i) => (i === index ? next : entry));
}

const DELIVERY_LABEL: Record<Delivery, string> = {
  sent: "Sent",
  queued: "Queued",
  submitted: "Submitted; the agent may still decline",
  stopped: "Stopped",
  stopping: "Stopping; not settled yet",
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
  const live = view.state !== null && view.state !== "ended";

  const end = useCallback((reason: string) => {
    session.current?.end(reason);
    session.current = null;
  }, []);

  const start = () => {
    session.current = new Session(threadId, dispatch); // first: it can throw, e.g. without 24 kHz audio support
    dispatch({ type: "start" });
  };

  const toggleMute = () => {
    session.current?.mute(!view.muted);
    dispatch({ type: "mute", muted: !view.muted });
  };

  // The panel owns the mic: bb keeps hidden tabs mounted, so hiding ends the
  // session too, not only unmounting.
  useEffect(() => {
    if (!visible) end("The Phreak panel was hidden.");
  }, [visible, end]);
  useEffect(() => () => end("The Phreak panel was closed."), [end]);

  // The server says "listening" once it has sent the audio; playback can lag behind.
  const state = view.state === "listening" && view.playing ? "speaking" : view.state;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-sm">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`${BUTTON} ${live ? DESTRUCTIVE : PRIMARY}`}
          onClick={live ? () => end("You ended the session.") : start}
        >
          <Icon name={live ? "Square" : "Mic"} className="size-4" />
          {live ? "End" : "Start"}
        </button>
        <button
          type="button"
          className={`${BUTTON} ${OUTLINE}`}
          aria-pressed={view.muted}
          disabled={!live}
          onClick={toggleMute}
        >
          {view.muted ? "Unmute" : "Mute"}
        </button>
      </div>
      <p className="text-muted-foreground" aria-live="polite">
        {state === null ? "Press Start to talk this thread through." : state[0].toUpperCase() + state.slice(1)}
        {view.detail ? ` · ${view.detail}` : null}
        {view.latencyMs === null ? null : ` · latency ${view.latencyMs} ms`}
      </p>
      {view.error === null ? null : (
        <p role="alert" className="break-words text-destructive">
          {view.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <ol className="flex flex-col gap-3">
          {view.entries.map((entry) =>
            entry.type === "action" ? (
              <ActionLine key={entry.key} action={entry} threadId={threadId} />
            ) : entry.text === "" ? null : (
              <li key={entry.key}>
                <div className="text-xs font-medium text-muted-foreground">{entry.role === "user" ? "You" : "Phreak"}</div>
                <p className={entry.final ? "break-words" : "break-words text-muted-foreground"}>{entry.text}</p>
              </li>
            ),
          )}
        </ol>
      </div>
    </div>
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
