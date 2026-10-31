import { LIGHT_CHUNK, type LightField } from "../sim/light.ts";
import type { World } from "../sim/world.ts";

/**
 * The light field (sim/light.ts) on the GPU: one rgba8 texel per cell of the world, filtered so
 * lamplight falls off smoothly between cells. Only the chunks the field recomputed are uploaded.
 */
export class LightTexture {
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  private texture: GPUTexture;
  private field: LightField | null = null;
  private zeros = new Uint8Array(LIGHT_CHUNK ** 3 * 4);

  constructor(private device: GPUDevice, world: World) {
    this.texture = device.createTexture({
      size: [world.sizeX, world.sizeY, world.sizeZ],
      dimension: "3d",
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
  }

  /** Upload what changed in `field` since last time (all of it, for a new field). */
  update(field: LightField | null) {
    if (!field) return;
    if (field !== this.field) {
      // A new world's field: clear what the old one lit, then take every chunk it has.
      if (this.field) { for (const c of this.field.chunks.keys()) field.changed.add(c); }
      for (const c of field.chunks.keys()) field.changed.add(c);
      this.field = field;
    }
    if (!field.changed.size) return;
    const C = LIGHT_CHUNK, t = this.texture;
    for (const c of field.changed) {
      const [x, y, z] = field.chunkOrigin(c);
      if (x >= t.width || y >= t.height || z >= t.depthOrArrayLayers) continue;
      const w = Math.min(C, t.width - x), h = Math.min(C, t.height - y);
      const d = Math.min(C, t.depthOrArrayLayers - z);
      this.device.queue.writeTexture(
        { texture: t, origin: { x, y, z } },
        field.chunks.get(c) ?? this.zeros,
        { bytesPerRow: C * 4, rowsPerImage: C },
        { width: w, height: h, depthOrArrayLayers: d },
      );
    }
    field.changed.clear();
  }
}
