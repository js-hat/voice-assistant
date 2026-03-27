/* ────────────────────────────────────────────────────────────
   Push-to-Talk Voice Client
   ──────────────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const transcriptEl = $('#transcript');
const pttBtn = $('#ptt-btn');
const btnConnect = $('#btn-connect');
const projectSelect = $('#project-select');

let ws = null;
let audioCtx = null;
let workletNode = null;
let localStream = null;
let recording = false;
let connected = false;
let audioBuffer = new Int16Array(0);
let sendTimer = null;

const SEND_INTERVAL_MS = 100;

// ── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = text;
}

function appendMessage(role, text) {
  const ph = transcriptEl.querySelector('.placeholder');
  if (ph) ph.remove();

  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? 'You' : 'Assistant';

  const body = document.createElement('div');
  body.textContent = text;

  div.append(label, body);
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return body;
}

function getOrCreateAssistantMsg() {
  const msgs = transcriptEl.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1];
  if (last && last.dataset.streaming === '1') {
    return last.querySelector('div:last-child');
  }
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.dataset.streaming = '1';

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Assistant';

  const body = document.createElement('div');
  div.append(label, body);
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return body;
}

// ── Base64 encoding ─────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Connect ─────────────────────────────────────────────────────────────────

async function connect() {
  try {
    setStatus('connecting', 'Connecting...');
    btnConnect.disabled = true;

    if (!navigator.mediaDevices) {
      setStatus('disconnected', 'HTTPS required');
      alert('Microphone requires HTTPS or localhost. Open via localhost on desktop, or enable HTTPS for mobile.');
      btnConnect.textContent = 'Connect';
      btnConnect.className = 'btn btn-primary';
      btnConnect.disabled = false;
      return;
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    audioCtx = new AudioContext({ sampleRate: 24000 });
    const source = audioCtx.createMediaStreamSource(localStream);

    await audioCtx.audioWorklet.addModule('pcm16-processor.js');
    workletNode = new AudioWorkletNode(audioCtx, 'pcm16-processor');
    source.connect(workletNode);

    workletNode.port.onmessage = (e) => {
      if (!recording) return;
      const chunk = new Int16Array(e.data);
      const merged = new Int16Array(audioBuffer.length + chunk.length);
      merged.set(audioBuffer);
      merged.set(chunk, audioBuffer.length);
      audioBuffer = merged;
    };

    // Send buffered audio at intervals while recording
    sendTimer = setInterval(() => {
      if (audioBuffer.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: arrayBufferToBase64(audioBuffer.buffer),
        }));
        audioBuffer = new Int16Array(0);
      }
    }, SEND_INTERVAL_MS);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      connected = true;
      setStatus('connected', 'Connected');
      pttBtn.disabled = false;
      btnConnect.textContent = 'Disconnect';
      btnConnect.className = 'btn btn-danger';
      btnConnect.disabled = false;
    };

    ws.onmessage = onServerMessage;

    ws.onclose = () => {
      disconnect();
    };

    ws.onerror = () => {
      setStatus('disconnected', 'Connection failed');
      cleanup();
      btnConnect.textContent = 'Connect';
      btnConnect.className = 'btn btn-primary';
      btnConnect.disabled = false;
    };
  } catch (err) {
    console.error('Connection failed:', err);
    setStatus('disconnected', 'Mic denied');
    cleanup();
    btnConnect.textContent = 'Connect';
    btnConnect.className = 'btn btn-primary';
    btnConnect.disabled = false;
  }
}

// ── Server messages ─────────────────────────────────────────────────────────

function onServerMessage(e) {
  let event;
  try {
    event = JSON.parse(e.data);
  } catch {
    return;
  }

  switch (event.type) {
    case 'session.created':
    case 'session.updated':
      break;

    case 'conversation.item.input_audio_transcription.completed':
      if (event.transcript) {
        appendMessage('user', event.transcript);
      }
      break;

    case 'response.created':
      setStatus('processing', 'Processing...');
      break;

    case 'response.done':
      if (connected) setStatus('connected', 'Connected');
      break;

    case 'response.text.delta': {
      const body = getOrCreateAssistantMsg();
      body.textContent += event.delta;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      break;
    }

    case 'response.text.done': {
      const msgs = transcriptEl.querySelectorAll('.msg.assistant[data-streaming="1"]');
      const last = msgs[msgs.length - 1];
      if (last) delete last.dataset.streaming;
      break;
    }

    case 'response.function_call_arguments.done':
      console.log(`Tool: ${event.name}`, event.arguments);
      break;

    case 'tool.result':
      console.log(`Result: ${event.name}`, event.result);
      if (event.name === 'switch_active_project' && event.result?.success) {
        loadProjects();
      }
      break;

    case 'error':
      console.error('API error:', event.error);
      break;
  }
}

// ── PTT ─────────────────────────────────────────────────────────────────────

function startRecording() {
  if (!connected || recording) return;
  recording = true;
  audioBuffer = new Int16Array(0);
  pttBtn.classList.add('recording');
  setStatus('recording', 'Recording...');
}

const PTT_GRACE_MS = 500; // keep capturing audio after button release

function stopRecording() {
  if (!recording) return;
  pttBtn.classList.remove('recording');
  setStatus('processing', 'Sending...');

  // Grace period: mobile audio pipeline has latency,
  // keep accepting audio for 500ms after release, then commit
  setTimeout(() => {
    recording = false;

    // Flush remaining audio
    if (audioBuffer.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: arrayBufferToBase64(audioBuffer.buffer),
      }));
      audioBuffer = new Int16Array(0);
    }

    // Commit and request response
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['text'] },
      }));
    }
    setStatus('processing', 'Processing...');
  }, PTT_GRACE_MS);
}

// ── Mouse side button PTT (button 3 = back, button 4 = forward) ─────────────

const PTT_BUTTONS = new Set([3, 4]); // both side buttons

window.addEventListener('mousedown', (e) => {
  if (PTT_BUTTONS.has(e.button)) {
    e.preventDefault();
    startRecording();
  }
});

window.addEventListener('mouseup', (e) => {
  if (PTT_BUTTONS.has(e.button)) {
    e.preventDefault();
    stopRecording();
  }
});

// Block browser back/forward navigation from side buttons
window.addEventListener('auxclick', (e) => {
  if (PTT_BUTTONS.has(e.button)) e.preventDefault();
});

// PTT button on screen — left click fallback
pttBtn.addEventListener('mousedown', (e) => {
  if (e.button === 0) { e.preventDefault(); startRecording(); }
});
pttBtn.addEventListener('mouseup', (e) => {
  if (e.button === 0) { e.preventDefault(); stopRecording(); }
});

// ── Disconnect / cleanup ────────────────────────────────────────────────────

function cleanup() {
  recording = false;
  connected = false;
  if (sendTimer) {
    clearInterval(sendTimer);
    sendTimer = null;
  }
  audioBuffer = new Int16Array(0);
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  pttBtn.disabled = true;
  pttBtn.classList.remove('recording');
}

function disconnect() {
  cleanup();
  setStatus('disconnected', 'Disconnected');
  btnConnect.textContent = 'Connect';
  btnConnect.className = 'btn btn-primary';
  btnConnect.disabled = false;
}

// ── Connect button ──────────────────────────────────────────────────────────

btnConnect.addEventListener('click', () => {
  if (connected) {
    disconnect();
  } else {
    connect();
  }
});

// ── Projects ────────────────────────────────────────────────────────────────

let activeProjectName = null;

async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { projects, activeProject } = await res.json();

    projectSelect.innerHTML = '';

    if (!projects || projects.length === 0) {
      projectSelect.innerHTML = '<option value="">No projects</option>';
      return;
    }

    const claudeProjects = projects.filter((p) => p.hasClaude);
    if (claudeProjects.length === 0) {
      projectSelect.innerHTML = '<option value="">No Claude sessions</option>';
      return;
    }

    // Restore active
    if (!activeProjectName && activeProject?.name) {
      activeProjectName = activeProject.name;
    }
    if (!activeProjectName && claudeProjects.length > 0) {
      activeProjectName = claudeProjects[0].name;
    }

    for (const proj of claudeProjects) {
      const opt = document.createElement('option');
      opt.value = proj.name;
      opt.textContent = proj.name;
      opt.dataset.path = proj.path || '';
      opt.dataset.session = proj.screenSession || '';
      if (proj.name === activeProjectName) opt.selected = true;
      projectSelect.appendChild(opt);
    }

    projectSelect.disabled = false;
  } catch (err) {
    console.error('Failed to load projects:', err);
    projectSelect.innerHTML = '<option value="">Error loading</option>';
  }
}

projectSelect.addEventListener('change', async () => {
  const opt = projectSelect.selectedOptions[0];
  if (!opt || !opt.value) return;
  activeProjectName = opt.value;
  try {
    await fetch('/api/projects/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: opt.value,
        path: opt.dataset.path || null,
        screenSession: opt.dataset.session || null,
      }),
    });
  } catch (err) {
    console.error('Failed to set active project:', err);
  }
});

loadProjects();
setInterval(loadProjects, 5000);