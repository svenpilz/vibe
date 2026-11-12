/**
 * WebGL renderer for the map: all geometry is tessellated on the CPU into
 * triangle soup (world units, z=0 plane) and drawn with a single dynamic
 * buffer. No Canvas2D anywhere — even the surface patterns are generated
 * procedurally into RGBA textures.
 *
 * World space: Web Mercator pixels at reference scale 2000 px/degree
 * longitude (R0 per radian), x east, y north, z up. The camera is a
 * perspective camera orbiting a ground target (Google Earth style):
 * pitch 0 = straight down, which reproduces the classic flat map exactly.
 */

export type Pt = [number, number];
export type RGBA = [number, number, number, number];

/** reference world units per radian of longitude (scale 2000 px/deg) */
export const R0 = (2000 * 180) / Math.PI;

export function mercY(latDeg: number): number {
  const clamped = Math.max(-85, Math.min(85, latDeg));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}
export function invMercY(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

// ---------------- colors ----------------

const NAMED: Record<string, RGBA> = {
  black: [0, 0, 0, 1], white: [1, 1, 1, 1], red: [1, 0, 0, 1],
  green: [0, 0.5, 0, 1], blue: [0, 0, 1, 1], yellow: [1, 1, 0, 1],
  gray: [0.5, 0.5, 0.5, 1], grey: [0.5, 0.5, 0.5, 1],
  orange: [1, 0.647, 0, 1], purple: [0.5, 0, 0.5, 1],
  brown: [0.647, 0.165, 0.165, 1], pink: [1, 0.753, 0.796, 1],
  cyan: [0, 1, 1, 1], magenta: [1, 0, 1, 1], lime: [0, 1, 0, 1],
  navy: [0, 0, 0.5, 1], teal: [0, 0.5, 0.5, 1], olive: [0.5, 0.5, 0, 1],
  maroon: [0.5, 0, 0, 1], silver: [0.753, 0.753, 0.753, 1],
};

/** parse a CSS color (#rgb/#rrggbb/#rrggbbaa, rgb()/rgba(), common names) */
export function parseColor(css: string): RGBA | null {
  const s = css.trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const hex = (n: number) => parseInt(h.slice(n * 2, n * 2 + 2), 16) / 255;
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16) / 255,
        g = parseInt(h[1] + h[1], 16) / 255,
        b = parseInt(h[2] + h[2], 16) / 255,
        a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (h.length === 6 || h.length === 8) {
      return [hex(0), hex(1), hex(2), h.length === 8 ? hex(3) : 1];
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((p) => p.length > 0);
    if (parts.length < 3) return null;
    const ch = (p: string): number | null => {
      if (p.endsWith("%")) {
        const v = parseFloat(p);
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : null;
      }
      const v = parseFloat(p);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 255)) : null;
    };
    const r = ch(parts[0]),
      g = ch(parts[1]),
      b = ch(parts[2]);
    if (r === null || g === null || b === null) return null;
    let a = 1;
    if (parts.length > 3) {
      const p = parts[3];
      const v = p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p);
      if (!Number.isFinite(v)) return null;
      a = Math.max(0, Math.min(1, v));
    }
    return [r, g, b, a];
  }
  return NAMED[s] ?? null;
}

export function rgba(css: string, alpha = 1): RGBA {
  const c = parseColor(css);
  return c ? [c[0], c[1], c[2], c[3] * alpha] : [0, 0, 0, alpha];
}

// ---------------- mat4 (column-major) ----------------

type Mat4 = Float32Array<ArrayBuffer>;

function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function mat4LookAt(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number],
): Mat4 {
  const z = norm3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0]; m[3] = 0;
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1]; m[7] = 0;
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2]; m[11] = 0;
  m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  m[15] = 1;
  return m;
}

function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

// ---------------- tessellation ----------------

function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointInTri(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const d2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
  const d3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
  const eps = -1e-9;
  return d1 >= eps && d2 >= eps && d3 >= eps;
}

/** ear-clipping triangulation of a simple (hole-free) ring; returns flat
 *  triangle indices into `ring` */
export function earclip(ring: Pt[]): number[] {
  const pts: Pt[] = [];
  for (const p of ring) {
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-9) pts.push(p);
  }
  if (pts.length > 1) {
    const f = pts[0],
      l = pts[pts.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-9) pts.pop();
  }
  const n = pts.length;
  if (n < 3) return [];
  let idx = pts.map((_, i) => i);
  if (ringArea(pts) < 0) idx = idx.reverse();
  const tris: number[] = [];
  let guard = 0;
  const maxGuard = n * n + 64;
  while (idx.length > 3 && guard++ < maxGuard) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length],
        i1 = idx[k],
        i2 = idx[(k + 1) % idx.length];
      const a = pts[i0],
        b = pts[i1],
        c = pts[i2];
      const cross =
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 1e-9) continue;
      let blocked = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(pts[j], a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push(i0, i1, i2);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      for (let k = 1; k < idx.length - 1; k++)
        tris.push(idx[0], idx[k], idx[k + 1]);
      return tris;
    }
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

// ---------------- procedural pattern tiles ----------------

function rand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export interface TileData {
  data: Uint8Array;
  w: number;
  h: number;
}

function makeTile(w: number, h: number): { t: TileData; fill: (x: number, y: number, ww: number, hh: number, rgb: [number, number, number]) => void } {
  const data = new Uint8Array(w * h * 4);
  const fill = (
    x: number,
    y: number,
    ww: number,
    hh: number,
    rgb: [number, number, number],
  ): void => {
    const x0 = Math.max(0, Math.round(x)),
      y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(w, Math.round(x + ww)),
      y1 = Math.min(h, Math.round(y + hh));
    for (let yy = y0; yy < y1; yy++)
      for (let xx = x0; xx < x1; xx++) {
        const o = (yy * w + xx) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
  };
  return { t: { data, w, h }, fill };
}

function greenBase(kind: string): [number, number, number] {
  if (kind === "scrub") return [73, 94, 55];
  return [93, 122, 68];
}

/** grass mottled texture tile, same layout as the old canvas pattern */
export function grassTileData(kind: string): TileData {
  const cell = 6;
  const { t, fill } = makeTile(cell * 2, cell * 2);
  const base = greenBase(kind);
  fill(0, 0, cell * 2, cell * 2, base);
  for (let ry = 0; ry < 2; ry++)
    for (let rx = 0; rx < 2; rx++) {
      const seed = ry * 13 + rx * 7 + 5;
      const d = Math.round((rand(seed) - 0.45) * 34);
      fill(
        rx * cell, ry * cell, cell, cell,
        [
          base[0] + d,
          base[1] + d + Math.round((rand(seed + 1) - 0.5) * 10),
          base[2] + d - Math.round((rand(seed + 2) - 0.5) * 14),
        ],
      );
      for (let k = 0; k < 6; k++) {
        const sd = seed * 37 + k;
        const bx = rand(sd) * cell,
          by = rand(sd + 11) * cell;
        const bw = 2 + rand(sd + 21) * cell * 0.22;
        const bh = 2 + rand(sd + 31) * cell * 0.22;
        const dd = Math.round((rand(sd + 41) - 0.5) * 46);
        fill(
          rx * cell + bx, ry * cell + by, bw, bh,
          [base[0] + dd, base[1] + dd + 6, base[2] + dd - 8],
        );
      }
    }
  return t;
}

/** stone tile texture (sett / paving_stones / cobblestone), or null */
export function stoneTileData(surface: string): TileData | null {
  const base0 = surface.split(";")[0].split(":")[0];
  if (base0 !== "paving_stones" && base0 !== "sett" && base0 !== "cobblestone")
    return null;
  const isSett = base0 !== "paving_stones";
  const size = isSett ? 5 : 8;
  const gap = 1;
  const cell = size + gap;
  const { t, fill } = makeTile(cell * 2, cell * 2);
  const base = isSett ? 110 : 128;
  fill(0, 0, cell * 2, cell * 2, [base - 22, base - 22, base - 22]);
  const drawStone = (
    x: number, y: number, w: number, h: number, seed: number,
  ): void => {
    const jitter = isSett ? 22 : 9;
    const v = base + Math.round((rand(seed) - 0.5) * jitter * 2);
    let px0 = x, py0 = y, pw = w, ph = h;
    if (isSett) {
      px0 += (rand(seed + 1) - 0.5) * gap * 2;
      py0 += (rand(seed + 2) - 0.5) * gap * 2;
      pw *= 0.86 + rand(seed + 3) * 0.26;
      ph *= 0.86 + rand(seed + 4) * 0.26;
    }
    fill(Math.round(px0), Math.round(py0), Math.max(2, Math.round(pw)), Math.max(2, Math.round(ph)), [
      v, v, v + (isSett ? -4 : 0),
    ]);
  };
  if (isSett) {
    for (let ry = 0; ry < 2; ry++)
      for (let rx = -1; rx < 3; rx++) {
        const x = rx * cell + (ry % 2 === 1 ? cell / 2 : 0);
        drawStone(x + gap / 2, ry * cell + gap / 2, size, size, ry * 31 + rx * 7 + 13);
      }
  } else {
    for (let ry = 0; ry < 2; ry++)
      for (let rx = 0; rx < 2; rx++)
        drawStone(rx * cell + gap / 2, ry * cell + gap / 2, size, size, ry * 17 + rx * 5 + 3);
  }
  return t;
}

// ---------------- renderer ----------------
// Scene-graph renderer: geometry is recorded once per zoom band into a loose
// quadtree (SceneGraph); each frame only frustum-visible leaves are drawn.
// Paint order (the 2D renderer's draw order) is preserved through the depth
// buffer: every recorded command gets a unique z = order/total.

export type FillSpec =
  | { color: RGBA }
  | { pattern: { key: string; w: number; h: number } };

export interface StrokeOpts {
  color: RGBA;
  /** gradient across the width: +normal side (defaults to color) */
  colorPos?: RGBA;
  dash?: [number, number];
  cap?: "round" | "butt";
}

interface Cmd {
  start: number;
  count: number;
  pattern: { key: string; w: number; h: number } | null;
  clip: number | null;
  mask: { outer: Pt[][]; holes: Pt[][] } | null;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface DrawRange {
  start: number;
  count: number;
  pattern: string | null;
  clip: number | null;
  mask: MaskRange | null;
}

interface MaskRange {
  outer: { start: number; count: number };
  holes: { start: number; count: number };
}

const MAX_ITEMS_PER_LEAF = 48;
const MIN_LEAF_HALF = 256; // world units

class SceneNode {
  children: SceneNode[] | null = null;
  items: Cmd[] = [];
  // GPU data (every node with items gets buffers, internal nodes included)
  vao: WebGLVertexArrayObject | null = null;
  buf: WebGLBuffer | null = null;
  lineVao: WebGLVertexArrayObject | null = null;
  lineBuf: WebGLBuffer | null = null;
  lineVerts = 0;
  ranges: DrawRange[] = [];
  clipMasks = new Map<number, MaskRange>();
  /** CPU copy of the vertex data, only retained when SceneGraph.keepData
   *  (test hook) — otherwise the GPU buffer is the only copy */
  data: Float32Array | null = null;
  // loose bounds (cell expanded by its half size on each side)
  constructor(
    public cx: number,
    public cy: number,
    public half: number,
  ) {}
  loose(): [number, number, number, number] {
    return [this.cx - 2 * this.half, this.cy - 2 * this.half, this.cx + 2 * this.half, this.cy + 2 * this.half];
  }
  contains(x0: number, y0: number, x1: number, y1: number): boolean {
    const [lx0, ly0, lx1, ly1] = this.loose();
    return x0 >= lx0 && y0 >= ly0 && x1 <= lx1 && y1 <= ly1;
  }
  insert(cmd: Cmd, root: SceneNode): void {
    let node: SceneNode = root;
    for (;;) {
      if (node.children) {
        const [x0, y0, x1, y1] = [cmd.minX, cmd.minY, cmd.maxX, cmd.maxY];
        const child = node.children.find((c) => c.contains(x0, y0, x1, y1));
        if (child) {
          node = child;
          continue;
        }
      }
      node.items.push(cmd);
      if (
        !node.children &&
        node.items.length > MAX_ITEMS_PER_LEAF &&
        node.half > MIN_LEAF_HALF
      ) {
        const h = node.half / 2;
        node.children = [
          new SceneNode(node.cx - h, node.cy - h, h),
          new SceneNode(node.cx + h, node.cy - h, h),
          new SceneNode(node.cx - h, node.cy + h, h),
          new SceneNode(node.cx + h, node.cy + h, h),
        ];
        const rest: Cmd[] = [];
        for (const it of node.items) {
          const child = node.children.find((c) =>
            c.contains(it.minX, it.minY, it.maxX, it.maxY),
          );
          if (child) child.items.push(it);
          else rest.push(it);
        }
        node.items = rest;
      }
      return;
    }
  }
}

export class SceneGraph {
  root: SceneNode;
  totalCmds = 0;
  /** test hook: retain CPU-side vertex copies on nodes */
  static keepData = false;
  constructor(
    public gl: WebGL2RenderingContext,
    cmds: Cmd[],
    verts: Float32Array,
    clipRefs: Map<number, { outer: Pt[][]; holes: Pt[][] }>,
  ) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cmds) {
      x0 = Math.min(x0, c.minX); y0 = Math.min(y0, c.minY);
      x1 = Math.max(x1, c.maxX); y1 = Math.max(y1, c.maxY);
    }
    if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
    const pad = Math.max(x1 - x0, y1 - y0, 1) * 0.05 + 1;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const half = Math.max((x1 - x0) / 2, (y1 - y0) / 2) + pad;
    this.root = new SceneNode(cx, cy, half);
    this.totalCmds = cmds.length;
    for (const c of cmds) this.root.insert(c, this.root);
    this.uploadAll(cmds, verts, clipRefs);
  }

  private triangulateMask(
    outer: Pt[][],
    holes: Pt[][],
    data: number[],
  ): MaskRange {
    const pushRingTris = (rings: Pt[][]): { start: number; count: number } => {
      const start = data.length / 9;
      for (const ring of rings) {
        const tris = earclip(ring);
        for (let i = 0; i < tris.length; i += 3)
          for (const idx of [tris[i], tris[i + 1], tris[i + 2]]) {
            const p = ring[idx];
            data.push(p[0], p[1], 1, 1, 1, 1, 0, 0, 0);
          }
      }
      return { start, count: data.length / 9 - start };
    };
    return { outer: pushRingTris(outer), holes: pushRingTris(holes) };
  }

  private uploadAll(
    cmds: Cmd[],
    verts: Float32Array,
    clipRefs: Map<number, { outer: Pt[][]; holes: Pt[][] }>,
  ): void {
    const gl = this.gl;
    const cmdOrder = new Map<Cmd, number>();
    cmds.forEach((c, i) => cmdOrder.set(c, i));
    const walk = (node: SceneNode): void => {
      if (node.items.length > 0) {
        // 9 floats per vertex: x,y,r,g,b,a,u,v,z. z encodes paint order:
        // LATER commands get SMALLER depth so they win under LEQUAL
        // (cleared depth is 1, first command has z ~ 1).
        const data: number[] = [];
        const n = Math.max(1, this.totalCmds);
        for (const cmd of node.items) {
          const start = data.length / 9;
          const z = (this.totalCmds - cmdOrder.get(cmd)! - 0.5) / n;
          for (let i = cmd.start * 8; i < (cmd.start + cmd.count) * 8; i += 8) {
            data.push(verts[i], verts[i + 1], verts[i + 2], verts[i + 3],
              verts[i + 4], verts[i + 5], verts[i + 6], verts[i + 7], z);
          }
          const range: DrawRange = {
            start,
            count: cmd.count,
            pattern: cmd.pattern ? cmd.pattern.key : null,
            clip: cmd.clip,
            mask: null,
          };
          if (cmd.mask) range.mask = this.triangulateMask(cmd.mask.outer, cmd.mask.holes, data);
          if (cmd.clip !== null && !node.clipMasks.has(cmd.clip)) {
            const clip = clipRefs.get(cmd.clip);
            if (clip)
              node.clipMasks.set(cmd.clip, this.triangulateMask(clip.outer, clip.holes, data));
          }
          node.ranges.push(range);
        }
        const fdata = new Float32Array(data);
        if (SceneGraph.keepData) node.data = fdata;
        node.buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, node.buf);
        gl.bufferData(gl.ARRAY_BUFFER, fdata, gl.STATIC_DRAW);
        node.vao = gl.createVertexArray();
        // wireframe line buffer: 6 line-verts per triangle vertex triple
        const lineData = new Float32Array(fdata.length * 2);
        for (let i = 0; i < fdata.length; i += 27) {
          for (let e = 0; e < 3; e++) {
            const a = i + e * 9, b = i + ((e + 1) % 3) * 9;
            lineData.set(fdata.subarray(a, a + 9), (i / 27) * 6 * 9 + e * 18);
            lineData.set(fdata.subarray(b, b + 9), (i / 27) * 6 * 9 + e * 18 + 9);
          }
        }
        node.lineVerts = fdata.length / 9 * 2;
        node.lineBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, node.lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.STATIC_DRAW);
        node.lineVao = gl.createVertexArray();
      }
      if (node.children) for (const c of node.children) walk(c);
    };
    walk(this.root);
  }
}

/** frustum planes (a,b,c,d with ax+by+cz+d>=0 inside) from a column-major mvp */
function frustumPlanes(m: Float32Array): number[][] {
  const r = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = r(0), r1 = r(1), r2 = r(2), r3 = r(3);
  const combos: number[][] = [];
  for (const [a, b] of [
    [r3, r0], [r3, r1], [r3, r2],
  ] as const) {
    combos.push(a.map((v, i) => v + b[i]));
    combos.push(a.map((v, i) => v - b[i]));
  }
  return combos.map((p) => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / l, p[1] / l, p[2] / l, p[3] / l];
  });
}

/** is the z=0 AABB visible against the frustum? */
function aabbVisible(
  planes: number[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  for (const [a, b, c, d] of planes) {
    const px = a >= 0 ? x1 : x0;
    const py = b >= 0 ? y1 : y0;
    if (a * px + b * py + d < 0) return false; // z = 0
    void c;
  }
  return true;
}

const FOVY = (60 * Math.PI) / 180;

export class GlMap {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private uMvp: WebGLUniformLocation;
  private uUseTex: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private aPos: number;
  private aColor: number;
  private aUv: number;
  private aZ: number;
  /** wireframe mode: draw triangle edges as lines instead of filled */
  wireframe = false;
  private verts = new Float32Array(1 << 16);
  private vertCount = 0;
  private cmds: Cmd[] = [];
  private clipStack: { id: number; outer: Pt[][]; holes: Pt[][] }[] = [];
  private clipRefs = new Map<number, { outer: Pt[][]; holes: Pt[][] }>();
  private nextClip = 1;
  private patterns = new Map<string, WebGLTexture | null>();
  private patternMakers = new Map<string, () => TileData | null>();

  cssW = 1;
  cssH = 1;
  dpr = 1;
  /** css pixels per world unit at the target (set by setCamera) */
  s = 1;
  private mvp = new Float32Array(16);
  private eye: [number, number, number] = [0, 0, 1];
  private fwd: [number, number, number] = [0, 0, -1];
  private right: [number, number, number] = [1, 0, 0];
  private up: [number, number, number] = [0, 1, 0];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl)
      throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;

    const vs = `#version 300 es
in vec2 a_pos; in vec4 a_color; in vec2 a_uv; in float a_z;
uniform mat4 u_mvp;
out vec4 v_color; out vec2 v_uv;
void main() {
  vec4 p = u_mvp * vec4(a_pos, 0.0, 1.0);
  p.z = (a_z * 2.0 - 1.0) * p.w;
  gl_Position = p;
  v_color = a_color; v_uv = a_uv;
}`;
    const fs = `#version 300 es
precision mediump float;
in vec4 v_color; in vec2 v_uv;
uniform float u_useTex; uniform sampler2D u_tex;
out vec4 frag;
void main() {
  vec4 c = v_color;
  if (u_useTex > 0.5) c = texture(u_tex, v_uv) * v_color;
  frag = c;
}`;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error("shader: " + gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error("link: " + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uMvp = gl.getUniformLocation(prog, "u_mvp")!;
    this.uUseTex = gl.getUniformLocation(prog, "u_useTex")!;
    this.uTex = gl.getUniformLocation(prog, "u_tex")!;
    this.aPos = gl.getAttribLocation(prog, "a_pos");
    this.aColor = gl.getAttribLocation(prog, "a_color");
    this.aUv = gl.getAttribLocation(prog, "a_uv");
    this.aZ = gl.getAttribLocation(prog, "a_z");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  registerPattern(key: string, make: () => TileData | null): void {
    this.patternMakers.set(key, make);
  }

  private patternTex(key: string): WebGLTexture | null {
    if (!this.patterns.has(key)) {
      const make = this.patternMakers.get(key);
      let tex: WebGLTexture | null = null;
      const tile = make ? make() : null;
      if (tile) {
        const gl = this.gl;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tile.w, tile.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, tile.data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }
      this.patterns.set(key, tex);
    }
    return this.patterns.get(key) ?? null;
  }

  clearPatternCache(): void {
    const gl = this.gl;
    for (const t of this.patterns.values()) if (t) gl.deleteTexture(t);
    this.patterns.clear();
  }

  setViewState(w: number, h: number, dpr: number): void {
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
  }

  /**
   * Camera from the classic view state. scale = css px per degree longitude;
   * the camera distance is chosen so that at pitch 0 the screen mapping is
   * exactly (world - target) * scale/2000 + center — identical to the flat
   * 2D renderer.
   */
  setCamera(
    tx: number,
    ty: number,
    scale: number,
    heading: number,
    pitch: number,
  ): void {
    this.s = scale / 2000;
    const dist = this.cssH / (2 * Math.tan(FOVY / 2) * this.s);
    const sp = Math.sin(pitch),
      cp = Math.cos(pitch);
    this.eye = [
      tx + dist * sp * Math.sin(heading),
      ty - dist * sp * Math.cos(heading),
      dist * cp,
    ];
    const target: [number, number, number] = [tx, ty, 0];
    const upHint: [number, number, number] = [-Math.sin(heading), Math.cos(heading), 0];
    this.fwd = norm3([
      target[0] - this.eye[0],
      target[1] - this.eye[1],
      target[2] - this.eye[2],
    ]);
    this.right = norm3(cross3(this.fwd, upHint));
    this.up = cross3(this.right, this.fwd);
    const view = mat4LookAt(this.eye, target, upHint);
    const proj = mat4Perspective(
      FOVY,
      (this.cssW * this.dpr) / Math.max(1, this.cssH * this.dpr),
      Math.max(0.01, dist * 0.02),
      dist * 100 + 1e7,
    );
    this.mvp = mat4Mul(proj, view);
  }

  /** camera basis for pan/zoom math (ground-projected up) */
  groundRight(): Pt {
    return [this.right[0], this.right[1]];
  }
  groundUp(): Pt {
    const l = Math.hypot(this.up[0], this.up[1]);
    return l > 1e-9 ? [this.up[0] / l, this.up[1] / l] : [0, 1];
  }

  /** unproject a css-pixel screen position onto the ground plane z=0 */
  screenToWorld(mx: number, my: number): Pt | null {
    const W = this.cssW * this.dpr,
      H = this.cssH * this.dpr;
    const ndcX = ((mx * this.dpr) / W) * 2 - 1;
    const ndcY = 1 - ((my * this.dpr) / H) * 2;
    const tanY = Math.tan(FOVY / 2);
    const tanX = tanY * (W / H);
    const dir = norm3([
      this.fwd[0] + this.right[0] * ndcX * tanX + this.up[0] * ndcY * tanY,
      this.fwd[1] + this.right[1] * ndcX * tanX + this.up[1] * ndcY * tanY,
      this.fwd[2] + this.right[2] * ndcX * tanX + this.up[2] * ndcY * tanY,
    ]);
    if (dir[2] >= -1e-9) return null;
    const t = -this.eye[2] / dir[2];
    return [this.eye[0] + dir[0] * t, this.eye[1] + dir[1] * t];
  }

  worldToScreen(p: Pt): Pt {
    const m = this.mvp;
    const x = p[0], y = p[1];
    const cx = m[0] * x + m[4] * y + m[12];
    const cy = m[1] * x + m[5] * y + m[13];
    const cw = m[3] * x + m[7] * y + m[15];
    if (cw <= 0) return [NaN, NaN];
    return [((cx / cw) * 0.5 + 0.5) * this.cssW, (0.5 - (cy / cw) * 0.5) * this.cssH];
  }

  // ---- frame + recording ----

  /** clear + viewport for a new frame (call every frame) */
  beginFrame(): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.setViewState(this.canvas.clientWidth, this.canvas.clientHeight, this.dpr || 1);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0x22 / 255, 0x22 / 255, 0x26 / 255, 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** start recording geometry (scene-graph build) */
  beginRecord(): void {
    this.vertCount = 0;
    this.cmds = [];
    this.clipStack = [];
    this.clipRefs.clear();
    this.nextClip = 1;
  }

  private pushVert(x: number, y: number, c: RGBA, u: number, v: number): void {
    // recording buffer is 8 floats/vertex; the z (paint order) is baked per
    // command as a 9th float when the scene graph uploads node buffers
    if ((this.vertCount + 1) * 8 > this.verts.length) {
      const nv = new Float32Array(this.verts.length * 2);
      nv.set(this.verts);
      this.verts = nv;
    }
    const o = this.vertCount * 8;
    this.verts[o] = x;
    this.verts[o + 1] = y;
    this.verts[o + 2] = c[0];
    this.verts[o + 3] = c[1];
    this.verts[o + 4] = c[2];
    this.verts[o + 5] = c[3];
    this.verts[o + 6] = u;
    this.verts[o + 7] = v;
    this.vertCount++;
    const cmd = this.cmds[this.cmds.length - 1];
    if (cmd) {
      if (x < cmd.minX) cmd.minX = x;
      if (y < cmd.minY) cmd.minY = y;
      if (x > cmd.maxX) cmd.maxX = x;
      if (y > cmd.maxY) cmd.maxY = y;
    }
  }

  private beginCmd(): Cmd {
    const top = this.clipStack[this.clipStack.length - 1];
    const cmd: Cmd = {
      start: this.vertCount,
      count: 0,
      pattern: null,
      clip: top ? top.id : null,
      mask: null,
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    this.cmds.push(cmd);
    return cmd;
  }
  private endCmd(cmd: Cmd): void {
    cmd.count = this.vertCount - cmd.start;
    if (cmd.count === 0) this.cmds.pop();
  }

  private uvFor(pattern: { key: string; w: number; h: number }, x: number, y: number): [number, number] {
    // tile size in world units = tile px / (px per world); anchored to the
    // world origin modulo one tile (same registration as the old canvas
    // pattern anchored at lon/lat 0)
    const tw = pattern.w / this.s,
      th = pattern.h / this.s;
    return [x / tw, -y / th];
  }

  private tri(
    cmd: Cmd,
    a: Pt, b: Pt, c: Pt,
    ca: RGBA, cb: RGBA, cc: RGBA,
    fill: FillSpec,
  ): void {
    const fillP = (fill as { pattern?: { key: string; w: number; h: number } }).pattern;
    const push = (p: Pt, col: RGBA) => {
      let u = 0, v = 0;
      if (fillP) [u, v] = this.uvFor(fillP, p[0], p[1]);
      this.pushVert(p[0], p[1], col, u, v);
    };
    if (fillP) {
      push(a, [1, 1, 1, 1]);
      push(b, [1, 1, 1, 1]);
      push(c, [1, 1, 1, 1]);
    } else {
      push(a, ca);
      push(b, cb);
      push(c, cc);
    }
  }

  /** filled polygon(s) with optional holes (even-odd via stencil) */
  fillPolygon(outer: Pt[][], holes: Pt[][], fill: FillSpec): void {
    const cmd = this.beginCmd();
    cmd.pattern = (fill as { pattern?: { key: string; w: number; h: number } }).pattern ?? null;
    if (holes.length > 0) cmd.mask = { outer, holes };
    const col = (fill as { color?: RGBA }).color ?? [1, 1, 1, 1];
    for (const ring of outer) {
      const tris = earclip(ring);
      for (let i = 0; i < tris.length; i += 3)
        this.tri(
          cmd,
          ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]],
          col, col, col,
          fill,
        );
    }
    this.endCmd(cmd);
  }

  private emitStrip(
    cmd: Cmd,
    pts: Pt[],
    half: number,
    color: RGBA,
    colorPos: RGBA,
    cap: "round" | "butt",
    fill: FillSpec,
  ): void {
    const n = pts.length;
    if (n < 2) return;
    const segN: Pt[] = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0],
        dy = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(dx, dy);
      segN.push(l > 0 ? [-dy / l, dx / l] : [0, 0]);
    }
    const off: Pt[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) off.push(segN[0]);
      else if (i === n - 1) off.push(segN[n - 2]);
      else {
        let nx = segN[i - 1][0] + segN[i][0],
          ny = segN[i - 1][1] + segN[i][1];
        const l = Math.hypot(nx, ny);
        if (l < 1e-9) {
          off.push(segN[i - 1]);
          continue;
        }
        nx /= l;
        ny /= l;
        const cosHalf = Math.max(0.25, nx * segN[i - 1][0] + ny * segN[i - 1][1]);
        const scale = Math.min(4, 1 / cosHalf);
        off.push([nx * scale, ny * scale]);
      }
    }
    const L = pts.map((p, i) => [p[0] + off[i][0] * half, p[1] + off[i][1] * half] as Pt);
    const R = pts.map((p, i) => [p[0] - off[i][0] * half, p[1] - off[i][1] * half] as Pt);
    for (let i = 1; i < n; i++) {
      this.tri(cmd, L[i - 1], L[i], R[i], colorPos, colorPos, color, fill);
      this.tri(cmd, L[i - 1], R[i], R[i - 1], colorPos, color, color, fill);
    }
    if (cap === "round") {
      const K = 6;
      const capFan = (center: Pt, bulge: Pt, nrm: Pt) => {
        let prev: Pt | null = null;
        for (let k = 0; k <= K; k++) {
          const a = (k / K) * Math.PI - Math.PI / 2;
          const p: Pt = [
            center[0] + (bulge[0] * Math.cos(a) + nrm[0] * Math.sin(a)) * half,
            center[1] + (bulge[1] * Math.cos(a) + nrm[1] * Math.sin(a)) * half,
          ];
          if (prev) this.tri(cmd, center, prev, p, color, color, color, fill);
          prev = p;
        }
      };
      const d0 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
      const l0 = Math.hypot(d0[0], d0[1]) || 1;
      const d1 = [pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]];
      const l1 = Math.hypot(d1[0], d1[1]) || 1;
      capFan(pts[0], [-d0[0] / l0, -d0[1] / l0], off[0]);
      capFan(pts[n - 1], [d1[0] / l1, d1[1] / l1], off[n - 1]);
    }
  }

  /** stroked polyline (world units width), optional dash pattern in world
   *  units, optional across-width color gradient */
  stroke(pts: Pt[], width: number, o: StrokeOpts): void {
    if (pts.length < 2 || width <= 0) return;
    const cmd = this.beginCmd();
    const fill: FillSpec = { color: o.color };
    const colorPos = o.colorPos ?? o.color;
    const half = width / 2;
    if (o.dash && o.dash[0] > 0) {
      const [on, off] = o.dash;
      let cur: Pt[] = [pts[0]];
      let inDash = true;
      let dashLeft = on;
      const flushSeg = () => {
        if (cur.length >= 2)
          this.emitStrip(cmd, cur, half, o.color, colorPos, o.cap ?? "round", fill);
        cur = [];
      };
      for (let i = 1; i < pts.length; i++) {
        let a = pts[i - 1],
          b = pts[i];
        let segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        while (segLen > 1e-12) {
          const step = Math.min(segLen, dashLeft);
          const t = step / segLen;
          const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (inDash) cur.push(p);
          dashLeft -= step;
          segLen -= step;
          a = p;
          if (dashLeft <= 1e-12) {
            if (inDash) {
              flushSeg();
              inDash = false;
              dashLeft = off;
            } else {
              inDash = true;
              dashLeft = on;
              cur = [p];
            }
          }
        }
      }
      flushSeg();
    } else {
      this.emitStrip(cmd, pts, half, o.color, colorPos, o.cap ?? "round", fill);
    }
    this.endCmd(cmd);
  }

  /** independent short segments (e.g. zebra stripes), butt caps */
  strokeSegments(segs: Pt[][], width: number, color: RGBA): void {
    if (segs.length === 0) return;
    const cmd = this.beginCmd();
    const fill: FillSpec = { color };
    const half = width / 2;
    for (const s of segs) {
      if (s.length < 2) continue;
      this.emitStrip(cmd, s, half, color, color, "butt", fill);
    }
    this.endCmd(cmd);
  }

  /** filled circle (triangle fan) */
  circle(c: Pt, r: number, color: RGBA): void {
    if (r <= 0) return;
    const cmd = this.beginCmd();
    const fill: FillSpec = { color };
    const segs = Math.max(10, Math.min(40, Math.round(r * this.s * 1.5)));
    let prev: Pt | null = null;
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const p: Pt = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
      if (prev) this.tri(cmd, c, prev, p, color, color, color, fill);
      prev = p;
    }
    this.endCmd(cmd);
  }

  /** radial-gradient halo: concentric ring fan with per-stop colors */
  halo(c: Pt, r: number, stops: [number, RGBA][]): void {
    if (r <= 0 || stops.length === 0) return;
    const cmd = this.beginCmd();
    const fill: FillSpec = { color: [1, 1, 1, 1] };
    const segs = 24;
    const sorted = [...stops].sort((a, b) => a[0] - b[0]);
    let prevRing: { p: Pt; col: RGBA }[] | null = null;
    for (const [t, col] of sorted) {
      const rr = Math.max(0, Math.min(1, t)) * r;
      const ring: { p: Pt; col: RGBA }[] = [];
      for (let k = 0; k <= segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        ring.push({ p: [c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)], col });
      }
      if (prevRing) {
        for (let k = 0; k < segs; k++) {
          this.tri(cmd, prevRing[k].p, prevRing[k + 1].p, ring[k + 1].p, prevRing[k].col, prevRing[k + 1].col, ring[k + 1].col, fill);
          this.tri(cmd, prevRing[k].p, ring[k + 1].p, ring[k].p, prevRing[k].col, ring[k + 1].col, ring[k].col, fill);
        }
      }
      prevRing = ring;
    }
    this.endCmd(cmd);
  }

  pushClip(outer: Pt[][], holes: Pt[][]): void {
    const id = this.nextClip++;
    this.clipStack.push({ id, outer, holes });
    this.clipRefs.set(id, { outer, holes });
  }
  popClip(): void {
    this.clipStack.pop();
  }

  /** build the persistent scene graph from the recorded frame */
  finishScene(): SceneGraph {
    return new SceneGraph(this.gl, this.cmds, this.verts.subarray(0, this.vertCount * 8), this.clipRefs);
  }

  /** draw only the frustum-visible leaves of the scene graph */
  renderScene(scene: SceneGraph): void {
    const gl = this.gl;
    if (scene.totalCmds === 0) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uMvp, false, this.mvp);
    const planes = frustumPlanes(this.mvp);
    const wire = this.wireframe;
    const setAttribs = (vao: WebGLVertexArrayObject, buf: WebGLBuffer) => {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(this.aPos);
      gl.enableVertexAttribArray(this.aColor);
      gl.enableVertexAttribArray(this.aUv);
      gl.enableVertexAttribArray(this.aZ);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 36, 0);
      gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, 36, 8);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 36, 24);
      gl.vertexAttribPointer(this.aZ, 1, gl.FLOAT, false, 36, 32);
    };
    const drawNode = (node: SceneNode): void => {
      if (node.ranges.length === 0 || !node.vao || !node.buf) return;
      if (wire) {
        // wireframe: all triangle edges of the node as one LINES draw
        if (!node.lineVao || !node.lineBuf || node.lineVerts === 0) return;
        setAttribs(node.lineVao, node.lineBuf);
        gl.uniform1f(this.uUseTex, 0);
        gl.drawArrays(gl.LINES, 0, node.lineVerts);
        gl.bindVertexArray(null);
        return;
      }
      setAttribs(node.vao, node.buf);
      const drawnClips = new Set<number>();
      const ranges = node.ranges;
      let i = 0;
      while (i < ranges.length) {
        const range = ranges[i];
        if (range.clip === null && range.mask === null) {
          // merge adjacent plain ranges with the same pattern into one draw
          let end = range.start + range.count;
          let j = i + 1;
          while (
            j < ranges.length &&
            ranges[j].clip === null &&
            ranges[j].mask === null &&
            ranges[j].pattern === range.pattern &&
            ranges[j].start === end
          ) {
            end += ranges[j].count;
            j++;
          }
          if (range.pattern) {
            const tex = this.patternTex(range.pattern);
            if (tex) {
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.uniform1i(this.uTex, 0);
              gl.uniform1f(this.uUseTex, 1);
            } else {
              gl.uniform1f(this.uUseTex, 0);
            }
          } else {
            gl.uniform1f(this.uUseTex, 0);
          }
          gl.drawArrays(gl.TRIANGLES, range.start, end - range.start);
          i = j;
          continue;
        }
        let stenciled = false;
        if (range.clip !== null) {
          const mask = node.clipMasks.get(range.clip);
          if (mask) {
            if (!drawnClips.has(range.clip)) {
              gl.clearStencil(0);
              gl.clear(gl.STENCIL_BUFFER_BIT);
              this.drawMaskRange(mask, gl.INCR, gl.DECR);
              drawnClips.add(range.clip);
            }
            gl.enable(gl.STENCIL_TEST);
            gl.stencilFunc(gl.EQUAL, 1, 0xff);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
            stenciled = true;
          }
        }
        if (range.mask !== null) {
          gl.disable(gl.STENCIL_TEST);
          gl.clearStencil(0);
          gl.clear(gl.STENCIL_BUFFER_BIT);
          this.drawMaskRange(range.mask, gl.INCR, gl.DECR);
          gl.enable(gl.STENCIL_TEST);
          gl.stencilFunc(gl.EQUAL, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          stenciled = true;
        }
        if (range.pattern) {
          const tex = this.patternTex(range.pattern);
          if (tex) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(this.uTex, 0);
            gl.uniform1f(this.uUseTex, 1);
          } else {
            gl.uniform1f(this.uUseTex, 0);
          }
        } else {
          gl.uniform1f(this.uUseTex, 0);
        }
        gl.drawArrays(gl.TRIANGLES, range.start, range.count);
        if (stenciled) gl.disable(gl.STENCIL_TEST);
        i++;
      }
      gl.bindVertexArray(null);
    };
    const walk = (node: SceneNode): void => {
      const [x0, y0, x1, y1] = node.loose();
      if (!aabbVisible(planes, x0, y0, x1, y1)) return;
      drawNode(node);
      if (node.children) for (const c of node.children) walk(c);
    };
    walk(scene.root);
    gl.disable(gl.STENCIL_TEST);
  }

  private drawMaskRange(
    mask: MaskRange,
    outerOp: number,
    holeOp: number,
  ): void {
    const gl = this.gl;
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, outerOp);
    gl.drawArrays(gl.TRIANGLES, mask.outer.start, mask.outer.count);
    if (mask.holes.count > 0) {
      gl.stencilOp(gl.KEEP, gl.KEEP, holeOp);
      gl.drawArrays(gl.TRIANGLES, mask.holes.start, mask.holes.count);
    }
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
  }
}
