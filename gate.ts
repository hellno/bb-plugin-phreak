// The mic's noise gate: only sustained sound well above the room's quiet floor
// reaches OpenAI's voice detection; everything else goes out as silence. One
// frame comes out for every frame in, so the stream keeps its timing. No DOM,
// so it runs in node for simulation.

const WARMUP_FRAMES = 15; // ~0.6 s to learn the room before anything can open
const MARGIN_DB = 12; // above the floor to open
const STRICT_MARGIN_DB = 18; // while Phreak is audible, and just after
const ATTACK_FRAMES = 3; // loud frames among those held to open: ~120 ms of voice
const STRICT_ATTACK_FRAMES = 5; // ~200 ms while Phreak is audible
const ATTACK_STEP_DB = 3; // average loud-frame level change, to keep steady traffic from opening the gate
const CANDIDATE_DB = 6; // above the floor, a frame may be the start of speech and is held
const MAX_HELD = 12; // ~480 ms of onset kept back while deciding, released on open
const QUIET_FRAMES = 3; // ~120 ms below the candidate level ends a held sound; shorter dips are gaps between syllables
const HYSTERESIS_DB = 6; // stays open down to this much below the open threshold
const HANG_FRAMES = 12; // ~480 ms open after the level drops, for gaps between words
const STEADY_FRAMES = 75; // ~3 s open at a near-constant level: steady noise such as a fan
const STEADY_STEP_DB = 2; // mean change from frame to frame: noise jitters under 1 dB, even when it drifts or cycles; speech swings about 4
const MIN_OPEN_DB = -50; // never opens on near-silence
const STRICT_MIN_OPEN_DB = -38; // talking over Phreak takes a voice at least this loud, so a voice across the room does not cut it off
const MAX_OPEN_DB = -32; // cap the level requirement for close-mic speech in a noisy room
const FLOOR_MIN_DB = -62; // lower, and the -50 limit would make strict and normal the same
const SILENT_DB = -90; // digital silence (mute, a device switch) says nothing about the room
const FLOOR_MAX_DB = -35;

type Held = { frame: Float32Array; db: number; loud: boolean; voiced: boolean };

export type GateStats = {
  frames: number;
  openFrames: number;
  opens: number;
  strictOpens: number;
  /** Sounds held as possible speech that never opened. */
  rejected: number;
  /** Times a steady sound held the gate open and became the new floor. */
  relearned: number;
  floorDb: number;
  /** The floor after warm-up and at its highest: a climbing floor points to auto gain. */
  firstFloorDb: number | null;
  maxFloorDb: number;
  /** The loudest frame passed on, and the loudest kept out after warm-up. */
  speechPeakDb: number;
  noisePeakDb: number;
};

export function frameDb(frame: Float32Array): number {
  return energyDb(frame, 0, frame.length);
}

/** The level most of the frame holds: the second quietest of its four quarters. A key click fills one quarter. */
export function sustainedDb(frame: Float32Array): number {
  return [...quarterDbs(frame)].sort((a, b) => a - b)[1];
}

function quarterDbs(frame: Float32Array): number[] {
  const quarter = Math.floor(frame.length / 4);
  return [0, 1, 2, 3].map((i) => energyDb(frame, i * quarter, quarter));
}

function meanStep(levels: number[]): number {
  let sum = 0;
  for (let i = 1; i < levels.length; i++) sum += Math.abs(levels[i] - levels[i - 1]);
  return sum / (levels.length - 1);
}

function energyDb(frame: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += frame[i] * frame[i];
  return 10 * Math.log10(sum / Math.max(1, length) || 1e-12);
}

/** Look for a repeating vocal-fold pulse. Clothing rub is often loud but aperiodic. */
function hasVoicing(frame: Float32Array): boolean {
  // Average four samples at a time (24 kHz to 6 kHz) and remove low-frequency rumble.
  const band = new Float32Array(Math.floor(frame.length / 4));
  let low = 0;
  let totalEnergy = 0;
  let bandEnergy = 0;
  for (let i = 0; i < band.length; i++) {
    const j = i * 4;
    const sample = (frame[j] + frame[j + 1] + frame[j + 2] + frame[j + 3]) / 4;
    low += 0.28 * (sample - low); // one-pole low-pass at about 310 Hz
    band[i] = sample - low;
    totalEnergy += sample * sample;
    bandEnergy += band[i] * band[i];
  }
  if (bandEnergy <= 0.12 * totalEnergy) return false;

  // Normalized autocorrelation at pitch periods of roughly 70–460 Hz.
  for (let lag = 13; lag <= 85; lag++) {
    let dot = 0;
    let left = 0;
    let right = 0;
    for (let i = lag; i < band.length; i++) {
      const a = band[i];
      const b = band[i - lag];
      dot += a * b;
      left += a * a;
      right += b * b;
    }
    if (dot > 0.5 * Math.sqrt(left * right)) return true;
  }
  return false;
}

export class NoiseGate {
  /** Whether frames pass on now. */
  open = false;
  /** The latest frame's level, in dBFS. */
  levelDb = -120;
  readonly stats: GateStats = {
    frames: 0,
    openFrames: 0,
    opens: 0,
    strictOpens: 0,
    rejected: 0,
    relearned: 0,
    floorDb: -60,
    firstFloorDb: null,
    maxFloorDb: -120,
    speechPeakDb: -120,
    noisePeakDb: -120,
  };
  private floor = -60;
  private held: Held[] = [];
  private quietRun = 0;
  private steady: number[] = []; // the voice level of recent open frames, for the steady-noise test
  private wasStrict = false;
  private hang = 0;

  /** Takes one frame; returns the frames to send now, each the frame itself or silence of its length. */
  push(frame: Float32Array, strict: boolean): Float32Array[] {
    const db = (this.levelDb = frameDb(frame));
    const quarters = quarterDbs(frame);
    const voice = [...quarters].sort((a, b) => a - b)[1]; // what most of the frame holds, so clicks count as quiet
    const tail = Math.min(quarters[2], quarters[3]); // a sound that starts late in the frame
    const stats = this.stats;
    stats.frames++;
    const becameStrict = strict && !this.wasStrict;
    this.wasStrict = strict;
    if (stats.frames <= WARMUP_FRAMES) {
      if (db >= SILENT_DB) this.floor = clamp(this.floor + (db - this.floor) * (stats.frames === 1 ? 1 : 0.3), FLOOR_MIN_DB, FLOOR_MAX_DB);
      if (stats.frames === WARMUP_FRAMES) stats.firstFloorDb = round(this.floor);
      return [this.silenced(frame, db)];
    }
    const openAt = strict
      ? clamp(this.floor + STRICT_MARGIN_DB, STRICT_MIN_OPEN_DB, MAX_OPEN_DB)
      : clamp(this.floor + MARGIN_DB, MIN_OPEN_DB, MAX_OPEN_DB);
    // Keep buffered audio for the onset, but count only new evidence once playback starts.
    if (becameStrict) {
      this.close();
      for (const held of this.held) held.loud = false;
    }

    if (this.open) {
      stats.openFrames++;
      stats.speechPeakDb = Math.max(stats.speechPeakDb, round(db));
      this.steady.push(voice);
      if (this.steady.length > STEADY_FRAMES) this.steady.shift();
      if (voice >= openAt - HYSTERESIS_DB) {
        this.hang = HANG_FRAMES;
        if (this.steady.length === STEADY_FRAMES && meanStep(this.steady) < STEADY_STEP_DB) {
          // Open 3 s at a near-constant level: steady noise, not speech. It becomes the floor.
          this.floor = clamp(voice, FLOOR_MIN_DB, FLOOR_MAX_DB);
          this.close();
          stats.relearned++;
          stats.floorDb = round(this.floor);
          stats.maxFloorDb = Math.max(stats.maxFloorDb, stats.floorDb);
        }
      } else if (--this.hang <= 0) {
        this.close();
      }
      return [frame];
    }

    if (db < openAt) this.learn(db);
    // Below the candidate level a frame is quiet; that level never exceeds the open level, so no frame is both.
    // A frame whose second half is all sound is held anyway, so a sharp onset late in it is kept.
    const candidateAt = Math.min(Math.max(this.floor + CANDIDATE_DB, MIN_OPEN_DB - CANDIDATE_DB), openAt);
    const quiet = voice < candidateAt && tail < candidateAt;
    if (quiet && this.held.length === 0) return [this.silenced(frame, db)];
    // Held in order, so frames come out as they went in.
    const loud = voice >= openAt;
    this.held.push({ frame: frame.slice(), db, loud, voiced: loud && hasVoicing(frame) });
    this.quietRun = quiet ? this.quietRun + 1 : 0;
    if (this.quietRun >= QUIET_FRAMES) return this.release(false); // the sound ended without enough voice
    const loudFrames = this.held.filter((held) => held.loud);
    if (
      loudFrames.length >= (strict ? STRICT_ATTACK_FRAMES : ATTACK_FRAMES) &&
      loudFrames.filter((held) => held.voiced).length >= (strict ? 2 : 1) &&
      meanStep(loudFrames.map((held) => held.db)) >= ATTACK_STEP_DB
    ) {
      this.open = true;
      this.hang = HANG_FRAMES;
      this.steady = [];
      stats.opens++;
      if (strict) stats.strictOpens++;
      stats.openFrames += this.held.length;
      for (const held of this.held) stats.speechPeakDb = Math.max(stats.speechPeakDb, round(held.db));
      return this.release(true);
    }
    // Hold back at most MAX_HELD frames; older ones go out as silence.
    if (this.held.length <= MAX_HELD) return [];
    const oldest = this.held.shift()!;
    return [this.silenced(oldest.frame, oldest.db)];
  }

  /** Closes the gate and returns the frames still held, as silence: on mute, and at the end, so every frame in has one out. */
  flush(): Float32Array[] {
    this.close();
    return this.release(false);
  }

  private close(): void {
    this.open = false;
    this.hang = 0;
    this.steady = [];
  }

  /** Slow to rise, quick to fall, so a quiet room is learned fast and speech barely moves it. */
  private learn(db: number): void {
    if (db < SILENT_DB) return;
    this.floor = clamp(this.floor + (db - this.floor) * (db < this.floor ? 0.3 : 0.02), FLOOR_MIN_DB, FLOOR_MAX_DB);
    this.stats.floorDb = round(this.floor);
    this.stats.maxFloorDb = Math.max(this.stats.maxFloorDb, this.stats.floorDb);
  }

  private release(pass: boolean): Float32Array[] {
    if (this.held.length > 0 && !pass) this.stats.rejected++;
    const out = this.held.map((held) => (pass ? held.frame : this.silenced(held.frame, held.db)));
    this.held = [];
    this.quietRun = 0;
    return out;
  }

  /** Silence in place of a frame kept out, noting how loud it was. */
  private silenced(frame: Float32Array, db: number): Float32Array {
    if (this.stats.frames > WARMUP_FRAMES) this.stats.noisePeakDb = Math.max(this.stats.noisePeakDb, round(db));
    return silence(frame);
  }
}

function silence(frame: Float32Array): Float32Array {
  return new Float32Array(frame.length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
