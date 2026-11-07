/**
 * When the watcher's midday song may start. The page calls this once a frame with the sim's day
 * and time of day (noon is 0.5). Nothing here runs in the sim: a skipped or fast clock still
 * starts the song at most once, and a noon that passed while the tab was quiet is spent without
 * a play.
 *
 * A start is the first moment a day is heard crossing noon, or any sample still inside the short
 * grace after noon. Several noons passed in one jump start it once and spend through the day
 * landed on, so plays never queue. A jump across a long gap (the tab was away) only starts the
 * song if the clock is still near noon. No click yet, mute, or the file still decoding never
 * throws: that noon waits out the grace, or a few seconds for the decode, then it is spent.
 */

/** Noon, as a fraction of the day. */
export const NOON = 0.5;
/** 1.5 game hours after noon still counts as midday if audio was not ready at the strike. */
export const MIDDAY_GRACE = 1.5 / 24;
/**
 * A game-time jump packed into this few real milliseconds is the time slider or a hitch. A longer
 * gap is a hidden tab, and the song does not start in the evening to make up for it.
 */
export const SCRUB_MS = 2_000;
/** A noon that arrived before the file decoded can still start until this much later. */
export const DECODE_HOLD_MS = 8_000;

export interface MiddaySample {
  /** Changes when the watched world changes, so a slot switch is not a time skip. */
  world: string;
  day: number;
  /** 0–1. Noon is {@link NOON}. */
  time: number;
}

export interface MiddayState {
  world: string;
  prevDay: number;
  prevTime: number;
  havePrev: boolean;
  /** Highest day whose noon has been played or given up. */
  playedDay: number;
  /** Day kept open while the file decodes. 0 when nothing is waiting on a decode. */
  holdDay: number;
  holdUntil: number;
}

export function freshMidday(): MiddayState {
  return {
    world: "",
    prevDay: 0,
    prevTime: 0,
    havePrev: false,
    playedDay: 0,
    holdDay: 0,
    holdUntil: 0,
  };
}

function reset(state: MiddayState, world: string) {
  state.world = world;
  state.prevDay = 0;
  state.prevTime = 0;
  state.havePrev = false;
  state.playedDay = 0;
  state.holdDay = 0;
  state.holdUntil = 0;
}

/** True when `sample` has moved forward across at least one noon since `prev`. */
function crossedNoon(prevDay: number, prevTime: number, day: number, time: number): boolean {
  if (day < prevDay) return false;
  if (day === prevDay) return prevTime < NOON && time >= NOON;
  if (prevTime < NOON) return true;
  if (day > prevDay + 1) return true;
  return time >= NOON;
}

/**
 * Folds `sample` into `state` and reports whether the song should start now.
 * `wallGapMs` is how long since the previous sample; the first sample passes 0.
 * `playing` is true while a start is still sounding, so a fast clock cannot stack another.
 */
export function advanceMidday(
  state: MiddayState,
  sample: MiddaySample,
  now: number,
  wallGapMs: number,
  playing: boolean,
  audible: boolean,
  ready: boolean,
): boolean {
  if (!Number.isFinite(sample.day) || !Number.isFinite(sample.time)) return false;
  if (sample.world !== state.world || (state.havePrev && sample.day < state.prevDay)) {
    reset(state, sample.world);
  }

  const prevDay = state.prevDay;
  const prevTime = state.prevTime;
  const havePrev = state.havePrev;
  state.prevDay = sample.day;
  state.prevTime = sample.time;
  state.havePrev = true;
  state.world = sample.world;

  const crossed = havePrev && crossedNoon(prevDay, prevTime, sample.day, sample.time);
  const grace = sample.time >= NOON && sample.time < NOON + MIDDAY_GRACE;
  const behind = sample.time >= NOON ? sample.day : sample.day - 1;
  const scrub = crossed && wallGapMs <= SCRUB_MS && sample.time >= NOON;
  const unspent = sample.day > state.playedDay;
  const want = unspent && (grace || scrub);
  const held = state.holdDay === sample.day && unspent && now <= state.holdUntil;

  if (playing) {
    // The play already running covers any noon the clock just went through.
    if (behind > state.playedDay) state.playedDay = behind;
    state.holdDay = 0;
    state.holdUntil = 0;
    return false;
  }

  if (audible && ready && (want || held)) {
    state.playedDay = sample.day;
    state.holdDay = 0;
    state.holdUntil = 0;
    return true;
  }

  // The strike was heard, but the buffer is not decoded yet. Keep this day open briefly.
  if (want && audible && !ready) {
    if (state.holdDay !== sample.day) {
      state.holdDay = sample.day;
      state.holdUntil = now + DECODE_HOLD_MS;
    }
    return false;
  }

  if (state.holdDay === sample.day && now <= state.holdUntil && audible) return false;

  // No gesture yet, and it is still midday: try again on a later frame.
  if (unspent && grace) return false;

  if (behind > state.playedDay) state.playedDay = behind;
  state.holdDay = 0;
  state.holdUntil = 0;
  return false;
}
