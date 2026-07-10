const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const STATE_KEYS = ['mps-state', 'mps-prompts', 'mps-tour-seen'];
let panel = null;
let pendingDoc = null;
let webviewReady = false;

// Decode a markdown file's bytes robustly: handle UTF-16 LE/BE BOMs, strip UTF-8 BOM, normalize line endings.
function decodeDoc(bytes) {
  const buf = Buffer.from(bytes);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.slice(2).toString('utf16le');
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) text = buf.slice(2).swap16().toString('utf16le');
  else text = buf.toString('utf8').replace(/^\uFEFF/, '');
  return text.replace(/\r\n?/g, '\n');
}

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// Strip API keys out of mps-state before it hits globalState; return { cleaned, keys }
function extractKeys(stateJson) {
  const keys = {};
  try {
    const st = JSON.parse(stateJson);
    if (st && st.aiCfg && st.aiCfg.byProvider) {
      for (const [prov, cfg] of Object.entries(st.aiCfg.byProvider)) {
        if (cfg && cfg.apiKey) { keys[prov] = cfg.apiKey; cfg.apiKey = ''; }
      }
    }
    return { cleaned: JSON.stringify(st), keys };
  } catch (e) {
    return { cleaned: stateJson, keys };
  }
}

async function mergeKeys(stateJson, secrets) {
  try {
    const st = JSON.parse(stateJson);
    if (st && st.aiCfg && st.aiCfg.byProvider) {
      for (const [prov, cfg] of Object.entries(st.aiCfg.byProvider)) {
        const k = await secrets.get('mps-apikey-' + prov);
        if (k && cfg) cfg.apiKey = k;
      }
    }
    return JSON.stringify(st);
  } catch (e) {
    return stateJson;
  }
}

async function buildHtml(context, webview) {
  const mediaRoot = vscode.Uri.file(path.join(context.extensionPath, 'media'));
  let html = fs.readFileSync(path.join(context.extensionPath, 'media', 'studio.html'), 'utf8');

  // initial storage: globalState + secrets merged back in
  const init = {};
  for (const k of STATE_KEYS) {
    let v = context.globalState.get('storage:' + k);
    if (typeof v === 'string') {
      if (k === 'mps-state') v = await mergeKeys(v, context.secrets);
      init[k] = v;
    }
  }

  const n = nonce();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${n}' ${webview.cspSource} https://unpkg.com 'unsafe-eval'`,
    `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    `img-src ${webview.cspSource} data: https:`,
    'connect-src https: http://localhost:* http://127.0.0.1:*',
  ].join('; ');

  html = html
    .replace('__CSP__', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('__INIT__', `<script nonce="${n}">window.__INITIAL_STORAGE__ = ${JSON.stringify(init)};</script>`)
    .replace('__BOOTSTRAP__', webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'bootstrap.js')).toString())
    .replace('__SUPPORT_JS__', webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'support.js')).toString())
    .replaceAll('__BRAND_LOGO__', webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'brand-small.png')).toString());
  return html;
}

async function openStudio(context) {
  if (panel) { panel.reveal(); return panel; }
  webviewReady = false;
  panel = vscode.window.createWebviewPanel('mpsStudio', 'Prompt Studio by AMB', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
  });
  panel.onDidDispose(() => { panel = null; webviewReady = false; }, null, context.subscriptions);

  panel.webview.onDidReceiveMessage(async (m) => {
    switch (m.type) {
      case 'ready': {
        webviewReady = true;
        if (pendingDoc) panel.webview.postMessage({ type: 'loadDoc', ...pendingDoc });
        break;
      }
      case 'docLoaded': {
        pendingDoc = null; // webview confirmed it applied the doc
        break;
      }
      case 'persist': {
        if (m.value == null) { await context.globalState.update('storage:' + m.key, undefined); break; }
        if (m.key === 'mps-state') {
          const { cleaned, keys } = extractKeys(m.value);
          for (const [prov, key] of Object.entries(keys)) await context.secrets.store('mps-apikey-' + prov, key);
          await context.globalState.update('storage:mps-state', cleaned);
        } else {
          await context.globalState.update('storage:' + m.key, m.value);
        }
        break;
      }
      case 'alert': vscode.window.showInformationMessage(m.message); break;
      case 'prompt': {
        const value = await vscode.window.showInputBox({ prompt: m.message, value: m.value });
        panel && panel.webview.postMessage({ type: 'dialogResult', id: m.id, value: value === undefined ? null : value });
        break;
      }
      case 'confirm': {
        const pick = await vscode.window.showWarningMessage(m.message, { modal: true }, 'OK');
        panel && panel.webview.postMessage({ type: 'dialogResult', id: m.id, value: pick === 'OK' });
        break;
      }
      case 'copy': await vscode.env.clipboard.writeText(m.text); break;
      case 'openExternal': await vscode.env.openExternal(vscode.Uri.parse(m.url)); break;
      case 'openFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { Markdown: ['md', 'markdown', 'txt'] },
        });
        if (uris && uris[0]) {
          const bytes = await vscode.workspace.fs.readFile(uris[0]);
          const name = path.basename(uris[0].fsPath).replace(/\.(md|markdown|txt)$/i, '');
          panel && panel.webview.postMessage({ type: 'loadDoc', name, text: decodeDoc(bytes) });
        }
        break;
      }
      case 'saveFile': {
        const ws = vscode.workspace.workspaceFolders;
        const def = ws && ws[0] ? vscode.Uri.joinPath(ws[0].uri, m.name) : vscode.Uri.file(path.join(require('os').homedir(), m.name));
        const uri = await vscode.window.showSaveDialog({ defaultUri: def, filters: { Markdown: ['md'] } });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(m.content, 'utf8'));
          vscode.window.showInformationMessage('Saved ' + path.basename(uri.fsPath));
        }
        break;
      }
    }
  }, null, context.subscriptions);

  panel.webview.html = await buildHtml(context, panel.webview);
  return panel;
}

// Resolve a loadable doc from a file URI, or fall back to the active editor.
// Returns { name, text } or null when there's nothing suitable to load.
async function resolveDoc(uri, { requireMarkdown = false } = {}) {
  if (uri && uri.scheme === 'file' && uri.fsPath) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { name: path.basename(uri.fsPath).replace(/\.(md|markdown|txt)$/i, ''), text: decodeDoc(bytes) };
  }
  const ed = vscode.window.activeTextEditor;
  if (!ed || !ed.document) return null;
  const fn = ed.document.fileName || '';
  const isMarkdown = /\.(md|markdown|txt)$/i.test(fn) || ed.document.languageId === 'markdown';
  if (requireMarkdown && !isMarkdown) return null;
  return { name: path.basename(fn).replace(/\.(md|markdown|txt)$/i, ''), text: ed.document.getText() };
}

// Open (or reveal) the studio and load a doc into it, surviving the webview ready handshake.
async function openStudioWithDoc(context, doc) {
  const p = await openStudio(context);
  // keep it pending until the webview acks; post immediately if it's already ready
  pendingDoc = doc;
  if (webviewReady) p.webview.postMessage({ type: 'loadDoc', name: doc.name, text: doc.text });
  return p;
}

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'promptstudiobyamb.open';
  status.text = '$(sparkle) Prompt Studio by AMB';
  status.tooltip = 'Open Prompt Studio by AMB';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('promptstudiobyamb.open', async () => {
      // Fresh open with a markdown file focused → load it, so the status-bar icon shows
      // the file you're looking at. If the studio is already open, just reveal it
      // (never clobber in-progress studio work — use the editor-title icon to swap files).
      if (!panel) {
        const doc = await resolveDoc(null, { requireMarkdown: true });
        if (doc) { await openStudioWithDoc(context, doc); return; }
      }
      await openStudio(context);
    }),
    vscode.commands.registerCommand('promptstudiobyamb.openFile', async (uri) => {
      const doc = await resolveDoc(uri);
      if (!doc) { vscode.window.showWarningMessage('Open a markdown file first.'); return; }
      await openStudioWithDoc(context, doc);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
