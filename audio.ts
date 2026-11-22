// Mic capture and assistant playback for one Phreak session. The 24 kHz
// context and gapless playback are adapted from Voice Mode's audio.ts
// (steveafrost/bb-plugin-voice-mode, MIT).
import { SAMPLE_RATE, type Played } from "./protocol";

const FRAME_SAMPLES = (SAMPLE_RATE * 40) / 1000; // one 40 ms mic frame
const FALLBACK_FRAME_SAMPLES = 1024; // ScriptProcessor sizes are powers of two: ~43 ms
const MAX_AHEAD_SECONDS = 60; // the relay sends faster than real time; replies are meant to be short
const START_LEAD_SECONDS = 0.03; // lets the first chunk of a burst start cleanly

/** Context seconds during which part of an item is scheduled to play. */
type Span = { start: number; end: number };
export type Cue = "wait" | "lookup"; // a reply is late; lookups are running

const WORKLET_NAME = "phreak-capture";
const WORKLET_SOURCE = `
registerProcessor("${WORKLET_NAME}", class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(${FRAME_SAMPLES});
    this.size = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    for (let i = 0; channel && i < channel.length; i++) {
      this.frame[this.size++] = channel[i];
      if (this.size === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(${FRAME_SAMPLES});
        this.size = 0;
      }
    }
    return true;
  }
});
`;

/**
 * Everything audio for one session, on one context at the wire rate so the browser does all resampling.
 * Construct it inside the Start click: Safari and mobile browsers only let a user gesture start an AudioContext.
 */
export class SessionAudio {
  private readonly ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  private stream: MediaStream | null = null;
  private muted = false;
  private closed = false;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly items = new Map<string, Span[]>(); // since the last flush, in arrival order
  private readonly cut = new Set<string>(); // items whose tail overflowed the schedule and was dropped
  private current: { id: string; spans: Span[] } | null = null; // takes the next binary frames; null drops them
  private playhead = 0;
  // The double tick sits 1 s into its loop, so a quiet moment shorter than that stays silent.
  private readonly cues: Record<Cue, AudioBuffer> = {
    wait: cueLoop(this.ctx, 1, 200, 0.04, [[0, 0.4, 0.6]]),
    lookup: cueLoop(this.ctx, 3, 660, 0.03, [[1, 0.008, 0.07], [1.15, 0.008, 0.07]]),
  };
  private stopCue: (() => void) | null = null;

  constructor(private readonly onPlaying: (playing: boolean) => void) {
    this.ctx.resume().catch(() => undefined);
  }

  /** Muted, the track sends silence: frames keep flowing, so voice detection hears your turn end. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  /** Asks for the mic, then streams PCM16 frames of about 40 ms to `onFrame` until close. */
  async startMic(onFrame: (pcm: ArrayBuffer) => void): Promise<void> {
    if (!navigator.mediaDevices) throw new Error("this page is not served over https or localhost");
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    // The session may have ended while the permission prompt was open.
    if (this.closed) return stopTracks(stream);
    this.stream = stream;
    this.setMuted(this.muted); // a mute pressed while the permission prompt was open
    const capture = await this.captureNode((samples) => onFrame(toPcm16(samples)));
    if (this.closed) return;
    const sink = new GainNode(this.ctx, { gain: 0 }); // capture nodes only run while something downstream pulls them
    this.ctx.createMediaStreamSource(stream).connect(capture).connect(sink).connect(this.ctx.destination);
  }

  /** Binary frames that follow belong to this assistant item. */
  startItem(itemId: string): void {
    this.current = { id: itemId, spans: [] };
    const now = this.audibleTime();
    for (const [id, spans] of this.items) if (!this.unfinished(id, spans, now)) this.items.delete(id);
    this.items.set(itemId, this.current.spans);
  }

  /** Schedules PCM for the current item; returns the seconds until it is audible, or null if dropped. */
  play(pcm: ArrayBuffer): number | null {
    const current = this.current;
    if (current === null || pcm.byteLength < 2) return null;
    const samples = toFloat32(pcm);
    const buffer = this.ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const now = this.ctx.currentTime;
    const start = Math.max(now + START_LEAD_SECONDS, this.playhead);
    if (start + buffer.duration - now > MAX_AHEAD_SECONDS) {
      // Cut the item's tail, never a chunk from its middle, so heard positions stay exact.
      this.cut.add(current.id);
      this.current = null;
      return null;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    source.start(start);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onPlaying(false);
    };
    if (this.sources.size === 0) this.onPlaying(true);
    this.sources.add(source);
    this.playhead = start + buffer.duration;
    const last = current.spans.at(-1);
    if (last?.end === start) last.end = this.playhead;
    else current.spans.push({ start, end: this.playhead });
    return start - now + (this.ctx.outputLatency || 0);
  }

  /** Stops all playback and reports how much was heard of every unfinished item (0 if none). */
  flush(): Played {
    const now = this.audibleTime();
    const heard: Played = [];
    for (const [itemId, spans] of this.items) {
      if (!this.unfinished(itemId, spans, now)) continue;
      const seconds = spans.reduce((sum, s) => sum + Math.min(Math.max(now - s.start, 0), s.end - s.start), 0);
      // Rounded, not floored: float error must not make a fully heard item look cut short.
      heard.push({ itemId, ms: Math.round(seconds * 1000) });
    }
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
    }
    if (this.sources.size > 0) this.onPlaying(false);
    this.sources.clear();
    this.items.clear();
    this.cut.clear();
    this.current = null; // binary frames carry no item id, so drop them until the next audio_start
    this.playhead = 0;
    return heard;
  }

  /** Loops a cue until the next call (null: none). On the playback path, so echo cancellation keeps it out of the mic. */
  cue(kind: Cue | null): void {
    if (this.closed) return;
    this.stopCue?.();
    this.stopCue = null;
    if (kind === null) return;
    const fade = new GainNode(this.ctx);
    const source = new AudioBufferSourceNode(this.ctx, { buffer: this.cues[kind], loop: true });
    source.connect(fade).connect(this.ctx.destination);
    source.start();
    this.stopCue = () => {
      // A short fade, as cutting a tone mid-swell clicks.
      fade.gain.setTargetAtTime(0, this.ctx.currentTime, 0.005);
      source.stop(this.ctx.currentTime + 0.05);
    };
  }

  /** Stops the mic and playback. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.stream !== null) stopTracks(this.stream);
    this.ctx.close().catch(() => undefined);
  }

  /** Whether part of this item may go unheard: more may arrive, some is still queued, or its tail was cut. */
  private unfinished(id: string, spans: Span[], now: number): boolean {
    return id === this.current?.id || (spans.at(-1)?.end ?? 0) > now || this.cut.has(id);
  }

  /** Context time of the sample reaching the speaker now. */
  private audibleTime(): number {
    return this.ctx.currentTime - (this.ctx.outputLatency || 0);
  }

  private async captureNode(ingest: (samples: Float32Array) => void): Promise<AudioNode> {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(this.ctx, WORKLET_NAME, { channelCount: 1, channelCountMode: "explicit" });
      node.port.onmessage = (event: MessageEvent<Float32Array>) => ingest(event.data);
      return node;
    } catch {
      // Worklets need a secure context and may be blocked by a CSP (Voice Mode
      // hit this in bb); the deprecated ScriptProcessor works everywhere.
      const node = this.ctx.createScriptProcessor(FALLBACK_FRAME_SAMPLES, 1, 1);
      node.onaudioprocess = (event) => ingest(event.inputBuffer.getChannelData(0));
      return node;
    }
  }
}

function toPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm.buffer;
}

function toFloat32(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  const pcm = new Int16Array(data, 0, data.byteLength >> 1);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

/** One loop of a cue, in seconds: sine blips with raised-cosine envelopes, which do not click. */
function cueLoop(ctx: BaseAudioContext, seconds: number, hz: number, gain: number, blips: [at: number, attack: number, release: number][]): AudioBuffer {
  const buffer = ctx.createBuffer(1, seconds * SAMPLE_RATE, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (const [at, attack, release] of blips) {
    for (let i = 0, offset = Math.round(at * SAMPLE_RATE); i < (attack + release) * SAMPLE_RATE; i++) {
      const t = i / SAMPLE_RATE;
      const envelope = t < attack ? Math.sin((Math.PI / 2) * (t / attack)) : Math.cos((Math.PI / 2) * ((t - attack) / release));
      data[offset + i] += gain * envelope ** 2 * Math.sin(2 * Math.PI * hz * t);
    }
  }
  return buffer;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
