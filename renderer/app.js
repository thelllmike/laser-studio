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
let profileId = load('ls.profileId', profiles[0].id);
const profile = () => profiles.find((p) => p.id === profileId) || profiles[0];
const gcodeOpts = () => {
  const p = profile();
  return { maxS: grbl.settings['30'] || p.maxS, scanOffset: p.scanOffset, airCmd: p.airCmd || 'M8' };
};

function saveProfiles() {
  store('ls.profiles', profiles);
  store('ls.profileId', profileId);
  renderProfileSelect();
  renderFrameLaser();
  draw();
}

function renderProfileSelect() {
  const sel = $('profileSelect');
  sel.innerHTML = '';
  for (const p of profiles) sel.add(new Option(`${p.name} (${p.bedW}×${p.bedH})`, p.id, false, p.id === profile().id));
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

function objsBBox(objs) {
  const pts = objs.filter((o) => o.geom).map((o) => [{ x: o.x, y: o.y }, { x: o.x + o.geom.width, y: o.y + o.geom.height }]);
  return Geometry.bbox(pts);
}

async function ensureGeom(obj) {
  if (obj.type === 'project') return obj.geom;
  const key = `${obj.text}|${obj.font}|${obj.height}`;
  if (obj.geom && obj.geom.key === key) return obj.geom;
  const font = await getFont(obj.font);
  const g = Geometry.textToPolylines(font, obj.text, obj.height);
  if (`${obj.text}|${obj.font}|${obj.height}` === key) obj.geom = { key, ...g };
  return obj.geom;
}

async function addText() {
  if (!defaultFont) return log('No fonts found on this Mac.', 'err');
  const p = profile();
  const obj = {
    id: uid(), type: 'text', text: 'Hello', font: defaultFont, height: 20,
    x: round1(p.bedW / 2 - 30), y: round1(p.bedH / 2 - 10),
    mode: 'line', power: 80, speed: 1000, passes: 1, interval: 0.1,
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
function renderProps() {
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
      const items = proj.items.map((it) => ({ id: uid(), type: 'project', fileId: f.id, ...it }));
      objects.push(...items);
      select(items.map((o) => o.id));
      const bb = objsBBox(items);
      const summary = f.cuts.map((l) => `${l.name} ${MODE_LABEL[l.mode]} ${l.power}% ${l.speed}mm/min`).join(' · ');
      log(`Imported "${f.name}" – ${items.length} items, ${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} mm. Layers: ${summary}`);
      if (f.skipped.length) log(`Skipped: ${f.skipped.join(', ')}`, 'err');
      const p = profile();
      if (bb.minX < 0 || bb.minY < 0 || bb.maxX > p.bedW || bb.maxY > p.bedH) {
        log(`Kept LightBurn's position, but part of it is outside your ${p.bedW}×${p.bedH} bed. ` +
          'Click an item to move it on its own, check your bed size under “My laser…”, or turn off layers you don\'t need.', 'err');
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

function view() {
  const W = canvas.width / dpr, H = canvas.height / dpr;
  const p = profile();
  const m = 40;
  const s = Math.max(0.01, Math.min((W - 2 * m) / p.bedW, (H - 2 * m) / p.bedH));
  const ox = (W - p.bedW * s) / 2;
  const oy = (H + p.bedH * s) / 2;
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
  for (let x = 0; x <= p.bedW; x += 10) {
    ctx.strokeStyle = x % 50 === 0 ? '#3a3e46' : '#2b2e34';
    const [px] = v.toPx(x, 0);
    line(px, by0, px, by0 + p.bedH * v.s);
  }
  for (let y = 0; y <= p.bedH; y += 10) {
    ctx.strokeStyle = y % 50 === 0 ? '#3a3e46' : '#2b2e34';
    const [, py] = v.toPx(0, y);
    line(bx0, py, bx0 + p.bedW * v.s, py);
  }
  ctx.strokeStyle = '#4b5058';
  ctx.strokeRect(bx0, by0, p.bedW * v.s, p.bedH * v.s);
  ctx.fillStyle = '#6b7079';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  for (let x = 0; x <= p.bedW; x += 50) { const [px, py] = v.toPx(x, 0); ctx.fillText(String(x), px, py + 14); }
  ctx.textAlign = 'right';
  for (let y = 50; y <= p.bedH; y += 50) { const [px, py] = v.toPx(0, y); ctx.fillText(String(y), px - 5, py + 3); }

  const wco = grbl.status.wco;

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
canvas.addEventListener('pointerdown', (e) => {
  const v = view();
  const [mx, my] = v.toMm(e.offsetX, e.offsetY);
  const wco = grbl.status.wco;
  const dx = mx - wco.x, dy = my - wco.y;
  const tol = 6 / v.s;
  const hits = objects.filter((o) => o.geom &&
    dx >= o.x - tol && dx <= o.x + o.geom.width + tol && dy >= o.y - tol && dy <= o.y + o.geom.height + tol);
  const hit = hits.sort((a, b) => a.geom.width * a.geom.height - b.geom.width * b.geom.height)[0];
  if (!hit) select([]);
  else if (e.shiftKey || e.metaKey) toggleSelect(hit.id);
  else if (!selection.has(hit.id)) select([hit.id]);
  else selectedId = hit.id;
  if (hit && selection.has(hit.id)) {
    const objs = selectedObjs();
    // A click (no drag) on an item inside a bigger selection narrows the selection to that item.
    const narrowTo = !(e.shiftKey || e.metaKey) && selection.size > 1 ? hit.id : null;
    drag = { objs, start: objs.map((o) => [o.x, o.y]), sx: mx, sy: my, moved: false, narrowTo };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  }
  refresh();
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [mx, my] = view().toMm(e.offsetX, e.offsetY);
  const ddx = round1(mx - drag.sx), ddy = round1(my - drag.sy);
  if (ddx || ddy) drag.moved = true;
  drag.objs.forEach((o, i) => { o.x = drag.start[i][0] + ddx; o.y = drag.start[i][1] + ddy; });
  renderProps();
  draw();
});
canvas.addEventListener('pointerup', () => {
  if (drag && !drag.moved && drag.narrowTo) { select([drag.narrowTo]); refresh(); }
  drag = null;
  canvas.style.cursor = 'default';
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
    await grbl.connect(Number(profile().baud) || 115200);
  } catch (e) {
    if (e.name !== 'NotFoundError') log(`Could not connect: ${e.message}`, 'err');
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
  const likely = /usb|wch|serial|modem|ch34|cp21/i;
  list.sort((a, b) => likely.test(b.portName) - likely.test(a.portName));
  for (const p of list) sel.add(new Option(`${p.portName}${p.displayName ? ' – ' + p.displayName : ''}`, p.portId));
  if (sel.options.length) sel.selectedIndex = 0;
  $('portHint').textContent = list.length
    ? 'Usually named “usbserial”, “usbmodem” or “wchusbserial”.'
    : 'No USB serial device found. Plug in the laser (and install the CH340 driver if needed), then try again.';
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

async function jobItems() {
  const items = [];
  for (const o of objects) {
    try { await ensureGeom(o); } catch { continue; }
    if (o.type === 'project' ? o.parts.some((p) => p.cut.enabled) : o.geom?.polys.length) items.push(o);
  }
  if (!items.length) return [];

  let sx = 0, sy = 0;
  if ($('startFrom').value === 'current') {
    // Put the design's bottom-left corner at the laser head.
    const minX = Math.min(...items.map((o) => o.x));
    const minY = Math.min(...items.map((o) => o.y));
    const pos = grbl.connected ? grbl.status.wpos : { x: 0, y: 0 };
    sx = pos.x - minX;
    sy = pos.y - minY;
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
  $('profileDelete').disabled = !p.id || profiles.length < 2;
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

$('editProfileBtn').onclick = () => openProfileDialog(profile());
$('profileNew').onclick = () => openProfileDialog({ ...DEFAULT_PROFILE, name: 'New laser' });
$('profileCancel').onclick = () => $('profileDialog').close();
$('profileDelete').onclick = () => {
  if (!confirm('Delete this laser profile?')) return;
  profiles = profiles.filter((p) => p.id !== pForm.dataset.id);
  profileId = profiles[0].id;
  saveProfiles();
  $('profileDialog').close();
};
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
  else { const p = { id: uid(), ...data }; profiles.push(p); profileId = p.id; }
  saveProfiles();
  $('profileDialog').close();
});
$('profileSelect').onchange = () => { profileId = $('profileSelect').value; saveProfiles(); };

// ---------------------------------------------------------------- start

function renderFrameLaser() {
  $('frameLaserText').textContent = `Laser on while framing (${Math.min(5, profile().framePower ?? 1)}%)`;
}
$('frameLaser').checked = load('ls.frameLaser', false);
$('frameLaser').onchange = () => store('ls.frameLaser', $('frameLaser').checked);
renderFrameLaser();

$('addTextBtn').onclick = addText;
bindProps();
renderProfileSelect();
setEnabled();
new ResizeObserver(resizeCanvas).observe(canvas);
loadFonts()
  .then(() => log('Ready. Plug in your laser and press Connect.'))
  .catch((e) => log(`Could not load fonts: ${e.message}`, 'err'));
