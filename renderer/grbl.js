// GRBL 1.1 controller over the Web Serial API.
// Uses character-counting streaming so GRBL's 128-byte receive buffer stays full during jobs.

const RX_BUFFER = 127;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Grbl extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;
    this.queue = [];     // commands waiting to be sent
    this.inFlight = [];  // commands sent, awaiting ok/error
    this.settings = {};
    this.status = {
      state: 'Disconnected',
      mpos: { x: 0, y: 0 },
      wpos: { x: 0, y: 0 },
      wco: { x: 0, y: 0 },
      feed: 0,
      power: 0,
    };
    this.encoder = new TextEncoder();
    this.bannerWaiter = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect(baudRate) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate, bufferSize: 4096 });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.connected = true;
    this.readLoop();

    // Arduino-based boards reboot when the port opens; wait for the "Grbl x.x" banner.
    // ESP32 / 32-bit boards usually don't reboot, so give up waiting after a moment.
    await this.waitForBanner(2500);
    await this.writeRaw('\r\n');
    await sleep(100);

    this.lastStatusAt = 0;
    this.pollTimer = setInterval(() => this.realtime(0x3f /* ? */), 250);

    // A GRBL controller answers "?" within a few hundred ms. Silence means this port isn't a laser.
    const start = Date.now();
    while (!this.lastStatusAt && Date.now() - start < 3000) await sleep(100);
    if (!this.lastStatusAt) {
      await this.disconnect();
      throw new Error('No reply from a GRBL laser controller on this port. Check it is the laser\'s USB port, the laser is switched on, and the baud rate under “My laser…” is right.');
    }
    this.emit('connection', true);
    try {
      await this.send('$$');
    } catch (e) {
      this.emit('log', { dir: 'err', text: `Could not read settings: ${e.message}` });
    }
  }

  waitForBanner(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.bannerWaiter = null; resolve(false); }, ms);
      this.bannerWaiter = () => { clearTimeout(t); this.bannerWaiter = null; resolve(true); };
    });
  }

  async disconnect() {
    clearInterval(this.pollTimer);
    this.flush('Disconnected');
    this.connected = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.port = this.reader = this.writer = null;
    this.status.state = 'Disconnected';
    this.emit('status', this.status);
    this.emit('connection', false);
  }

  async readLoop() {
    const decoder = new TextDecoder();
    let buf = '';
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch (e) {
      this.emit('log', { dir: 'err', text: `Serial error: ${e.message}` });
    } finally {
      try { this.reader.releaseLock(); } catch {}
      if (this.connected) this.disconnect(); // cable unplugged
    }
  }

  handleLine(line) {
    if (line.startsWith('<') && line.endsWith('>')) {
      this.parseStatus(line);
      return;
    }
    if (line === 'ok' || line.startsWith('error')) {
      const cmd = this.inFlight.shift();
      if (cmd) {
        if (line === 'ok') cmd.resolve(line);
        else cmd.reject(new Error(`${line} on "${cmd.line}"${errorHint(line)}`));
      }
      if (!cmd || !cmd.quiet || line !== 'ok') this.emit('log', { dir: line === 'ok' ? 'ok' : 'err', text: line });
      this.pump();
      return;
    }
    const setting = line.match(/^\$(\d+)=([-\d.]+)/);
    if (setting) this.settings[setting[1]] = Number(setting[2]);

    if (/^Grbl\s/i.test(line)) {
      this.flush('Controller reset');
      this.bannerWaiter?.();
    }
    if (line.startsWith('ALARM')) this.emit('alarm', line);
    this.emit('log', { dir: line.startsWith('ALARM') ? 'err' : 'in', text: line + errorHint(line) });
  }

  parseStatus(line) {
    this.lastStatusAt = Date.now();
    const parts = line.slice(1, -1).split('|');
    const st = this.status;
    st.state = parts[0].split(':')[0];
    let mpos = null;
    let wpos = null;
    for (const p of parts.slice(1)) {
      const [k, v] = p.split(':');
      const n = (v || '').split(',').map(Number);
      if (k === 'MPos') mpos = n;
      else if (k === 'WPos') wpos = n;
      else if (k === 'WCO') st.wco = { x: n[0], y: n[1] };
      else if (k === 'FS' || k === 'F') { st.feed = n[0]; st.power = n[1] || 0; }
    }
    if (mpos) {
      st.mpos = { x: mpos[0], y: mpos[1] };
      st.wpos = { x: mpos[0] - st.wco.x, y: mpos[1] - st.wco.y };
    } else if (wpos) {
      st.wpos = { x: wpos[0], y: wpos[1] };
      st.mpos = { x: wpos[0] + st.wco.x, y: wpos[1] + st.wco.y };
    }
    this.emit('status', st);
  }

  /** Queue a line of G-code / $ command. Resolves on "ok", rejects on "error". */
  send(line, { quiet = false } = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    line = line.trim();
    return new Promise((resolve, reject) => {
      this.queue.push({ line, resolve, reject, quiet });
      if (!quiet) this.emit('log', { dir: 'out', text: line });
      this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      const used = this.inFlight.reduce((n, c) => n + c.line.length + 1, 0);
      const next = this.queue[0];
      if (this.inFlight.length && used + next.line.length + 1 > RX_BUFFER) break;
      this.queue.shift();
      this.inFlight.push(next);
      this.writeRaw(next.line + '\n');
    }
  }

  /** Real-time single-byte commands: ? status, ! hold, ~ resume, 0x18 reset, 0x85 jog cancel. */
  realtime(byte) {
    if (!this.connected || !this.writer) return;
    this.writer.write(new Uint8Array([byte])).catch(() => {});
  }

  async writeRaw(text) {
    if (!this.writer) return;
    try {
      await this.writer.write(this.encoder.encode(text));
    } catch (e) {
      this.emit('log', { dir: 'err', text: `Write failed: ${e.message}` });
    }
  }

  flush(reason) {
    const all = [...this.inFlight, ...this.queue];
    this.inFlight = [];
    this.queue = [];
    for (const c of all) c.reject(new Error(reason));
  }

  pause() { this.realtime(0x21); }  // !
  resume() { this.realtime(0x7e); } // ~

  /** Stop immediately: feed hold first (keeps position), then soft reset (laser off, buffer cleared). */
  async stop() {
    this.realtime(0x21);
    await sleep(200);
    this.realtime(0x18);
    this.flush('Stopped');
  }

  /** Resolves once the machine reports Idle (job motion finished). */
  waitForIdle(timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let seenBusy = false;
      const check = () => {
        if (!this.connected) return reject(new Error('Disconnected'));
        const s = this.status.state;
        if (s !== 'Idle') seenBusy = true;
        if (s === 'Idle' && (seenBusy || Date.now() - start > 600)) return resolve();
        if (s === 'Alarm') return reject(new Error('Alarm'));
        if (timeoutMs && Date.now() - start > timeoutMs) return reject(new Error('Timeout'));
        setTimeout(check, 150);
      };
      check();
    });
  }
}

const GRBL_ERRORS = {
  'error:2': 'bad number format', 'error:9': 'locked (alarm) – press Unlock or Home',
  'error:15': 'jog target outside machine limits', 'error:20': 'unsupported command',
  'ALARM:1': 'hard limit hit – re-home', 'ALARM:2': 'target outside machine limits',
  'ALARM:3': 'reset while moving – re-home or unlock', 'ALARM:8': 'homing failed – switch not cleared',
  'ALARM:9': 'homing failed – switch not found',
};
function errorHint(line) {
  const key = line.split(' ')[0];
  return GRBL_ERRORS[key] ? ` (${GRBL_ERRORS[key]})` : '';
}
