const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const transcriptEl = $('#transcript');
const pttIndicator = $('#ptt-indicator');
const pttLabel = $('#ptt-label');
const projectSelect = $('#project-select');

let audioCtx = null;
let workletNode = null;
let localStream = null;
let recording = false;
let audioBuffer = new Int16Array(0);
let sendTimer = null;
let peakRms = 0;

const SEND_INTERVAL_MS = 100;
const PTT_GRACE_MS = 500;
const MIN_SPEECH_RMS = 0.015; // below this = silence, don't send

// ── Audio setup ─────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function initAudio() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    audioCtx = new AudioContext({ sampleRate: 24000 });
    const source = audioCtx.createMediaStreamSource(localStream);

    // Filters
    const highpass = audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    highpass.Q.value = 0.7;

    const lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 7000;
    lowpass.Q.value = 0.7;

    source.connect(highpass);
    highpass.connect(lowpass);

    await audioCtx.audioWorklet.addModule('pcm16-processor.js');
    workletNode = new AudioWorkletNode(audioCtx, 'pcm16-processor');
    lowpass.connect(workletNode);

    workletNode.port.onmessage = (e) => {
      if (!recording) return;
      const chunk = new Int16Array(e.data);

      // Track peak RMS to detect silence
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) {
        const s = chunk[i] / 32768;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / chunk.length);
      if (rms > peakRms) peakRms = rms;

      const merged = new Int16Array(audioBuffer.length + chunk.length);
      merged.set(audioBuffer);
      merged.set(chunk, audioBuffer.length);
      audioBuffer = merged;
    };

    sendTimer = setInterval(() => {
      if (audioBuffer.length > 0) {
        window.ptt.sendAudio(arrayBufferToBase64(audioBuffer.buffer));
        audioBuffer = new Int16Array(0);
      }
    }, SEND_INTERVAL_MS);

    console.log('Audio initialized');
  } catch (err) {
    console.error('Audio init failed:', err);
  }
}

// ── PTT ─────────────────────────────────────────────────────────────────────

function startRecording() {
  if (recording) return;
  recording = true;
  audioBuffer = new Int16Array(0);
  peakRms = 0;
  pttIndicator.classList.add('recording');
  pttLabel.textContent = 'Recording...';
  setStatus('recording', 'Recording');
}

function stopRecording() {
  if (!recording) return;
  pttIndicator.classList.remove('recording');
  pttLabel.textContent = 'Sending...';

  setTimeout(() => {
    recording = false;

    // Check if there was actual speech
    if (peakRms < MIN_SPEECH_RMS) {
      console.log(`Silence detected (peak RMS: ${peakRms.toFixed(4)}), discarding`);
      audioBuffer = new Int16Array(0);
      pttLabel.textContent = 'No speech — discarded';
      setStatus('connected', 'Connected');
      setTimeout(() => { pttLabel.textContent = 'Ready'; }, 1500);
      return;
    }

    if (audioBuffer.length > 0) {
      window.ptt.sendAudio(arrayBufferToBase64(audioBuffer.buffer));
      audioBuffer = new Int16Array(0);
    }

    window.ptt.commit();
    pttLabel.textContent = 'Processing...';
    setStatus('processing', 'Processing');
  }, PTT_GRACE_MS);
}

// ── UI ──────────────────────────────────────────────────────────────────────

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
}

function getOrCreateAssistantMsg() {
  const msgs = transcriptEl.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1];
  if (last && last.dataset.streaming === '1') return last.querySelector('div:last-child');

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

// ── IPC listeners ───────────────────────────────────────────────────────────

window.ptt.onPtt((action) => {
  if (action === 'start') startRecording();
  else if (action === 'stop') stopRecording();
});

window.ptt.onStatus((status) => {
  if (status === 'connected') {
    setStatus('connected', 'Connected');
    pttLabel.textContent = 'Ready';
  } else if (status === 'disconnected') {
    setStatus('disconnected', 'Reconnecting...');
  } else if (status === 'processing') {
    setStatus('processing', 'Processing');
  }
});

window.ptt.onTranscript((msg) => {
  appendMessage(msg.role, msg.text);
});

window.ptt.onTool((data) => {
  console.log(`Tool: ${data.name}`, data.result);
  if (data.name === 'switch_active_project' && data.result?.success) {
    loadProjects();
  }
});

window.ptt.onTextDelta((delta) => {
  const body = getOrCreateAssistantMsg();
  body.textContent += delta;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
});

window.ptt.onTextDone(() => {
  const msgs = transcriptEl.querySelectorAll('.msg.assistant[data-streaming="1"]');
  const last = msgs[msgs.length - 1];
  if (last) delete last.dataset.streaming;
});

window.ptt.onError((msg) => {
  console.error('Error:', msg);
});

window.ptt.onActiveProject((name) => {
  for (const opt of projectSelect.options) {
    if (opt.value === name) { opt.selected = true; break; }
  }
  // Brief visual flash to show switch happened
  projectSelect.style.borderColor = '#6c63ff';
  setTimeout(() => { projectSelect.style.borderColor = ''; }, 600);
});

// ── Projects ────────────────────────────────────────────────────────────────

async function loadProjects() {
  const { projects, activeProject } = await window.ptt.getProjects();

  projectSelect.innerHTML = '';
  const claudeProjects = (projects || []).filter((p) => p.hasClaude);

  if (claudeProjects.length === 0) {
    projectSelect.innerHTML = '<option value="">No Claude sessions</option>';
    return;
  }

  for (const proj of claudeProjects) {
    const opt = document.createElement('option');
    opt.value = proj.name;
    opt.textContent = proj.name;
    opt.dataset.path = proj.path || '';
    opt.dataset.session = proj.screenSession || '';
    if (activeProject && proj.name === activeProject.name) opt.selected = true;
    projectSelect.appendChild(opt);
  }
}

projectSelect.addEventListener('change', () => {
  const opt = projectSelect.selectedOptions[0];
  if (!opt || !opt.value) return;
  window.ptt.setActiveProject({
    name: opt.value,
    path: opt.dataset.path || null,
    screenSession: opt.dataset.session || null,
  });
});

// ── Hotkey config ───────────────────────────────────────────────────────────

const hotkeyBtns = document.querySelectorAll('.hotkey-btn');
let capturingWhich = null;

hotkeyBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const which = btn.dataset.which;
    if (capturingWhich === which) {
      capturingWhich = null;
      btn.classList.remove('capturing');
      window.ptt.cancelHotkeyCapture();
      return;
    }
    // Cancel any other capture
    hotkeyBtns.forEach((b) => b.classList.remove('capturing'));
    capturingWhich = which;
    btn.classList.add('capturing');
    btn.querySelector('span').textContent = 'Press any key...';
    window.ptt.startHotkeyCapture(which);
  });
});

window.ptt.onHotkeyCaptured((data) => {
  capturingWhich = null;
  hotkeyBtns.forEach((b) => b.classList.remove('capturing'));
  const nameEl = $(`#hotkey-${data.which}-name`);
  if (nameEl) nameEl.textContent = data.name;
});

// Load current hotkeys on start
window.ptt.getHotkeys().then((data) => {
  $('#hotkey-ptt-name').textContent = data.ptt.name;
  $('#hotkey-switch-name').textContent = data.switch.name;
});

// While capturing, show modifiers being held
document.addEventListener('keydown', (e) => {
  if (!capturingWhich) return;
  e.preventDefault();
  const btn = $(`#hotkey-${capturingWhich}`);
  if (!btn) return;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Cmd');
  if (mods.length > 0) {
    btn.querySelector('span').textContent = mods.join(' + ') + ' + ...';
  }
});

// ── Init ────────────────────────────────────────────────────────────────────

initAudio();
loadProjects();
setInterval(loadProjects, 5000);
