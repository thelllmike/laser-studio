// Import LightBurn project files (.lbrn2, and the older .lbrn).
// Produces a "project" design object: layers of polylines / images in mm, Y up, relative to the design's bottom-left.

const LightBurn = (() => {
  const { mul, apply } = Geometry.mat;
  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const VERT_RE = new RegExp(`V(${NUM})\\s+(${NUM})([^V]*)`, 'g');
  const C0_RE = new RegExp(`c0x(${NUM})c0y(${NUM})`);
  const C1_RE = new RegExp(`c1x(${NUM})c1y(${NUM})`);
  const IDENTITY = [1, 0, 0, 1, 0, 0];

  const child = (el, name) => [...el.children].find((c) => c.nodeName === name) || null;
  const num = (el, name, fallback = 0) => {
    const v = parseFloat(el.getAttribute(name));
    return Number.isFinite(v) ? v : fallback;
  };

  function parseVertList(text) {
    const out = [];
    for (const m of text.matchAll(VERT_RE)) {
      const v = { x: +m[1], y: +m[2] };
      const c0 = m[3].match(C0_RE);
      const c1 = m[3].match(C1_RE);
      if (c0) v.c0 = { x: +c0[1], y: +c0[2] };
      if (c1) v.c1 = { x: +c1[1], y: +c1[2] };
      out.push(v);
    }
    return out;
  }

  function parsePrimList(text) {
    text = text.trim();
    if (/^Line/i.test(text)) return { all: true, closed: /Closed/i.test(text) };
    const prims = [];
    for (const m of text.matchAll(/([LB])(\d+)\s+(\d+)/g)) prims.push({ t: m[1], a: +m[2], b: +m[3] });
    return { prims };
  }

  // Old .lbrn format: <V vx= vy= c0x= .../> and <P T="L|B" p0= p1=/> elements.
  function parseOldVerts(el) {
    return [...el.children].filter((c) => c.nodeName === 'V').map((c) => {
      const v = { x: num(c, 'vx'), y: num(c, 'vy') };
      if (c.hasAttribute('c0x')) v.c0 = { x: num(c, 'c0x'), y: num(c, 'c0y') };
      if (c.hasAttribute('c1x')) v.c1 = { x: num(c, 'c1x'), y: num(c, 'c1y') };
      return v;
    });
  }
  function parseOldPrims(el) {
    const prims = [...el.children].filter((c) => c.nodeName === 'P').map((c) => ({
      t: c.getAttribute('T') === 'B' ? 'B' : 'L', a: num(c, 'p0'), b: num(c, 'p1'),
    }));
    return prims.length ? { prims } : { all: true, closed: true };
  }

  function cubicTo(out, p0, p1, p2, p3) {
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const n = Math.max(2, Math.min(200, Math.ceil(len / 0.1)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push({
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      });
    }
  }

  function pathToPolys(verts, prims, m) {
    const W = verts.map((v) => ({
      p: apply(m, v.x, v.y),
      c0: v.c0 && apply(m, v.c0.x, v.c0.y),
      c1: v.c1 && apply(m, v.c1.x, v.c1.y),
    }));
    if (prims.all) {
      const poly = W.map((w) => w.p);
      if (prims.closed && poly.length > 2) poly.push({ ...poly[0] });
      return poly.length > 1 ? [poly] : [];
    }
    const polys = [];
    let cur = null;
    let last = -1;
    for (const pr of prims.prims) {
      const A = W[pr.a], B = W[pr.b];
      if (!A || !B) continue;
      if (!cur || pr.a !== last) {
        if (cur && cur.length > 1) polys.push(cur);
        cur = [A.p];
      }
      if (pr.t === 'L') cur.push(B.p);
      else cubicTo(cur, A.p, A.c0 || A.p, B.c1 || B.p, B.p);
      last = pr.b;
    }
    if (cur && cur.length > 1) polys.push(cur);
    return polys;
  }

  function parse(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const root = doc.documentElement;
    if (doc.querySelector('parsererror') || root.nodeName !== 'LightBurnProject') {
      throw new Error('This is not a LightBurn project file.');
    }

    const settings = new Map();
    for (const el of root.children) {
      if (!el.nodeName.startsWith('CutSetting')) continue;
      const s = { type: el.getAttribute('type') || 'Cut' };
      for (const c of el.children) {
        const v = c.getAttribute('Value');
        s[c.nodeName] = v !== null && v !== '' && !isNaN(v) ? Number(v) : v;
      }
      const kind = s.type === 'Image' ? 'img' : 'cut';
      settings.set(`${kind}:${s.index ?? 0}`, s);
    }

    const vertCache = new Map();
    const primCache = new Map();
    const shapes = [];
    const skipped = new Map();

    function walk(el, parentM, cutIndexOverride) {
      const type = el.getAttribute('Type');
      const xf = child(el, 'XForm');
      const local = xf ? xf.textContent.trim().split(/\s+/).map(Number) : IDENTITY;
      const m = mul(parentM, local.length === 6 && local.every(Number.isFinite) ? local : IDENTITY);
      const cutIndex = cutIndexOverride ?? num(el, 'CutIndex');

      if (type === 'Group') {
        const kids = child(el, 'Children');
        if (kids) for (const c of kids.children) if (c.nodeName === 'Shape') walk(c, m);
      } else if (type === 'Text') {
        const bp = child(el, 'BackupPath');
        if (bp) walk(bp, parentM, cutIndex);
        else skipped.set('Text without outline', (skipped.get('Text without outline') || 0) + 1);
      } else if (type === 'Path') {
        const vid = el.getAttribute('VertID');
        const pid = el.getAttribute('PrimID');
        const vl = child(el, 'VertList');
        const pl = child(el, 'PrimList');
        let verts = vl ? parseVertList(vl.textContent) : vid !== null ? vertCache.get(vid) : parseOldVerts(el);
        let prims = pl ? parsePrimList(pl.textContent) : pid !== null ? primCache.get(pid) : parseOldPrims(el);
        if (vl && vid !== null) vertCache.set(vid, verts);
        if (pl && pid !== null) primCache.set(pid, prims);
        if (!verts) verts = parseOldVerts(el);
        if (!prims) prims = parseOldPrims(el);
        const polys = pathToPolys(verts, prims, m);
        if (polys.length) shapes.push({ kind: 'path', cutIndex, polys });
      } else if (type === 'Rect') {
        const w = num(el, 'W') / 2, h = num(el, 'H') / 2;
        const poly = [[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]].map(([x, y]) => apply(m, x, y));
        shapes.push({ kind: 'path', cutIndex, polys: [poly] });
      } else if (type === 'Ellipse') {
        const rx = num(el, 'Rx'), ry = num(el, 'Ry');
        const n = Math.max(24, Math.min(360, Math.ceil((Math.PI * 2 * Math.max(rx, ry)) / 0.3)));
        const poly = [];
        for (let i = 0; i <= n; i++) poly.push(apply(m, rx * Math.cos((i / n) * Math.PI * 2), ry * Math.sin((i / n) * Math.PI * 2)));
        shapes.push({ kind: 'path', cutIndex, polys: [poly] });
      } else if (type === 'Bitmap') {
        const data = el.getAttribute('Data');
        if (data) {
          shapes.push({
            kind: 'bitmap', cutIndex, m, data,
            w: num(el, 'W'), h: num(el, 'H'),
            gamma: num(el, 'Gamma', 1), contrast: num(el, 'Contrast'), brightness: num(el, 'Brightness'),
          });
        }
      } else {
        skipped.set(type, (skipped.get(type) || 0) + 1);
      }
    }

    for (const el of root.children) if (el.nodeName === 'Shape') walk(el, IDENTITY);
    return { settings, shapes, skipped };
  }

  async function decodeImage(shape) {
    const bin = atob(shape.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes]));
    const bw = bmp.width, bh = bmp.height;
    const cv = new OffscreenCanvas(bw, bh);
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const px = cx.getImageData(0, 0, bw, bh).data;

    // Grayscale 0 (black) … 1 (white); transparent counts as white.
    const gray = new Float32Array(bw * bh);
    const contrast = 1 + shape.contrast / 100;
    const brightness = shape.brightness / 100;
    const gamma = shape.gamma > 0 ? shape.gamma : 1;
    for (let i = 0; i < bw * bh; i++) {
      const a = px[i * 4 + 3] / 255;
      let g = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
      g = g * a + (1 - a);
      g = (g - 0.5) * contrast + 0.5 + brightness;
      g = Math.pow(Math.min(1, Math.max(0, g)), gamma);
      gray[i] = g;
    }

    // Preview: dark pixels drawn warm, light pixels transparent so the bed shows through.
    const pv = new OffscreenCanvas(bw, bh);
    const pctx = pv.getContext('2d');
    const out = pctx.createImageData(bw, bh);
    for (let i = 0; i < bw * bh; i++) {
      out.data[i * 4] = 255;
      out.data[i * 4 + 1] = 214;
      out.data[i * 4 + 2] = 170;
      out.data[i * 4 + 3] = Math.round((1 - gray[i]) * 235);
    }
    pctx.putImageData(out, 0, 0);

    // Pixel (u, v) -> local shape coords (centred, Y up) -> world mm.
    const w = shape.w || bw, h = shape.h || bh;
    const pixToLocal = [w / bw, 0, 0, -h / bh, -w / 2, h / 2];
    return { gray, bw, bh, preview: pv, m: mul(shape.m, pixToLocal) };
  }

  const MODE = { Cut: 'line', Scan: 'fill', Offset: 'fill', Image: 'image' };

  /** Parse + decode a LightBurn file into a Laser Studio project object. */
  async function load(xmlText, name) {
    const { settings, shapes, skipped } = parse(xmlText);
    const layers = new Map();
    for (const s of shapes) {
      const key = `${s.kind === 'bitmap' ? 'img' : 'cut'}:${s.cutIndex}`;
      if (!layers.has(key)) {
        const cs = settings.get(key) || { type: s.kind === 'bitmap' ? 'Image' : 'Cut' };
        layers.set(key, {
          key,
          name: cs.name || `C${String(s.cutIndex).padStart(2, '0')}`,
          mode: MODE[cs.type] || 'line',
          power: Number.isFinite(cs.maxPower) ? cs.maxPower : 50,
          speed: Math.round((Number.isFinite(cs.speed) ? cs.speed : 50) * 60), // LightBurn stores mm/s
          passes: Math.max(1, cs.numPasses || 1),
          interval: cs.interval > 0 ? cs.interval : 0.1,
          dither: cs.ditherMode || 'stucki',
          enabled: cs.doOutput !== 0,
          priority: cs.priority ?? 0,
          polys: [],
          images: [],
        });
      }
      const layer = layers.get(key);
      if (s.kind === 'bitmap') layer.images.push(await decodeImage(s));
      else layer.polys.push(...s.polys);
    }

    // Shift everything so the design's bottom-left corner is (0,0); remember where it was.
    const allPts = [];
    for (const l of layers.values()) {
      for (const p of l.polys) allPts.push(p);
      for (const im of l.images) allPts.push(Geometry.imageCorners(im));
    }
    const bb = Geometry.bbox(allPts);
    if (!bb) throw new Error('No shapes found in this file.');
    const shift = [1, 0, 0, 1, -bb.minX, -bb.minY];
    for (const l of layers.values()) {
      l.polys = l.polys.map((p) => p.map((pt) => ({ x: pt.x - bb.minX, y: pt.y - bb.minY })));
      for (const im of l.images) im.m = mul(shift, im.m);
    }

    return {
      type: 'project',
      name,
      x: Math.round(bb.minX * 10) / 10,
      y: Math.round(bb.minY * 10) / 10,
      geom: { key: 'project', width: bb.maxX - bb.minX, height: bb.maxY - bb.minY },
      layers: [...layers.values()].sort((a, b) => a.priority - b.priority),
      skipped: [...skipped.entries()].map(([t, n]) => `${n}× ${t}`),
    };
  }

  return { load, parse };
})();
