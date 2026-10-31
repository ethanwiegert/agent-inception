import { Anim, type SimEvent } from "./sim/sim.ts";

/**
 * The world's sound (M13): WebAudio with positional one-shots hooked to what villagers do (steps,
 * digging, building, splashes, munching, speech), sim events (a level up, a Wish, a knock) and
 * ambience that follows the day and the weather (birds, crickets, wind, fire crackling near the
 * camera). Every sound is synthesized here as a placeholder until its file lands: list files in
 * `web/audio/manifest.json` and they replace the synth, music included. Audio starts on the
 * spectator's first click or key (browsers' autoplay rule) and remembers being muted.
 */

export type SoundId =
  | "step"
  | "dig"
  | "plant"
  | "rustle"
  | "thunk"
  | "splash"
  | "munch"
  | "chime"
  | "pin"
  | "voice"
  | "knock"
  | "click";
type LoopId = "birds" | "crickets" | "wind" | "crackle";

/** `web/audio/manifest.json`: files under `web/audio/`. Missing entries keep the synth. */
export interface SoundManifest {
  /** Played in order, looping, under everything else. */
  music?: string[];
  sounds?: Partial<Record<SoundId | LoopId, string>>;
  /** Short voice clips; each villager gets one by their id when they say something. */
  voices?: string[];
}

export interface Listener {
  eye: ArrayLike<number>;
  target: ArrayLike<number>;
}

export interface AgentSound {
  id: number;
  x: number;
  y: number;
  z: number;
  anim: number;
  stride: number;
}

/** Seconds between a working villager's sounds, by animation. */
const WORK: Partial<Record<number, [SoundId, number]>> = {
  [Anim.Till]: ["dig", 0.7],
  [Anim.Plant]: ["plant", 0.8],
  [Anim.Harvest]: ["rustle", 0.6],
  [Anim.Build]: ["thunk", 0.55],
  [Anim.Eat]: ["munch", 0.5],
};
/** Blocks walked between footsteps. */
const STEP = 0.8;
/** Sounds further than this from the listener aren't started; at most this many play at once. */
const HEAR = 70;
const VOICES = 20;
const STORE = "ai-sound";

export class SoundScape {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private voiceClips: AudioBuffer[] = [];
  private loops = new Map<LoopId, { gain: GainNode; panner?: PannerNode }>();
  private playing = 0;
  private agents = new Map<number, { anim: number; stride: number; next: number }>();
  private ear: [number, number, number] = [0, 0, 0];
  /** Reused for each villager's position each frame (play reads it at once). */
  private at: [number, number, number] = [0, 0, 0];
  muted: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORE);
    } catch { /* storage blocked: start unmuted */ }
    this.muted = stored === "off";
    // Every click or key may be the gesture the browser waits for before audio can play.
    const start =
      () => (this.ctx ? this.ctx.state === "suspended" && this.applyMute() : this.start());
    addEventListener("pointerdown", start);
    addEventListener("keydown", start);
    addEventListener("visibilitychange", () => this.applyMute());
  }

  get started(): boolean {
    return this.ctx !== null;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      localStorage.setItem(STORE, muted ? "off" : "on");
    } catch { /* not remembered */ }
    if (!muted && !this.ctx) this.start();
    this.applyMute();
  }

  private applyMute() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.muted || document.hidden) void ctx.suspend();
    else void ctx.resume();
  }

  private start() {
    if (this.ctx || typeof AudioContext === "undefined") return;
    const ctx = this.ctx = new AudioContext();
    const comp = new DynamicsCompressorNode(ctx, { threshold: -14, ratio: 4 });
    comp.connect(ctx.destination);
    this.master = new GainNode(ctx, { gain: 0.8 });
    this.master.connect(comp);
    for (const [id, make] of Object.entries(SYNTH)) this.buffers.set(id, make(ctx));
    for (const id of ["birds", "crickets", "wind"] as LoopId[]) this.loop(id, false);
    this.loop("crackle", true);
    this.applyMute();
    void this.loadFiles();
  }

  private loop(id: LoopId, positional: boolean) {
    const ctx = this.ctx!;
    const gain = new GainNode(ctx, { gain: 0 });
    let panner: PannerNode | undefined;
    if (positional) {
      panner = this.panner(0, -100, 0);
      gain.connect(panner).connect(this.master!);
    } else gain.connect(this.master!);
    const src = new AudioBufferSourceNode(ctx, { buffer: this.buffers.get(id)!, loop: true });
    src.connect(gain);
    src.start();
    this.loops.set(id, { gain, panner });
  }

  private panner(x: number, y: number, z: number) {
    return new PannerNode(this.ctx!, {
      panningModel: "equalpower",
      distanceModel: "inverse",
      refDistance: 5,
      maxDistance: 150,
      rolloffFactor: 1.4,
      positionX: x,
      positionY: y,
      positionZ: z,
    });
  }

  /** Swap in Ethan's recordings where the manifest names them. */
  private async loadFiles() {
    const ctx = this.ctx!;
    let manifest: SoundManifest;
    try {
      const res = await fetch("/audio/manifest.json");
      if (!res.ok) return;
      manifest = await res.json();
    } catch {
      return;
    }
    const decode = async (file: string) =>
      await ctx.decodeAudioData(await (await fetch(`/audio/${file}`)).arrayBuffer());
    for (const [id, file] of Object.entries(manifest.sounds ?? {})) {
      try {
        this.buffers.set(id, await decode(file!));
      } catch { /* keep the synth */ }
    }
    for (const file of manifest.voices ?? []) {
      try {
        this.voiceClips.push(await decode(file));
      } catch { /* skip it */ }
    }
    const music: AudioBuffer[] = [];
    for (const file of manifest.music ?? []) {
      try {
        music.push(await decode(file));
      } catch { /* skip it */ }
    }
    if (music.length) this.playMusic(music, 0);
  }

  private playMusic(tracks: AudioBuffer[], i: number) {
    const ctx = this.ctx!;
    const src = new AudioBufferSourceNode(ctx, { buffer: tracks[i % tracks.length] });
    src.connect(new GainNode(ctx, { gain: 0.35 })).connect(this.master!);
    src.onended = () => this.playMusic(tracks, i + 1);
    src.start();
  }

  /** Play `id` at a world position (or everywhere, without one). */
  play(id: SoundId, at?: [number, number, number], volume = 1, buffer?: AudioBuffer) {
    const ctx = this.ctx;
    if (!ctx || this.muted || document.hidden || this.playing >= VOICES) return;
    if (at && Math.hypot(at[0] - this.ear[0], at[2] - this.ear[2]) > HEAR) return;
    const src = new AudioBufferSourceNode(ctx, {
      buffer: buffer ?? this.buffers.get(id)!,
      playbackRate: 0.92 + Math.random() * 0.16,
    });
    const gain = new GainNode(ctx, { gain: volume });
    src.connect(gain);
    if (at) gain.connect(this.panner(at[0], at[1], at[2])).connect(this.master!);
    else gain.connect(this.master!);
    this.playing++;
    src.onended = () => this.playing--;
    src.start();
  }

  /** A sim event's sound, if it has one. */
  event(e: SimEvent, where: (agent: number) => [number, number, number] | undefined) {
    if (!this.ctx) return;
    const at = "agent" in e && e.agent ? where(e.agent) : undefined;
    switch (e.type) {
      case "say": {
        const clips = this.voiceClips;
        const clip = clips.length ? clips[e.agent % clips.length] : undefined;
        return this.play("voice", at, 0.6, clip);
      }
      case "catch":
        return this.play("splash", at);
      case "joined":
        return this.play("chime", undefined, 0.4);
      case "village":
        // Level ups and finished errands chime; the rest (needs, weather) stay quiet.
        if (/grown into|finished an errand/.test(e.text)) this.play("chime", undefined, 0.6);
        return;
      case "board":
        return this.play("pin", e.agent ? at : undefined, 0.7);
      case "physics":
        return this.play("knock", at);
      case "signal":
        return this.play("click", e.from, 0.6);
    }
  }

  /**
   * Once a frame: move the ear with the camera, voice what villagers are doing, and fade the
   * ambience with the time of day, the clouds and the nearest fire.
   */
  update(
    now: number,
    listener: Listener,
    agents: AgentSound[],
    timeOfDay: number,
    clouds: number,
    nearestFire: [number, number, number] | null,
  ) {
    const ctx = this.ctx;
    if (!ctx || this.muted || document.hidden) return;
    const l = ctx.listener, e = listener.eye, t = listener.target;
    this.ear[0] = e[0], this.ear[1] = e[1], this.ear[2] = e[2];
    const fx = t[0] - e[0], fy = t[1] - e[1], fz = t[2] - e[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    if (l.positionX) {
      l.positionX.value = e[0], l.positionY.value = e[1], l.positionZ.value = e[2];
      l.forwardX.value = fx / fl, l.forwardY.value = fy / fl, l.forwardZ.value = fz / fl;
      l.upX.value = 0, l.upY.value = 1, l.upZ.value = 0;
    }

    const secs = now / 1000;
    for (const a of agents) {
      let s = this.agents.get(a.id);
      if (!s) this.agents.set(a.id, s = { anim: a.anim, stride: a.stride, next: secs });
      const at = this.at;
      at[0] = a.x, at[1] = a.y, at[2] = a.z;
      if (a.anim === Anim.Walk && Math.floor(a.stride / STEP) !== Math.floor(s.stride / STEP)) {
        this.play("step", at, 0.5);
      }
      const work = WORK[a.anim];
      if (work && (s.anim !== a.anim || secs >= s.next)) {
        this.play(work[0], at, 0.7);
        s.next = secs + work[1] * (0.85 + Math.random() * 0.3);
      }
      if (a.anim === Anim.Fish && s.anim !== Anim.Fish) this.play("splash", at, 0.5);
      s.anim = a.anim, s.stride = a.stride;
    }

    // Daylight 0-1 from the hour: birds by day, crickets by night, wind with the clouds.
    const day = Math.max(0, Math.min(1, (Math.sin((timeOfDay - 0.25) * Math.PI * 2) + 0.15) * 2));
    const height = Math.max(0, Math.min(1, (e[1] - 20) / 80));
    this.fade("birds", day * (1 - clouds * 0.6) * (1 - height) * 0.35);
    this.fade("crickets", (1 - day) * (1 - height) * 0.22);
    this.fade("wind", 0.05 + clouds * 0.18 + height * 0.2);
    const crackle = this.loops.get("crackle")!;
    if (nearestFire) {
      crackle.panner!.positionX.value = nearestFire[0];
      crackle.panner!.positionY.value = nearestFire[1];
      crackle.panner!.positionZ.value = nearestFire[2];
    }
    this.fade("crackle", nearestFire ? 0.8 : 0);
  }

  private fade(id: LoopId, gain: number) {
    const g = this.loops.get(id)!.gain.gain;
    g.setTargetAtTime(gain, this.ctx!.currentTime, 0.8);
  }
}

// ---------------------------------------------------------------- synthesized placeholders

/** A small seeded noise source, so the synth sounds the same on every load. */
function noise(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13, s ^= s >>> 17, s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

function buffer(ctx: BaseAudioContext, seconds: number, fill: (t: number, i: number) => number) {
  const rate = ctx.sampleRate, n = Math.floor(seconds * rate);
  const b = ctx.createBuffer(1, n, rate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = fill(i / rate, i);
  return b;
}

/** A one-pole low-pass over a noise source: `k` near 0 is dull, near 1 bright. */
function lowNoise(seed: number, k: number) {
  const r = noise(seed);
  let y = 0;
  return () => (y += (r() - y) * k);
}

const env = (t: number, attack: number, decay: number) =>
  t < attack ? t / attack : Math.exp(-(t - attack) / decay);
const tone = (t: number, f: number) => Math.sin(t * f * Math.PI * 2);

const SYNTH: Record<SoundId | LoopId, (ctx: BaseAudioContext) => AudioBuffer> = {
  step: (ctx) => {
    const n = lowNoise(1, 0.15);
    return buffer(ctx, 0.12, (t) => n() * env(t, 0.004, 0.03) * 1.4);
  },
  dig: (ctx) => {
    const n = lowNoise(2, 0.35);
    return buffer(ctx, 0.25, (t) => n() * env(t, 0.01, 0.07) * (1 + 0.5 * tone(t, 23)));
  },
  plant: (ctx) => {
    const n = lowNoise(3, 0.5);
    return buffer(ctx, 0.3, (t) => n() * env(t, 0.05, 0.08) * 0.6);
  },
  rustle: (ctx) => {
    const n = lowNoise(4, 0.7);
    return buffer(ctx, 0.35, (t) => n() * env(t, 0.03, 0.1) * (0.6 + 0.4 * tone(t, 31)) * 0.6);
  },
  thunk: (ctx) => {
    const n = lowNoise(5, 0.6);
    return buffer(
      ctx,
      0.3,
      (t) => (tone(t, 150 - t * 200) * 0.9 + n() * 0.5 * env(t, 0.001, 0.01)) * env(t, 0.002, 0.06),
    );
  },
  splash: (ctx) => {
    const n = lowNoise(6, 0.6);
    return buffer(ctx, 0.6, (t) => n() * env(t, 0.01, 0.15) * (0.7 + 0.3 * tone(t, 9)));
  },
  munch: (ctx) => {
    const n = lowNoise(7, 0.8);
    return buffer(ctx, 0.18, (t) => n() * env(t, 0.003, 0.025) * (t % 0.06 < 0.03 ? 1 : 0.3));
  },
  chime: (ctx) =>
    buffer(ctx, 1.4, (t) =>
      [523.25, 659.25, 783.99].reduce(
        (s, f, i) => s + (t > i * 0.12 ? tone(t, f) * env(t - i * 0.12, 0.005, 0.4) * 0.3 : 0),
        0,
      )),
  pin: (ctx) => {
    const n = lowNoise(8, 0.9);
    return buffer(
      ctx,
      0.25,
      (t) => n() * env(t, 0.001, 0.015) * 0.5 + tone(t, 1320) * env(t, 0.002, 0.06) * 0.25,
    );
  },
  // A soft two-note "mm-hm" until Ethan's voices land.
  voice: (ctx) =>
    buffer(ctx, 0.4, (t) => {
      const f = t < 0.18 ? 220 : 262;
      return (tone(t, f) * 0.6 + tone(t, f * 2) * 0.2) * env(t % 0.2, 0.02, 0.07) * 0.5;
    }),
  knock: (ctx) => {
    const n = lowNoise(9, 0.25);
    return buffer(ctx, 0.4, (t) => (tone(t, 70) + n() * 0.6) * env(t, 0.002, 0.09));
  },
  click: (ctx) => buffer(ctx, 0.05, (t) => tone(t, 2200) * env(t, 0.0005, 0.006) * 0.5),

  // Loops: a few seconds each, faded in and out by `update`.
  birds: (ctx) => {
    const r = noise(10);
    const chirps = Array.from({ length: 14 }, () => ({
      at: (r() + 1) * 2.9,
      f: 2600 + r() * 1400,
      sweep: r() * 1800,
      len: 0.05 + (r() + 1) * 0.05,
    }));
    return buffer(ctx, 6, (t) => {
      let s = 0;
      for (const c of chirps) {
        const u = t - c.at;
        if (u > 0 && u < c.len) {
          s += Math.sin((c.f + c.sweep * u / c.len) * u * Math.PI * 2) *
            Math.sin(u / c.len * Math.PI);
        }
      }
      return s * 0.25;
    });
  },
  crickets: (ctx) =>
    buffer(ctx, 4, (t) => {
      const pulse = (t * 3.1) % 1 < 0.35 ? Math.max(0, tone(t, 45)) : 0;
      return tone(t, 4400) * pulse * 0.12;
    }),
  wind: (ctx) => {
    const n = lowNoise(11, 0.02);
    return buffer(ctx, 8, (t) => n() * 3 * (0.6 + 0.4 * Math.sin(t * Math.PI / 4)));
  },
  crackle: (ctx) => {
    const r = noise(12), hiss = lowNoise(13, 0.3);
    let pop = 0;
    return buffer(ctx, 3, () => {
      if (r() > 0.9993) pop = 1;
      pop *= 0.992;
      return hiss() * 0.15 + r() * pop * 0.6;
    });
  },
};
