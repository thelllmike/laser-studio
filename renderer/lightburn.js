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

  const TYPE_NAME = { Bitmap: 'Image', Group: 'Group', Path: 'Shape', Rect: 'Rectangle', Ellipse: 'Ellipse' };
  function shapeName(el) {
    const type = el.getAttribute('Type');
    const str = (el.getAttribute('Str') || '').replace(/\s+/g, ' ').trim();
    if (type === 'Text' && str) return str.length > 28 ? str.slice(0, 27) + '…' : str;
    return TYPE_NAME[type] || type || 'Shape';
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

    // `top` = index of the top-level shape this belongs to; each one becomes a separately movable item.
    const tops = [];
    function walk(el, parentM, cutIndexOverride, top) {
      const type = el.getAttribute('Type');
      const xf = child(el, 'XForm');
      const local = xf ? xf.textContent.trim().split(/\s+/).map(Number) : IDENTITY;
      const m = mul(parentM, local.length === 6 && local.every(Number.isFinite) ? local : IDENTITY);
      const cutIndex = cutIndexOverride ?? num(el, 'CutIndex');

      if (type === 'Group') {
        const kids = child(el, 'Children');
        if (kids) for (const c of kids.children) if (c.nodeName === 'Shape') walk(c, m, undefined, top);
      } else if (type === 'Text') {
        const bp = child(el, 'BackupPath');
        if (bp) walk(bp, parentM, cutIndex, top);
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
        if (polys.length) shapes.push({ kind: 'path', cutIndex, top, polys });
      } else if (type === 'Rect') {
        const w = num(el, 'W') / 2, h = num(el, 'H') / 2;
        const poly = [[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]].map(([x, y]) => apply(m, x, y));
        shapes.push({ kind: 'path', cutIndex, top, polys: [poly] });
      } else if (type === 'Ellipse') {
        const rx = num(el, 'Rx'), ry = num(el, 'Ry');
        const n = Math.max(24, Math.min(360, Math.ceil((Math.PI * 2 * Math.max(rx, ry)) / 0.3)));
        const poly = [];
        for (let i = 0; i <= n; i++) poly.push(apply(m, rx * Math.cos((i / n) * Math.PI * 2), ry * Math.sin((i / n) * Math.PI * 2)));
        shapes.push({ kind: 'path', cutIndex, top, polys: [poly] });
      } else if (type === 'Bitmap') {
        const data = el.getAttribute('Data');
        if (data) {
          shapes.push({
            kind: 'bitmap', cutIndex, top, m, data,
            w: num(el, 'W'), h: num(el, 'H'),
            gamma: num(el, 'Gamma', 1), contrast: num(el, 'Contrast'), brightness: num(el, 'Brightness'),
          });
        }
      } else {
        skipped.set(type, (skipped.get(type) || 0) + 1);
      }
    }

    for (const el of root.children) {
      if (el.nodeName !== 'Shape') continue;
      tops.push(shapeName(el));
      walk(el, IDENTITY, undefined, tops.length - 1);
    }
    return { settings, shapes, skipped, tops };
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

    // Pixel (u, v) -> local shape coords (centred) -> world mm.
    // LightBurn's bitmap XForm already carries the image's Y flip, so pixel row 0 sits at local -h/2.
    const w = shape.w || bw, h = shape.h || bh;
    const pixToLocal = [w / bw, 0, 0, h / bh, -w / 2, -h / 2];
    return { gray, bw, bh, preview: pv, m: mul(shape.m, pixToLocal) };
  }

  const MODE = { Cut: 'line', Scan: 'fill', Offset: 'fill', Image: 'image' };

  // LightBurn's layer palette (C00…C29).
  const PALETTE = [
    '#000000', '#0000ff', '#ff0000', '#00e000', '#d0d000', '#ff8000', '#00e0e0', '#ff00ff', '#b4b4b4', '#0000a0',
    '#a00000', '#00a000', '#a0a000', '#c08000', '#00a0ff', '#a000a0', '#808080', '#7d87b9', '#bb7784', '#4a6fe3',
    '#d33f6a', '#8cd78c', '#8d8cff', '#e7d58a', '#e0a8b8', '#f0b98d', '#bf6cd8', '#0f80b9', '#2fe6a5', '#9c6644',
  ];
  const layerColor = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

  /**
   * Parse + decode a LightBurn file.
   * Returns { name, cuts, items, skipped }: `cuts` are the file's layer settings (shared by every item),
   * `items` are its top-level shapes, each { name, x, y, geom, parts: [{ cut, polys, images }] }
   * with geometry in mm relative to the item's bottom-left corner and (x, y) its place on the bed.
   */
  async function load(xmlText, name) {
    const { settings, shapes, skipped, tops } = parse(xmlText);
    const cuts = new Map();
    const groups = new Map();
    for (const s of shapes) {
      const key = `${s.kind === 'bitmap' ? 'img' : 'cut'}:${s.cutIndex}`;
      if (!cuts.has(key)) {
        const cs = settings.get(key) || { type: s.kind === 'bitmap' ? 'Image' : 'Cut' };
        cuts.set(key, {
          key,
          name: cs.name || `C${String(s.cutIndex).padStart(2, '0')}`,
          index: s.cutIndex,
          color: layerColor(s.cutIndex),
          mode: MODE[cs.type] || 'line',
          power: Number.isFinite(cs.maxPower) ? cs.maxPower : 50,
          minPower: Number.isFinite(cs.minPower) ? cs.minPower : 0,
          air: cs.runBlower !== 0, // LightBurn leaves air assist on unless the file turns it off
          shown: cs.hide !== 1,
          speed: Math.round((Number.isFinite(cs.speed) ? cs.speed : 50) * 60), // LightBurn stores mm/s
          passes: Math.max(1, cs.numPasses || 1),
          interval: cs.interval > 0 ? cs.interval : 0.1,
          dither: cs.ditherMode || 'stucki',
          enabled: cs.doOutput !== 0,
          priority: cs.priority ?? 0,
        });
      }
      if (!groups.has(s.top)) groups.set(s.top, new Map());
      const parts = groups.get(s.top);
      if (!parts.has(key)) parts.set(key, { cut: cuts.get(key), polys: [], images: [] });
      const part = parts.get(key);
      if (s.kind === 'bitmap') part.images.push(await decodeImage(s));
      else part.polys.push(...s.polys);
    }

    const items = [];
    for (const [top, partMap] of groups) {
      const parts = [...partMap.values()];
      const bb = Geometry.bbox(parts.flatMap((p) => [...p.polys, ...p.images.map(Geometry.imageCorners)]));
      if (!bb) continue;
      // Keep exact positions (not rounded) so items stay lined up with each other.
      const shift = Geometry.mat.translate(-bb.minX, -bb.minY);
      for (const p of parts) {
        p.polys = p.polys.map((poly) => poly.map((pt) => ({ x: pt.x - bb.minX, y: pt.y - bb.minY })));
        for (const im of p.images) im.m = mul(shift, im.m);
      }
      items.push({
        name: tops[top], x: bb.minX, y: bb.minY,
        geom: { key: 'project', width: bb.maxX - bb.minX, height: bb.maxY - bb.minY }, parts,
      });
    }
    if (!items.length) throw new Error('No shapes found in this file.');

    return {
      name,
      cuts: [...cuts.values()].sort((a, b) => a.priority - b.priority),
      items,
      skipped: [...skipped.entries()].map(([t, n]) => `${n}× ${t}`),
    };
  }

  return { load, parse, layerColor };
})();
