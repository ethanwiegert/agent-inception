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
  fogDensity: number;
  wind: number;
}

export const LOOKS: Record<string, Look> = {
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
  },
  storybook: {
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
  nightZenith: [0.003, 0.006, 0.02] as Rgb,
  nightHorizon: [0.015, 0.025, 0.06] as Rgb,
  duskZenith: [0.12, 0.14, 0.32] as Rgb,
  duskHorizon: [0.95, 0.42, 0.18] as Rgb,
  dayZenith: [0.16, 0.36, 0.85] as Rgb,
  dayHorizon: [0.55, 0.72, 0.95] as Rgb,
};

/**
 * Write lighting and look uniforms for a time of day in [0, 1):
 * 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.
 */
export function applyLook(out: Float32Array, look: Look, timeOfDay: number) {
  const a = (timeOfDay - 0.25) * Math.PI * 2;
  const sun: Rgb = [Math.cos(a) * 0.8, Math.sin(a), 0.45];
  const len = Math.hypot(...sun);
  sun[0] /= len, sun[1] /= len, sun[2] /= len;
  const elev = sun[1];

  const day = smoothstep(-0.1, 0.25, elev);
  const twilight = Math.max(0, 1 - Math.abs(elev) / 0.3);

  // The key light is the sun by day and a cool moon (opposite the sun) by night.
  const isSun = elev > 0;
  const keyDir: Rgb = isSun ? sun : [-sun[0], -sun[1], -sun[2]];
  const keyElev = keyDir[1];
  const sunColor = mixRgb([1.0, 0.45, 0.2], [1.0, 0.93, 0.82], smoothstep(0.0, 0.45, elev));
  const keyColor = isSun ? sunColor : ([0.3, 0.42, 1.0] as Rgb);
  const keyIntensity = (isSun ? 2.3 : 0.3) * smoothstep(0.0, 0.12, keyElev);

  let zenith = mixRgb(SKY.nightZenith, SKY.dayZenith, day);
  let horizon = mixRgb(SKY.nightHorizon, SKY.dayHorizon, day);
  zenith = mixRgb(zenith, SKY.duskZenith, twilight * 0.6);
  horizon = mixRgb(horizon, SKY.duskHorizon, twilight * 0.75);

  out.set(keyDir, F.sunDir);
  out[F.sunDir + 3] = keyIntensity;
  out.set(keyColor, F.sunColor);
  out[F.sunColor + 3] = mix(1.2, 2.2, day);
  out.set(zenith, F.skyZenith);
  out[F.skyZenith + 3] = mix(2.4, 1.0, day); // exposure: eyes adjust a little at night
  out.set(horizon, F.skyHorizon);
  out[F.skyHorizon + 3] = look.fogDensity;
  out.set(mixRgb([0.01, 0.012, 0.02], [0.38, 0.32, 0.18], day), F.groundAmbient);
  out[F.groundAmbient + 3] = look.aoStrength;
  out.set(look.grassBase, F.grassBase);
  out[F.grassBase + 3] = look.edgeDarken;
  out.set(look.grassTip, F.grassTip);
  out[F.grassTip + 3] = look.flowerChance;
  out[F.grass] = look.bladeHeight;
  out[F.grass + 1] = look.bladeWidth;
  out[F.grass + 2] = look.bladesPerBlock;
  out[F.wind] = 0.8;
  out[F.wind + 1] = 0.6;
  out[F.wind + 2] = look.wind;
  out[F.grade] = look.saturation * mix(0.45, 1, day); // colors fade in moonlight
  out[F.grade + 1] = look.contrast;
  out[F.grade + 2] = look.warmth;
  out[F.grade + 3] = look.vignette;
  out[F.extra] = 1 - smoothstep(-0.2, 0.0, elev);
  out[F.extra + 1] = day;
}
