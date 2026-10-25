import { invert, lookAt, mat4, multiply, perspective, type Vec3 } from "./math.ts";

/**
 * Angled top-down orbit camera. Watching is allowed: drag to orbit,
 * right-drag to pan, wheel to zoom.
 */
export class Camera {
  readonly viewProj = mat4();
  readonly invViewProj = mat4();
  readonly eye: Vec3 = [0, 0, 0];
  readonly target: Vec3;
  yaw = 0.7;
  pitch = 0.95;
  distance = 58;
  fovY = 0.55;
  /** Agent id to keep centered, or null for free look. Panning breaks the follow. */
  follow: number | null = null;
  /** Distance to glide to (e.g. when focusing on an agent); scrolling cancels it. */
  zoomTo: number | null = null;
  private view = mat4();
  private proj = mat4();

  constructor(
    readonly worldSize: [number, number],
    private groundAt: (x: number, z: number) => number,
  ) {
    this.target = [worldSize[0] / 2, 0, worldSize[1] / 2];
    this.target[1] = groundAt(this.target[0], this.target[2]) + 1;
  }

  attach(el: HTMLElement) {
    let dragging: number | null = null;
    let lastX = 0, lastY = 0;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      dragging = e.button;
      lastX = e.clientX, lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointerup", () => (dragging = null));
    el.addEventListener("pointermove", (e) => {
      if (dragging === null) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX, lastY = e.clientY;
      if (dragging === 0) {
        this.yaw -= dx * 0.005;
        this.pitch = Math.min(1.45, Math.max(0.45, this.pitch + dy * 0.004));
      } else {
        this.follow = null;
        const s = this.distance * 0.0016;
        const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
        this.pan(-(dx * cos + dy * sin) * s, (dx * sin - dy * cos) * s);
      }
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomTo = null;
      this.distance = Math.min(110, Math.max(10, this.distance * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }

  pan(dx: number, dz: number) {
    this.target[0] = Math.min(this.worldSize[0], Math.max(0, this.target[0] + dx));
    this.target[2] = Math.min(this.worldSize[1], Math.max(0, this.target[2] + dz));
  }

  /** Follow an agent and close in to a comfortable watching distance. */
  focus(agentId: number) {
    this.follow = agentId;
    this.zoomTo = Math.min(this.distance, 30);
  }

  /** Ease the view target toward a point, e.g. a followed agent. */
  track(x: number, z: number) {
    this.target[0] += (x - this.target[0]) * 0.08;
    this.target[2] += (z - this.target[2]) * 0.08;
  }

  update(aspect: number) {
    if (this.zoomTo !== null) {
      this.distance += (this.zoomTo - this.distance) * 0.06;
      if (Math.abs(this.zoomTo - this.distance) < 0.05) this.zoomTo = null;
    }
    const ground = this.groundAt(this.target[0], this.target[2]) + 1;
    this.target[1] += (ground - this.target[1]) * 0.08;
    const cp = Math.cos(this.pitch);
    this.eye[0] = this.target[0] + Math.sin(this.yaw) * cp * this.distance;
    this.eye[1] = this.target[1] + Math.sin(this.pitch) * this.distance;
    this.eye[2] = this.target[2] + Math.cos(this.yaw) * cp * this.distance;
    lookAt(this.view, this.eye, this.target, [0, 1, 0]);
    perspective(this.proj, this.fovY, aspect, 0.5, 4000);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);
  }
}
