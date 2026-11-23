import { F } from "./frame.ts";

type Rgb = [number, number, number];

/** Art-direction knobs. Colors are linear. */
export interface Look {
  name: string;
  grassBase: Rgb;
  grassTip: Rgb;
  bladeHeight: number;
  bladeWidth: number;
  bladesPerBlock: number;
  flowerChance: number;
  aoStrength: number;
  edgeDarken: number;
  saturation: number;
  contrast: number;
  warmth: number;
  vignette: number;
  /** Split-tone strength after the tonemap: cool shade, warm light (0 keeps colors true). */
  splitTone?: number;
  /** Painterly miniature styling (0 off, 1 on): mossy bevels, ceramic sheen, twilight fireflies. */
  painterly?: number;
  fogDensity: number;
  wind: number;
  /** How much of the light above white spills around it (the sun, glints, lamps, fire). */
  bloom: number;
}

export const LOOKS: Record<string, Look> = {
  miniature: {
    name: "Miniature",
    // Hard-set painterly miniature look: 5A sunlit botanical day -> 06 golden dusk -> 5B glowing twilight.
    grassBase: [0.046, 0.126, 0.053],
    grassTip: [0.177, 0.31, 0.098],
    bladeHeight: 0.32,
    bladeWidth: 0.063,
    bladesPerBlock: 56,
    flowerChance: 0.014,
    aoStrength: 0.92,
    edgeDarken: 0.11,
    saturation: 1.04,
    contrast: 1.05,
    warmth: 0.52,
    vignette: 0.26,
    splitTone: 0.36,
    painterly: 1,
    fogDensity: 0.0024,
    wind: 0.72,
    bloom: 0.25,
  },
  natural: {
    name: "Natural",
    // Tuned under the PBR Neutral tonemap, which keeps more chroma than the old filmic curve.
    grassBase: [0.058, 0.15, 0.032],
    grassTip: [0.18, 0.36, 0.08],
    bladeHeight: 0.62,
    bladeWidth: 0.05,
    bladesPerBlock: 64,
    flowerChance: 0.004,
    aoStrength: 0.9,
    edgeDarken: 0,
    saturation: 1.0,
    contrast: 1.06,
    warmth: 0.15,
    vignette: 0.16,
    fogDensity: 0.0016,
    wind: 0.9,
    bloom: 0.1,
  },
  lush: {
    name: "Lush meadow",
    grassBase: [0.02, 0.07, 0.012],
    grassTip: [0.16, 0.36, 0.05],
    bladeHeight: 0.85,
    bladeWidth: 0.13,
    bladesPerBlock: 28,
    flowerChance: 0.01,
    aoStrength: 0.85,
    edgeDarken: 0,
    saturation: 1.12,
    contrast: 1.08,
    warmth: 0.4,
    vignette: 0.22,
    fogDensity: 0.006,
    wind: 1,
    bloom: 0.14,
  },
  crisp: {
    name: "Crisp blocks",
    grassBase: [0.04, 0.12, 0.025],
    grassTip: [0.12, 0.28, 0.05],
    bladeHeight: 0.6,
    bladeWidth: 0.05,
    bladesPerBlock: 64,
    flowerChance: 0,
    aoStrength: 1,
    edgeDarken: 0,
    saturation: 1.0,
    contrast: 1.12,
    warmth: 0,
    vignette: 0.08,
    fogDensity: 0.004,
    wind: 0.6,
    bloom: 0.06,
  },
  storybook: {
    splitTone: 0.4,
    name: "Storybook",
    grassBase: [0.06, 0.15, 0.035],
    grassTip: [0.3, 0.48, 0.12],
    bladeHeight: 0.6,
    bladeWidth: 0.16,
    bladesPerBlock: 20,
    flowerChance: 0.05,
    aoStrength: 0.6,
    edgeDarken: 0.12,
    saturation: 0.95,
    contrast: 0.96,
    warmth: 1,
    vignette: 0.38,
    fogDensity: 0.01,
    wind: 1.3,
    bloom: 0.18,
  },
};

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const SKY = {
  nightZenith: [0.008, 0.016, 0.045] as Rgb,
  nightHorizon: [0.025, 0.04, 0.085] as Rgb,
  velvetNightZenith: [0.015, 0.017, 0.078] as Rgb,
  velvetNightHorizon: [0.042, 0.04, 0.132] as Rgb,
  duskZenith: [0.12, 0.13, 0.34] as Rgb,
  duskHorizon: [0.96, 0.44, 0.18] as Rgb,
  dayZenith: [0.08, 0.22, 0.6] as Rgb,
  dayHorizon: [0.36, 0.53, 0.8] as Rgb,
  sanctuaryHorizon: [0.46, 0.58, 0.72] as Rgb,
};

/** Moon phases cycle over this many game days. */
const MOON_CYCLE_DAYS = 8;

/** Direction of a body on a tilted daily arc; angle 0 rises in the east, π/2 is overhead. */
function arc(angle: number): Rgb {
  const v: Rgb = [Math.cos(angle) * 0.8, Math.sin(angle), 0.45];
  const len = Math.hypot(...v);
  return [v[0] / len, v[1] / len, v[2] / len];
}

export interface Weather {
  /** 0 clear to 1 overcast. */
  clouds: number;
}

/**
 * Write lighting and look uniforms for a time of day in [0, 1) on game day `day`:
 * 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.
 */
export function applyLook(
  out: Float32Array,
  look: Look,
  timeOfDay: number,
  day = 1,
  weather: Weather = { clouds: 0.35 },
) {
  const painterly = look.painterly ?? 0;
  const sunAngle = (timeOfDay - 0.25) * Math.PI * 2;
  const sun = arc(sunAngle);
  const elev = sun[1];
  // The moon trails the sun by a phase angle that grows through the cycle: new moon rides with
  // the sun, full moon rises at sunset.
  // Start the cycle near first quarter so a new world's first night has a moon to see.
  const phase = (((day - 1 + timeOfDay) / MOON_CYCLE_DAYS + 0.4) % 1) * Math.PI * 2;
  const moon = arc(sunAngle - phase);
  const illuminated = (1 - Math.cos(phase)) / 2;

  const day01 = smoothstep(-0.1, 0.25, elev);
  // Moonlit grading (washed-out colors, a blue cast) waits until the sun has actually set, so
  // sunsets keep their color.
  const night = 1 - smoothstep(-0.14, 0.0, elev);
  const twilight = Math.max(0, 1 - Math.abs(elev) / 0.3);
  const overcast = weather.clouds;

  // The key light is the sun by day and the moon (by its phase) at night.
  const isSun = elev > 0 || moon[1] <= 0;
  const keyDir: Rgb = isSun ? (elev > 0 ? sun : [0, 1, 0]) : moon;
  const noonSun = mixRgb([1.0, 0.94, 0.83], [1.0, 0.91, 0.74], painterly);
  const sunColor = mixRgb([1.0, 0.48, 0.22], noonSun, smoothstep(0.0, 0.45, elev));
  const keyColor = isSun ? sunColor : mixRgb([0.3, 0.42, 1.0], [0.38, 0.44, 1.0], painterly);
  // The moon key runs stronger and cooler than a flat night fill so moon shadows actually read;
  // its strength follows the phase — a full moon lights the island, a new moon is starlight.
  const keyIntensity = isSun
    ? 2.3 * smoothstep(0.0, 0.12, elev) * mix(1, 0.55, overcast)
    : (0.2 + 0.58 * illuminated) * smoothstep(0.0, 0.12, moon[1]);

  const nightZ = mixRgb(SKY.nightZenith, SKY.velvetNightZenith, painterly);
  const nightH = mixRgb(SKY.nightHorizon, SKY.velvetNightHorizon, painterly);
  const dayH = mixRgb(SKY.dayHorizon, SKY.sanctuaryHorizon, painterly * 0.45);
  let zenith = mixRgb(nightZ, SKY.dayZenith, day01);
  let horizon = mixRgb(nightH, dayH, day01);
  // Eyes adjust as the light goes; in Miniature mode keep twilight deeper indigo so glowing
  // lanterns, campfires, fireflies, and Floatsee faces pop with dramatic terrarium contrast.
  const nightExp = mix(mix(1.7, 3.2, illuminated), mix(1.25, 1.85, illuminated), painterly);
  const exposure = mix(nightExp, 1.0, day01);
  const keep = (1 - twilight * 0.3) * (1 - twilight * 0.75);
  const dusk = twilight * 0.75 / exposure;
  zenith = mixRgb(zenith, SKY.duskZenith, twilight * 0.6);
  horizon = [
    horizon[0] * keep + SKY.duskHorizon[0] * dusk,
    horizon[1] * keep + SKY.duskHorizon[1] * dusk,
    horizon[2] * keep + SKY.duskHorizon[2] * dusk,
  ];
  // Overcast skies go grey.
  const grey = (c: Rgb): Rgb => {
    const l = (c[0] + c[1] + c[2]) / 3;
    return mixRgb(c, [l, l, l * 1.05], overcast * 0.5);
  };
  zenith = grey(zenith);
  horizon = grey(horizon);

  out.set(keyDir, F.sunDir);
  out[F.sunDir + 3] = keyIntensity;
  out.set(keyColor, F.sunColor);
  // At night the ambient floor drops with the moon's phase, so the cool key has contrast to work
  // against instead of a flat blue wash.
  out[F.sunColor + 3] = mix(1.0, 1.15, day01) * mix(1, 1.3, overcast) *
    mix(1.0, mix(0.42, 0.72, illuminated), night);
  out.set(zenith, F.skyZenith);
  out[F.skyZenith + 3] = exposure;
  out.set(horizon, F.skyHorizon);
  out[F.skyHorizon + 3] = look.fogDensity;
  out.set(
    mixRgb(
      mixRgb([0.01, 0.012, 0.02], [0.022, 0.02, 0.052], painterly),
      mixRgb([0.38, 0.32, 0.18], [0.46, 0.37, 0.21], painterly),
      day01,
    ),
    F.groundAmbient,
  );
  out[F.groundAmbient + 3] = look.aoStrength;
  out.set(look.grassBase, F.grassBase);
  // Mist pools over low ground around sunrise and sunset, and a little under heavy cloud.
  out[F.grassBase + 3] = 0.28 * smoothstep(0.25, 0.9, twilight) * (1 - 0.5 * night) +
    0.1 * overcast * overcast;
  out.set(look.grassTip, F.grassTip);
  out[F.grassTip + 3] = look.flowerChance;
  out[F.grass] = look.bladeHeight;
  out[F.grass + 1] = look.bladeWidth;
  out[F.grass + 2] = look.bladesPerBlock;
  out[F.wind] = 0.8;
  out[F.wind + 1] = 0.6;
  out[F.wind + 2] = look.wind * mix(1, 1.6, overcast);
  // In Miniature, preserve richer lantern/jewel chroma at night while still cooling shadow fill.
  out[F.grade] = look.saturation * mix(1, mix(0.45, 0.72, painterly), night);
  out[F.grade + 1] = look.contrast;
  out[F.grade + 2] = look.warmth;
  out[F.grade + 3] = look.vignette;
  out[F.extra] = (1 - smoothstep(-0.2, 0.0, elev)) * (1 - overcast);
  out[F.extra + 1] = 1 - night;
  out.set(sun, F.sunPos);
  out[F.sunPos + 3] = smoothstep(-0.08, 0.05, elev) * mix(1, 0.3, overcast);
  out.set(moon, F.moonDir);
  out[F.moonDir + 3] = illuminated * smoothstep(-0.05, 0.05, moon[1]) * (1 - overcast * 0.8);
  out[F.weather] = overcast;
  out[F.weather + 1] = 1;
  out[F.lookParams] = look.splitTone ?? 0;
  out[F.lookParams + 1] = painterly;
  out[F.lookParams + 2] = twilight * painterly;
  out[F.lookParams + 3] = look.edgeDarken;
  out[F.weather + 3] = look.bloom;
}
