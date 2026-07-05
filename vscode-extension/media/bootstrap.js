// Runs before support.js — adapts the Prompt Studio app to the VSCode webview environment.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  window.__vscodeApi = vscode;

  // ---------- localStorage shim (webview storage is unreliable; persist via extension host) ----------
  const store = Object.assign({}, window.__INITIAL_STORAGE__ || {});
  const shim = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); vscode.postMessage({ type: 'persist', key: k, value: String(v) }); },
    removeItem: (k) => { delete store[k]; vscode.postMessage({ type: 'persist', key: k, value: null }); },
    clear: () => {},
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  try { Object.defineProperty(window, 'localStorage', { get: () => shim }); } catch (e) {}

  // ---------- dialog shims (webviews have no alert/prompt/confirm) ----------
  let dialogSeq = 0;
  const pending = new Map();
  window.alert = (message) => { vscode.postMessage({ type: 'alert', message: String(message) }); };
  window.prompt = (message, defaultValue) => new Promise((resolve) => {
    const id = ++dialogSeq;
    pending.set(id, resolve);
    vscode.postMessage({ type: 'prompt', id, message: String(message), value: defaultValue == null ? '' : String(defaultValue) });
  });
  window.confirm = (message) => new Promise((resolve) => {
    const id = ++dialogSeq;
    pending.set(id, resolve);
    vscode.postMessage({ type: 'confirm', id, message: String(message) });
  });

  // ---------- clipboard fallback ----------
  const origWrite = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText.bind(navigator.clipboard) : null;
  const clip = { writeText: (t) => { vscode.postMessage({ type: 'copy', text: String(t) }); return origWrite ? origWrite(t).catch(() => {}) : Promise.resolve(); } };
  try { Object.defineProperty(navigator, 'clipboard', { get: () => clip }); } catch (e) {}

  // ---------- file open/save via extension host ----------
  window.__mpsOpenFile = () => vscode.postMessage({ type: 'openFile' });
  window.__mpsSaveFile = (name, content) => vscode.postMessage({ type: 'saveFile', name, content });

  function loadDoc(name, text) {
    const c = window.__mps;
    if (!c) { setTimeout(() => loadDoc(name, text), 150); return; }
    try { c.stashCurrent(); } catch (e) {}
    const raw = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    c.setState({
      raw, promptName: name || null, tab: 'viewer', mode: 'view',
      deselected: {}, optionSel: {}, collapsed: {}, noOptDismissed: false,
    });
    vscode.postMessage({ type: 'docLoaded' });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'dialogResult') {
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m.value); }
    } else if (m.type === 'loadDoc') {
      loadDoc(m.name, m.text);
    }
  });

  // Signal ready as soon as the app has mounted (window 'load' can be delayed or
  // missed in webviews), and keep 'load' as a fallback.
  let readySent = false;
  function sendReady() { if (readySent) return; readySent = true; vscode.postMessage({ type: 'ready' }); }
  (function waitApp() {
    if (window.__mps) { sendReady(); return; }
    setTimeout(waitApp, 100);
  })();
  window.addEventListener('load', () => { if (window.__mps) sendReady(); });
})();
