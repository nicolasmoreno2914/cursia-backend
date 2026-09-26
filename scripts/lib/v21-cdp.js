/* eslint-disable */
// Cursia V2.1 / R8 — cliente CDP mínimo (Chrome headless, sin dependencias).
// Patrón de shoot-afix.mjs: user-data-dir PROPIO, puerto de depuración libre.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function launchChrome({ extraArgs = [] } = {}) {
  let port = await freePort();
  if (port === 9334) port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r8-chrome-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`,
      // R13: el gate puede restringir la red de Chrome (solo 127.0.0.1 + hosts de reproducción de YouTube).
      ...(process.env.CURSIA_CHROME_HOST_RESOLVER_RULES ? [`--host-resolver-rules=${process.env.CURSIA_CHROME_HOST_RESOLVER_RULES}`, '--disable-background-networking', '--disable-component-update'] : []),
      ...extraArgs, 'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let wsUrl = null;
  for (let i = 0; i < 75 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) wsUrl = p.webSocketDebuggerUrl;
    } catch (e) {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) {
    proc.kill('SIGKILL');
    throw new Error('CDP no disponible');
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method) listeners.forEach((fn) => fn(m));
  });
  // sessionId opcional (R13): sesiones planas de iframes/workers adjuntados con Target.setAutoAttach.
  const send = (method, params, sessionId) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
    });
  /** Evalúa en la página principal; lanza si hay excepción. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.error) throw new Error(`CDP: ${r.error.message}`);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(`JS: ${(d.exception && d.exception.description) || d.text}`);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  const close = () => {
    try { ws.close(); } catch (e) {}
    try { proc.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {} }, 1500).unref();
  };
  const navigate = async (url, { waitMs = 30000 } = {}) => {
    await send('Page.navigate', { url });
    const t0 = Date.now();
    await sleep(300);
    while (Date.now() - t0 < waitMs) {
      try {
        if ((await evaluate('document.readyState')) === 'complete') return;
      } catch (e) {}
      await sleep(200);
    }
    throw new Error(`timeout cargando ${url}`);
  };
  const screenshot = async (file, { fullPage = false } = {}) => {
    const params = { format: 'png' };
    if (fullPage) params.captureBeyondViewport = true;
    const r = await send('Page.captureScreenshot', params);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  };
  const setViewport = (width, height, mobile = false) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const waitFor = async (expression, { timeoutMs = 30000, stepMs = 250, what = expression } = {}) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeoutMs) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(stepMs);
    }
    throw new Error(`timeout esperando: ${what} (último: ${JSON.stringify(last)})`);
  };
  return { send, evaluate, navigate, screenshot, setViewport, waitFor, close, onEvent: (fn) => listeners.push(fn), port, proc };
}

module.exports = { launchChrome, freePort, sleep };
