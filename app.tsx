// Phreak's panel for the thread it sits beside: Start/End and Mute on one row
// with a state chip, live captions, and a card per action. Drafts go into the
// thread's composer. Ctrl+Shift+Space opens the panel, then starts or ends.
import { useCallback, useEffect, useReducer, useRef, type UIEvent } from "react";
import {
  Markdown,
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useSidebarThreads,
  experimental_useTabVisible,
  useComposer,
  useSettings,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { SessionAudio, type Cue } from "./audio";
import { PLUGIN_ID, SESSION_PATH } from "./protocol";
import type { ActionTool, ClientMessage, ServerMessage, SessionState } from "./protocol";

type CaptionMessage = Extract<ServerMessage, { type: "caption" }>;
type ActionMessage = Extract<ServerMessage, { type: "action" }>;

/** What the panel follows: every server message but those only the audio or composer takes, plus local events. */
type PanelEvent =
  | Exclude<ServerMessage, { type: "audio_start" | "draft" }>
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

/** One voice session: the socket to server.ts plus the session's audio. Closing the socket ends it on the server too. */
class Session {
  private readonly audio: SessionAudio;
  private readonly ws: WebSocket;
  private opened = false;
  private closed = false;
  private thinkingAt: number | null = null; // when your speech ended, until the reply is audible
  /** The mic's loudness from 0 to 1, for the level meter: rises at once, falls gently. Muted, it falls to 0. */
  level = 0;

  // Must run inside the Start click: SessionAudio needs the user gesture. Throws if audio or the socket cannot start.
  constructor(
    threadId: string,
    private readonly emit: (event: PanelEvent) => void,
    private readonly draft: (text: string) => void,
  ) {
    this.audio = new SessionAudio((playing) => this.report({ type: "playing", playing }));
    try {
      this.ws = new WebSocket(sessionUrl(threadId));
    } catch (error) {
      this.audio.close();
      throw error;
    }
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => (this.opened = true);
    this.ws.onmessage = (event) => this.receive(event.data);
    this.ws.onclose = (event) =>
      this.end(event.reason || (this.opened ? "The connection to Phreak closed." : "Could not reach the Phreak server."));
    this.audio
      .startMic((frame) => {
        this.level = Math.max(loudness(frame), this.level * 0.8);
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
      })
      .catch((error: unknown) => this.end(`Microphone unavailable: ${errorText(error)}`));
  }

  mute(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  cue(kind: Cue | null): void {
    this.audio.cue(kind);
  }

  end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
    this.audio.close();
    this.emit({ type: "ended", reason });
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
        this.audio.cue(null);
        this.send({ type: "played", items: this.audio.flush() });
        break;
      case "draft":
        try {
          this.draft(message.text);
          return this.send({ type: "drafted", id: message.id, ok: true });
        } catch (error) {
          return this.send({ type: "drafted", id: message.id, ok: false, error: errorText(error) });
        }
      case "ended":
        return this.end(message.reason);
      case "status":
        if (message.state === "thinking") this.thinkingAt = performance.now();
    }
    this.report(message);
  }

  private send(message: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private play(pcm: ArrayBuffer): void {
    const onset = this.audio.play(pcm);
    if (onset === null || this.thinkingAt === null) return;
    // Measured to the first audible sample, not the first byte.
    this.report({ type: "latency", ms: Math.round(performance.now() - this.thinkingAt + onset * 1000) });
    this.thinkingAt = null;
  }

  // Once closed, nothing from this session (late socket or audio events) reaches the panel.
  private report(event: PanelEvent): void {
    if (!this.closed) this.emit(event);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A PCM16 frame's loudness from 0 to 1: -55 dBFS (a quiet room) to -15 dBFS (close speech). */
function loudness(frame: ArrayBuffer): number {
  const pcm = new Int16Array(frame);
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 0x8000;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms || 1e-9) + 55) / 40));
}

type Entry = (CaptionMessage | ActionMessage) & { key: string };

interface View {
  state: SessionState | "ended" | null; // null until the first Start
  reason: string | null; // why the session ended
  latencyMs: number | null;
  playing: boolean;
  talking: boolean; // from an interrupt (you started speaking) to the next status other than listening
  lookups: number; // ask_agent lookups in flight
  muted: boolean;
  entries: Entry[]; // the session's whole transcript: sessions are capped at 60 minutes
  error: string | null;
}

const IDLE: View = { state: null, reason: null, latencyMs: null, playing: false, talking: false, lookups: 0, muted: false, entries: [], error: null };

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
    case "interrupt":
      return { ...view, talking: true };
    case "status":
      return { ...view, state: event.state, talking: view.talking && event.state === "listening" };
    case "lookups":
      return { ...view, lookups: event.running };
    case "error":
      return { ...view, error: event.message };
    case "caption":
      return { ...view, entries: upsertCaption(view.entries, event) };
    case "action":
      return { ...view, entries: [...view.entries, { ...event, key: `a:${view.entries.length}` }] };
    case "ended":
      return { ...view, state: "ended", reason: event.reason, playing: false, muted: false };
  }
}

// Keyed by item, so an empty caption sent at commit holds the utterance's place until its text arrives.
function upsertCaption(entries: Entry[], caption: CaptionMessage): Entry[] {
  const next: Entry = { ...caption, key: `c:${caption.itemId}` };
  const index = entries.findIndex((entry) => entry.key === next.key);
  return index === -1 ? [...entries, next] : entries.map((entry, i) => (i === index ? next : entry));
}

const TAB = { id: "phreak", context: { kind: "thread" }, availability: "action" } as const;
// Voice Mode's Ctrl+Shift chord on Space, which bb and Voice Mode leave free. Ctrl on macOS too.
const SHORTCUT = { key: "Space", control: true, shift: true };
const SHORTCUT_LABEL = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌃⇧Space" : "Ctrl+Shift+Space";

/** The mounted panels by thread, so the shortcut can reach them. */
const panels = new Map<string, { visible: boolean; toggle: () => void }>();
/** The thread whose panel the shortcut opened: its Start button takes focus once it shows. */
let focusStartFor: string | null = null;

/** What the chip shows: the session's state, with muted and lookups split out of listening. */
type Shown = SessionState | "muted" | "lookup" | "ended";
const CHIP: Record<Shown, { icon: string; fallback?: string; label: string; motion?: string }> = {
  connecting: { icon: "Loading", label: "Connecting", motion: "animate-spin" },
  reconnecting: { icon: "Loading", label: "Reconnecting", motion: "animate-spin" },
  listening: { icon: "Mic", label: "Listening" },
  muted: { icon: "phreak/mic-off", fallback: "Mic", label: "Muted" },
  lookup: { icon: "Search", label: "Looking up", motion: "animate-pulse" },
  thinking: { icon: "MoreHorizontal", label: "Thinking", motion: "animate-pulse" },
  speaking: { icon: "phreak/audio-lines", fallback: "Play", label: "Speaking" },
  ended: { icon: "Square", label: "Ended" },
};

const TOOLS: Record<ActionTool, { label: string; icon: string }> = {
  send_to_chat: { label: "Message", icon: "Sent" },
  unsend_message: { label: "Unsend", icon: "ArrowTurnBackward" },
  draft_message: { label: "Draft", icon: "Edit" },
  stop_agent: { label: "Stop", icon: "Square" },
  answer_question: { label: "Answer", icon: "MessageQuestion" },
  start_thread: { label: "New thread", icon: "MessageSquarePlus" },
};
const PROBLEMS = new Set(["refused", "failed", "unknown"]);

/** Endings that need nothing from you, said quietly. */
const ROUTINE = /^(You ended|The Phreak panel was|The session reached|Ended after|A new(er)? Phreak session started|Phreak was reloaded|The conversation outgrew)/;
/** The fix for each problem you can fix, matched on the server's or the browser's message. */
const FIXES: [RegExp, string][] = [
  [/not allowed to use the ChatGPT sign-in/i, "Add `phreak` to codex-realtime's allowed plugins (Settings → Plugins → ChatGPT Realtime Connection), then press Start."],
  [/codex-realtime: .*(unknown plugin|not found|not running|not enabled|no rpc method)/i, "Phreak's voice comes from the ChatGPT Realtime Connection plugin. Install it with `bb plugin install codex-realtime`, then press Start."],
  [/no Codex login|no ChatGPT sign-in/i, "Sign in to Codex with ChatGPT on the machine running bb: run `codex login`, then press Start."],
  [/expired|OpenAI refused or did not answer/i, "Renew the ChatGPT sign-in: run `codex` once on the machine running bb, then press Start."],
  [/Microphone unavailable: .*(NotAllowed|Permission|denied)/i, "Allow this site to use your microphone in the browser, then press Start."],
  [/Microphone unavailable: .*(NotFound|not found)/i, "Connect a microphone, then press Start."],
  [/not served over https or localhost/i, "The microphone needs a secure page: open bb over https or on localhost."],
  [/Could not reach the Phreak server|connection to Phreak closed/i, "Check that Phreak is running with `bb plugin list`, then press Start."],
];

const BUTTON =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const PRIMARY = "bg-foreground text-background hover:bg-foreground/90";
const DESTRUCTIVE = "bg-destructive text-destructive-foreground hover:bg-destructive/90";
const OUTLINE = "border border-border bg-transparent text-foreground hover:bg-state-hover";
const MUTED = "border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15";

function PhreakTab({ threadId }: ExperimentalThreadTabProps) {
  // Keyed so a thread change unmounts the panel, which ends its session.
  return <PhreakPanel key={threadId} threadId={threadId} />;
}

function PhreakPanel({ threadId }: { threadId: string }) {
  const visible = experimental_useTabVisible();
  const [view, dispatch] = useReducer(reduce, IDLE);
  const composer = useComposer();
  const settings = useSettings();
  const session = useRef<Session | null>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const live = view.state !== null && view.state !== "ended";
  useEffect(() => {
    if (!live) session.current = null;
  }, [live]);

  const end = useCallback((reason: string) => {
    session.current?.end(reason);
    session.current = null;
  }, []);

  // Into this thread's composer, after any draft there; it lands even while the composer is off screen.
  const draft = (text: string) => {
    if (composer.scope.kind !== "thread" || composer.scope.threadId !== threadId) throw new Error("the composer here belongs to another thread");
    composer.insert(text, { at: "end", block: true });
  };

  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true); // following the newest line, until you scroll up

  const start = () => {
    try {
      session.current = new Session(threadId, dispatch, draft);
    } catch (error) {
      return dispatch({ type: "ended", reason: `Phreak could not start: ${errorText(error)}` });
    }
    pinned.current = true;
    dispatch({ type: "start" });
  };
  const toggle = live ? () => end("You ended the session.") : start;

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

  useEffect(() => {
    const entry = { visible, toggle };
    panels.set(threadId, entry);
    return () => {
      if (panels.get(threadId) === entry) panels.delete(threadId);
    };
  });
  useEffect(() => {
    if (!visible || focusStartFor !== threadId) return;
    focusStartFor = null;
    startButton.current?.focus();
  }, [visible, threadId]);

  // Keeps the newest line in view as lines arrive and captions grow, unless you scrolled up to read.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !list.current) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(list.current);
    return () => observer.disconnect();
  }, []);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  };

  // The server says "listening" once it has sent the audio; playback can lag behind.
  const state = view.state === "listening" && view.playing ? "speaking" : view.state;
  // A soft pulse once a reply is 700 ms late; a sparse tick while lookups run and nobody speaks.
  const cue = state === "thinking" && !view.talking ? "wait" : state === "listening" && !view.talking && view.lookups > 0 ? "lookup" : null;
  useEffect(() => {
    if (cue === null) return;
    const timer = setTimeout(() => session.current?.cue(cue), cue === "wait" ? 700 : 0);
    return () => (clearTimeout(timer), session.current?.cue(null));
  }, [cue]);

  const shown: Shown | null = state === "listening" ? (view.muted ? "muted" : view.lookups > 0 && !view.talking ? "lookup" : "listening") : state;
  const quietReason = view.state === "ended" && view.reason !== null && ROUTINE.test(view.reason) ? ` ${view.reason}` : "";
  const level = useCallback(() => session.current?.level ?? 0, []);
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <button
          ref={startButton}
          type="button"
          aria-label={live ? "End voice session" : "Start voice session"}
          aria-keyshortcuts="Control+Shift+Space"
          className={`${BUTTON} ${live ? DESTRUCTIVE : PRIMARY}`}
          onClick={toggle}
        >
          <Icon name={live ? "Square" : "Mic"} aria-hidden className="size-4" />
          {live ? "End" : "Start"}
        </button>
        {live ? (
          <button type="button" className={`${BUTTON} ${view.muted ? MUTED : OUTLINE}`} onClick={toggleMute}>
            <Icon name={view.muted ? "phreak/mic-off" : "Mic"} fallback="Mic" aria-hidden className="size-4" />
            {view.muted ? "Unmute" : "Mute"}
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {live ? <LevelMeter level={level} /> : null}
          {shown === null ? null : <StateChip shown={shown} />}
          {settings.values?.showLatency === true && view.latencyMs !== null ? (
            <span className="text-xs tabular-nums text-muted-foreground" title="From the end of your speech to the first audible reply">
              {view.latencyMs} ms
            </span>
          ) : null}
        </div>
        {/* Screen readers hear state changes and quiet endings; captions stay silent. */}
        <span role="status" className="sr-only">
          {shown === null ? "" : `${CHIP[shown].label}.${quietReason}`}
        </span>
      </header>
      {view.error === null ? null : <Notice message={view.error} />}
      {view.state === "ended" && view.reason !== null ? <Notice message={view.reason} /> : null}
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {view.state === null ? <IdleHint /> : null}
        <ol ref={list} aria-label="Conversation" className="flex flex-col gap-5">
          {view.entries.map((entry) =>
            entry.type === "action" ? <ActionCard key={entry.key} action={entry} /> : <Caption key={entry.key} caption={entry} />,
          )}
        </ol>
      </div>
    </div>
  );
}

/** The session's state as an icon and a word, so it never rests on color alone. */
function StateChip({ shown }: { shown: Shown }) {
  const chip = CHIP[shown];
  const tone = shown === "muted" ? "border-destructive/50 text-destructive" : "border-border text-foreground";
  return (
    <span aria-hidden className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium ${tone}`}>
      <Icon name={chip.icon} fallback={chip.fallback} className={`size-3.5 motion-reduce:animate-none ${chip.motion ?? ""}`} />
      {chip.label}
    </span>
  );
}

const BAR_SHAPE = [0.55, 1, 0.75, 0.4];

/** Four thin bars that follow the mic: they move while it hears you and lie flat while silent or muted. */
function LevelMeter({ level }: { level: () => number }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let frame = requestAnimationFrame(function draw() {
      const value = level();
      bars.current.forEach((bar, i) => bar?.style.setProperty("transform", `scaleY(${0.15 + 0.85 * value * BAR_SHAPE[i]})`));
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return (
    <span aria-hidden title="Microphone level" className="flex h-4 items-center gap-0.5">
      {BAR_SHAPE.map((_, i) => (
        <span
          key={i}
          ref={(bar) => {
            bars.current[i] = bar;
          }}
          style={{ transform: "scaleY(0.15)" }}
          className="h-full w-0.5 rounded-full bg-muted-foreground"
        />
      ))}
    </span>
  );
}

function IdleHint() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <Icon name="Mic" aria-hidden className="size-5" />
      <p className="leading-relaxed">Press Start to talk this thread through.</p>
      <p className="text-xs leading-relaxed">
        Shortcut <kbd className="rounded border border-border px-1.5 py-0.5 font-sans">{SHORTCUT_LABEL}</kbd>
        <br />
        Wear headphones so Phreak doesn't hear itself.
      </p>
    </div>
  );
}

/** One spoken turn, written in place: grey while it is still being heard, normal once final. */
function Caption({ caption }: { caption: CaptionMessage }) {
  if (caption.text === "" && caption.final) return null;
  return (
    <li>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{caption.role === "user" ? "You" : "Phreak"}</div>
      {caption.text === "" ? (
        // Holds the place of words not yet transcribed, so the lines after it do not move.
        <p aria-hidden className="text-muted-foreground">…</p>
      ) : (
        <p className={`whitespace-pre-wrap break-words leading-relaxed ${caption.final ? "text-foreground" : "text-muted-foreground"}`}>{caption.text}</p>
      )}
    </li>
  );
}

/** What an action did: bb's own status, then the text as the chat shows it. */
function ActionCard({ action }: { action: ActionMessage }) {
  const tool = TOOLS[action.tool];
  const problem = PROBLEMS.has(action.status);
  return (
    <li className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        <Icon name={tool.icon} aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">{tool.label}</span>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <span className={problem ? "inline-flex items-center gap-1 font-medium text-destructive" : "text-muted-foreground"}>
          {problem ? <Icon name="AlertCircle" aria-hidden className="size-3.5" /> : null}
          {action.status[0].toUpperCase() + action.status.slice(1)}
        </span>
      </div>
      {action.detail ? <p className="mt-1 break-words text-xs text-muted-foreground">{action.detail}</p> : null}
      {action.text ? <Markdown content={action.text} className="mt-2 break-words" /> : null}
      {action.threadId ? <NewThreadLink threadId={action.threadId} /> : null}
    </li>
  );
}

/** Why the session ended or what went wrong: routine endings quietly, problems with the fix first. */
function Notice({ message }: { message: string }) {
  if (ROUTINE.test(message)) return <p className="px-4 pt-3 text-xs text-muted-foreground">{message}</p>;
  const fix = FIXES.find(([pattern]) => pattern.test(message))?.[1];
  return (
    <div role="alert" className="mx-4 mt-3 flex gap-2 rounded-lg border border-border px-3 py-2.5">
      <Icon name="AlertCircle" aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 break-words">
        <p className="leading-relaxed text-foreground">
          <WithCode text={fix ?? message} />
        </p>
        {fix ? (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Details</summary>
            <p className="mt-1">{message}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Text with `code` spans, as the fixes are written. */
function WithCode({ text }: { text: string }) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** Opens a new thread in a browser tab of its own: opening it in bb would unmount this panel and end the session. */
function NewThreadLink({ threadId }: { threadId: string }) {
  const href = experimental_useSidebarThreads().threads.find((thread) => thread.id === threadId)?.href;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${BUTTON} ${OUTLINE} mt-2`}>
      <Icon name="ExternalLink" aria-hidden className="size-4" />
      Open in a new tab
    </a>
  ) : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...TAB,
    title: "Phreak",
    tooltip: "Talk this thread through by voice",
    icon: "Mic",
    layout: "flush",
    component: PhreakTab,
  });
  app.commands.register({
    id: "toggle",
    title: "Phreak: start or end voice",
    defaultShortcut: SHORTCUT,
    isAvailable: ({ threadId }) => threadId !== null,
    run({ threadId, experimental_panel }) {
      if (threadId === null) return;
      // A session needs its panel on screen, and audio may only start inside a key press or click.
      // So a press while the panel is hidden opens it and focuses Start; the next press starts.
      const panel = panels.get(threadId);
      if (panel?.visible) return panel.toggle();
      focusStartFor = threadId;
      experimental_panel.openTab({ tab: TAB, title: "Phreak" });
    },
  });
});
