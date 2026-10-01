'use strict';

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const round1 = (n) => Math.round(n * 10) / 10;
const grbl = new Grbl();

// ---------------------------------------------------------------- storage / laser profiles

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const DEFAULT_PROFILE = {
  name: 'My Diode Laser', bedW: 400, bedH: 400, maxS: 1000, baud: 115200, firePower: 1, frameSpeed: 3000, framePower: 1,
  scanOffset: { enabled: false, rows: [] }, airCmd: 'M8',
};
let profiles = load('ls.profiles', null);
if (!Array.isArray(profiles) || !profiles.length) profiles = [{ id: uid(), ...DEFAULT_PROFILE }];
let defaultId = load('ls.defaultId', null);
let profileId = load('ls.defaultId', null) || load('ls.profileId', profiles[0].id);
const profile = () => profiles.find((p) => p.id === profileId) || profiles[0];
const gcodeOpts = () => {
  const p = profile();
  return { maxS: grbl.settings['30'] || p.maxS, scanOffset: p.scanOffset, airCmd: p.airCmd || 'M8' };
};

function saveProfiles() {
  store('ls.profiles', profiles);
  store('ls.profileId', profileId);
  store('ls.defaultId', defaultId);
  renderProfileSelect();
  renderPorts();
  renderFrameLaser();
  draw();
}

function renderProfileSelect() {
  const sel = $('profileSelect');
  sel.innerHTML = '';
  for (const p of profiles) sel.add(new Option(`${p.name} (${p.bedW}×${p.bedH})`, p.id, false, p.id === profile().id));
}

// ---------------------------------------------------------------- USB port dropdown

let usbPorts = [];
const AUTO_PORT = '';

function renderPorts() {
  const sel = $('portSelect');
  const want = profile().port || AUTO_PORT;
  sel.innerHTML = '';
  sel.add(new Option(usbPorts.length ? 'Auto (first USB port)' : 'No USB laser found', AUTO_PORT));
  for (const name of usbPorts) sel.add(new Option(name, name));
  if (want && !usbPorts.includes(want)) sel.add(new Option(`${want} (not plugged in)`, want));
  sel.value = want;
}

async function refreshPorts() {
  try {
    const list = await window.native.listUsbPorts();
    if (list.join() === usbPorts.join()) return;
    usbPorts = list;
    renderPorts();
  } catch {}
}

$('portSelect').onchange = () => {
  profile().port = $('portSelect').value || undefined;
  saveProfiles();
};
$('portSelect').addEventListener('mousedown', refreshPorts);
window.addEventListener('focus', refreshPorts);
setInterval(() => { if (!grbl.connected) refreshPorts(); }, 3000);

/** Tell the port picker which port to use, so Connect doesn't have to ask. */
function preferPort(strict = false) {
  const chosen = profile().port || usbPorts[0] || null;
  window.native.setPreferredPort(chosen, strict);
  return chosen;
}

// ---------------------------------------------------------------- fonts

let fonts = [];
let defaultFont = null;
const fontCache = new Map();

function getFont(path) {
  if (!fontCache.has(path)) {
    const p = window.native.readFont(path).then((u8) =>
      opentype.parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength))
    );
    p.catch(() => fontCache.delete(path));
    fontCache.set(path, p);
  }
  return fontCache.get(path);
}

function addFontOption(path) {
  const sel = $('pFont');
  if ([...sel.options].some((o) => o.value === path)) return;
  const name = path.split('/').pop().replace(/\.(ttf|otf|woff)$/i, '');
  sel.add(new Option(name, path), sel.options.length - 1);
}

async function loadFonts() {
  fonts = await window.native.listFonts();
  const preferred = ['Arial', 'Arial Bold', 'Verdana', 'Georgia'];
  defaultFont = (preferred.map((n) => fonts.find((f) => f.name === n)).find(Boolean) || fonts[0] || {}).path || null;
  const sel = $('pFont');
  sel.innerHTML = '';
  for (const f of fonts) sel.add(new Option(f.name, f.path));
  sel.add(new Option('Other font file…', '__browse'));
}

// ---------------------------------------------------------------- design objects

const objects = [];
const files = new Map(); // imported LightBurn files: id -> { id, name, cuts, skipped, selCut }
const selection = new Set();
let selectedId = null; // the "primary" selected object, whose properties the side panel shows
const selected = () => objects.find((o) => o.id === selectedId) || null;
const selectedObjs = () => objects.filter((o) => selection.has(o.id));

function select(ids, { add = false } = {}) {
  if (!add) selection.clear();
  for (const id of ids) selection.add(id);
  selectedId = ids.length ? ids[ids.length - 1] : null;
}
function toggleSelect(id) {
  if (selection.has(id)) selection.delete(id);
  else selection.add(id);
  selectedId = selection.has(id) ? id : [...selection].pop() || null;
}

/** Move objects by (dx, dy) mm. Moves are rounded to 0.1 mm so items keep their exact spacing. */
function moveBy(objs, dx, dy) {
  dx = round1(dx); dy = round1(dy);
  for (const o of objs) { o.x += dx; o.y += dy; }
}

// The design area: a box (e.g. a 100 × 145 mm card) you lay the design out inside. Work coordinates, like objects.
const area = { on: true, w: 100, h: 145, x: null, y: null, ...load('ls.area', {}) };
function saveArea() { store('ls.area', area); }
function areaRect() {
  if (!area.on || !(area.w > 0) || !(area.h > 0)) return null;
  if (area.x === null || area.y === null) centerArea();
  return { minX: area.x, minY: area.y, maxX: area.x + area.w, maxY: area.y + area.h };
}
function centerArea() {
  const wco = grbl.status.wco;
  area.x = round1(profile().bedW / 2 - area.w / 2 - wco.x);
  area.y = round1(profile().bedH / 2 - area.h / 2 - wco.y);
}

/** Align: one item → inside the design area (or the bed); several → to the edges of the selection. */
function alignSelection(how) {
  const objs = selectedObjs().filter((o) => o.geom);
  if (!objs.length) return;
  const wco = grbl.status.wco;
  const target = objs.length > 1 ? objsBBox(objs) : areaRect() ||
    { minX: -wco.x, minY: -wco.y, maxX: profile().bedW - wco.x, maxY: profile().bedH - wco.y };
  for (const o of objs) {
    const w = o.geom.width, h = o.geom.height;
    if (how === 'left') o.x = target.minX;
    if (how === 'right') o.x = target.maxX - w;
    if (how === 'hcenter') o.x = (target.minX + target.maxX) / 2 - w / 2;
    if (how === 'bottom') o.y = target.minY;
    if (how === 'top') o.y = target.maxY - h;
    if (how === 'vcenter') o.y = (target.minY + target.maxY) / 2 - h / 2;
  }
  refresh();
}

/**
 * Snap a dragged selection (bbox bb, already moved by dx/dy) to the design area and to other items:
 * left/centre/right against left/centre/right, same for bottom/middle/top. Returns the corrected
 * offsets plus the guide lines to draw.
 */
function snapDrag(bb, dx, dy, tol, moving) {
  const xs = [], ys = [];
  const addRect = (r) => {
    xs.push(r.minX, (r.minX + r.maxX) / 2, r.maxX);
    ys.push(r.minY, (r.minY + r.maxY) / 2, r.maxY);
  };
  const a = areaRect();
  if (a) addRect(a);
  for (const o of objects) {
    if (!o.geom || moving.has(o)) continue;
    addRect({ minX: o.x, minY: o.y, maxX: o.x + o.geom.width, maxY: o.y + o.geom.height });
  }
  const best = (edges, targets) => {
    let pick = null;
    for (const e of edges) for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= tol && (!pick || Math.abs(d) < Math.abs(pick.d))) pick = { d, at: t };
    }
    return pick;
  };
  const sx = best([bb.minX + dx, (bb.minX + bb.maxX) / 2 + dx, bb.maxX + dx], xs);
  const sy = best([bb.minY + dy, (bb.minY + bb.maxY) / 2 + dy, bb.maxY + dy], ys);
  return { dx: dx + (sx?.d || 0), dy: dy + (sy?.d || 0), guides: { x: sx ? [sx.at] : [], y: sy ? [sy.at] : [] } };
}

// ---- rotate / resize / flip

const mat2 = (m, x) => [m[0] * x[0] + m[2] * x[1], m[1] * x[0] + m[3] * x[1], m[0] * x[2] + m[2] * x[3], m[1] * x[2] + m[3] * x[3]];
const normDeg = (d) => { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d; };

/** Remember where each object is, so a whole drag can be applied from the same starting point. */
function snapshot(objs) {
  return objs.map((o) => ({ o, xf: o.xf || IDENTITY_XF, rot: o.rot || 0,
    px: o.x + (o.geom?.pivot?.x ?? o.geom.width / 2), py: o.y + (o.geom?.pivot?.y ?? o.geom.height / 2) }));
}

/** Apply linear map M (2×2) around anchor A to snapshotted objects. rotDeg only updates the shown angle. */
function applyTransform(snap, M, A, rotDeg = 0) {
  for (const s of snap) {
    const o = s.o;
    o.xf = mat2(M, s.xf);
    o.rot = normDeg(s.rot + rotDeg);
    rederive(o);
    const dx = s.px - A.x, dy = s.py - A.y;
    o.x = A.x + M[0] * dx + M[2] * dy - o.geom.pivot.x;
    o.y = A.y + M[1] * dx + M[3] * dy - o.geom.pivot.y;
  }
}
const rotM = (deg) => { const r = (deg * Math.PI) / 180; return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r)]; };

/** One-shot transform of the current selection around its centre (used by the panel buttons). */
function transformSelection(M, rotDeg = 0) {
  const objs = selectedObjs().filter((o) => o.base);
  const bb = objsBBox(objs);
  if (!bb) return;
  applyTransform(snapshot(objs), M, { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 }, rotDeg);
  refresh();
}

// Handle positions (work mm) on the selection's bounding box; the rotate knob sits above the top edge.
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function handlePoints(bb) {
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  return { nw: [bb.minX, bb.maxY], n: [cx, bb.maxY], ne: [bb.maxX, bb.maxY], e: [bb.maxX, cy],
    se: [bb.maxX, bb.minY], s: [cx, bb.minY], sw: [bb.minX, bb.minY], w: [bb.minX, cy] };
}
const OPPOSITE = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
const ROT_KNOB_PX = 26;

/** Which handle (if any) is under screen point (px, py)? */
function handleAt(px, py) {
  const objs = selectedObjs().filter((o) => o.base);
  const bb = objsBBox(objs);
  if (!bb || drag || marquee) return null;
  const v = view(), wco = grbl.status.wco;
  const toS = ([x, y]) => v.toPx(x + wco.x, y + wco.y);
  const [tx, ty] = toS([(bb.minX + bb.maxX) / 2, bb.maxY]);
  if (Math.hypot(px - tx, py - (ty - ROT_KNOB_PX)) <= 8) return 'rot';
  const pts = handlePoints(bb);
  for (const k of HANDLES) {
    const [hx, hy] = toS(pts[k]);
    if (Math.abs(px - hx) <= 6 && Math.abs(py - hy) <= 6) return k;
  }
  return null;
}
const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', rot: 'crosshair' };

function objsBBox(objs) {
  const pts = objs.filter((o) => o.geom).map((o) => [{ x: o.x, y: o.y }, { x: o.x + o.geom.width, y: o.y + o.geom.height }]);
  return Geometry.bbox(pts);
}

// Every object keeps its untransformed geometry in `base` and a 2×2 transform `xf` ([a, b, c, d]:
// x' = a·x + c·y, y' = b·x + d·y) for rotate / resize / flip, applied around the base's centre.
// `geom` (and `parts` for imported items) is the transformed result, normalised so its bounding box
// starts at (0, 0); geom.pivot is where the base's centre ended up inside that box.
const IDENTITY_XF = [1, 0, 0, 1];

function transformParts(parts, w, h, xf) {
  const { mul, apply, translate, } = Geometry.mat;
  const T = mul([xf[0], xf[1], xf[2], xf[3], 0, 0], translate(-w / 2, -h / 2));
  const out = parts.map((p) => ({
    cut: p.cut,
    polys: p.polys.map((poly) => poly.map((pt) => apply(T, pt.x, pt.y))),
    images: p.images.map((im) => ({ ...im, m: mul(T, im.m) })),
  }));
  const bb = Geometry.bbox(out.flatMap((p) => [...p.polys, ...p.images.map(Geometry.imageCorners)]))
    || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const shift = translate(-bb.minX, -bb.minY);
  for (const p of out) {
    p.polys = p.polys.map((poly) => poly.map((pt) => ({ x: pt.x - bb.minX, y: pt.y - bb.minY })));
    for (const im of p.images) im.m = mul(shift, im.m);
  }
  return { parts: out, width: bb.maxX - bb.minX, height: bb.maxY - bb.minY, pivot: { x: -bb.minX, y: -bb.minY } };
}

/** Recompute an object's transformed geometry from its base (synchronous once the base exists). */
function rederive(o) {
  if (!o.base) return;
  const xf = o.xf || IDENTITY_XF;
  const d = transformParts(o.base.parts, o.base.width, o.base.height, xf);
  if (o.type === 'project') {
    o.parts = d.parts;
    o.geom = { key: 'project', width: d.width, height: d.height, pivot: d.pivot };
  } else {
    o.geom = { key: o.base.key, xk: xf.join(), polys: d.parts[0].polys, width: d.width, height: d.height, pivot: d.pivot };
  }
}

async function ensureGeom(obj) {
  if (obj.type === 'project') return obj.geom;
  const key = `${obj.text}|${obj.font}|${obj.height}`;
  if (!obj.base || obj.base.key !== key) {
    const font = await getFont(obj.font);
    const g = Geometry.textToPolylines(font, obj.text, obj.height);
    if (`${obj.text}|${obj.font}|${obj.height}` !== key) return obj.geom; // edited again meanwhile
    obj.base = { key, parts: [{ polys: g.polys, images: [] }], width: g.width, height: g.height };
  }
  if (!obj.geom || obj.geom.key !== key || obj.geom.xk !== (obj.xf || IDENTITY_XF).join()) rederive(obj);
  return obj.geom;
}

async function addText() {
  if (!defaultFont) return log('No fonts found on this Mac.', 'err');
  const p = profile();
  const obj = {
    id: uid(), type: 'text', text: 'Hello', font: defaultFont, height: 20,
    x: round1(p.bedW / 2 - 30), y: round1(p.bedH / 2 - 10),
    mode: 'line', power: 80, speed: 1000, passes: 1, interval: 0.1, xf: IDENTITY_XF, rot: 0,
  };
  objects.push(obj);
  select([obj.id]);
  await refresh(obj);
  $('pText').focus();
  $('pText').select();
}

async function refresh(obj) {
  if (obj) {
    try { await ensureGeom(obj); } catch (e) { log(`Font error: ${e.message}`, 'err'); }
  }
  renderList();
  renderProps();
  draw();
}

function renderList() {
  const ul = $('objectList');
  ul.innerHTML = '';
  let lastFile = null;
  for (const o of objects) {
    if (o.fileId && o.fileId !== lastFile) {
      const f = files.get(o.fileId);
      const ids = objects.filter((x) => x.fileId === f.id).map((x) => x.id);
      const head = h('li', { className: 'file', textContent: f.name, title: 'Select the whole design' },
        h('small', { textContent: `LightBurn · ${ids.length} items` }));
      if (ids.every((id) => selection.has(id))) head.classList.add('sel');
      head.onclick = () => { select(ids); refresh(); };
      ul.append(head);
    }
    lastFile = o.fileId || null;
    const li = h('li', { textContent: o.type === 'project' ? o.name : o.text.replace(/\n/g, ' ') || '(empty)' },
      h('small', { textContent: o.type === 'project' ? '' : o.mode === 'fill' ? 'fill' : 'line' }));
    if (o.fileId) li.classList.add('child');
    if (selection.has(o.id)) li.classList.add('sel');
    li.onclick = (e) => {
      if (e.shiftKey || e.metaKey) toggleSelect(o.id);
      else select([o.id]);
      refresh();
    };
    ul.append(li);
  }
}

const PROPS = {
  pText: 'text', pFont: 'font', pHeight: 'height', pX: 'x', pY: 'y', pMode: 'mode',
  pPower: 'power', pSpeed: 'speed', pPasses: 'passes', pInterval: 'interval',
};

let propsFor = null;
function renderTransform() {
  const objs = selectedObjs().filter((o) => o.base);
  const bb = objsBBox(objs);
  $('xfSection').hidden = !bb;
  if (!bb) return;
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set('xfW', round1(bb.maxX - bb.minX));
  set('xfH', round1(bb.maxY - bb.minY));
  set('xfRot', objs.length === 1 ? Math.round((objs[0].rot || 0) * 10) / 10 : '');
  $('xfRot').placeholder = objs.length > 1 ? 'adds' : '0';
}

function renderProps() {
  renderTransform();
  const o = selected();
  $('propsSection').hidden = !o || o.type === 'project';
  $('projSection').hidden = !o || o.type !== 'project';
  if (!o) return;
  if (o.type === 'project') return renderProject(o);
  addFontOption(o.font);
  const switched = propsFor !== o.id;
  propsFor = o.id;
  for (const [id, key] of Object.entries(PROPS)) {
    if (switched || document.activeElement !== $(id)) $(id).value = o[key];
  }
  $('intervalWrap').style.visibility = o.mode === 'fill' ? 'visible' : 'hidden';
  $('sizeInfo').textContent = o.geom
    ? `Size: ${o.geom.width.toFixed(1)} × ${o.geom.height.toFixed(1)} mm`
    : '';
}

function bindProps() {
  for (const [id, key] of Object.entries(PROPS)) {
    $(id).addEventListener('input', async () => {
      const o = selected();
      if (!o) return;
      let v = $(id).value;
      if (key === 'font' && v === '__browse') {
        const path = await window.native.chooseFont();
        if (!path) { $(id).value = o.font; return; }
        addFontOption(path);
        $(id).value = v = path;
      }
      if (!['text', 'font', 'mode'].includes(key)) {
        v = parseFloat(v);
        if (!Number.isFinite(v)) return;
        if (key === 'passes') v = Math.max(1, Math.round(v));
        if (key === 'power') v = Math.max(0, Math.min(100, v));
        if (key === 'height' && v < 0.5) return;
        if (key === 'interval' && v < 0.02) return;
      }
      if (key === 'mode' && v !== o.mode) {
        // Sensible starting points for a diode laser.
        if (v === 'fill' && o.speed === 1000) o.speed = 3000;
        if (v === 'line' && o.speed === 3000) o.speed = 1000;
      }
      o[key] = v;
      await refresh(o);
    });
  }
  $('deleteBtn').onclick = $('projDeleteBtn').onclick = deleteSelection;
  $('centerBtn').onclick = $('projCenterBtn').onclick = () => {
    const objs = selectedObjs();
    const bb = objsBBox(objs);
    if (!bb) return;
    const wco = grbl.status.wco;
    moveBy(objs, profile().bedW / 2 - (bb.minX + bb.maxX) / 2 - wco.x, profile().bedH / 2 - (bb.minY + bb.maxY) / 2 - wco.y);
    refresh();
  };
  $('projAllBtn').onclick = () => {
    const o = selected();
    if (!o?.fileId) return;
    select(objects.filter((x) => x.fileId === o.fileId).map((x) => x.id));
    refresh();
  };
  // X/Y show the bottom-left of the selection; typing moves everything selected.
  for (const [id, axis] of [['jX', 'x'], ['jY', 'y']]) {
    $(id).addEventListener('input', () => {
      const objs = selectedObjs();
      const bb = objsBBox(objs);
      const v = parseFloat($(id).value);
      if (!bb || !Number.isFinite(v)) return;
      if (axis === 'x') moveBy(objs, v - bb.minX, 0);
      else moveBy(objs, 0, v - bb.minY);
      $('projSize').textContent = projSizeText(objs);
      draw();
    });
  }
}

function deleteSelection() {
  for (let i = objects.length - 1; i >= 0; i--) if (selection.has(objects[i].id)) objects.splice(i, 1);
  for (const id of files.keys()) if (!objects.some((o) => o.fileId === id)) files.delete(id);
  select([]);
  refresh();
}

// ---------------------------------------------------------------- imported LightBurn projects

const MODE_LABEL = { line: 'Line', fill: 'Fill', image: 'Image' };
const DITHERS = ['stucki', 'jarvis', 'floyd', 'atkinson', 'threshold', 'grayscale'];

function projSizeText(objs) {
  const bb = objsBBox(objs);
  if (!bb) return '';
  const what = objs.length > 1 ? `${objs.length} items · ` : '';
  return `${what}${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} mm · at X ${round1(bb.minX)}, Y ${round1(bb.minY)}`;
}

function renderProject(o) {
  const f = files.get(o.fileId);
  const objs = selectedObjs();
  const bb = objsBBox(objs);
  $('projTitle').textContent = objs.length > 1 ? `${objs.length} items selected` : `${o.name} · ${f.name}`;
  if (bb && document.activeElement !== $('jX')) $('jX').value = round1(bb.minX);
  if (bb && document.activeElement !== $('jY')) $('jY').value = round1(bb.minY);
  $('projSize').textContent = projSizeText(objs);
  $('projNote').textContent = f.skipped.length ? `Not imported: ${f.skipped.join(', ')}` : '';
  if (!f.cuts.some((c) => c.key === f.selCut)) f.selCut = f.cuts[0]?.key;
  const switched = propsFor !== f.id;
  propsFor = f.id;
  renderCuts(f);
  if (switched || !$('cutEditor').contains(document.activeElement)) renderCutEditor(f);
}

function h(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}
const spdPwr = (l) => `${Math.round(l.speed).toLocaleString()} / ${Math.round(l.power)}`;

function renderCuts(f) {
  const body = $('cutsBody');
  body.innerHTML = '';
  for (const l of f.cuts) {
    const tr = h('tr', { className: (l.key === f.selCut ? 'sel' : '') + (l.enabled ? '' : ' off') });
    const chip = h('span', { className: 'chip', textContent: String(l.index ?? '').padStart(2, '0'), title: l.name });
    chip.style.background = l.color || '#60a5fa';
    chip.style.color = textOn(l.color || '#60a5fa');

    let mode;
    if (l.mode === 'image') mode = document.createTextNode('Image');
    else {
      mode = h('select');
      for (const m of ['line', 'fill']) mode.add(new Option(MODE_LABEL[m], m, false, m === l.mode));
      mode.onchange = () => { l.mode = mode.value; renderCutEditor(f); draw(); };
    }
    const toggle = (key, title) => {
      const cb = h('input', { type: 'checkbox', className: 'switch', checked: l[key], title });
      cb.onchange = () => { l[key] = cb.checked; tr.classList.toggle('off', !l.enabled); draw(); };
      return h('td', { className: 'tog' }, cb);
    };
    tr.append(
      h('td', {}, chip), h('td', {}, mode), h('td', { className: 'spdpwr', textContent: spdPwr(l) }),
      toggle('enabled', 'Burn this layer'), toggle('shown', 'Show on screen'), toggle('air', 'Air assist'),
    );
    tr.onclick = (e) => {
      if (e.target.closest('input, select') || f.selCut === l.key) return;
      f.selCut = l.key;
      renderCuts(f);
      renderCutEditor(f);
    };
    body.append(tr);
  }
}

function renderCutEditor(f) {
  const l = f.cuts.find((x) => x.key === f.selCut);
  $('cutEditor').hidden = !l;
  if (!l) return;
  for (const inp of $('cutEditor').querySelectorAll('[data-k]')) {
    if (inp.dataset.k !== 'dither') inp.value = l[inp.dataset.k];
  }
  const dither = $('cutEditor').querySelector('[data-k=dither]');
  dither.innerHTML = '';
  for (const d of DITHERS) dither.add(new Option(d, d, false, d === l.dither));
  $('cutFillRow').hidden = l.mode === 'line';
  $('cutDitherWrap').style.visibility = l.mode === 'image' ? 'visible' : 'hidden';
}

$('cutEditor').addEventListener('input', (e) => {
  const f = files.get(selected()?.fileId);
  const l = f?.cuts.find((x) => x.key === f.selCut);
  const k = e.target.dataset.k;
  if (!l || !k) return;
  if (k === 'dither') { l.dither = e.target.value; return; }
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  if (k === 'power' || k === 'minPower') l[k] = Math.max(0, Math.min(100, v));
  else if (k === 'passes') l.passes = Math.max(1, Math.round(v));
  else if (k === 'interval') { if (v >= 0.02) l.interval = v; }
  else if (k === 'speed') { if (v > 0) l.speed = v; }
  const cell = $('cutsBody').querySelector('tr.sel .spdpwr');
  if (cell) cell.textContent = spdPwr(l);
});

// Black or white text, whichever reads better on a layer colour.
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 140 ? '#000' : '#fff';
}

async function importFiles(fileList) {
  for (const file of fileList) {
    if (!/\.lbrn2?$/i.test(file.name)) { log(`${file.name}: not a LightBurn file (.lbrn2 / .lbrn).`, 'err'); continue; }
    try {
      log(`Importing ${file.name}…`);
      const proj = await LightBurn.load(await file.text(), file.name.replace(/\.lbrn2?$/i, ''));
      const f = { id: uid(), name: proj.name, cuts: proj.cuts, skipped: proj.skipped, selCut: null };
      files.set(f.id, f);
      const items = proj.items.map((it) => {
        const o = { id: uid(), type: 'project', fileId: f.id, ...it, xf: IDENTITY_XF, rot: 0 };
        o.base = { parts: it.parts, width: it.geom.width, height: it.geom.height };
        rederive(o);
        return o;
      });
      objects.push(...items);
      select(items.map((o) => o.id));
      const bb = objsBBox(items);
      const summary = f.cuts.map((l) => `${l.name} ${MODE_LABEL[l.mode]} ${l.power}% ${l.speed}mm/min`).join(' · ');
      log(`Imported "${f.name}" – ${items.length} items, ${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} mm. Layers: ${summary}`);
      if (f.skipped.length) log(`Skipped: ${f.skipped.join(', ')}`, 'err');
      const p = profile();
      if (bb.minX < 0 || bb.minY < 0 || bb.maxX > p.bedW || bb.maxY > p.bedH) {
        log(`Kept LightBurn's position, but part of it is outside your ${p.bedW}×${p.bedH} bed. ` +
          'Click an item to move it on its own, check your bed size under Devices → Edit, or turn off layers you don\'t need.', 'err');
      }
    } catch (e) {
      log(`Could not import ${file.name}: ${e.message}`, 'err');
    }
  }
  refresh();
}

$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = () => { importFiles([...$('importFile').files]); $('importFile').value = ''; };

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').hidden = true;
  importFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------- canvas

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let dpr = 1;

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  draw();
}

// Zoom/pan on top of the "whole bed fits" view. zoom 1 = fit bed; pan is in screen pixels.
const cam = { zoom: 1, panX: 0, panY: 0 };
const ZOOM_MIN = 0.5, ZOOM_MAX = 60;

function view() {
  const W = canvas.width / dpr, H = canvas.height / dpr;
  const p = profile();
  const m = 40;
  const fit = Math.max(0.01, Math.min((W - 2 * m) / p.bedW, (H - 2 * m) / p.bedH));
  const s = fit * cam.zoom;
  const ox = (W - p.bedW * s) / 2 + cam.panX;
  const oy = (H + p.bedH * s) / 2 + cam.panY;
  return {
    s, ox, oy,
    toPx: (x, y) => [ox + x * s, oy - y * s],
    toMm: (px, py) => [(px - ox) / s, (oy - py) / s],
  };
}

function draw() {
  if (!canvas.width) return;
  const p = profile();
  const v = view();
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#17181b';
  ctx.fillRect(0, 0, W, H);

  // bed
  const [bx0, by0] = v.toPx(0, p.bedH);
  ctx.fillStyle = '#23252a';
  ctx.fillRect(bx0, by0, p.bedW * v.s, p.bedH * v.s);
  ctx.lineWidth = 1;
  // Grid spacing follows the zoom: minor lines ≥ 8 px apart, labels ≥ 45 px apart.
  const STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  const minor = STEPS.find((d) => d * v.s >= 8) || 500;
  const major = STEPS.find((d) => d * v.s >= 45 && d % minor === 0) || 500;
  const [mx0, my1] = v.toMm(0, 0), [mx1, my0] = v.toMm(W, H);
  const from = (lo) => Math.max(0, Math.ceil(lo / minor) * minor);
  const isMajor = (n) => Math.abs(n / major - Math.round(n / major)) < 1e-6;
  for (let x = from(mx0); x <= Math.min(p.bedW, mx1); x += minor) {
    ctx.strokeStyle = isMajor(x) ? '#3a3e46' : '#2b2e34';
    const [px] = v.toPx(x, 0);
    line(px, by0, px, by0 + p.bedH * v.s);
  }
  for (let y = from(my0); y <= Math.min(p.bedH, my1); y += minor) {
    ctx.strokeStyle = isMajor(y) ? '#3a3e46' : '#2b2e34';
    const [, py] = v.toPx(0, y);
    line(bx0, py, bx0 + p.bedW * v.s, py);
  }
  ctx.strokeStyle = '#4b5058';
  ctx.strokeRect(bx0, by0, p.bedW * v.s, p.bedH * v.s);
  ctx.fillStyle = '#6b7079';
  ctx.font = '10px -apple-system, sans-serif';
  const fmt = (n) => String(Math.round(n * 10) / 10);
  ctx.textAlign = 'center';
  const labelY = Math.min(H - 32, Math.max(14, v.toPx(0, 0)[1] + 14)); // stay above the hint bar
  for (let x = Math.max(0, Math.ceil(mx0 / major) * major); x <= Math.min(p.bedW, mx1); x += major) {
    ctx.fillText(fmt(x), v.toPx(x, 0)[0], labelY);
  }
  ctx.textAlign = 'right';
  const labelX = Math.min(W - 4, Math.max(30, v.toPx(0, 0)[0] - 5));
  for (let y = Math.max(major, Math.ceil(my0 / major) * major); y <= Math.min(p.bedH, my1); y += major) {
    ctx.fillText(fmt(y), labelX, v.toPx(0, y)[1] + 3);
  }

  const wco = grbl.status.wco;

  // design area
  const a = areaRect();
  if (a) {
    const [ax, ay] = v.toPx(a.minX + wco.x, a.maxY + wco.y);
    const aw = area.w * v.s, ah = area.h * v.s;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(ax, ay, aw, ah);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    line(ax + aw / 2, ay, ax + aw / 2, ay + ah);
    line(ax, ay + ah / 2, ax + aw, ay + ah / 2);
    ctx.strokeStyle = '#a5b4fc';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(ax, ay, aw, ah);
    ctx.setLineDash([]);
    ctx.fillStyle = '#a5b4fc';
    ctx.textAlign = 'right';
    ctx.fillText(`${area.w} × ${area.h} mm`, ax + aw, ay - 6);
  }

  // design
  for (const o of objects) {
    if (!o.geom) continue;
    if (o.type === 'project') drawProject(o, v, wco);
    else drawText(o, v, wco);
    if (selection.has(o.id)) {
      const [x0, y0] = v.toPx(o.x + wco.x, o.y + o.geom.height + wco.y);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = o.id === selectedId ? '#e6e7ea' : '#9ca3af';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 3, y0 - 3, o.geom.width * v.s + 6, o.geom.height * v.s + 6);
      ctx.setLineDash([]);
      if (o.id === selectedId && selection.size === 1) {
        ctx.fillStyle = '#e6e7ea';
        ctx.textAlign = 'left';
        ctx.fillText(`${o.geom.width.toFixed(1)} × ${o.geom.height.toFixed(1)} mm`, x0 - 3, y0 - 8);
      }
    }
  }

  // drag-to-select box: solid = items fully inside, dashed (right-to-left) = items it touches
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = 'rgba(59,130,246,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1;
    if (marquee.x1 < marquee.x0) ctx.setLineDash([5, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // smart guides while dragging
  if (drag?.guides) {
    ctx.strokeStyle = '#ec4899';
    ctx.lineWidth = 1;
    for (const gx of drag.guides.x) { const [px] = v.toPx(gx + wco.x, 0); line(px, 0, px, H); }
    for (const gy of drag.guides.y) { const [, py] = v.toPx(0, gy + wco.y); line(0, py, W, py); }
  }

  // resize / rotate handles around the selection
  const selBB = !marquee && objsBBox(selectedObjs().filter((o) => o.base));
  if (selBB && !(drag && drag.kind === 'move')) {
    const toS = ([x, y]) => v.toPx(x + wco.x, y + wco.y);
    const [x0, y0] = toS([selBB.minX, selBB.maxY]), [x1, y1] = toS([selBB.maxX, selBB.minY]);
    if (selection.size > 1) {
      ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
    }
    const tx = (x0 + x1) / 2;
    ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 1;
    line(tx, y0 - 3, tx, y0 - ROT_KNOB_PX + 6);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(tx, y0 - ROT_KNOB_PX, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(tx, y0 - ROT_KNOB_PX, 3, -Math.PI * 0.9, Math.PI * 0.4); ctx.stroke();
    const pts = handlePoints(selBB);
    for (const k of HANDLES) {
      const [hx, hy] = toS(pts[k]);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(hx - 4, hy - 4, 8, 8);
      ctx.strokeRect(hx - 4, hy - 4, 8, 8);
    }
    if (drag?.kind === 'rot' || drag?.kind === 'scale') {
      const o = selected();
      const label = drag.kind === 'rot' ? `${Math.round(o?.rot ?? 0)}°`
        : `${(selBB.maxX - selBB.minX).toFixed(1)} × ${(selBB.maxY - selBB.minY).toFixed(1)} mm`;
      ctx.font = '11px -apple-system, sans-serif';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(17,24,39,.9)';
      ctx.fillRect(drag.lastX + 14, drag.lastY + 10, tw, 18);
      ctx.fillStyle = '#e6e7ea';
      ctx.textAlign = 'left';
      ctx.fillText(label, drag.lastX + 19, drag.lastY + 23);
    }
  }

  // job origin: the point that will sit under the laser when starting from the current position
  if ($('startFrom').value === 'current') {
    const objs = jobObjects();
    const box = objs.length || areaRect() ? jobRefBox(objs) : null;
    if (box) {
      const a = jobAnchor(box);
      const [jx, jy] = v.toPx(a.x + wco.x, a.y + wco.y);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(jx, jy, 7, 0, Math.PI * 2); ctx.stroke();
      line(jx - 12, jy, jx + 12, jy);
      line(jx, jy - 12, jx, jy + 12);
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      const label = 'Laser starts here';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(17,24,39,.9)';
      ctx.fillRect(jx + 12, jy - 24, tw, 17);
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(label, jx + 17, jy - 12);
    }
  }

  // work origin
  const [ox, oy] = v.toPx(wco.x, wco.y);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  line(ox - 9, oy, ox + 9, oy);
  line(ox, oy - 9, ox, oy + 9);

  // laser head
  if (grbl.connected) {
    const [hx, hy] = v.toPx(grbl.status.mpos.x, grbl.status.mpos.y);
    ctx.fillStyle = grbl.status.power > 0 ? '#fde047' : '#ef4444';
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(239,68,68,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(hx, hy, 10, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function tracePolys(polys, v, dx, dy) {
  ctx.beginPath();
  for (const poly of polys) {
    poly.forEach((pt, i) => {
      const [px, py] = v.toPx(pt.x + dx, pt.y + dy);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
  }
}

function drawText(o, v, wco) {
  tracePolys(o.geom.polys, v, o.x + wco.x, o.y + wco.y);
  if (o.mode === 'fill') {
    ctx.fillStyle = LAYER_COLORS.fill;
    ctx.fill('evenodd');
  } else {
    ctx.strokeStyle = LAYER_COLORS.line;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
}

const LAYER_COLORS = { line: '#60a5fa', fill: 'rgba(245, 158, 11, 0.85)' };

function drawProject(o, v, wco) {
  const dx = o.x + wco.x, dy = o.y + wco.y;
  const order = { image: 0, fill: 1, line: 2 };
  for (const part of [...o.parts].sort((a, b) => order[a.cut.mode] - order[b.cut.mode])) {
    const l = { ...part.cut, polys: part.polys, images: part.images };
    if (l.shown === false) continue;
    ctx.globalAlpha = l.enabled ? 1 : 0.25;
    // The bed is dark, so LightBurn's black layer (C00) is drawn light.
    const color = !l.color || l.color === '#000000' ? '#d1d5db' : l.color;
    if (l.mode === 'image' || l.images.length) {
      const base = [v.s, 0, 0, -v.s, v.ox + dx * v.s, v.oy - dy * v.s];
      for (const im of l.images) {
        const m = Geometry.mat.mul(base, im.m);
        ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
        ctx.drawImage(im.preview, 0, 0);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (l.polys.length) {
      tracePolys(l.polys, v, dx, dy);
      if (l.mode === 'fill') { ctx.fillStyle = color; ctx.globalAlpha *= 0.85; ctx.fill('evenodd'); }
      else { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
    }
  }
  ctx.globalAlpha = 1;
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

let drag = null;
let marquee = null; // drag-to-select box, in screen px
let pan = null;
let spaceHeld = false;

canvas.addEventListener('pointerdown', (e) => {
  // Space + drag, or the middle mouse button, pans the view.
  if (spaceHeld || e.button === 1) {
    pan = { x: e.clientX, y: e.clientY, px: cam.panX, py: cam.panY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    return;
  }
  const v = view();
  const [mx, my] = v.toMm(e.offsetX, e.offsetY);
  const wco = grbl.status.wco;
  const dx = mx - wco.x, dy = my - wco.y;
  const tol = 6 / v.s;

  const handle = handleAt(e.offsetX, e.offsetY);
  if (handle) {
    const objs = selectedObjs().filter((o) => o.base);
    const bb = objsBBox(objs);
    const pts = handlePoints(bb);
    drag = {
      kind: handle === 'rot' ? 'rot' : 'scale', handle, bb, snap: snapshot(objs), moved: false,
      start: { x: dx, y: dy }, center: { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 },
      grab: handle === 'rot' ? null : { x: pts[handle][0], y: pts[handle][1] },
      opp: handle === 'rot' ? null : { x: pts[OPPOSITE[handle]][0], y: pts[OPPOSITE[handle]][1] },
      lastX: e.offsetX, lastY: e.offsetY,
    };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  const hits = objects.filter((o) => o.geom &&
    dx >= o.x - tol && dx <= o.x + o.geom.width + tol && dy >= o.y - tol && dy <= o.y + o.geom.height + tol);
  const hit = hits.sort((a, b) => a.geom.width * a.geom.height - b.geom.width * b.geom.height)[0];
  if (!hit) {
    if (!(e.shiftKey || e.metaKey)) select([]);
    marquee = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, add: e.shiftKey || e.metaKey };
    canvas.setPointerCapture(e.pointerId);
  } else if (e.shiftKey || e.metaKey) toggleSelect(hit.id);
  else if (!selection.has(hit.id)) select([hit.id]);
  else selectedId = hit.id;
  if (hit && selection.has(hit.id)) {
    const objs = selectedObjs();
    // A click (no drag) on an item inside a bigger selection narrows the selection to that item.
    const narrowTo = !(e.shiftKey || e.metaKey) && selection.size > 1 ? hit.id : null;
    drag = { kind: 'move', objs, start: objs.map((o) => [o.x, o.y]), bb: objsBBox(objs), sx: mx, sy: my, moved: false, narrowTo, guides: null };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  }
  refresh();
});
canvas.addEventListener('pointermove', (e) => {
  if (pan) {
    cam.panX = pan.px + e.clientX - pan.x;
    cam.panY = pan.py + e.clientY - pan.y;
    draw();
    return;
  }
  if (marquee) {
    marquee.x1 = e.offsetX;
    marquee.y1 = e.offsetY;
    draw();
    return;
  }
  if (!drag) {
    const hnd = handleAt(e.offsetX, e.offsetY);
    canvas.style.cursor = spaceHeld ? 'grab' : hnd ? HANDLE_CURSOR[hnd] : 'default';
    return;
  }
  if (drag.kind === 'rot' || drag.kind === 'scale') {
    const v = view(), wco = grbl.status.wco;
    const [mx, my] = v.toMm(e.offsetX, e.offsetY);
    const p = { x: mx - wco.x, y: my - wco.y };
    drag.moved = true;
    drag.lastX = e.offsetX; drag.lastY = e.offsetY;
    if (drag.kind === 'rot') {
      const c = drag.center;
      let deg = ((Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x)) * 180) / Math.PI;
      // Snap the resulting angle: every 15° with Shift, otherwise to 45° steps when within 3°.
      const base = drag.snap.find((s) => s.o.id === selectedId)?.rot ?? 0;
      const target = base + deg;
      const step = e.shiftKey ? 15 : 45;
      const snapped = Math.round(target / step) * step;
      if (e.shiftKey || Math.abs(snapped - target) < 3) deg = snapped - base;
      applyTransform(drag.snap, rotM(deg), c, deg);
    } else {
      const h = drag.handle;
      const A = e.altKey ? drag.center : drag.opp;
      const g = drag.grab;
      const minK = 0.5 / Math.max(1, drag.bb.maxX - drag.bb.minX, drag.bb.maxY - drag.bb.minY);
      const ratio = (cur, grab, anchor) => (Math.abs(grab - anchor) < 1e-9 ? 1 : (cur - anchor) / (grab - anchor));
      let kx = h.includes('e') || h.includes('w') ? ratio(p.x, g.x, A.x) : 1;
      let ky = h.includes('n') || h.includes('s') ? ratio(p.y, g.y, A.y) : 1;
      if (h.length === 2 && !e.shiftKey) {
        // Corners keep proportions: use the drag distance along the diagonal.
        const vx = g.x - A.x, vy = g.y - A.y;
        const k = ((p.x - A.x) * vx + (p.y - A.y) * vy) / (vx * vx + vy * vy || 1);
        kx = ky = k;
      }
      kx = Math.max(minK, kx); ky = Math.max(minK, ky);
      applyTransform(drag.snap, [kx, 0, 0, ky], A, 0);
    }
    renderProps();
    draw();
    return;
  }
  const v = view();
  const [mx, my] = v.toMm(e.offsetX, e.offsetY);
  let ddx = round1(mx - drag.sx), ddy = round1(my - drag.sy);
  if (ddx || ddy) drag.moved = true;
  drag.guides = null;
  if (!e.altKey && drag.bb) {
    const snap = snapDrag(drag.bb, ddx, ddy, 6 / v.s, new Set(drag.objs));
    ddx = snap.dx; ddy = snap.dy; drag.guides = snap.guides;
  }
  drag.objs.forEach((o, i) => { o.x = drag.start[i][0] + ddx; o.y = drag.start[i][1] + ddy; });
  renderProps();
  draw();
});
canvas.addEventListener('pointerup', () => {
  if (pan) { pan = null; canvas.style.cursor = spaceHeld ? 'grab' : 'default'; return; }
  if (marquee) {
    const m = marquee;
    marquee = null;
    if (Math.abs(m.x1 - m.x0) > 3 || Math.abs(m.y1 - m.y0) > 3) {
      const v = view(), wco = grbl.status.wco;
      const [ax, ay] = v.toMm(Math.min(m.x0, m.x1), Math.max(m.y0, m.y1));
      const [bx, by] = v.toMm(Math.max(m.x0, m.x1), Math.min(m.y0, m.y1));
      const box = { minX: ax - wco.x, minY: ay - wco.y, maxX: bx - wco.x, maxY: by - wco.y };
      const touching = m.x1 < m.x0; // right-to-left = anything the box touches, like LightBurn
      const ids = objects.filter((o) => {
        if (!o.geom) return false;
        const r = { minX: o.x, minY: o.y, maxX: o.x + o.geom.width, maxY: o.y + o.geom.height };
        return touching
          ? r.minX <= box.maxX && r.maxX >= box.minX && r.minY <= box.maxY && r.maxY >= box.minY
          : r.minX >= box.minX && r.maxX <= box.maxX && r.minY >= box.minY && r.maxY <= box.maxY;
      }).map((o) => o.id);
      select(m.add ? [...selection, ...ids] : ids);
    }
    refresh();
    return;
  }
  if (drag && (drag.kind === 'rot' || drag.kind === 'scale')) { drag = null; refresh(); return; }
  if (drag && !drag.moved && drag.narrowTo) { select([drag.narrowTo]); refresh(); }
  drag = null;
  draw();
  canvas.style.cursor = 'default';
});

// ---------------------------------------------------------------- zoom

function zoomAt(px, py, factor) {
  const before = view().toMm(px, py);
  cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom * factor));
  cam.panX = 0; cam.panY = 0;
  const [qx, qy] = view().toPx(...before);
  cam.panX = px - qx;
  cam.panY = py - qy;
  draw();
  renderZoom();
}

/** Zoom so a box in machine mm fills the view (with a margin). */
function zoomTo(box) {
  if (!box) return;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  cam.zoom = 1; cam.panX = 0; cam.panY = 0;
  const fit = view().s;
  // Never zoom closer than a 40 mm window, so a tiny item doesn't fill the screen.
  const w = Math.max(40, box.maxX - box.minX), h = Math.max(40, box.maxY - box.minY);
  cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((W * 0.85) / w, (H * 0.85) / h) / fit));
  cam.panX = 0; cam.panY = 0;
  const [cx, cy] = view().toPx((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
  cam.panX = W / 2 - cx;
  cam.panY = H / 2 - cy;
  draw();
  renderZoom();
}
const toMachine = (r) => r && { minX: r.minX + grbl.status.wco.x, maxX: r.maxX + grbl.status.wco.x, minY: r.minY + grbl.status.wco.y, maxY: r.maxY + grbl.status.wco.y };

function renderZoom() { $('zoomPct').textContent = `${Math.round(cam.zoom * 100)}%`; }

// Trackpad: pinch (sent as ctrl+wheel) or ⌘+scroll zooms at the cursor; two-finger scroll pans.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01));
  else { cam.panX -= e.deltaX; cam.panY -= e.deltaY; draw(); }
}, { passive: false });

const stageCenter = () => [canvas.width / dpr / 2, canvas.height / dpr / 2];
$('zoomIn').onclick = () => zoomAt(...stageCenter(), 1.5);
$('zoomOut').onclick = () => zoomAt(...stageCenter(), 1 / 1.5);
$('zoomFit').onclick = () => { cam.zoom = 1; cam.panX = cam.panY = 0; draw(); renderZoom(); };
$('zoomArea').onclick = () => zoomTo(toMachine(areaRect()));
$('zoomSel').onclick = () => zoomTo(toMachine(objsBBox(selection.size ? selectedObjs() : objects)));

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  if (!spaceHeld) { spaceHeld = true; if (!pan) canvas.style.cursor = 'grab'; }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceHeld = false; if (!pan) canvas.style.cursor = 'default'; }
});

// ---------------------------------------------------------------- console

function log(text, cls = 'info') {
  const el = $('log');
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text + '\n';
  el.append(span);
  while (el.childNodes.length > 600) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

grbl.addEventListener('log', (e) => log(e.detail.text, e.detail.dir));
grbl.addEventListener('alarm', (e) => log(`⚠ ${e.detail} – press Home or Unlock.`, 'err'));

$('cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = $('cmdInput').value.trim();
  if (!cmd) return;
  $('cmdInput').value = '';
  grbl.send(cmd).catch((err) => log(err.message, 'err'));
});

// ---------------------------------------------------------------- connection + status

let job = null;

grbl.addEventListener('status', (e) => {
  const st = e.detail;
  const pill = $('statePill');
  pill.textContent = st.state;
  pill.className = `pill ${st.state}`;
  $('posReadout').textContent = grbl.connected
    ? `X ${st.wpos.x.toFixed(2)}  Y ${st.wpos.y.toFixed(2)}`
    : 'X —  Y —';
  if (job) $('pauseBtn').textContent = st.state === 'Hold' ? 'Resume' : 'Pause';
  draw();
});

grbl.addEventListener('connection', (e) => {
  log(e.detail ? 'Connected.' : 'Disconnected.');
  if (e.detail) {
    // Warn about the one setting that makes a laser dangerous: laser mode off keeps it on during travel moves.
    setTimeout(() => {
      if (grbl.settings['32'] === 0) {
        log('Laser mode ($32) is OFF. The laser will be switched on automatically when you start a job.', 'err');
      }
    }, 1500);
  }
  setEnabled();
});

$('connectBtn').onclick = async () => {
  if (grbl.connected) return grbl.disconnect();
  try {
    $('connectBtn').disabled = true;
    $('statePill').textContent = 'Connecting…';
    await refreshPorts();
    const port = preferPort();
    if (port) log(`Connecting to ${port}…`);
    await grbl.connect(Number(profile().baud) || 115200);
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      log(`Could not connect: ${e.message}`, 'err');
      alert(`Could not connect.\n\n${e.message}`);
    }
    $('statePill').textContent = 'Disconnected';
  } finally {
    setEnabled();
  }
};

// Port picker (Electron hands us the list from main.js)
let portAnswered = true;
window.native.onSerialPortList((list) => {
  const sel = $('portList');
  sel.innerHTML = '';
  // Bluetooth headphones and the like show up as serial ports too; only USB ports can be the laser.
  const likely = /usb|wch|serial|modem|ch34|cp21/i;
  list = list.filter((p) => p.usb || likely.test(p.portName));
  list.sort((a, b) => likely.test(b.portName) - likely.test(a.portName));
  for (const p of list) sel.add(new Option(`${p.portName}${p.displayName ? ' – ' + p.displayName : ''}`, p.portId));
  if (sel.options.length) sel.selectedIndex = 0;
  $('portHint').textContent = list.length
    ? 'Usually named “usbserial”, “usbmodem” or “wchusbserial”.'
    : 'No laser found on USB. Check the cable is plugged in at both ends, the laser is switched on, and the cable carries data (some USB cables only charge). Then press Connect again.';
  $('portOk').disabled = !list.length;
  portAnswered = false;
  $('portDialog').showModal();
});
function answerPort(id) {
  if (portAnswered) return;
  portAnswered = true;
  window.native.chooseSerialPort(id);
  if ($('portDialog').open) $('portDialog').close();
}
$('portOk').onclick = () => answerPort($('portList').value);
$('portList').ondblclick = () => answerPort($('portList').value);
$('portCancel').onclick = () => answerPort('');
$('portDialog').addEventListener('close', () => answerPort(''));

function setEnabled() {
  const c = grbl.connected;
  const busy = !!job;
  $('connectBtn').disabled = busy;
  $('connectBtn').textContent = c ? 'Disconnect' : 'Connect';
  $('connectBtn').classList.toggle('primary', !c);
  for (const el of document.querySelectorAll('[data-jog], #homeBtn, #unlockBtn, #setOriginBtn, #clearOriginBtn, #gotoOriginBtn, #fireBtn, #frameBtn, #startBtn')) {
    el.disabled = !c || busy;
  }
  $('unlockBtn').disabled = !c;
  $('pauseBtn').disabled = !busy;
  $('stopBtn').disabled = !c;
  if (!busy) $('pauseBtn').textContent = 'Pause';
  if (!c) { $('statePill').textContent = 'Disconnected'; $('statePill').className = 'pill'; $('posReadout').textContent = 'X —  Y —'; }
}

// ---------------------------------------------------------------- moving

const cmd = (line) => grbl.send(line).catch((e) => log(e.message, 'err'));

function jog(dx, dy) {
  if (!grbl.connected || job) return;
  const step = parseFloat($('jogStep').value);
  const feed = parseFloat($('jogFeed').value) || 3000;
  const parts = [];
  if (dx) parts.push(`X${dx * step}`);
  if (dy) parts.push(`Y${dy * step}`);
  cmd(`$J=G91 G21 ${parts.join(' ')} F${feed}`);
}

for (const b of document.querySelectorAll('[data-jog]')) {
  const [dx, dy] = b.dataset.jog.split(',').map(Number);
  b.onclick = () => jog(dx, dy);
}

$('homeBtn').onclick = () => cmd('$H');
$('unlockBtn').onclick = () => cmd('$X');
$('setOriginBtn').onclick = () => grbl.send('G10 L20 P1 X0 Y0')
  .then(() => log('Origin set at the current laser position.'))
  .catch((e) => log(e.message, 'err'));
$('clearOriginBtn').onclick = () => grbl.send('G10 L2 P1 X0 Y0')
  .then(() => log('Origin reset to machine zero.'))
  .catch((e) => log(e.message, 'err'));
$('gotoOriginBtn').onclick = () => cmd('G90 G0 X0 Y0');

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape' && job) { stopJob(); return; }
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  if (e.key === 'a' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); select(objects.map((o) => o.id)); refresh(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size && !job) { e.preventDefault(); deleteSelection(); return; }
  const keys = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (keys[e.key]) { e.preventDefault(); jog(...keys[e.key]); }
});

// Hold-to-fire for focusing. M3 + G1 (no axis words) keeps a GRBL laser on while stationary.
let firing = false;
let fireTimer = null;
function fireOn() {
  if (firing || !grbl.connected || job || grbl.status.state !== 'Idle') return;
  const maxS = grbl.settings['30'] || profile().maxS;
  const s = Math.max(1, Math.round((Math.min(5, profile().firePower) / 100) * maxS));
  firing = true;
  $('fireBtn').classList.add('on');
  cmd(`G1 F1000 M3 S${s}`);
  fireTimer = setTimeout(fireOff, 15000); // safety: never fire longer than 15 s
}
function fireOff() {
  if (!firing) return;
  firing = false;
  clearTimeout(fireTimer);
  $('fireBtn').classList.remove('on');
  cmd('M5');
}
$('fireBtn').addEventListener('pointerdown', fireOn);
$('fireBtn').addEventListener('pointerup', fireOff);
$('fireBtn').addEventListener('pointerleave', fireOff);
window.addEventListener('blur', fireOff);

// ---------------------------------------------------------------- jobs

// ---- where the job starts

const ORIGIN_NAMES = { tl: 'top left', t: 'top middle', tr: 'top right', l: 'middle left', c: 'middle',
  r: 'middle right', bl: 'bottom left', b: 'bottom middle', br: 'bottom right' };

/** Objects the job will burn: everything, or only the selection when "Burn selected items only" is on. */
function jobObjects() {
  const sel = $('selOnly').checked && selection.size ? objects.filter((o) => selection.has(o.id)) : objects;
  return sel.filter((o) => o.geom && (o.type === 'project' ? o.parts.some((p) => p.cut.enabled) : o.geom.polys?.length));
}

/** The box the job origin refers to: the design area (your card) when it's on, otherwise the design itself. */
function jobRefBox(objs) {
  return areaRect() || objsBBox(objs);
}

/** The job-origin point (work mm) on that box. */
function jobAnchor(box) {
  const k = document.querySelector('input[name=jobOrigin]:checked')?.value || 'bl';
  const x = k.endsWith('l') ? box.minX : k.endsWith('r') ? box.maxX : (box.minX + box.maxX) / 2;
  const y = k.startsWith('t') ? box.maxY : k.startsWith('b') ? box.minY : (box.minY + box.maxY) / 2;
  return { x, y, name: ORIGIN_NAMES[k] };
}

function renderJobOrigin() {
  const current = $('startFrom').value === 'current';
  $('jobOriginRow').classList.toggle('off', !current);
  const a = areaRect() ? 'design area' : 'design';
  const k = document.querySelector('input[name=jobOrigin]:checked')?.value || 'bl';
  $('jobOriginText').textContent = current ? `${ORIGIN_NAMES[k]} of the ${a}` : 'Not used – design burns at its X/Y';
}

async function jobItems() {
  for (const o of objects) { try { await ensureGeom(o); } catch {} }
  const items = jobObjects();
  if (!items.length) return [];

  let sx = 0, sy = 0;
  if ($('startFrom').value === 'current') {
    // Put the chosen job-origin point (e.g. the middle of the card) under the laser head.
    const a = jobAnchor(jobRefBox(items));
    const pos = grbl.connected ? grbl.status.wpos : { x: 0, y: 0 };
    sx = pos.x - a.x;
    sy = pos.y - a.y;
  }
  const out = [];
  const byCut = new Map();
  for (const o of items) {
    const dx = o.x + sx, dy = o.y + sy;
    const move = (polys) => polys.map((p) => p.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })));
    if (o.type === 'project') {
      for (const part of o.parts) {
        const l = part.cut;
        if (!l.enabled) continue;
        if (!byCut.has(l)) {
          byCut.set(l, {
            label: `${files.get(o.fileId)?.name} ${l.name}`, mode: l.mode, interval: l.interval, dither: l.dither,
            power: l.power, minPower: l.minPower, air: l.air, speed: l.speed, passes: l.passes, polys: [], images: [],
          });
          out.push(byCut.get(l));
        }
        const it = byCut.get(l);
        it.polys.push(...move(part.polys));
        it.images.push(...part.images.map((im) => ({ ...im, m: Geometry.mat.mul(Geometry.mat.translate(dx, dy), im.m) })));
      }
    } else {
      out.push({
        label: o.text.replace(/\s+/g, ' ').slice(0, 30), mode: o.mode, interval: o.interval,
        power: o.power, speed: o.speed, passes: o.passes, polys: move(o.geom.polys), images: [],
      });
    }
  }
  return out;
}

function itemsBBox(items) {
  return Geometry.bbox(items.flatMap((it) => [...it.polys, ...it.images.map(Geometry.imageCorners)]));
}

function checkBounds(bb) {
  const wco = grbl.status.wco;
  const p = profile();
  const out = bb.minX + wco.x < -0.5 || bb.minY + wco.y < -0.5 || bb.maxX + wco.x > p.bedW + 0.5 || bb.maxY + wco.y > p.bedH + 0.5;
  return !out || confirm('Part of the design is outside the laser bed. Run anyway?');
}

function ready() {
  if (!grbl.connected) return false;
  if (grbl.status.state !== 'Idle') {
    alert(`The laser is "${grbl.status.state}". It must be Idle – try Home or Unlock first.`);
    return false;
  }
  return true;
}

$('frameBtn').onclick = async () => {
  if (!ready()) return;
  const items = await jobItems();
  if (!items.length) return alert('Add some text first.');
  const bb = itemsBBox(items);
  if (!checkBounds(bb)) return;
  // Faint visible beam: never more than 5 %, so framing can't burn the material.
  const p = profile();
  const maxS = grbl.settings['30'] || p.maxS;
  const s = $('frameLaser').checked ? Math.max(1, Math.round((Math.min(5, p.framePower ?? 1) / 100) * maxS)) : 0;
  for (const l of Geometry.frameGcode(bb, p.frameSpeed, s)) cmd(l);
};

$('saveBtn').onclick = async () => {
  const items = await jobItems();
  if (!items.length) return alert('Add some text first.');
  const saved = await window.native.saveGcode(Geometry.buildGcode(items, gcodeOpts()).join('\n') + '\n');
  if (saved) log(`Saved ${saved}`);
};

$('startBtn').onclick = async () => {
  if (!ready()) return;
  const items = await jobItems();
  if (!items.length) return alert('Add some text first.');
  if (!checkBounds(itemsBBox(items))) return;

  if (grbl.settings['32'] !== undefined && grbl.settings['32'] !== 1) {
    if (!confirm('Laser mode ($32) is OFF on your controller. Without it the laser stays on while travelling between letters.\n\nTurn laser mode on now?')) return;
    try { await grbl.send('$32=1'); } catch (e) { return log(e.message, 'err'); }
  }

  $('jobInfo').textContent = 'Preparing…';
  await new Promise((r) => setTimeout(r, 30));
  const lines = Geometry.buildGcode(items, gcodeOpts()).map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
  job = { total: lines.length, done: 0, start: Date.now() };
  setEnabled();
  log(`Job started – ${lines.length} lines.`);
  updateProgress();

  try {
    // Keep a bounded number of lines queued so huge image jobs don't create a million promises at once.
    const inflight = [];
    let failure = null;
    for (const l of lines) {
      if (failure) throw failure;
      const p = grbl.send(l, { quiet: true }).then(() => { job.done++; if (job.done % 50 === 0) updateProgress(); });
      p.catch((e) => { failure = failure || e; });
      inflight.push(p);
      if (inflight.length > 300) await inflight.shift();
    }
    await Promise.all(inflight);
    updateProgress();
    $('jobInfo').textContent = 'All sent – finishing…';
    await grbl.waitForIdle();
    log(`Job finished in ${formatTime(Date.now() - job.start)}.`);
    $('jobInfo').textContent = `Done in ${formatTime(Date.now() - job.start)}`;
  } catch (e) {
    log(`Job stopped: ${e.message}`, 'err');
    $('jobInfo').textContent = `Stopped: ${e.message}`;
    if (grbl.connected && e.message !== 'Stopped' && e.message !== 'Controller reset') await grbl.stop();
  } finally {
    job = null;
    setEnabled();
  }
};

function updateProgress() {
  if (!job) return;
  $('progress').max = job.total;
  $('progress').value = job.done;
  $('jobInfo').textContent = `${Math.round((job.done / job.total) * 100)}% · ${formatTime(Date.now() - job.start)}`;
}

function formatTime(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function stopJob() {
  fireOff();
  await grbl.stop();
  log('STOP – laser off, motion cancelled.', 'err');
}
$('stopBtn').onclick = stopJob;
$('pauseBtn').onclick = () => {
  if (grbl.status.state === 'Hold') grbl.resume();
  else grbl.pause();
};

// ---------------------------------------------------------------- laser profile dialog

const pForm = $('profileForm');
function openProfileDialog(p) {
  for (const k of ['name', 'bedW', 'bedH', 'maxS', 'baud', 'firePower', 'frameSpeed']) pForm.elements[k].value = p[k];
  pForm.elements.framePower.value = p.framePower ?? 1;
  pForm.dataset.id = p.id || '';
  const so = p.scanOffset || { enabled: false, rows: [] };
  pForm.elements.scanEnabled.checked = !!so.enabled;
  $('scanRows').innerHTML = '';
  for (const r of so.rows) addScanRow(r);
  if (!so.rows.length) addScanRow();
  pForm.elements.airCmd.value = p.airCmd || 'M8';
  $('profileTitle').textContent = p.id ? `Edit device – ${p.name}` : 'Create device manually';
  $('profileDialog').showModal();
}
function addScanRow(r = { speed: '', shift: '', initial: 0 }) {
  const tr = document.createElement('tr');
  for (const [k, step] of [['speed', 100], ['shift', 0.01], ['initial', 0.01]]) {
    const inp = Object.assign(document.createElement('input'), { type: 'number', step, value: r[k] });
    inp.dataset.k = k;
    if (k === 'speed') inp.min = 1;
    const td = document.createElement('td');
    td.append(inp);
    tr.append(td);
  }
  const del = Object.assign(document.createElement('button'), { type: 'button', className: 'small', textContent: '✕', title: 'Remove' });
  del.onclick = () => tr.remove();
  const td = document.createElement('td');
  td.append(del);
  tr.append(td);
  $('scanRows').append(tr);
}
$('scanAdd').onclick = () => addScanRow();

function readScanRows() {
  return [...$('scanRows').rows]
    .map((tr) => Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.dataset.k, parseFloat(i.value)])))
    .filter((r) => r.speed > 0 && Number.isFinite(r.shift))
    .map((r) => ({ speed: r.speed, shift: r.shift, initial: Number.isFinite(r.initial) ? r.initial : 0 }))
    .sort((a, b) => a.speed - b.speed);
}

$('profileCancel').onclick = () => $('profileDialog').close();
$('profileRead').onclick = async () => {
  if (!grbl.connected) return alert('Connect to the laser first.');
  try { await grbl.send('$$'); } catch (e) { return log(e.message, 'err'); }
  const s = grbl.settings;
  if (s['130']) pForm.elements.bedW.value = Math.round(s['130']);
  if (s['131']) pForm.elements.bedH.value = Math.round(s['131']);
  if (s['30']) pForm.elements.maxS.value = s['30'];
};
pForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const el = pForm.elements;
  const data = {
    name: el.name.value.trim() || 'Laser',
    bedW: Number(el.bedW.value), bedH: Number(el.bedH.value), maxS: Number(el.maxS.value),
    baud: Number(el.baud.value), firePower: Number(el.firePower.value), frameSpeed: Number(el.frameSpeed.value),
    framePower: Math.min(5, Number(el.framePower.value) || 1),
    scanOffset: { enabled: el.scanEnabled.checked, rows: readScanRows() },
    airCmd: el.airCmd.value || 'M8',
  };
  const existing = profiles.find((p) => p.id === pForm.dataset.id);
  if (existing) Object.assign(existing, data);
  else { const p = { id: uid(), ...data }; profiles.push(p); devSel = p.id; }
  saveProfiles();
  renderDevices();
  $('profileDialog').close();
});

// ---------------------------------------------------------------- Devices window

let devSel = null;
let findFrom = 0; // Find My Laser resumes here if macOS needed another click

function renderDevices() {
  const ul = $('deviceList');
  ul.innerHTML = '';
  if (!profiles.some((p) => p.id === devSel)) devSel = profile().id;
  for (const p of profiles) {
    const li = h('li', {},
      h('span', { className: 'badge', textContent: 'grbl' }),
      h('span', { className: 'meta' },
        h('b', { textContent: p.name }),
        h('span', { textContent: `GRBL | GCode · ${p.bedW} × ${p.bedH} mm${p.port ? ' · ' + p.port : ''}` })));
    if (p.id === defaultId) li.append(h('span', { className: 'tag', textContent: 'Default' }));
    if (p.id === devSel) li.classList.add('sel');
    li.onclick = () => { devSel = p.id; renderDevices(); };
    li.ondblclick = () => openProfileDialog(p);
    ul.append(li);
  }
  const busy = grbl.connected;
  $('devRemove').disabled = profiles.length < 2;
  $('devFind').disabled = busy;
  $('devFind').title = busy ? 'Disconnect first' : 'Look for a GRBL laser on every USB port';
}

function deviceStatus(text, cls = '') {
  $('deviceStatus').textContent = text;
  $('deviceStatus').className = `muted device-status ${cls}`;
}

$('devicesBtn').onclick = () => {
  devSel = profile().id;
  deviceStatus('');
  renderDevices();
  $('devicesDialog').showModal();
};
$('devCancel').onclick = () => $('devicesDialog').close();
$('devOk').onclick = () => {
  if (devSel && devSel !== profileId) {
    if (grbl.connected) log('Switched device – disconnect and reconnect to use the new settings.', 'err');
    profileId = devSel;
    saveProfiles();
  }
  $('devicesDialog').close();
};
$('devCreate').onclick = () => openProfileDialog({ ...DEFAULT_PROFILE, name: 'GRBL' });
$('devEdit').onclick = () => openProfileDialog(profiles.find((p) => p.id === devSel));
$('devDefault').onclick = () => {
  defaultId = devSel;
  saveProfiles();
  renderDevices();
  deviceStatus('This device will be selected when Laser Studio starts.');
};
$('devRemove').onclick = () => {
  const p = profiles.find((x) => x.id === devSel);
  if (!p || profiles.length < 2 || !confirm(`Remove “${p.name}”?`)) return;
  profiles = profiles.filter((x) => x.id !== p.id);
  if (profileId === p.id) profileId = profiles[0].id;
  if (defaultId === p.id) defaultId = null;
  devSel = profileId;
  saveProfiles();
  renderDevices();
};
$('devExport').onclick = async () => {
  const p = profiles.find((x) => x.id === devSel);
  if (!p) return;
  const { id, ...data } = p;
  const saved = await window.native.exportDevice(p.name, JSON.stringify({ laserStudioDevice: 1, ...data }, null, 2));
  if (saved) deviceStatus(`Exported to ${saved}`);
};
$('devImport').onclick = async () => {
  const text = await window.native.importDevice();
  if (!text) return;
  try {
    const { laserStudioDevice, id, ...data } = JSON.parse(text);
    if (!laserStudioDevice || !(data.bedW > 0) || !(data.bedH > 0)) throw new Error('not a Laser Studio device file');
    const p = { ...DEFAULT_PROFILE, ...data, id: uid() };
    profiles.push(p);
    devSel = p.id;
    saveProfiles();
    renderDevices();
    deviceStatus(`Imported “${p.name}”.`);
  } catch (e) {
    deviceStatus(`Could not import: ${e.message}`, 'err-text');
  }
};

// Try each USB port: connect, read GRBL's settings ($130/$131 bed size, $30 max power), add a device.
$('devFind').onclick = async () => {
  if (grbl.connected) return deviceStatus('Disconnect from the laser first.', 'err-text');
  await refreshPorts();
  if (!usbPorts.length) {
    findFrom = 0;
    return deviceStatus('No laser found on USB. Switch the laser on, check the cable at both ends, and use a cable that carries data (not a charge-only one).', 'err-text');
  }
  $('devFind').disabled = true;
  try {
    for (let i = findFrom; i < usbPorts.length; i++) {
      const port = usbPorts[i];
      for (const baud of [115200, 250000]) {
        deviceStatus(`Trying ${port} at ${baud} baud…`);
        window.native.setPreferredPort(port, true);
        try {
          await grbl.connect(baud);
        } catch (e) {
          if (e.name === 'SecurityError') {
            findFrom = i;
            return deviceStatus(`macOS needs another click to try ${port}. Press Find My Laser again.`, 'err-text');
          }
          continue;
        }
        try { await grbl.send('$$'); } catch {}
        const st = { ...grbl.settings };
        await grbl.disconnect();
        findFrom = 0;
        const p = {
          ...DEFAULT_PROFILE, id: uid(), name: `GRBL (${port.replace(/^cu\./, '')})`, port, baud,
          bedW: st['130'] > 0 ? Math.round(st['130']) : DEFAULT_PROFILE.bedW,
          bedH: st['131'] > 0 ? Math.round(st['131']) : DEFAULT_PROFILE.bedH,
          maxS: st['30'] > 0 ? st['30'] : DEFAULT_PROFILE.maxS,
        };
        profiles.push(p);
        devSel = p.id;
        saveProfiles();
        renderDevices();
        return deviceStatus(`Found a GRBL laser on ${port}: bed ${p.bedW} × ${p.bedH} mm, max power S${p.maxS}. Press OK to use it.`);
      }
    }
    findFrom = 0;
    deviceStatus('Found USB ports, but none answered as a GRBL laser. Is the laser switched on? If LightBurn is open, close it – only one app can use the port at a time.', 'err-text');
  } finally {
    renderDevices();
  }
};
$('profileSelect').onchange = () => { profileId = $('profileSelect').value; saveProfiles(); };

// ---------------------------------------------------------------- start

function renderFrameLaser() {
  $('frameLaserText').textContent = `Laser on while framing (${Math.min(5, profile().framePower ?? 1)}%)`;
}
$('frameLaser').checked = load('ls.frameLaser', false);
$('frameLaser').onchange = () => store('ls.frameLaser', $('frameLaser').checked);
renderFrameLaser();

function renderArea() {
  areaRect();
  for (const [id, k] of [['areaW', 'w'], ['areaH', 'h'], ['areaX', 'x'], ['areaY', 'y']]) {
    if (document.activeElement !== $(id)) $(id).value = area[k] === null ? '' : round1(area[k]);
  }
  $('areaOn').checked = area.on;
  $('areaOn').closest('.area-box').classList.toggle('off', !area.on);
}
$('areaOn').onchange = () => { area.on = $('areaOn').checked; saveArea(); renderArea(); renderJobOrigin(); draw(); };
for (const [id, k] of [['areaW', 'w'], ['areaH', 'h'], ['areaX', 'x'], ['areaY', 'y']]) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value);
    if (!Number.isFinite(v) || ((k === 'w' || k === 'h') && v <= 0)) return;
    area[k] = v;
    saveArea();
    draw();
  });
}
$('areaCenter').onclick = () => { centerArea(); saveArea(); renderArea(); draw(); };
for (const b of document.querySelectorAll('[data-align]')) b.onclick = () => alignSelection(b.dataset.align);

for (const [id, axis] of [['xfW', 'x'], ['xfH', 'y']]) {
  $(id).addEventListener('change', () => {
    const objs = selectedObjs().filter((o) => o.base);
    const bb = objsBBox(objs);
    const v = parseFloat($(id).value);
    if (!bb || !(v > 0)) return renderTransform();
    const cur = axis === 'x' ? bb.maxX - bb.minX : bb.maxY - bb.minY;
    if (!(cur > 0)) return;
    const k = v / cur;
    const lock = $('xfLock').checked;
    transformSelection(axis === 'x' ? [k, 0, 0, lock ? k : 1] : [lock ? k : 1, 0, 0, k]);
  });
}
$('xfRot').addEventListener('change', () => {
  const v = parseFloat($('xfRot').value);
  if (!Number.isFinite(v)) return renderTransform();
  const objs = selectedObjs();
  const deg = objs.length === 1 ? v - (objs[0].rot || 0) : v; // several items: rotate by the amount typed
  transformSelection(rotM(deg), deg);
});
$('xfRotL').onclick = () => transformSelection(rotM(90), 90);
$('xfRotR').onclick = () => transformSelection(rotM(-90), -90);
$('xfFlipH').onclick = () => transformSelection([-1, 0, 0, 1]);
$('xfFlipV').onclick = () => transformSelection([1, 0, 0, -1]);

{
  const saved = load('ls.job', {});
  if (saved.startFrom) $('startFrom').value = saved.startFrom;
  const o = document.querySelector(`input[name=jobOrigin][value="${saved.origin || 'c'}"]`);
  if (o) o.checked = true;
  $('selOnly').checked = !!saved.selOnly;
  const save = () => {
    store('ls.job', { startFrom: $('startFrom').value, selOnly: $('selOnly').checked,
      origin: document.querySelector('input[name=jobOrigin]:checked')?.value });
    renderJobOrigin();
    draw();
  };
  $('startFrom').addEventListener('change', save);
  $('selOnly').addEventListener('change', save);
  for (const r of document.querySelectorAll('input[name=jobOrigin]')) r.addEventListener('change', save);
}

$('addTextBtn').onclick = addText;
bindProps();
renderProfileSelect();
renderPorts();
refreshPorts();
renderArea();
renderZoom();
renderJobOrigin();
setEnabled();
new ResizeObserver(resizeCanvas).observe(canvas);
loadFonts()
  .then(() => log('Ready. Plug in your laser and press Connect.'))
  .catch((e) => log(`Could not load fonts: ${e.message}`, 'err'));
