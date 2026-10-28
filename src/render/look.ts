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
  nightZenith: [0.008, 0.016, 0.045] as Rgb,
  nightHorizon: [0.025, 0.04, 0.085] as Rgb,
  duskZenith: [0.12, 0.14, 0.32] as Rgb,
  duskHorizon: [0.95, 0.42, 0.18] as Rgb,
  dayZenith: [0.08, 0.22, 0.6] as Rgb,
  dayHorizon: [0.36, 0.53, 0.8] as Rgb,
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
  const sunColor = mixRgb([1.0, 0.45, 0.2], [1.0, 0.93, 0.82], smoothstep(0.0, 0.45, elev));
  const keyColor = isSun ? sunColor : ([0.3, 0.42, 1.0] as Rgb);
  const keyIntensity = isSun
    ? 2.3 * smoothstep(0.0, 0.12, elev) * mix(1, 0.55, overcast)
    : 0.15 + 0.35 * illuminated * smoothstep(0.0, 0.12, moon[1]);

  let zenith = mixRgb(SKY.nightZenith, SKY.dayZenith, day01);
  let horizon = mixRgb(SKY.nightHorizon, SKY.dayHorizon, day01);
  zenith = mixRgb(zenith, SKY.duskZenith, twilight * 0.6);
  horizon = mixRgb(horizon, SKY.duskHorizon, twilight * 0.75);
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
  out[F.sunColor + 3] = mix(1.0, 1.15, day01) * mix(1, 1.3, overcast);
  out.set(zenith, F.skyZenith);
  out[F.skyZenith + 3] = mix(3.2, 1.0, day01); // exposure: eyes adjust at night
  out.set(horizon, F.skyHorizon);
  out[F.skyHorizon + 3] = look.fogDensity;
  out.set(mixRgb([0.01, 0.012, 0.02], [0.38, 0.32, 0.18], day01), F.groundAmbient);
  out[F.groundAmbient + 3] = look.aoStrength;
  out.set(look.grassBase, F.grassBase);
  out.set(look.grassTip, F.grassTip);
  out[F.grassTip + 3] = look.flowerChance;
  out[F.grass] = look.bladeHeight;
  out[F.grass + 1] = look.bladeWidth;
  out[F.grass + 2] = look.bladesPerBlock;
  out[F.wind] = 0.8;
  out[F.wind + 1] = 0.6;
  out[F.wind + 2] = look.wind * mix(1, 1.6, overcast);
  out[F.grade] = look.saturation * mix(1, 0.45, night); // colors fade in moonlight
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
}
