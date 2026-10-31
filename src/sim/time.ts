/** The sim's clock: its fixed tick, and how ticks make game days and hours. */

export const TICK_HZ = 20;
/** One game day per ten real minutes at 1× speed. */
export const TICKS_PER_DAY = TICK_HZ * 600;
/** Ticks in `hours` game hours. */
export const gameHours = (hours: number) => Math.round((hours / 24) * TICKS_PER_DAY);
