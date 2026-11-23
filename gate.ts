// The mic's noise gate: only sustained sound well above the room's quiet floor
// reaches OpenAI's voice detection; everything else goes out as silence. One
// frame comes out for every frame in, so the stream keeps its timing. No DOM,
// so it runs in node for simulation.

const WARMUP_FRAMES = 15; // ~0.6 s to learn the room before anything can open
const MARGIN_DB = 12; // above the floor to open
const STRICT_MARGIN_DB = 18; // while Phreak is audible, and just after
const ATTACK_FRAMES = 3; // loud frames among those held to open: ~120 ms of voice
const STRICT_ATTACK_FRAMES = 5; // ~200 ms while Phreak is audible
const CANDIDATE_DB = 6; // above the floor, a frame may be the start of speech and is held
const MAX_HELD = 12; // ~480 ms of onset kept back while deciding, released on open
const QUIET_FRAMES = 3; // ~120 ms below the candidate level ends a held sound; shorter dips are gaps between syllables
const HYSTERESIS_DB = 6; // stays open down to this much below the open threshold
const HANG_FRAMES = 12; // ~480 ms open after the level drops, for gaps between words
const STEADY_FRAMES = 75; // ~3 s open without a dip: steady noise such as a fan, not speech, which dips between words
const MIN_OPEN_DB = -50; // never opens on near-silence
const STRICT_MIN_OPEN_DB = -38; // talking over Phreak takes a voice at least this loud, so a voice across the room does not cut it off
const MAX_OPEN_DB = -32; // sustained close-mic speech always opens, however noisy the room
const FLOOR_MIN_DB = -62; // lower, and the -50 limit would make strict and normal the same
const SILENT_DB = -90; // digital silence (mute, a device switch) says nothing about the room
const FLOOR_MAX_DB = -35;

type Held = { frame: Float32Array; db: number; loud: boolean };

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
  const quarter = Math.floor(frame.length / 4);
  const levels = [0, 1, 2, 3].map((i) => energyDb(frame, i * quarter, quarter)).sort((a, b) => a - b);
  return levels[1];
}

function energyDb(frame: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += frame[i] * frame[i];
  return 10 * Math.log10(sum / Math.max(1, length) || 1e-12);
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
  private steadyRun = 0;
  private wasStrict = false;
  private hang = 0;

  /** Takes one frame; returns the frames to send now, each the frame itself or silence of its length. */
  push(frame: Float32Array, strict: boolean): Float32Array[] {
    const db = (this.levelDb = frameDb(frame));
    const voice = sustainedDb(frame); // what most of the frame holds, so clicks count as quiet
    const stats = this.stats;
    stats.frames++;
    const becameStrict = strict && !this.wasStrict;
    this.wasStrict = strict;
    if (stats.frames <= WARMUP_FRAMES) {
      if (db >= SILENT_DB) this.floor = clamp(this.floor + (db - this.floor) * (stats.frames === 1 ? 1 : 0.3), FLOOR_MIN_DB, FLOOR_MAX_DB);
      if (stats.frames === WARMUP_FRAMES) stats.firstFloorDb = round(this.floor);
      return [this.silenced({ frame, db, loud: false })];
    }
    const openAt = strict
      ? clamp(this.floor + STRICT_MARGIN_DB, STRICT_MIN_OPEN_DB, MAX_OPEN_DB)
      : clamp(this.floor + MARGIN_DB, MIN_OPEN_DB, MAX_OPEN_DB);
    // When Phreak starts talking, whatever holds the gate open must pass the stricter test again.
    if (becameStrict && this.open) this.close();

    if (this.open) {
      stats.openFrames++;
      stats.speechPeakDb = Math.max(stats.speechPeakDb, round(db));
      if (voice >= openAt - HYSTERESIS_DB) {
        this.hang = HANG_FRAMES;
        if (++this.steadyRun >= STEADY_FRAMES) {
          // Open 3 s without a dip: steady noise, not speech. It becomes the floor.
          this.floor = clamp(voice, FLOOR_MIN_DB, FLOOR_MAX_DB);
          this.close();
          stats.relearned++;
          stats.floorDb = round(this.floor);
          stats.maxFloorDb = Math.max(stats.maxFloorDb, stats.floorDb);
        }
      } else {
        this.steadyRun = 0;
        if (--this.hang <= 0) this.close();
      }
      return [frame];
    }

    if (db < openAt) this.learn(db);
    const quiet = voice < Math.max(this.floor + CANDIDATE_DB, MIN_OPEN_DB - CANDIDATE_DB);
    if (quiet && this.held.length === 0) return [this.silenced({ frame, db, loud: false })];
    // Held in order, so frames come out as they went in.
    this.held.push({ frame: frame.slice(), db, loud: voice >= openAt });
    this.quietRun = quiet ? this.quietRun + 1 : 0;
    if (this.quietRun >= QUIET_FRAMES) return this.release(false); // the sound ended without enough voice
    if (this.held.filter((held) => held.loud).length >= (strict ? STRICT_ATTACK_FRAMES : ATTACK_FRAMES)) {
      this.open = true;
      this.hang = HANG_FRAMES;
      this.steadyRun = 0;
      stats.opens++;
      if (strict) stats.strictOpens++;
      stats.openFrames += this.held.length;
      for (const held of this.held) stats.speechPeakDb = Math.max(stats.speechPeakDb, round(held.db));
      return this.release(true);
    }
    // Hold back at most MAX_HELD frames; older ones go out as silence.
    return this.held.length > MAX_HELD ? [this.silenced(this.held.shift()!)] : [];
  }

  /** Frames still held, as silence: on mute, and at the end, so every frame in has one out. */
  flush(): Float32Array[] {
    return this.release(false);
  }

  private close(): void {
    this.open = false;
    this.hang = 0;
    this.steadyRun = 0;
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
    const out = this.held.map((held) => (pass ? held.frame : this.silenced(held)));
    this.held = [];
    this.quietRun = 0;
    return out;
  }

  /** Silence in place of a frame kept out, noting how loud it was. */
  private silenced({ frame, db }: Held): Float32Array {
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
