// Mic capture and assistant playback for one Phreak session (SPEC §4.2).
// Capture and gapless playback are adapted from Voice Mode's audio.ts
// (steveafrost/bb-plugin-voice-mode, MIT).
import { SAMPLE_RATE } from "./protocol";

const FRAME_SAMPLES = (SAMPLE_RATE * 40) / 1000; // one 40 ms mic frame
const AHEAD_SECONDS = 3; // audio handed to WebAudio ahead of the playhead
const BACKLOG_SECONDS = 120; // audio waiting behind that window
const START_LEAD_SECONDS = 0.03; // lets the first chunk of a burst start cleanly

/** How much of an assistant audio item was heard, for `played`. */
export interface Heard {
  itemId: string;
  ms: number;
}

const WORKLET_NAME = "phreak-capture";
// Batches raw input so the main thread gets one message per 512 samples
// instead of one per 128-sample render quantum.
const WORKLET_SOURCE = `
registerProcessor("${WORKLET_NAME}", class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(512);
    this.size = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.batch[this.size++] = channel[i];
        if (this.size === this.batch.length) {
          this.port.postMessage(this.batch, [this.batch.buffer]);
          this.batch = new Float32Array(512);
          this.size = 0;
        }
      }
    }
    return true;
  }
});
`;

/**
 * Everything audio for one session. Construct it synchronously inside the
 * Start click handler: Safari and mobile browsers only let a user gesture
 * start an AudioContext.
 */
export class SessionAudio {
  private readonly ctx = new AudioContext();
  private readonly playback: Playback;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private framer: Framer | null = null;
  private muted = false;
  private closed = false;

  constructor(onPlaying: (playing: boolean) => void) {
    this.ctx.resume().catch(() => undefined);
    this.playback = new Playback(this.ctx, onPlaying);
  }

  /** Asks for the mic, then streams 40 ms PCM16 frames to `onFrame` until close. */
  async startMic(onFrame: (frame: ArrayBuffer) => void): Promise<void> {
    if (!navigator.mediaDevices) throw new Error("this page is not served over https or localhost");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // The session may have ended while the permission prompt was open.
    if (this.closed) return stopTracks(stream);
    this.stream = stream;
    const framer = new Framer(this.ctx.sampleRate / SAMPLE_RATE, onFrame);
    this.framer = framer;
    const capture = await this.captureNode((samples) => {
      if (!this.closed && !this.muted) framer.push(samples);
    });
    if (this.closed) return;
    const source = this.ctx.createMediaStreamSource(stream);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // capture nodes only run while something downstream pulls them
    source.connect(capture).connect(sink).connect(this.ctx.destination);
    this.nodes = [source, capture, sink];
  }

  /** Muting keeps the mic open but sends nothing. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.framer?.reset();
  }

  /** Binary frames that follow belong to this assistant item. */
  startItem(itemId: string): void {
    this.playback.startItem(itemId);
  }

  play(pcm: ArrayBuffer): void {
    this.playback.enqueue(pcm);
  }

  /** Flushes playback at once; returns what was heard of the audible item. */
  interrupt(): Heard | null {
    return this.playback.interrupt();
  }

  /** Stops the mic and playback and releases the context. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.playback.interrupt();
    if (this.stream !== null) stopTracks(this.stream);
    for (const node of this.nodes) node.disconnect();
    this.ctx.close().catch(() => undefined);
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
      const node = this.ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (event) => ingest(event.inputBuffer.getChannelData(0));
      return node;
    }
  }
}

/** Resamples float input to SAMPLE_RATE and cuts it into 40 ms PCM16 frames. */
class Framer {
  private frame = new Int16Array(FRAME_SAMPLES);
  private filled = 0;
  private sum = 0; // weighted input gathered for the next output sample
  private span = 0; // how many input samples (fractional) that covers

  // `ratio` is input samples per output sample. Each output averages the input
  // span it covers, which also filters out aliasing when downsampling.
  constructor(
    private readonly ratio: number,
    private readonly emit: (frame: ArrayBuffer) => void,
  ) {}

  push(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      let weight = 1;
      while (weight > 1e-9) {
        const take = Math.min(weight, this.ratio - this.span);
        this.sum += input[i] * take;
        this.span += take;
        weight -= take;
        if (this.ratio - this.span < 1e-9) {
          this.write(this.sum / this.ratio);
          this.sum = 0;
          this.span = 0;
        }
      }
    }
  }

  reset(): void {
    this.filled = 0;
    this.sum = 0;
    this.span = 0;
  }

  private write(value: number): void {
    const sample = Math.max(-1, Math.min(1, value));
    this.frame[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    if (this.filled === FRAME_SAMPLES) {
      this.emit(this.frame.buffer);
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.filled = 0;
    }
  }
}

interface Chunk {
  itemId: string;
  samples: Float32Array<ArrayBuffer>;
}

interface Scheduled {
  itemId: string;
  source: AudioBufferSourceNode;
  startAt: number;
  duration: number;
}

/**
 * Plays assistant PCM back to back. Only a few seconds sit in WebAudio at a
 * time, so a flush is cheap; the server may send faster than real time, so the
 * rest waits in a bounded backlog.
 */
class Playback {
  private itemId: string | null = null;
  private accepting = false;
  private pending: Chunk[] = [];
  private pendingSamples = 0;
  private scheduled: Scheduled[] = [];
  private playhead = 0;
  private finished = new Map<string, number>(); // seconds of each item already played, chunks no longer scheduled
  private playing = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly onPlaying: (playing: boolean) => void,
  ) {}

  startItem(itemId: string): void {
    this.itemId = itemId;
    this.accepting = true;
    for (const id of this.finished.keys()) {
      if (id !== itemId && !this.holds(id)) this.finished.delete(id);
    }
  }

  enqueue(data: ArrayBuffer): void {
    if (!this.accepting || this.itemId === null) return;
    const samples = toFloat32(data);
    if (samples.length === 0) return;
    if (this.pendingSamples + samples.length > BACKLOG_SECONDS * SAMPLE_RATE) {
      // Cut the item's tail rather than a chunk from its middle, so `played`
      // stays a true position within the item.
      this.accepting = false;
      return;
    }
    this.pending.push({ itemId: this.itemId, samples });
    this.pendingSamples += samples.length;
    this.pump();
  }

  /** Stops everything; reports the item audible now (else the latest one) and how much of it played. */
  interrupt(): Heard | null {
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    const audible = this.scheduled.find((s) => s.startAt + s.duration > now)?.itemId ?? this.itemId;
    for (const s of this.scheduled) {
      s.source.onended = null;
      s.source.stop();
      // Partly played chunks count too, so a repeated interrupt reports the same position.
      this.addFinished(s.itemId, Math.min(Math.max(now - s.startAt, 0), s.duration));
    }
    this.scheduled = [];
    this.pending = [];
    this.pendingSamples = 0;
    this.playhead = 0;
    // Binary frames carry no item id, so drop them all until the next audio_start.
    this.accepting = false;
    this.updatePlaying();
    if (audible === null) return null;
    return { itemId: audible, ms: Math.floor((this.finished.get(audible) ?? 0) * 1000) };
  }

  private pump(): void {
    while (this.pending.length > 0 && this.playhead - this.ctx.currentTime < AHEAD_SECONDS) {
      const chunk = this.pending.shift()!;
      this.pendingSamples -= chunk.samples.length;
      this.schedule(chunk);
    }
    this.updatePlaying();
  }

  private schedule({ itemId, samples }: Chunk): void {
    // Labelled at the wire rate; WebAudio resamples to the device rate.
    const buffer = this.ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + START_LEAD_SECONDS, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
    const entry: Scheduled = { itemId, source, startAt, duration: buffer.duration };
    this.scheduled.push(entry);
    source.onended = () => {
      this.scheduled = this.scheduled.filter((s) => s !== entry);
      this.addFinished(itemId, entry.duration);
      this.pump();
    };
  }

  private addFinished(itemId: string, seconds: number): void {
    this.finished.set(itemId, (this.finished.get(itemId) ?? 0) + seconds);
  }

  private holds(itemId: string): boolean {
    return this.scheduled.some((s) => s.itemId === itemId) || this.pending.some((c) => c.itemId === itemId);
  }

  private updatePlaying(): void {
    const playing = this.scheduled.length > 0 || this.pending.length > 0;
    if (playing === this.playing) return;
    this.playing = playing;
    this.onPlaying(playing);
  }
}

function toFloat32(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  const pcm = new Int16Array(data, 0, data.byteLength >> 1);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
