// Phreak's panel for the thread it sits beside: Start/End and Mute on one row
// with a state chip, live captions, and a card per action. Drafts go into the
// thread's composer. Ctrl+Shift+Space starts or ends, opening the panel if needed.
import { useCallback, useEffect, useReducer, useRef, useState, type MouseEvent, type RefObject, type UIEvent } from "react";
import {
  Markdown,
  definePluginApp,
  experimental_Icon as Icon,
  experimental_copyToClipboard,
  experimental_useSidebarThreads,
  experimental_useTabVisible,
  useComposer,
  useSettings,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { SessionAudio, type Cue } from "./audio";
import { sessionDebug } from "./diagnostics";
import { PLUGIN_ID, SESSION_PATH } from "./protocol";
import type { ActionTool, ClientMessage, MicReport, ServerMessage, SessionState } from "./protocol";

type CaptionMessage = Extract<ServerMessage, { type: "caption" }>;
type ActionMessage = Extract<ServerMessage, { type: "action" }>;

/** What the panel follows: every server message but those only the audio or composer takes, plus local events. */
type PanelEvent =
  | Exclude<ServerMessage, { type: "audio_start" | "draft" | "ended" }>
  | { type: "ended"; reason: string; mic?: MicReport }
  | { type: "start" }
  | { type: "mute"; muted: boolean }
  | { type: "playing"; playing: boolean }
  | { type: "latency"; ms: number };

const AUDIO_CHECK_MS = 2_000;
const MIC_REPORT_MS = 10_000; // the server logs the latest at the session's end, which may come from its side

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
  private micReports: ReturnType<typeof setInterval> | undefined;

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
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
      })
      .catch((error: unknown) => this.end(`Microphone unavailable: ${error instanceof Error ? `${error.name}: ` : ""}${errorText(error)}`));
    // A browser may keep audio off when no click or key press started it (Safari after the palette, say).
    setTimeout(() => {
      if (this.closed) return;
      void this.audio.ensureRunning().then((running) => {
        if (!running) this.end("The browser kept audio off. Press Start.");
      });
    }, AUDIO_CHECK_MS);
    // Started last, so a constructor that throws leaves no timer behind.
    this.micReports = setInterval(() => this.sendMicReport(), MIC_REPORT_MS);
  }

  /** The level meter's reading: the mic's loudness from 0 to 1, and whether Phreak hears it as speech. */
  get meter(): { level: number; passing: boolean } {
    return this.audio.meter;
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
    clearInterval(this.micReports);
    const mic = this.audio.micReport();
    this.send({ type: "mic", report: mic });
    this.ws.close();
    this.audio.close();
    this.emit({ type: "ended", reason, mic });
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

  private sendMicReport(): void {
    this.send({ type: "mic", report: this.audio.micReport() });
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

type Entry = (CaptionMessage | ActionMessage) & { key: string };

interface View {
  state: SessionState | "ended" | null; // null until the first Start
  reason: string | null; // why the session ended
  latencyMs: number | null;
  playing: boolean;
  talking: boolean; // from an interrupt (you started speaking) to the next status other than listening
  lookups: number; // look_up lookups in flight
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
    case "status": {
      // You started speaking (an interrupt, then listening; a reconnect's interrupt is followed by reconnecting).
      const talking = view.talking && event.state === "listening";
      return { ...view, state: event.state, talking, entries: talking ? withHearing(view.entries) : view.entries };
    }
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

/** Your line while you speak, before the server has an item for it; your next caption takes its place. */
const HEARING: Entry = { type: "caption", role: "user", itemId: "", text: "", final: false, key: "c:hearing" };

/** Puts your speaking line last, moving one left behind by speech that never became an utterance. */
function withHearing(entries: Entry[]): Entry[] {
  return entries.at(-1)?.key === HEARING.key ? entries : [...entries.filter((entry) => entry.key !== HEARING.key), HEARING];
}

// Keyed by item, so an empty caption sent at commit holds the utterance's place until its text arrives.
function upsertCaption(entries: Entry[], caption: CaptionMessage): Entry[] {
  const next: Entry = { ...caption, key: `c:${caption.itemId}` };
  let index = entries.findIndex((entry) => entry.key === next.key);
  if (index === -1 && caption.role === "user") index = entries.findIndex((entry) => entry.key === HEARING.key);
  return index === -1 ? [...entries, next] : entries.map((entry, i) => (i === index ? next : entry));
}

const TAB = { id: "phreak", context: { kind: "thread" }, availability: "action" } as const;
// Voice Mode's Ctrl+Shift chord on Space, which bb and Voice Mode leave free. Ctrl on macOS too.
const SHORTCUT = { key: "Space", control: true, shift: true };
const PENDING_START_MS = 3_000;

/** The mounted panels by thread, so the shortcut can reach them. */
const panels = new Map<string, { visible: boolean; toggle: () => void }>();
/** A shortcut press that opened a hidden panel: the panel starts once it shows, if that is soon. */
let pendingStart: { threadId: string; at: number } | null = null;
/** When the shortcut last toggled: a browser may also click the focused button on the Space key's release. */
let shortcutAt = 0;

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
  send_to_chat: { label: "To agent", icon: "Sent" },
  unsend_message: { label: "Unsend", icon: "ArrowTurnBackward" },
  draft_message: { label: "Draft", icon: "Edit" },
  stop_agent: { label: "Stop agent", icon: "Square" },
  answer_question: { label: "Answer", icon: "MessageQuestion" },
  start_thread: { label: "New thread", icon: "MessageSquarePlus" },
};
const PROBLEMS = new Set(["refused", "failed", "unknown"]);

/** Endings that need nothing from you, said quietly. */
const ROUTINE = /^(You ended|The Phreak panel was|The session reached|Ended after|A new(er)? Phreak session started|Phreak was reloaded|The conversation outgrew)/;
/** The fix for each problem you can fix, matched on the server's or the browser's message. */
const FIXES: [RegExp, string][] = [
  [/not allowed to use the ChatGPT sign-in/i, "Allow Phreak in ChatGPT Realtime Connection's settings: add `phreak` to **Plugins that may use the sign-in**, then press Start."],
  [/codex-realtime: .*unknown plugin/i, "Phreak's voice comes from the ChatGPT Realtime Connection plugin. Install it with `bb plugin install codex-realtime`, then press Start."],
  [/codex-realtime: .*(not running|not enabled|disabled|no rpc method)/i, "ChatGPT Realtime Connection isn't running. Turn it on with `bb plugin enable codex-realtime`, or check `bb plugin list`, then press Start."],
  [/no Codex login|no ChatGPT sign-in/i, "Sign in to Codex with ChatGPT on the machine running bb: run `codex login`, then press Start."],
  [/expired|OpenAI refused or did not answer/i, "Renew the ChatGPT sign-in: run `codex` once on the machine running bb, then press Start."],
  [/Microphone unavailable: .*(NotAllowedError|SecurityError|denied|not allowed)/i, "Allow this site to use your microphone in the browser, then press Start."],
  [/Microphone unavailable: .*(NotFoundError|OverconstrainedError|not found|can ?not be found)/i, "Connect a microphone, then press Start."],
  [/not served over https or localhost/i, "The microphone needs a secure page: open bb over https or on localhost."],
  [/Could not reach the Phreak server|connection to Phreak closed/i, "Check that Phreak is running with `bb plugin list`, then press Start."],
  [/closed the session during setup|connection dropped/i, "The voice connection dropped. Press Start to reconnect."],
];

const BUTTON =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const PRIMARY = "bg-foreground text-background hover:bg-foreground/90";
const OUTLINE = "border border-border bg-transparent text-foreground hover:bg-state-hover";
const MUTED = "border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15";

function PhreakTab({ threadId }: ExperimentalThreadTabProps) {
  // Keyed so a thread change unmounts the panel, which ends its session.
  return <PhreakPanel key={threadId} threadId={threadId} />;
}

function PhreakPanel({ threadId }: { threadId: string }) {
  const visible = experimental_useTabVisible();
  const [view, dispatch] = useReducer(reduce, IDLE);
  const debugKey = `phreak:last-session:${threadId}`;
  const [debug, setDebug] = useState(() => {
    try {
      return sessionStorage.getItem(debugKey);
    } catch {
      return null;
    }
  });
  const composer = useComposer();
  const settings = useSettings();
  const session = useRef<Session | null>(null);
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
  const lastTop = useRef(0);

  const start = () => {
    const started = new Date();
    let sessionId: string | null = null;
    let lastError: string | null = null;
    const receive = (event: PanelEvent) => {
      if (event.type === "status") sessionId = event.sessionId;
      if (event.type === "error") lastError = event.message;
      if (event.type === "ended") {
        const report = sessionDebug(threadId, started, sessionId, event.reason, lastError, event.mic);
        setDebug(report);
        try {
          sessionStorage.setItem(debugKey, report);
        } catch {
          // Storage may be disabled. The mounted panel still has the report.
        }
      }
      dispatch(event);
    };
    dispatch({ type: "start" });
    try {
      session.current = new Session(threadId, receive, draft);
    } catch (error) {
      return receive({ type: "ended", reason: `Phreak could not start: ${errorText(error)}` });
    }
    pinned.current = true;
  };
  const toggle = live ? () => end("You ended the session.") : start;
  // Start moves between the empty panel and the top row, so focus follows the button you pressed.
  const toggleButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const onToggleClick = (event: MouseEvent) => {
    if (event.detail === 0 && performance.now() - shortcutAt < 500) return; // the shortcut's own key release
    refocus.current = true;
    toggle();
  };
  useEffect(() => {
    if (refocus.current) toggleButton.current?.focus();
    refocus.current = false;
  }, [live]);

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
    if (!visible || pendingStart?.threadId !== threadId) return;
    const fresh = performance.now() - pendingStart.at < PENDING_START_MS;
    pendingStart = null;
    if (fresh && !live) start();
  }, [visible, threadId]);

  // Keeps the newest line in view as lines arrive, captions grow or the box shrinks, unless you scrolled up to read.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !list.current) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(list.current);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 40) pinned.current = true;
    else if (box.scrollTop < lastTop.current) pinned.current = false; // only your own scroll moves it up
    lastTop.current = box.scrollTop;
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
  const announced =
    shown === null
      ? ""
      : `${CHIP[shown].label}${view.muted && shown !== "muted" ? ", muted" : ""}.` +
        (view.state === "ended" && view.reason !== null && ROUTINE.test(view.reason) ? ` ${view.reason}` : "");
  const level = useCallback(() => session.current?.meter ?? SILENT, []);
  // Your newest line holds its place while empty, until its final caption says no words came. Before the server names
  // the turn, your speaking line shows only while you talk or Phreak thinks, so a start that never became a turn hides.
  const newestYours = view.entries.filter((entry) => entry.type === "caption" && entry.role === "user").at(-1)?.key;
  const holdsPlace = (entry: Entry) =>
    live && entry.type === "caption" && !entry.final && entry.key === newestYours && (entry.key !== HEARING.key || view.talking || view.state === "thinking");
  const lines = view.entries.filter((entry) => entry.type === "action" || entry.text !== "" || holdsPlace(entry));
  const empty = lines.length === 0;
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      {/* Screen readers hear state changes and quiet endings; captions stay silent. */}
      <span role="status" className="sr-only">
        {announced}
      </span>
      {live || !empty ? (
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <button
            ref={toggleButton}
            type="button"
            aria-label={live ? "End voice session" : "Start voice session"}
            className={`${BUTTON} ${live ? OUTLINE : PRIMARY}`}
            onClick={onToggleClick}
          >
            <Icon name={live ? "Square" : "Mic"} aria-hidden className={live ? "size-3.5 text-destructive" : "size-4"} />
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
        </header>
      ) : null}
      {view.error === null ? null : <Notice message={view.error} />}
      {view.state === "ended" && view.reason !== null ? <Notice message={view.reason} /> : null}
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {empty && !live ? <StartHere buttonRef={toggleButton} onStart={onToggleClick} /> : null}
        {empty && live && shown !== null ? <Waiting level={level} label={CHIP[shown].label} /> : null}
        <ol ref={list} aria-label="Conversation" className="flex flex-col gap-5">
          {lines.map((entry) =>
            entry.type === "action" ? (
              <ActionCard key={entry.key} action={entry} />
            ) : (
              <Caption key={entry.key} caption={entry} />
            ),
          )}
        </ol>
      </div>
      {!live && debug ? <SessionDebug key={debug} report={debug} /> : null}
    </div>
  );
}

function SessionDebug({ report }: { report: string }) {
  const [result, setResult] = useState<boolean | null>(null);
  return (
    <footer className="border-t border-border px-4 py-2">
      <button
        type="button"
        className={`${BUTTON} ${OUTLINE}`}
        onClick={async () => setResult(await experimental_copyToClipboard({ text: report }))}
      >
        <Icon name="Copy" aria-hidden className="size-3.5" />
        Copy session debug info
      </button>
      <span role="status" className="ml-2 text-xs text-muted-foreground">
        {result === true ? "Copied" : result === false ? "Select and copy below." : ""}
      </span>
      {result === false ? (
        <textarea
          readOnly
          aria-label="Session debug info"
          value={report}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-2 w-full rounded border border-border bg-background p-2 font-mono text-xs"
          rows={4}
        />
      ) : null}
    </footer>
  );
}

/** Before the first session, or after one that said nothing: the one thing to do. */
function StartHere({ buttonRef, onStart }: { buttonRef: RefObject<HTMLButtonElement | null>; onStart: (event: MouseEvent) => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground">
      <Icon name="Mic" aria-hidden className="size-6" />
      <button ref={buttonRef} type="button" aria-label="Start voice session" className={`${BUTTON} ${PRIMARY}`} onClick={onStart}>
        Start
      </button>
      <p className="text-xs">Best with a headset</p>
    </div>
  );
}

/** A live session before anyone spoke: the mic level, big, so you can see it hears you. */
function Waiting({ level, label }: { level: () => { level: number; passing: boolean }; label: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <LevelMeter level={level} large />
      <p className="text-xs">{label}</p>
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
const SILENT = { level: 0, passing: false };

/** Thin bars that follow the mic: faint while Phreak treats the sound as noise, full once it hears speech. */
function LevelMeter({ level, large = false }: { level: () => { level: number; passing: boolean }; large?: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let frame = requestAnimationFrame(function draw() {
      const { level: value, passing } = level();
      bars.current.forEach((bar, i) => {
        bar?.style.setProperty("transform", `scaleY(${0.15 + 0.85 * value * BAR_SHAPE[i]})`);
        bar?.style.setProperty("opacity", passing ? "1" : "0.35");
      });
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return (
    <span aria-hidden title="Microphone level: faint is noise Phreak ignores, full is speech it hears" className={`flex items-center motion-reduce:hidden ${large ? "h-10 gap-1.5" : "h-4 gap-0.5"}`}>
      {BAR_SHAPE.map((_, i) => (
        <span
          key={i}
          ref={(bar) => {
            bars.current[i] = bar;
          }}
          style={{ transform: "scaleY(0.15)", opacity: 0.35 }}
          className={`h-full rounded-full bg-foreground ${large ? "w-1" : "w-0.5"}`}
        />
      ))}
    </span>
  );
}

/** One spoken turn, written in place: grey while it is still being heard, normal once final. */
function Caption({ caption }: { caption: CaptionMessage }) {
  return (
    <li>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{caption.role === "user" ? "You" : "Phreak"}</div>
      {caption.text === "" ? (
        // Your words arrive once you pause; until then this holds their place, so later lines do not move.
        <p aria-hidden className="animate-pulse text-muted-foreground motion-reduce:animate-none">
          …
        </p>
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
        {fix ? (
          <>
            <Markdown content={fix} />
            <details className="mt-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Details</summary>
              <p className="mt-1">{message}</p>
            </details>
          </>
        ) : (
          <p className="leading-relaxed text-foreground">{message}</p>
        )}
      </div>
    </div>
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
      shortcutAt = performance.now();
      const panel = panels.get(threadId);
      if (panel?.visible) return panel.toggle();
      // A session needs its panel on screen: open it, and it starts once it shows.
      pendingStart = { threadId, at: shortcutAt };
      if (!experimental_panel.openTab({ tab: TAB, title: "Phreak" })) pendingStart = null;
    },
  });
});
