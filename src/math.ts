/** Column-major 4×4 matrices in Float32Arrays, matching WGSL `mat4x4f`. Depth range is [0, 1]. */
export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export const mat4 = (): Mat4 => new Float32Array(16);

export function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}

export function ortho(out: Mat4, halfW: number, halfH: number, near: number, far: number) {
  out.fill(0);
  out[0] = 1 / halfW;
  out[5] = 1 / halfH;
  out[10] = 1 / (near - far);
  out[14] = near / (near - far);
  out[15] = 1;
  return out;
}

export function lookAt(out: Mat4, eye: Vec3, target: Vec3, up: Vec3) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  zx /= len, zy /= len, zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  xx /= len, xy /= len, xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx, out[1] = yx, out[2] = zx, out[3] = 0;
  out[4] = xy, out[5] = yy, out[6] = zy, out[7] = 0;
  out[8] = xz, out[9] = yz, out[10] = zz, out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function multiply(out: Mat4, a: Mat4, b: Mat4) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
  return out;
}

export function invert(out: Mat4, m: Mat4) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = 1 /
    (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

// In-place transform builders: each post-multiplies `m` (m = m · T), like a scene-graph walk.

export function identity(m: Mat4) {
  m.fill(0);
  m[0] =
    m[5] =
    m[10] =
    m[15] =
      1;
  return m;
}

export function translate(m: Mat4, x: number, y: number, z: number) {
  for (let r = 0; r < 4; r++) m[12 + r] += m[r] * x + m[4 + r] * y + m[8 + r] * z;
  return m;
}

export function scale(m: Mat4, x: number, y: number, z: number) {
  for (let r = 0; r < 4; r++) m[r] *= x, m[4 + r] *= y, m[8 + r] *= z;
  return m;
}

/** Rotate about local X; positive angles tip +Y toward +Z. */
export function rotateX(m: Mat4, a: number) {
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 4; r++) {
    const y = m[4 + r], z = m[8 + r];
    m[4 + r] = y * c + z * s;
    m[8 + r] = z * c - y * s;
  }
  return m;
}

/** Rotate about local Y; positive angles turn +Z toward +X. */
export function rotateY(m: Mat4, a: number) {
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 4; r++) {
    const x = m[r], z = m[8 + r];
    m[r] = x * c - z * s;
    m[8 + r] = x * s + z * c;
  }
  return m;
}

/** Rotate about local Z; positive angles turn +X toward +Y. */
export function rotateZ(m: Mat4, a: number) {
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 4; r++) {
    const x = m[r], y = m[4 + r];
    m[r] = x * c + y * s;
    m[4 + r] = y * c - x * s;
  }
  return m;
}

const PLANE_ROWS = [0, 1, 0, -1, 1, 1, 1, -1, 2, 0, 2, -1];

/** The six planes (a, b, c, d) of a view-projection's frustum, for `aabbVisible`. */
export function frustumPlanes(out: Float32Array, m: Mat4) {
  // Gribb-Hartmann for [0, 1] depth: left, right, bottom, top, near, far. Row r is m[r + 4k].
  for (let p = 0; p < 6; p++) {
    const r = PLANE_ROWS[p * 2], s = PLANE_ROWS[p * 2 + 1];
    for (let k = 0; k < 4; k++) {
      const v = m[r + 4 * k];
      out[p * 4 + k] = s === 0 ? v : m[3 + 4 * k] + s * v;
    }
  }
  return out;
}

/** Whether an axis-aligned box touches the frustum (conservative). */
export function aabbVisible(
  planes: Float32Array,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): boolean {
  for (let i = 0; i < 24; i += 4) {
    const a = planes[i], b = planes[i + 1], c = planes[i + 2], d = planes[i + 3];
    // The box corner furthest along the plane normal.
    if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
  }
  return true;
}
