import { invert, lookAt, mat4, multiply, perspective, type Vec3 } from "./math.ts";

const MIN_PITCH = 0.12, MAX_PITCH = 1.45;
const MIN_DIST = 6, MAX_DIST = 160;
/** Higher is snappier; the camera closes 1 - e^-k of the gap to its goal each second-ish. */
const DAMP = 10;

const css = `
.ai-cam{position:fixed;right:12px;bottom:12px;display:flex;gap:6px;align-items:center;
  font:600 13px/1 ui-sans-serif,system-ui;user-select:none}
.ai-cam button{width:32px;height:32px;border-radius:999px;border:1px solid rgba(255,255,255,.18);
  background:rgba(10,14,18,.55);color:#fff;cursor:pointer;font:inherit;padding:0}
.ai-cam button:hover{background:rgba(10,14,18,.8)}
.ai-cam button.on{border-color:#9fd36b;background:rgba(20,40,16,.8)}
.ai-cam .needle{display:inline-block;transition:none;color:#e58b7a}
`;

/**
 * Orbit camera for spectators. Gestures move the *goal* values and the real view eases toward
 * them, so every input feels smooth. Mouse: drag orbits, right/middle-drag grabs the ground,
 * wheel zooms toward the cursor, double-click glides to a point. Touch: one finger orbits, pinch
 * zooms, two fingers pan. No keyboard control (WASD is reserved for the gag).
 */
export class Camera {
  readonly viewProj = mat4();
  readonly invViewProj = mat4();
  readonly eye: Vec3 = [0, 0, 0];
  /** Current (eased) values. Write these directly only together with `snap()`. */
  readonly target: Vec3;
  yaw = 0.7;
  pitch = 0.95;
  distance = 58;
  fovY = 0.55;
  /** Agent id to keep centered, or null for free look. Panning breaks the follow. */
  follow: number | null = null;
  /** Slow auto-orbit for a hands-off cinematic view. */
  cinematic = false;
  private goalTarget: Vec3;
  private goalYaw = this.yaw;
  private goalPitch = this.pitch;
  private goalDistance = this.distance;
  private view = mat4();
  private proj = mat4();
  private lastTime = 0;
  private hit: Vec3 = [0, 0, 0];
  private needle: HTMLElement | null = null;
  private cinematicButton: HTMLElement | null = null;
  private wasCinematic = false;

  constructor(
    readonly worldSize: [number, number],
    private groundAt: (x: number, z: number) => number,
  ) {
    this.target = [worldSize[0] / 2, 0, worldSize[1] / 2];
    this.target[1] = groundAt(this.target[0], this.target[2]) + 1;
    this.goalTarget = [...this.target];
  }

  /** Distance to glide to (e.g. when focusing on an agent). */
  set zoomTo(d: number | null) {
    if (d !== null) this.goalDistance = clamp(d, MIN_DIST, MAX_DIST);
  }

  /** Jump straight to the given pose (screenshots, tests), skipping the easing. */
  snap(o: { x?: number; z?: number; distance?: number; pitch?: number; yaw?: number }) {
    if (o.x !== undefined) this.target[0] = this.goalTarget[0] = o.x;
    if (o.z !== undefined) this.target[2] = this.goalTarget[2] = o.z;
    this.target[1] = this.groundAt(this.target[0], this.target[2]) + 1;
    if (o.distance !== undefined) this.distance = this.goalDistance = o.distance;
    if (o.pitch !== undefined) this.pitch = this.goalPitch = o.pitch;
    if (o.yaw !== undefined) this.yaw = this.goalYaw = o.yaw;
  }

  /** The current pose, in the shape `snap` takes. */
  pose() {
    return {
      x: this.target[0],
      z: this.target[2],
      distance: this.distance,
      pitch: this.pitch,
      yaw: this.yaw,
    };
  }

  attach(el: HTMLElement) {
    el.style.touchAction = "none";
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    const pointers = new Map<number, { x: number; y: number; button: number }>();
    let pinch = 0;

    const centroid = () => {
      let x = 0, y = 0;
      for (const p of pointers.values()) x += p.x, y += p.y;
      return [x / pointers.size, y / pointers.size];
    };
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    el.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
      if (pointers.size === 2) pinch = spread();
      el.setPointerCapture(e.pointerId);
    });
    const release = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 2) pinch = spread();
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (pointers.size >= 2) {
        // Two fingers: pinch zooms about their midpoint, the midpoint's motion pans.
        const before = centroid();
        p.x = e.clientX, p.y = e.clientY;
        const after = centroid();
        const s = spread();
        if (pinch > 0 && s > 0) this.zoomAt(el, after[0], after[1], pinch / s);
        pinch = s;
        this.grab(el, before[0], before[1], after[0], after[1]);
        return;
      }
      p.x = e.clientX, p.y = e.clientY;
      if (p.button === 0) {
        this.goalYaw -= dx * 0.005;
        this.goalPitch = clamp(this.goalPitch + dy * 0.004, MIN_PITCH, MAX_PITCH);
      } else {
        this.grab(el, e.clientX - dx, e.clientY - dy, e.clientX, e.clientY);
      }
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      // deltaMode 1 is lines (Firefox); normalise to pixels.
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAt(el, e.clientX, e.clientY, Math.exp(clamp(dy, -200, 200) * 0.0012));
    }, { passive: false });
    el.addEventListener("dblclick", (e) => {
      if (!this.ground(el, e.clientX, e.clientY, this.hit)) return;
      this.follow = null;
      this.moveGoal(this.hit[0], this.hit[2]);
      this.goalDistance = clamp(Math.min(this.goalDistance, 30), MIN_DIST, MAX_DIST);
    });
    this.attachHud();
  }

  private attachHud() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const bar = document.createElement("div");
    bar.className = "ai-cam";
    const button = (label: string, title: string, onclick: () => void) => {
      const b = document.createElement("button");
      b.innerHTML = label;
      b.title = title;
      b.onclick = onclick;
      bar.append(b);
      return b;
    };
    button("&#8630;", "Rotate left 45°", () => this.goalYaw += Math.PI / 4);
    const compass = button('<span class="needle">N</span>', "Face north", () => {
      this.goalYaw = Math.round(this.goalYaw / (Math.PI * 2)) * Math.PI * 2;
    });
    this.needle = compass.firstElementChild as HTMLElement;
    button("&#8631;", "Rotate right 45°", () => this.goalYaw -= Math.PI / 4);
    button("&#9974;", "Overview of the whole island", () => this.overview());
    this.cinematicButton = button("&#9654;", "Cinematic auto-orbit", () => {
      this.cinematic = !this.cinematic;
    });
    document.body.append(bar);
  }

  /** Pull back to see the whole world. */
  overview() {
    this.follow = null;
    this.moveGoal(this.worldSize[0] / 2, this.worldSize[1] / 2);
    this.goalDistance = MAX_DIST * 0.8;
    this.goalPitch = 0.9;
  }

  pan(dx: number, dz: number) {
    this.moveGoal(this.goalTarget[0] + dx, this.goalTarget[2] + dz);
  }

  private moveGoal(x: number, z: number) {
    this.goalTarget[0] = clamp(x, 0, this.worldSize[0]);
    this.goalTarget[2] = clamp(z, 0, this.worldSize[1]);
  }

  /** Follow an agent and close in to a comfortable watching distance. */
  focus(agentId: number) {
    this.follow = agentId;
    this.zoomTo = Math.min(this.goalDistance, 30);
  }

  /** Aim the view at a point, e.g. a followed agent; the easing happens in `update`. */
  track(x: number, z: number) {
    this.moveGoal(x, z);
  }

  /** Zoom by `factor` (>1 out) keeping the ground point under the cursor fixed. */
  private zoomAt(el: HTMLElement, cx: number, cy: number, factor: number) {
    const next = clamp(this.goalDistance * factor, MIN_DIST, MAX_DIST);
    if (next === this.goalDistance) return;
    if (this.follow === null && this.ground(el, cx, cy, this.hit)) {
      // Slide the target toward the cursor point in proportion to how much we zoom.
      const k = 1 - next / this.goalDistance;
      this.moveGoal(
        this.goalTarget[0] + (this.hit[0] - this.goalTarget[0]) * k,
        this.goalTarget[2] + (this.hit[2] - this.goalTarget[2]) * k,
      );
    }
    this.goalDistance = next;
  }

  /** Drag the ground so the point under (x0,y0) ends up under (x1,y1). */
  private grab(el: HTMLElement, x0: number, y0: number, x1: number, y1: number) {
    const a: Vec3 = [0, 0, 0], b = this.hit;
    if (!this.ground(el, x0, y0, a) || !this.ground(el, x1, y1, b)) return;
    this.follow = null;
    this.pan(a[0] - b[0], a[2] - b[2]);
  }

  /** Intersect the cursor ray with the terrain (plane at target height, refined twice). */
  private ground(el: HTMLElement, cx: number, cy: number, out: Vec3): boolean {
    const r = el.getBoundingClientRect();
    const nx = ((cx - r.left) / r.width) * 2 - 1, ny = 1 - ((cy - r.top) / r.height) * 2;
    const m = this.invViewProj;
    const unproject = (z: number, o: Vec3) => {
      const w = m[3] * nx + m[7] * ny + m[11] * z + m[15];
      o[0] = (m[0] * nx + m[4] * ny + m[8] * z + m[12]) / w;
      o[1] = (m[1] * nx + m[5] * ny + m[9] * z + m[13]) / w;
      o[2] = (m[2] * nx + m[6] * ny + m[10] * z + m[14]) / w;
    };
    const near: Vec3 = [0, 0, 0], far: Vec3 = [0, 0, 0];
    unproject(0, near), unproject(1, far);
    const dy = far[1] - near[1];
    if (dy >= -1e-6) return false; // looking at or above the horizon
    let h = this.target[1] - 1;
    for (let i = 0; i < 3; i++) {
      const t = (h - near[1]) / dy;
      out[0] = near[0] + (far[0] - near[0]) * t;
      out[2] = near[2] + (far[2] - near[2]) * t;
      h = this.groundAt(clamp(out[0], 0, this.worldSize[0]), clamp(out[2], 0, this.worldSize[1]));
    }
    out[1] = h;
    return true;
  }

  update(aspect: number) {
    const now = performance.now();
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;
    if (this.cinematic) this.goalYaw += dt * 0.12;
    if (this.cinematic !== this.wasCinematic) {
      this.wasCinematic = this.cinematic;
      this.cinematicButton?.classList.toggle("on", this.cinematic);
    }

    const k = 1 - Math.exp(-DAMP * dt);
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    this.distance += (this.goalDistance - this.distance) * k;
    // Following eases a little slower than free moves so agents don't feel glued to the centre.
    const kt = this.follow === null ? k : 1 - Math.exp(-5 * dt);
    this.target[0] += (this.goalTarget[0] - this.target[0]) * kt;
    this.target[2] += (this.goalTarget[2] - this.target[2]) * kt;
    const ground = this.groundAt(this.target[0], this.target[2]) + 1;
    this.target[1] += (ground - this.target[1]) * Math.min(1, 5 * dt);

    const cp = Math.cos(this.pitch);
    this.eye[0] = this.target[0] + Math.sin(this.yaw) * cp * this.distance;
    this.eye[1] = this.target[1] + Math.sin(this.pitch) * this.distance;
    this.eye[2] = this.target[2] + Math.cos(this.yaw) * cp * this.distance;
    // Low orbits behind a hill would put the eye inside it; ride over the terrain instead.
    const [sx, sz] = this.worldSize;
    const under = this.groundAt(clamp(this.eye[0], 0, sx - 1), clamp(this.eye[2], 0, sz - 1)) + 1.5;
    if (this.eye[1] < under) this.eye[1] = under;
    lookAt(this.view, this.eye, this.target, [0, 1, 0]);
    perspective(this.proj, this.fovY, aspect, 0.5, 4000);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);

    if (this.needle) {
      // Yaw 0 puts the eye at +z looking north (-z); the needle swings opposite to the view.
      this.needle.style.transform = `rotate(${this.yaw}rad)`;
    }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
