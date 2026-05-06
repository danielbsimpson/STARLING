// ── Config ────────────────────────────────────────────────────────────────────
const OLLAMA_BASE  = 'http://localhost:11434';
const BACKEND_BASE = 'http://localhost:8000';
const MODEL        = localStorage.getItem('starling_model') || 'llama3.1:8b';
const SYSTEM_PROMPT =
  'You are S.T.A.R.L.I.N.G. (Speech‑Triggered Autonomous Reasoning & Local Intelligence Node Generator), a highly capable local AI assistant. Be concise, precise, and direct. Avoid unnecessary pleasantries.';

// ── Conversation state ────────────────────────────────────────────────────────
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const starlingEl  = document.getElementById('starling');
const chatInner   = document.getElementById('chat-inner');
const micBtn      = document.getElementById('mic-btn');
const textInput   = document.getElementById('text-input');
const sendBtn     = document.getElementById('send-btn');
const clearBtn    = document.getElementById('clear-btn');

const statModel   = document.getElementById('stat-model');
const statStatus  = document.getElementById('stat-status');
const waveformEl  = document.getElementById('waveform');
const ttsToggle   = document.getElementById('tts-toggle');
const voiceSelect = document.getElementById('voice-select');
const ttsEngineEl = document.getElementById('tts-engine');
const ftrTts      = document.getElementById('ftr-tts');
const ftrWhisperDev = document.getElementById('ftr-whisper-dev');
const ftrKokoroDev  = document.getElementById('ftr-kokoro-dev');
const ftrOllamaDev  = document.getElementById('ftr-ollama-dev');

// ── Sphere shared state ─────────────────────────────────────────────────────────────
const sphereStateRef    = { current: 'idle' };
const sphereAnalyserRef = { an: null, data: null };

// ── System status ────────────────────────────────────────────────────────────
async function fetchSystemStatus() {
  try {
    const res = await fetch(`${BACKEND_BASE}/system-status`);
    if (!res.ok) return;
    const { whisper, kokoro, ollama } = await res.json();
    function setDev(el, val) {
      if (!el) return;
      el.textContent = val;
      el.dataset.dev  = val;
    }
    setDev(ftrWhisperDev, whisper);
    setDev(ftrKokoroDev,  kokoro);
    setDev(ftrOllamaDev,  ollama);
  } catch { /* backend offline — ignore */ }
}

// ── Waveform bars ─────────────────────────────────────────────────────────────
const BAR_COUNT = 40;
const bars = Array.from({ length: BAR_COUNT }, () => {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = (Math.random() * 6 + 4) + 'px';
  waveformEl.appendChild(b);
  return b;
});

// Idle sine-wave animation
let idleActive = true;
function idleTick() {
  if (!idleActive) return;
  const t = Date.now() / 1000;
  bars.forEach((b, i) => {
    b.style.height = (Math.sin(t * 1.1 + i * 0.38) * 5 + 7) + 'px';
  });
  requestAnimationFrame(idleTick);
}
idleTick();

// Real audio-level visualizer during recording
let analyserRaf = null;
function startAudioViz(stream) {
  idleActive = false;
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an  = ctx.createAnalyser();
  an.fftSize = 128;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  sphereAnalyserRef.an   = an;
  sphereAnalyserRef.data = data;
  function tick() {
    an.getByteFrequencyData(data);
    bars.forEach((b, i) => {
      const v = data[Math.floor(i * data.length / bars.length)] / 255;
      b.style.height = (v * 28 + 3) + 'px';
    });
    analyserRaf = requestAnimationFrame(tick);
  }
  tick();
}
function stopAudioViz() {
  cancelAnimationFrame(analyserRaf);
  sphereAnalyserRef.an   = null;
  sphereAnalyserRef.data = null;
  idleActive = true;
  idleTick();
}

// ── Three.js living sphere ─────────────────────────────────────────────────────────────
function initSphere() {
  if (typeof THREE === 'undefined') {
    console.warn('S.T.A.R.L.I.N.G.: Three.js not loaded — sphere unavailable');
    return;
  }
  const canvas = document.getElementById('sphere-canvas');
  if (!canvas) return;

  const SIZE = 210;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(SIZE, SIZE);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.z = 6.2;

  // Very dim ambient — keeps the sphere face close to black
  scene.add(new THREE.AmbientLight(0xffffff, 0.025));

  // ── 5 orbiting light orbs ──────────────────────────────────────────────────
  // Each orb is a small visible sphere (MeshBasicMaterial so it always glows)
  // plus a PointLight that illuminates the main sphere.
  // Each orb orbits at a fixed radius in a plane tilted by tiltX / tiltZ —
  // distance from centre is always exactly r, so they can never enter the sphere.
  const ORB_WHITE  = new THREE.Color(0xffffff);
  const ORB_BLUE   = new THREE.Color(0x88bbff);
  const ORB_YELLOW = new THREE.Color(0xffdd88);

  const orbDefs = [
    { r: 1.65, speed: 0.19, phase: 0.0, tiltX: 0.30, tiltZ: 0.00  },
    { r: 1.65, speed: 0.14, phase: 2.1, tiltX: 1.15, tiltZ: 0.50  },
    { r: 1.65, speed: 0.23, phase: 4.2, tiltX: 0.70, tiltZ: -0.90 },
    { r: 1.65, speed: 0.17, phase: 1.1, tiltX: -0.55, tiltZ: 1.20 },
    { r: 1.65, speed: 0.21, phase: 3.5, tiltX: -1.00, tiltZ: -0.40 },
  ];

  let orbSpeedMult = 1.0; // smoothly interpolated speed multiplier
  let orbTimeAccum  = 0;   // accumulated orbit time (scaled by multiplier)
  let _lastT        = null;

  const orbs = orbDefs.map(() => {
    const mat   = new THREE.MeshBasicMaterial({ color: ORB_WHITE.clone() });
    const mesh  = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 10), mat);
    const light = new THREE.PointLight(0xffffff, 10, 0, 0);
    scene.add(mesh);
    scene.add(light);
    return { mesh, mat, light, color: ORB_WHITE.clone() };
  });

  // ── Main sphere ────────────────────────────────────────────────────────────
  const SEG = 56;
  const sphereGeo  = new THREE.SphereGeometry(1, SEG, SEG);
  const origPos    = sphereGeo.attributes.position.array.slice();
  const numVerts   = origPos.length / 3;
  const dispSmooth = new Float32Array(numVerts);

  const sphereMat  = new THREE.MeshPhongMaterial({
    color:     0x060606,
    specular:  0x888888,
    shininess: 38,
  });
  const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
  scene.add(sphereMesh);

  function animate() {
    requestAnimationFrame(animate);
    const t     = Date.now() * 0.001;
    const delta = _lastT === null ? 0 : t - _lastT;
    _lastT      = t;
    const state        = sphereStateRef.current;
    const isListening  = state === 'listening';
    const isSpeaking   = state === 'speaking';
    const targetColor  = isListening ? ORB_BLUE : isSpeaking ? ORB_YELLOW : ORB_WHITE;

    // Smoothly ramp orbit speed up during active states
    const targetSpeedMult = isListening ? 1.6 : isSpeaking ? 1.4 : 1.0;
    orbSpeedMult += (targetSpeedMult - orbSpeedMult) * 0.03;
    orbTimeAccum += delta * orbSpeedMult;

    // ── Update orb positions and colours ────────────────────────────────────
    orbDefs.forEach((p, i) => {
      const angle = p.speed * orbTimeAccum + p.phase;
      // Point on circle in local XY plane
      const lx = p.r * Math.cos(angle);
      const ly = p.r * Math.sin(angle);
      // Rotate around X axis by tiltX
      const mx = lx;
      const my = ly * Math.cos(p.tiltX);
      const mz = ly * Math.sin(p.tiltX);
      // Rotate around Z axis by tiltZ
      const fx = mx * Math.cos(p.tiltZ) - my * Math.sin(p.tiltZ);
      const fy = mx * Math.sin(p.tiltZ) + my * Math.cos(p.tiltZ);
      const fz = mz;

      const orb = orbs[i];
      orb.mesh.position.set(fx, fy, fz);
      orb.light.position.set(fx, fy, fz);

      // Smooth colour transition
      orb.color.lerp(targetColor, 0.04);
      orb.mat.color.copy(orb.color);
      orb.light.color.copy(orb.color);

      // Slightly higher intensity while listening
      orb.light.intensity = isListening ? 12 : isSpeaking ? 10 : 8;
    });

    // ── Sphere surface deformation (audio-driven in listening mode) ──────────
    const positions = sphereGeo.attributes.position.array;
    if (isListening && sphereAnalyserRef.an && sphereAnalyserRef.data) {
      sphereAnalyserRef.an.getByteFrequencyData(sphereAnalyserRef.data);
      const audioData = sphereAnalyserRef.data;
      const dataLen   = audioData.length;
      for (let i = 0; i < numVerts; i++) {
        const bin    = Math.floor((i / numVerts) * dataLen);
        const target = (audioData[bin] / 255) * 0.13;
        dispSmooth[i] += (target - dispSmooth[i]) * 0.32;
        const scale = 1 + dispSmooth[i];
        positions[i * 3]     = origPos[i * 3]     * scale;
        positions[i * 3 + 1] = origPos[i * 3 + 1] * scale;
        positions[i * 3 + 2] = origPos[i * 3 + 2] * scale;
      }
      sphereGeo.attributes.position.needsUpdate = true;
    } else {
      // Smoothly return vertices to resting position
      let anyChange = false;
      for (let i = 0; i < numVerts; i++) {
        if (Math.abs(dispSmooth[i]) > 0.0005) {
          dispSmooth[i] *= 0.87;
          const scale = 1 + dispSmooth[i];
          positions[i * 3]     = origPos[i * 3]     * scale;
          positions[i * 3 + 1] = origPos[i * 3 + 1] * scale;
          positions[i * 3 + 2] = origPos[i * 3 + 2] * scale;
          anyChange = true;
        } else if (dispSmooth[i] !== 0) {
          dispSmooth[i]        = 0;
          positions[i * 3]     = origPos[i * 3];
          positions[i * 3 + 1] = origPos[i * 3 + 1];
          positions[i * 3 + 2] = origPos[i * 3 + 2];
          anyChange = true;
        }
      }
      if (anyChange) sphereGeo.attributes.position.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  animate();
}

// ── UI state machine ──────────────────────────────────────────────────────────
const STATE_CFG = {
  idle:         { cls: null,              label: 'READY',        status: 'ONLINE'  },
  listening:    { cls: 'state-listening', label: 'LISTENING',    status: 'HEARING' },
  transcribing: { cls: 'state-thinking',  label: 'TRANSCRIBING', status: 'PROC...' },
  thinking:     { cls: 'state-thinking',  label: 'THINKING',     status: 'PROC...' },
  speaking:     { cls: 'state-speaking',  label: 'SPEAKING',     status: 'ONLINE'  },
  error:        { cls: 'state-error',     label: 'ERROR',        status: 'ERROR'   },
};
const ALL_STATE_CLASSES = ['state-listening', 'state-thinking', 'state-speaking', 'state-error'];

function setState(name) {
  const s = STATE_CFG[name] ?? STATE_CFG.idle;
  ALL_STATE_CLASSES.forEach(c => starlingEl.classList.remove(c));
  if (s.cls) starlingEl.classList.add(s.cls);
  statStatus.textContent = s.status;
  sphereStateRef.current = name;
}

// ── Append message ────────────────────────────────────────────────────────────
function appendMessage(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role === 'user' ? 'user' : 'asst'}`;

  const lbl = document.createElement('span');
  lbl.className   = 'msg-lbl';
  lbl.textContent = role === 'user' ? 'YOU' : 'S.T.A.R.L.I.N.G.';

  const txt = document.createElement('span');
  txt.className   = 'msg-text';
  txt.textContent = content;

  wrap.appendChild(lbl);
  wrap.appendChild(txt);
  chatInner.appendChild(wrap);
  chatInner.scrollTop = chatInner.scrollHeight;
  return { wrap, txt };
}

// ── Ollama streaming chat ─────────────────────────────────────────────────────
async function sendToOllama(userText) {
  conversationHistory.push({ role: 'user', content: userText });

  const { wrap, txt } = appendMessage('assistant', '');
  wrap.classList.add('streaming');
  setState('thinking');

  try {
    const res = await fetch(`${BACKEND_BASE}/chat/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: conversationHistory,
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const token = JSON.parse(line)?.message?.content ?? '';
          full += token;
          txt.textContent = full;
          chatInner.scrollTop = chatInner.scrollHeight;
        } catch { /* partial JSON chunk — skip */ }
      }
    }

    wrap.classList.remove('streaming');
    conversationHistory.push({ role: 'assistant', content: full });
    setState('idle');
    return full;
  } catch (err) {
    wrap.classList.remove('streaming');
    txt.textContent = `[Error: ${err.message}]`;
    setState('error');
    setTimeout(() => setState('idle'), 4000);
    return null;
  }
}

// ── Text-to-Speech ────────────────────────────────────────────────────────────
// State: 'kokoro' | 'browser' | 'off'
let ttsMode  = localStorage.getItem('starling_tts_mode') || 'kokoro';
let ttsVoice = localStorage.getItem('starling_tts_voice') || 'bm_george';

function _applyTtsMode() {
  if (ttsMode === 'off') {
    ttsToggle.textContent    = 'TTS OFF';
    ttsToggle.classList.add('tts-off');
    voiceSelect.disabled     = true;
    ttsEngineEl.textContent  = 'OFF';
    if (ftrTts) ftrTts.textContent = 'Off';
  } else if (ttsMode === 'browser') {
    ttsToggle.textContent    = 'TTS: BROWSER';
    ttsToggle.classList.remove('tts-off');
    voiceSelect.disabled     = true;
    ttsEngineEl.textContent  = 'BROWSER';
    if (ftrTts) ftrTts.textContent = 'Web Speech';
  } else {
    ttsToggle.textContent    = 'TTS: KOKORO';
    ttsToggle.classList.remove('tts-off');
    voiceSelect.disabled     = false;
    ttsEngineEl.textContent  = 'KOKORO';
    if (ftrTts) ftrTts.textContent = 'Kokoro (local)';
  }
}

// Cycle: kokoro → browser → off → kokoro
ttsToggle.addEventListener('click', () => {
  ttsMode = ttsMode === 'kokoro' ? 'browser' : ttsMode === 'browser' ? 'off' : 'kokoro';
  localStorage.setItem('starling_tts_mode', ttsMode);
  _applyTtsMode();
});

voiceSelect.addEventListener('change', () => {
  ttsVoice = voiceSelect.value;
  localStorage.setItem('starling_tts_voice', ttsVoice);
});

// Populate voice dropdown from /synthesize/voices
async function loadVoices() {
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/voices`);
    if (!res.ok) return;
    const voices = await res.json();
    voiceSelect.innerHTML = '';
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value       = v.id;
      opt.textContent = v.label;
      if (v.id === ttsVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    });
    // Ensure stored voice still exists; fall back to first option
    if (!voices.find(v => v.id === ttsVoice)) {
      ttsVoice = voices[0]?.id || 'bm_george';
      voiceSelect.value = ttsVoice;
      localStorage.setItem('starling_tts_voice', ttsVoice);
    }
  } catch { /* backend not running — leave static fallback option */ }
}

// Active audio element (so we can cancel mid-speech)
let _activeAudio = null;

async function _speakKokoro(text) {
  setState('speaking');
  try {
    const res = await fetch(`${BACKEND_BASE}/synthesize/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoice, speed: 1.0 }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _activeAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); _activeAudio = null; setState('idle'); };
    audio.onerror = () => { URL.revokeObjectURL(url); _activeAudio = null; setState('idle'); };
    await audio.play();
  } catch (err) {
    console.warn('Kokoro TTS failed, falling back to browser SpeechSynthesis:', err);
    _speakBrowser(text);
  }
}

function _speakBrowser(text) {
  if (!window.speechSynthesis) { setState('idle'); return; }
  window.speechSynthesis.cancel();
  const utt   = new SpeechSynthesisUtterance(text);
  utt.rate    = 0.95;
  utt.pitch   = 0.8;
  utt.onstart = () => setState('speaking');
  utt.onend   = () => setState('idle');
  utt.onerror = () => setState('idle');
  window.speechSynthesis.speak(utt);
}

function stopSpeaking() {
  if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  setState('idle');
}

async function speak(text) {
  if (ttsMode === 'off') return;
  if (ttsMode === 'browser') { _speakBrowser(text); return; }
  await _speakKokoro(text);
}

// ── Text send handler ─────────────────────────────────────────────────────────
async function handleSend() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  appendMessage('user', text);
  const response = await sendToOllama(text);
  if (response) {
    await speak(response);
    fetchSystemStatus();
  }
}

sendBtn.addEventListener('click', handleSend);
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});

// ── Clear conversation ────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
  chatInner.innerHTML = '';
  setState('idle');
});

// ── MediaRecorder → Whisper STT ───────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];

async function startRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return; // guard
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startAudioViz(stream);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : '';
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    audioChunks   = [];

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      stopAudioViz();
      stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1024) {
        setState('idle');   // recording was too short / empty — silently ignore
        return;
      }

      setState('transcribing');

      const form = new FormData();
      form.append('audio', blob, 'recording.webm');

      try {
        const r = await fetch(`${BACKEND_BASE}/transcribe/`, { method: 'POST', body: form });
        if (!r.ok) throw new Error(`STT ${r.status}`);
        const { transcript } = await r.json();
        if (!transcript) { setState('idle'); return; }
        appendMessage('user', transcript);
        const response = await sendToOllama(transcript);
        if (response) {
          await speak(response);
          fetchSystemStatus();
        }
      } catch (err) {
        appendMessage('assistant', `[STT error: ${err.message}]`);
        setState('error');
        setTimeout(() => setState('idle'), 4000);
      }
    };

    mediaRecorder.start();
    micBtn.classList.add('recording');
    setState('listening');
  } catch (err) {
    appendMessage('assistant', `[Mic error: ${err.message}]`);
    setState('error');
    setTimeout(() => setState('idle'), 4000);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    micBtn.classList.remove('recording');
  }
}

// Push-to-talk — mouse
micBtn.addEventListener('mousedown', startRecording);
micBtn.addEventListener('mouseup',   stopRecording);
micBtn.addEventListener('mouseleave', stopRecording);

// Push-to-talk — touch
micBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
micBtn.addEventListener('touchend',   e => { e.preventDefault(); stopRecording();  });

// Push-to-talk — spacebar (only when text input is not focused)
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.activeElement !== textInput && !e.repeat) {
    e.preventDefault();
    startRecording();
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && document.activeElement !== textInput) {
    e.preventDefault();
    stopRecording();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
initSphere();
statModel.textContent = MODEL;
_applyTtsMode();
loadVoices();
appendMessage('assistant',
  `All systems nominal. S.T.A.R.L.I.N.G. online — running ${MODEL} on GPU via Ollama. How can I assist?`);
setState('idle');
