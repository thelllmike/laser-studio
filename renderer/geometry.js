// Text -> polylines (mm), fill hatching, and G-code generation.
// Coordinates are millimetres with Y pointing up (machine convention).

const Geometry = (() => {
  const CURVE_STEP_MM = 0.15;

  function flattenCommands(commands) {
    const polys = [];
    let cur = null;
    let x = 0, y = 0;
    const push = (px, py) => { cur.push({ x: px, y: py }); x = px; y = py; };
    for (const c of commands) {
      if (c.type === 'M') {
        if (cur && cur.length > 1) polys.push(cur);
        cur = [{ x: c.x, y: c.y }];
        x = c.x; y = c.y;
      } else if (c.type === 'L') {
        push(c.x, c.y);
      } else if (c.type === 'Q') {
        const n = segments(x, y, c.x1, c.y1, c.x, c.y);
        const x0 = x, y0 = y;
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
        }
      } else if (c.type === 'C') {
        const n = segments(x, y, c.x1, c.y1, c.x2, c.y2, c.x, c.y);
        const x0 = x, y0 = y;
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(
            u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y
          );
        }
      } else if (c.type === 'Z') {
        if (cur && cur.length > 1) {
          const s = cur[0], e = cur[cur.length - 1];
          if (Math.hypot(s.x - e.x, s.y - e.y) > 1e-6) cur.push({ x: s.x, y: s.y });
          polys.push(cur);
          x = s.x; y = s.y;
        }
        cur = null;
      }
    }
    if (cur && cur.length > 1) polys.push(cur);
    return polys;
  }

  // Number of straight segments for a curve, based on its control-polygon length.
  function segments(...pts) {
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    return Math.max(2, Math.min(64, Math.ceil(len / CURVE_STEP_MM)));
  }

  /** Lay out (possibly multi-line) text. Height = capital-letter height in mm. Returns polylines with bbox at (0,0). */
  function textToPolylines(font, text, heightMm) {
    const capH = (font.tables.os2 && font.tables.os2.sCapHeight) || font.unitsPerEm * 0.7;
    const fontSize = (heightMm * font.unitsPerEm) / capH;
    const lineGap = heightMm * 1.6;
    let polys = [];
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      const path = font.getPath(line, 0, i * lineGap, fontSize);
      polys.push(...flattenCommands(path.commands));
    });
    // opentype uses Y-down; flip to Y-up.
    polys = polys.map((p) => p.map((pt) => ({ x: pt.x, y: -pt.y })));
    const bb = bbox(polys);
    if (!bb) return { polys: [], width: 0, height: 0 };
    polys = polys.map((p) => p.map((pt) => ({ x: pt.x - bb.minX, y: pt.y - bb.minY })));
    return { polys, width: bb.maxX - bb.minX, height: bb.maxY - bb.minY };
  }

  function bbox(polys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polys) for (const pt of p) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  /** Even-odd scanline fill. Returns rows of [x1, x2] segments, alternating direction (zig-zag). */
  function hatch(polys, interval) {
    const bb = bbox(polys);
    if (!bb || interval <= 0) return [];
    const edges = [];
    for (const p of polys) {
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        if (a.y !== b.y) edges.push(a.y < b.y ? [a, b] : [b, a]);
      }
    }
    const rows = [];
    let flip = false;
    for (let y = bb.minY + interval / 2; y < bb.maxY; y += interval) {
      const xs = [];
      for (const [a, b] of edges) {
        if (y >= a.y && y < b.y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      if (xs.length < 2) continue;
      xs.sort((m, n) => m - n);
      const segs = [];
      for (let i = 0; i + 1 < xs.length; i += 2) segs.push([xs[i], xs[i + 1]]);
      if (flip) segs.reverse().forEach((s) => s.reverse());
      rows.push({ y, segs });
      flip = !flip;
    }
    return rows;
  }

  // 2D affine matrices as [a, b, c, d, e, f]:  x' = a·x + c·y + e,  y' = b·x + d·y + f
  const mat = {
    mul: (p, c) => [
      p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
      p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
      p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5],
    ],
    apply: (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }),
    invert: (m) => {
      const det = m[0] * m[3] - m[1] * m[2];
      return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
    },
    translate: (x, y) => [1, 0, 0, 1, x, y],
  };

  /** Corners (mm) of an image whose pixel->mm transform is im.m. */
  function imageCorners(im) {
    return [[0, 0], [im.bw, 0], [im.bw, im.bh], [0, im.bh]].map(([u, v]) => mat.apply(im.m, u, v));
  }

  const DITHER_KERNELS = {
    floyd: [16, [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]],
    jarvis: [48, [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]]],
    stucki: [42, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]]],
    atkinson: [8, [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]],
  };

  /**
   * Resample an image onto the laser's line grid and convert it to burn levels (0 = off … 1 = full power).
   * Returns { minX, maxY, cols, rows, interval, level: Float32Array }.
   */
  function rasterize(im, interval, dither) {
    const bb = bbox([imageCorners(im)]);
    const cols = Math.max(1, Math.round((bb.maxX - bb.minX) / interval));
    const rows = Math.max(1, Math.round((bb.maxY - bb.minY) / interval));
    const inv = mat.invert(im.m);
    const pxSize = Math.sqrt(Math.abs(im.m[0] * im.m[3] - im.m[1] * im.m[2]));
    const ss = Math.max(1, Math.min(4, Math.ceil(interval / pxSize))); // supersample when downscaling
    const g = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const x = bb.minX + (c + (sx + 0.5) / ss) * interval;
            const y = bb.maxY - (r + (sy + 0.5) / ss) * interval;
            const u = Math.floor(inv[0] * x + inv[2] * y + inv[4]);
            const v = Math.floor(inv[1] * x + inv[3] * y + inv[5]);
            sum += u >= 0 && v >= 0 && u < im.bw && v < im.bh ? im.gray[v * im.bw + u] : 1;
          }
        }
        g[r * cols + c] = sum / (ss * ss);
      }
    }

    const level = new Float32Array(cols * rows);
    if (dither === 'grayscale') {
      for (let i = 0; i < g.length; i++) level[i] = g[i] > 0.98 ? 0 : 1 - g[i];
    } else if (dither === 'threshold') {
      for (let i = 0; i < g.length; i++) level[i] = g[i] < 0.5 ? 1 : 0;
    } else {
      const [div, kernel] = DITHER_KERNELS[dither] || DITHER_KERNELS.stucki;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const on = g[i] < 0.5;
          level[i] = on ? 1 : 0;
          const err = g[i] - (on ? 0 : 1);
          if (err === 0) continue;
          for (const [dx, dy, w] of kernel) {
            const cc = c + dx, rr = r + dy;
            if (cc >= 0 && cc < cols && rr < rows) g[rr * cols + cc] += (err * w) / div;
          }
        }
      }
    }
    return { minX: bb.minX, maxY: bb.maxY, cols, rows, interval, level };
  }

  const f = (n) => (Math.abs(n) < 0.0005 ? '0' : n.toFixed(3).replace(/\.?0+$/, ''));

  /**
   * Scanning offset, matching LightBurn's table: { shift, initial } in mm for a speed (mm/min).
   * `shift` = how far EACH scan line is moved against its direction of travel (LightBurn: enter half the
   * measured gap between left-going and right-going lines). `initial` moves the whole engraving
   * left/right. Linear between rows and extended linearly beyond them; a single row scales with speed
   * (the error comes from a fixed time delay, so it grows in proportion to speed).
   */
  function scanOffsets(rows, speed) {
    const pts = (rows || []).filter((r) => r.speed > 0).sort((a, b) => a.speed - b.speed);
    if (!pts.length) return { shift: 0, initial: 0 };
    const at = (key) => {
      if (pts.length === 1) return ((pts[0][key] || 0) * speed) / pts[0].speed;
      let i = pts.findIndex((p) => p.speed >= speed);
      if (i <= 0) i = i === 0 ? 1 : pts.length - 1; // extend the first or last segment
      const a = pts[i - 1], b = pts[i];
      return (a[key] || 0) + (((b[key] || 0) - (a[key] || 0)) * (speed - a.speed)) / (b.speed - a.speed);
    };
    return { shift: Math.max(0, at('shift')), initial: at('initial') };
  }

  /**
   * Build a G-code job.
   * items: [{ polys (absolute mm), mode, interval, power (%), minPower (%), speed, passes, air }]
   * opts: { maxS, scanOffset: { enabled, rows }, airCmd }
   * Uses M4 dynamic laser power (GRBL laser mode $32=1): laser is off during G0 moves.
   */
  function buildGcode(items, { maxS, scanOffset, airCmd = 'M8' }) {
    const out = ['; Laser Studio job', 'G21 ; mm', 'G90 ; absolute', 'M5', 'M4 S0'];
    const pct = (p) => Math.max(0, Math.min(100, p || 0)) / 100;
    for (const it of items) {
      const s = Math.round(pct(it.power) * maxS);
      const minS = Math.min(s, Math.round(pct(it.minPower) * maxS));
      const feed = Math.round(it.speed);
      // Each scan line is moved back against its direction of travel by `shift`, so both directions meet.
      const off = scanOffset?.enabled ? scanOffsets(scanOffset.rows, feed) : { shift: 0, initial: 0 };
      if (it.air) out.push(`${airCmd} ; air assist on`);
      for (let pass = 1; pass <= it.passes; pass++) {
        out.push(`; ${it.label} – ${it.mode}, pass ${pass}/${it.passes}`);
        if (it.mode === 'image') {
          for (const im of it.images) rasterGcode(out, rasterize(im, it.interval, it.dither), minS, s, feed, off);
        } else if (it.mode === 'fill') {
          for (const row of hatch(it.polys, it.interval)) {
            for (const [x1, x2] of row.segs) {
              const d = Math.sign(x2 - x1) * off.shift - off.initial;
              out.push(`G0 X${f(x1 - d)} Y${f(row.y)}`);
              out.push(`G1 X${f(x2 - d)} S${s} F${feed}`);
            }
          }
        } else {
          for (const p of it.polys) {
            out.push(`G0 X${f(p[0].x)} Y${f(p[0].y)}`);
            out.push(`G1 X${f(p[1].x)} Y${f(p[1].y)} S${s} F${feed}`);
            for (let i = 2; i < p.length; i++) out.push(`G1 X${f(p[i].x)} Y${f(p[i].y)}`);
          }
        }
      }
      if (it.air) out.push('M9 ; air assist off');
    }
    out.push('M5 ; laser off', 'G0 S0');
    return out;
  }

  // Zig-zag raster: one G0 to the start of each burn run, one G1 across it.
  // Grey levels map onto minS…maxS; `off` is the scanning-offset correction for this speed.
  function rasterGcode(out, ras, minS, maxS, feed, off = { shift: 0, initial: 0 }) {
    const { cols, rows, interval, level } = ras;
    let forward = true;
    for (let r = 0; r < rows; r++) {
      const runs = [];
      let c = 0;
      while (c < cols) {
        const q = Math.round(level[r * cols + c] * 100);
        if (!q) { c++; continue; }
        let e = c + 1;
        while (e < cols && Math.round(level[r * cols + e] * 100) === q) e++;
        runs.push([c, e, q]);
        c = e;
      }
      if (!runs.length) continue;
      const y = ras.maxY - (r + 0.5) * interval;
      const d = (forward ? off.shift : -off.shift) - off.initial;
      if (!forward) runs.reverse();
      let first = true;
      for (const [c0, c1, q] of runs) {
        const xa = ras.minX + (forward ? c0 : c1) * interval - d;
        const xb = ras.minX + (forward ? c1 : c0) * interval - d;
        out.push(first ? `G0 X${f(xa)} Y${f(y)}` : `G0 X${f(xa)}`);
        out.push(`G1 X${f(xb)} S${Math.round(minS + (q / 100) * (maxS - minS))}${first ? ` F${feed}` : ''}`);
        first = false;
      }
      forward = !forward;
    }
  }

  /**
   * Bounding-box frame. s = 0 keeps the laser off; s > 0 traces it with a faint visible beam (M3 constant power).
   * The laser is only switched on after the travel move to the first corner.
   */
  function frameGcode(bb, feed, s = 0) {
    return [
      'G21', 'G90', 'M5',
      `G0 X${f(bb.minX)} Y${f(bb.minY)}`,
      ...(s > 0 ? [`M3 S${s}`] : []),
      `G1 X${f(bb.maxX)} Y${f(bb.minY)} S${s} F${feed}`,
      `G1 X${f(bb.maxX)} Y${f(bb.maxY)}`,
      `G1 X${f(bb.minX)} Y${f(bb.maxY)}`,
      `G1 X${f(bb.minX)} Y${f(bb.minY)}`,
      'M5', 'S0',
    ];
  }

  return { textToPolylines, bbox, hatch, buildGcode, frameGcode, mat, imageCorners, rasterize, scanOffsets };
})();
