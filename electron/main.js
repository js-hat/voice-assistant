const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const WebSocket = require('ws');
const path = require('path');
const { execFile, exec, spawn } = require('child_process');
const { promisify } = require('util');
const { existsSync } = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const execAsync = promisify(exec);

// ── Config ──────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini';
const VOICE = process.env.OPENAI_VOICE || 'marin';
const INSTRUCTIONS = process.env.ASSISTANT_INSTRUCTIONS ||
  'Ты — голосовой мост. Твоя единственная задача — вызывать инструменты. СТРОГО ЗАПРЕЩЕНО: отвечать текстом, перефразировать, дополнять, переводить, интерпретировать. Когда пользователь говорит что-либо — вызови run_claude и передай его слова ДОСЛОВНО в параметре "prompt". Копируй речь пользователя один-к-одному, без изменений. Один вызов на одно сообщение — никогда не вызывай run_claude дважды подряд.';

const MOUSE_BUTTON_NAMES = { 1: 'LMB', 2: 'RMB', 3: 'Middle Click', 4: 'Mouse Back', 5: 'Mouse Forward' };

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

// ── Tools (inline, same as shared/tools.js) ─────────────────────────────────

const PROJECTS_BASE = path.dirname(path.join(__dirname, '..'));

let activeProject = { name: null, path: null, screenSession: null };

function resolveProjectPath(windowTitle) {
  const projectName = windowTitle.split(' – ')[0].trim();
  const candidate = path.join(PROJECTS_BASE, projectName);
  if (existsSync(candidate)) return { name: projectName, path: candidate };
  return { name: projectName, path: null };
}

async function getClaudeScreenMap() {
  const map = new Map();
  try {
    const { stdout } = await execAsync('screen -ls 2>&1 || true');
    const re = /(\d+)\.(claude\S*)\s+\((Attached|Detached)\)/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      const screenPid = m[1];
      const sessionId = `${m[1]}.${m[2]}`;
      const attached = m[3] === 'Attached';
      try {
        const { stdout: children } = await execAsync(`pgrep -P ${screenPid} 2>/dev/null`);
        for (const childPid of children.trim().split('\n').filter(Boolean)) {
          const gcResult = await execAsync(`pgrep -P ${childPid} 2>/dev/null`).catch(() => ({ stdout: '' }));
          for (const gpid of gcResult.stdout.trim().split('\n').filter(Boolean)) {
            const lsofResult = await execAsync(`lsof -a -p ${gpid} -d cwd -Fn 2>/dev/null`).catch(() => ({ stdout: '' }));
            const cwdLine = lsofResult.stdout.split('\n').find((l) => l.startsWith('n/'));
            if (cwdLine) {
              const cwd = cwdLine.slice(1);
              if (!map.has(cwd) || attached) map.set(cwd, sessionId);
            }
          }
        }
      } catch {}
    }
  } catch {}
  return map;
}

async function detectProjects() {
  const projects = [];
  let windows = [];
  let screenMap = new Map();

  try {
    const [windowsResult, mapResult] = await Promise.allSettled([
      execAsync(`osascript -e 'tell application "System Events" to tell process "WebStorm" to get name of every window'`),
      getClaudeScreenMap(),
    ]);
    if (windowsResult.status === 'fulfilled') windows = windowsResult.value.stdout.trim().split(', ').filter(Boolean);
    if (mapResult.status === 'fulfilled') screenMap = mapResult.value;
  } catch { return projects; }

  for (const win of windows) {
    const resolved = resolveProjectPath(win);
    if (!resolved.name) continue;
    let hasClaude = false, screenSession = null;
    for (const [cwd, session] of screenMap) {
      if (resolved.path && (cwd === resolved.path || cwd.startsWith(resolved.path + '/'))) {
        hasClaude = true; screenSession = session; break;
      }
      if (!resolved.path && cwd.split('/').pop() === resolved.name) {
        hasClaude = true; screenSession = session; resolved.path = cwd; break;
      }
    }
    projects.push({ name: resolved.name, path: resolved.path, window: win, hasClaude, screenSession });
  }
  return projects;
}

const TOOL_DEBOUNCE_MS = 2000;
let lastRunClaudeTime = 0;
const CYCLE_DEBOUNCE_MS = 600;
let lastCycleTime = 0;

const tools = [
  {
    definition: { type: 'function', name: 'switch_active_project', description: 'Переключает активный проект. Вызывай ТОЛЬКО когда пользователь явно просит сменить проект.', parameters: { type: 'object', properties: { project_name: { type: 'string' } }, required: ['project_name'] } },
    handler: async ({ project_name }) => {
      const projects = await detectProjects();
      const query = project_name.toLowerCase();
      const target = projects.find((p) => p.name.toLowerCase().includes(query));
      if (!target) return { success: false, error: `Project "${project_name}" not found`, silent: true };
      activeProject = { name: target.name, path: target.path, screenSession: target.screenSession };
      return { success: true, project: target.name, silent: true };
    },
  },
  {
    definition: { type: 'function', name: 'run_claude', description: 'ИНСТРУМЕНТ ПО УМОЛЧАНИЮ. Передаёт речь пользователя дословно в Claude Code. Вызывай для ВСЕГО, что не подходит под другие инструменты.', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
    handler: async ({ prompt }) => {
      const now = Date.now();
      if (now - lastRunClaudeTime < TOOL_DEBOUNCE_MS) return { success: false, error: 'Debounced', silent: true };
      lastRunClaudeTime = now;
      const session = activeProject.screenSession;
      if (!session) return { success: false, error: 'No screen session', silent: true };
      await execAsync(`screen -S ${session} -X stuff $'${prompt.replace(/'/g, "'\\''")}\r'`);
      return { success: true, silent: true };
    },
  },
  {
    definition: { type: 'function', name: 'confirm_claude', description: 'Нажимает Enter для подтверждения. Вызывай ТОЛЬКО для коротких подтверждений: "да", "подтверди", "давай", "окей".', parameters: { type: 'object', properties: {}, required: [] } },
    handler: async () => {
      const session = activeProject.screenSession;
      if (!session) return { success: false, error: 'No screen session', silent: true };
      await execAsync(`screen -S ${session} -X stuff $'\\r'`);
      return { success: true, silent: true };
    },
  },
  {
    definition: { type: 'function', name: 'interrupt_claude', description: 'Прерывает текущую задачу нажатием Escape. Вызывай ТОЛЬКО для команд остановки: "стоп", "прерви", "хватит", "отмена".', parameters: { type: 'object', properties: {}, required: [] } },
    handler: async () => {
      const session = activeProject.screenSession;
      if (!session) return { success: false, error: 'No screen session', silent: true };
      await execAsync(`screen -S ${session} -X stuff $'\\033'`);
      return { success: true, silent: true };
    },
  },
];

const toolDefs = tools.map((t) => t.definition);
const handlerMap = new Map(tools.map((t) => [t.definition.name, t.handler]));

async function executeTool(name, args) {
  const handler = handlerMap.get(name);
  if (!handler) return { error: `Unknown tool: ${name}` };
  const parsed = typeof args === 'string' ? JSON.parse(args) : args;
  return handler(parsed);
}

// ── OpenAI Realtime WS ─────────────────────────────────────────────────────

let openaiWs = null;
let win = null;

function connectOpenAI() {
  openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
  });

  openaiWs.on('open', () => {
    console.log('OpenAI connected');
    sendToRenderer('status', 'connected');

    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: INSTRUCTIONS,
        tools: toolDefs,
        tool_choice: 'required',
        temperature: 0.6,
        input_audio_format: 'pcm16',
        input_audio_transcription: { model: 'gpt-4o-transcribe' },
        turn_detection: null,
      },
    }));
  });

  openaiWs.on('message', async (data) => {
    let event;
    try { event = JSON.parse(data.toString()); } catch { return; }

    switch (event.type) {
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) sendToRenderer('transcript', { role: 'user', text: event.transcript });
        break;

      case 'response.function_call_arguments.done': {
        const { call_id, name, arguments: args } = event;
        let result;
        try { result = await executeTool(name, typeof args === 'string' ? JSON.parse(args) : args); }
        catch (err) { result = { error: err.message }; }

        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id, output: JSON.stringify(result) },
        }));

        if (!result.silent) {
          openaiWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text'] } }));
        }

        sendToRenderer('tool', { name, result });
        break;
      }

      case 'response.text.delta':
        sendToRenderer('text-delta', event.delta);
        break;

      case 'response.text.done':
        sendToRenderer('text-done', null);
        break;

      case 'response.created':
        sendToRenderer('status', 'processing');
        break;

      case 'response.done':
        sendToRenderer('status', 'connected');
        break;

      case 'error':
        console.error('OpenAI error:', event.error);
        sendToRenderer('error', event.error?.message || 'Unknown error');
        break;
    }
  });

  openaiWs.on('close', () => {
    console.log('OpenAI disconnected');
    sendToRenderer('status', 'disconnected');
    // Reconnect after 3s
    setTimeout(connectOpenAI, 3000);
  });

  openaiWs.on('error', (err) => {
    console.error('OpenAI WS error:', err.message);
  });
}

function sendToOpenAI(event) {
  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
    openaiWs.send(JSON.stringify(event));
  }
}

function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
  // Update tray on status changes
  if (tray) {
    if (channel === 'status') { trayStatus = data; updateTray(); }
    if (channel === 'ptt') { trayStatus = data === 'start' ? 'recording' : 'connected'; updateTray(); }
    if (channel === 'active-project') { updateTray(); }
  }
}

// ── IPC from renderer ───────────────────────────────────────────────────────

ipcMain.on('audio', (_e, base64) => {
  sendToOpenAI({ type: 'input_audio_buffer.append', audio: base64 });
});

ipcMain.on('commit', () => {
  sendToOpenAI({ type: 'input_audio_buffer.commit' });
  sendToOpenAI({ type: 'response.create', response: { modalities: ['text'] } });
});

ipcMain.handle('get-projects', async () => {
  const projects = await detectProjects();
  return { projects, activeProject };
});

ipcMain.on('set-active-project', (_e, { name, path: p, screenSession }) => {
  activeProject = { name, path: p, screenSession };
});

// ── Global PTT via uiohook (keyboard + mouse) ──────────────────────────────

// ── Hotkey combo system ──────────────────────────────────────────────────────

const KEY_NAMES = {};
for (const [name, code] of Object.entries(UiohookKey)) {
  KEY_NAMES[code] = name;
}

const MODIFIER_KEYCODES = new Set([
  UiohookKey.Shift, UiohookKey.ShiftRight,
  UiohookKey.Ctrl, UiohookKey.CtrlRight,
  UiohookKey.Alt, UiohookKey.AltRight,
  UiohookKey.Meta, UiohookKey.MetaRight,
]);

const MODIFIER_LABELS = {
  [UiohookKey.Shift]: 'Shift', [UiohookKey.ShiftRight]: 'Shift',
  [UiohookKey.Ctrl]: 'Ctrl', [UiohookKey.CtrlRight]: 'Ctrl',
  [UiohookKey.Alt]: 'Alt', [UiohookKey.AltRight]: 'Alt',
  [UiohookKey.Meta]: 'Cmd', [UiohookKey.MetaRight]: 'Cmd',
};

// A hotkey combo: { modifiers: Set<keycode>, key: keycode|null }
// e.g. Alt+Shift+F → { modifiers: {Alt, Shift}, key: F }
// or just Backtick → { modifiers: {}, key: Backtick }
let pttCombo = { modifiers: new Set(), key: 41, mouseButton: null }; // default: backtick
let switchCombo = { modifiers: new Set([UiohookKey.Alt]), key: 15, mouseButton: null }; // default: Alt+Tab

let capturingHotkey = null; // null | 'ptt' | 'switch'
let captureModifiers = new Set();
let captureCompletedAt = 0;

const pressedKeys = new Set(); // track currently held keys
let pttMouseActive = false;

function comboToName(combo) {
  const parts = [];
  for (const mod of combo.modifiers) {
    const label = MODIFIER_LABELS[mod];
    if (label && !parts.includes(label)) parts.push(label);
  }
  if (combo.mouseButton != null) {
    parts.push(MOUSE_BUTTON_NAMES[combo.mouseButton] || `Mouse${combo.mouseButton}`);
  } else if (combo.key !== null) {
    parts.push(KEY_NAMES[combo.key] || `Key${combo.key}`);
  }
  return parts.join(' + ') || '(none)';
}

function comboMatches(combo, keycode) {
  if (Date.now() - captureCompletedAt < 500) return false;
  if (combo.key !== keycode) return false;
  for (const mod of combo.modifiers) {
    if (!pressedKeys.has(mod)) {
      // Check both left/right variants
      const pairs = [
        [UiohookKey.Shift, UiohookKey.ShiftRight],
        [UiohookKey.Ctrl, UiohookKey.CtrlRight],
        [UiohookKey.Alt, UiohookKey.AltRight],
        [UiohookKey.Meta, UiohookKey.MetaRight],
      ];
      const pair = pairs.find(([a, b]) => a === mod || b === mod);
      if (!pair || (!pressedKeys.has(pair[0]) && !pressedKeys.has(pair[1]))) return false;
    }
  }
  return true;
}

function comboMatchesMouse(combo, button) {
  if (Date.now() - captureCompletedAt < 500) return false;
  if (combo.mouseButton == null || combo.mouseButton !== button) return false;
  for (const mod of combo.modifiers) {
    if (!pressedKeys.has(mod)) {
      const pairs = [
        [UiohookKey.Shift, UiohookKey.ShiftRight],
        [UiohookKey.Ctrl, UiohookKey.CtrlRight],
        [UiohookKey.Alt, UiohookKey.AltRight],
        [UiohookKey.Meta, UiohookKey.MetaRight],
      ];
      const pair = pairs.find(([a, b]) => a === mod || b === mod);
      if (!pair || (!pressedKeys.has(pair[0]) && !pressedKeys.has(pair[1]))) return false;
    }
  }
  return true;
}

function comboToData(combo) {
  return { modifiers: [...combo.modifiers], key: combo.key, mouseButton: combo.mouseButton ?? null, name: comboToName(combo) };
}

function dataToCombo(data) {
  return { modifiers: new Set(data.modifiers), key: data.key, mouseButton: data.mouseButton ?? null };
}

ipcMain.on('start-hotkey-capture', (_e, which) => {
  capturingHotkey = which;
  captureModifiers = new Set();
  console.log(`Hotkey capture (${which}) — press combo...`);
});

ipcMain.on('cancel-hotkey-capture', () => {
  capturingHotkey = null;
  captureModifiers.clear();
});

ipcMain.handle('get-hotkeys', () => ({
  ptt: comboToData(pttCombo),
  switch: comboToData(switchCombo),
}));

async function cycleProject() {
  const now = Date.now();
  if (now - lastCycleTime < CYCLE_DEBOUNCE_MS) return;
  lastCycleTime = now;

  const projects = await detectProjects();
  const withClaude = projects.filter((p) => p.hasClaude);
  if (withClaude.length <= 1) return;

  const currentIdx = withClaude.findIndex((p) => p.name === activeProject.name);
  const nextIdx = (currentIdx + 1) % withClaude.length;
  const next = withClaude[nextIdx];

  activeProject = { name: next.name, path: next.path, screenSession: next.screenSession };
  console.log(`Switched to: ${next.name}`);
  sendToRenderer('active-project', next.name);
}

function setupInputHook() {
  uIOhook.on('keydown', (e) => {
    pressedKeys.add(e.keycode);

    // Capture mode
    if (capturingHotkey) {
      if (MODIFIER_KEYCODES.has(e.keycode)) {
        captureModifiers.add(e.keycode);
        return;
      }
      // Non-modifier key pressed — finalize combo
      const which = capturingHotkey;
      capturingHotkey = null;
      const combo = { modifiers: new Set(captureModifiers), key: e.keycode, mouseButton: null };
      captureModifiers.clear();

      if (which === 'ptt') pttCombo = combo;
      else if (which === 'switch') switchCombo = combo;

      const name = comboToName(combo);
      console.log(`${which} hotkey set: ${name}`);
      sendToRenderer('hotkey-captured', { which, ...comboToData(combo) });
      captureCompletedAt = Date.now();
      return;
    }

    // PTT start
    if (comboMatches(pttCombo, e.keycode)) sendToRenderer('ptt', 'start');
    // Switch project
    if (comboMatches(switchCombo, e.keycode)) cycleProject();
  });

  uIOhook.on('keyup', (e) => {
    pressedKeys.delete(e.keycode);

    // PTT stop — release main key OR any modifier in the combo
    if (e.keycode === pttCombo.key || pttCombo.modifiers.has(e.keycode)) {
      sendToRenderer('ptt', 'stop');
    }
  });

  uIOhook.on('mousedown', (e) => {
    if (capturingHotkey) {
      if (e.button === 1) return; // ignore left click (UI interaction)
      const which = capturingHotkey;
      capturingHotkey = null;
      const combo = { modifiers: new Set(captureModifiers), key: null, mouseButton: e.button };
      captureModifiers.clear();

      if (which === 'ptt') pttCombo = combo;
      else if (which === 'switch') switchCombo = combo;

      const name = comboToName(combo);
      console.log(`${which} hotkey set: ${name}`);
      sendToRenderer('hotkey-captured', { which, ...comboToData(combo) });
      captureCompletedAt = Date.now();
      return;
    }

    if (comboMatchesMouse(pttCombo, e.button)) {
      if (pttMouseActive) {
        pttMouseActive = false;
        sendToRenderer('ptt', 'stop');
      } else {
        pttMouseActive = true;
        sendToRenderer('ptt', 'start');
      }
    }
    if (comboMatchesMouse(switchCombo, e.button)) cycleProject();
  });

  uIOhook.start();
  console.log(`Global input hook active. PTT: ${comboToName(pttCombo)}, Switch: ${comboToName(switchCombo)}`);
}

// ── Tray ─────────────────────────────────────────────────────────────────────

let tray = null;
let trayStatus = 'disconnected';

const STATUS_ICONS = {
  disconnected: '⏹',
  connected:    '🟢',
  recording:    '🔴',
  processing:   '🟡',
};

function updateTray() {
  if (!tray) return;

  const icon = STATUS_ICONS[trayStatus] || STATUS_ICONS.disconnected;
  const project = activeProject.name || '—';
  tray.setTitle(`${icon} ${project}`);
  tray.setToolTip(`PTT Voice — ${project}`);

  updateTrayMenu();
}

async function updateTrayMenu() {
  const projects = await detectProjects().catch(() => []);
  const claudeProjects = projects.filter((p) => p.hasClaude);

  const projectItems = claudeProjects.map((p) => ({
    label: p.name,
    type: 'radio',
    checked: p.name === activeProject.name,
    click: () => {
      activeProject = { name: p.name, path: p.path, screenSession: p.screenSession };
      sendToRenderer('active-project', p.name);
      updateTray();
    },
  }));

  const menu = Menu.buildFromTemplate([
    { label: `PTT: ${comboToName(pttCombo)}`, enabled: false },
    { label: `Switch: ${comboToName(switchCombo)}`, enabled: false },
    { type: 'separator' },
    ...(projectItems.length > 0
      ? [{ label: 'Projects', submenu: projectItems }]
      : [{ label: 'No Claude sessions', enabled: false }]),
    { type: 'separator' },
    { label: 'Show window', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ── Electron app ────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 600,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f13',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Hide to tray instead of closing
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

app.whenReady().then(() => {
  // Create tray (1x1 transparent icon — status shown via title text)
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('⏹ Starting...');
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  updateTray();

  createWindow();
  connectOpenAI();
  setupInputHook();

  // Auto-select first project with Claude
  detectProjects().then((projects) => {
    const withClaude = projects.find((p) => p.hasClaude);
    if (withClaude) {
      activeProject = { name: withClaude.name, path: withClaude.path, screenSession: withClaude.screenSession };
      sendToRenderer('active-project', activeProject.name);
      updateTray();
    }
  });
});

app.isQuitting = false;

app.on('before-quit', () => {
  app.isQuitting = true;
  uIOhook.stop();
  if (openaiWs) openaiWs.close();
});

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
});
