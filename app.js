// ====== IndexedDB layer ======
const DB_NAME = 'training-timer';
const DB_VERSION = 2;
let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('trainings')) {
        db.createObjectStore('trainings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('schedule')) {
        db.createObjectStore('schedule', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('history')) {
        const h = db.createObjectStore('history', { keyPath: 'id' });
        h.createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ====== State ======
const state = {
  trainings: [],
  schedule: [],
  editingTraining: null,
  run: null,
};

// ====== Wake lock (keep screen on) ======
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    console.warn('Wake lock failed', e);
  }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}
// Re-acquire after the tab becomes visible again (wake lock is auto-released when hidden).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.run && !wakeLock) {
    acquireWakeLock();
  }
});

// ====== Speech ======
function pickEnglishVoice() {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'en-US')
    || voices.find((v) => v.lang?.startsWith('en'))
    || null;
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  const voice = pickEnglishVoice();
  if (voice) u.voice = voice;
  u.rate = 1;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}

function beep(freq = 660, duration = 200) {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq;
    osc.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);
    osc.start();
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {}
}

// ====== Rendering: views ======
function activeSwipeable() {
  const list = ['schedule', 'trainings', 'history'];
  if (state.run) list.push('run');
  return list;
}

function switchView(name, opts = {}) {
  const swiper = document.getElementById('swiper');
  const SWIPEABLE = activeSwipeable();
  const isSwipe = SWIPEABLE.includes(name);

  document.querySelectorAll('.view:not(.swipe-view)').forEach((el) => el.classList.remove('active'));

  if (isSwipe) {
    swiper.classList.add('active');
    const idx = SWIPEABLE.indexOf(name);
    // Use auto behavior on initial load; smooth otherwise (handled by CSS scroll-behavior)
    const left = idx * swiper.clientWidth;
    if (opts.instant) {
      const prev = swiper.style.scrollBehavior;
      swiper.style.scrollBehavior = 'auto';
      swiper.scrollLeft = left;
      // restore on next frame
      requestAnimationFrame(() => { swiper.style.scrollBehavior = prev || ''; });
    } else {
      swiper.scrollTo({ left, behavior: 'smooth' });
    }
  } else {
    swiper.classList.remove('active');
    document.getElementById('view-' + name).classList.add('active');
  }

  setActiveNav(name);
  updateRunNav();
}

function updateRunNav() {
  const runBtn = document.querySelector('nav button[data-view="run"]');
  runBtn.hidden = !state.run;
  runBtn.classList.toggle('running', !!state.run);
  document.getElementById('view-run').classList.toggle('swipe-hidden', !state.run);
}

function setActiveNav(name) {
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
}

document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// Update nav highlight as the user swipes the carousel
(() => {
  const swiper = document.getElementById('swiper');
  let raf = null;
  swiper.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      if (!swiper.clientWidth) return;
      const idx = Math.round(swiper.scrollLeft / swiper.clientWidth);
      const name = activeSwipeable()[idx];
      if (name) setActiveNav(name);
    });
  }, { passive: true });
})();

document.querySelectorAll('[data-back]').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.back));
});

// ====== Trainings ======
async function loadTrainings() {
  state.trainings = (await idbAll('trainings')) || [];
  renderTrainings();
  renderSchedule();
}

function renderTrainings() {
  const list = document.getElementById('training-list');
  list.innerHTML = '';
  if (!state.trainings.length) {
    list.innerHTML = '<p class="hint">No trainings yet. Tap "+ New training" to start.</p>';
    return;
  }
  for (const t of state.trainings) {
    const el = document.createElement('div');
    el.className = 'card';
    const exerciseCount = (t.exercises || []).length;
    el.innerHTML = `
      <div class="card-head">
        <div>
          <strong>${escapeHtml(t.name || 'Untitled')}</strong>
          <div class="card-sub">${exerciseCount} exercise${exerciseCount !== 1 ? 's' : ''} · ${formatDuration(estimateDuration(t))}</div>
        </div>
        <div class="row">
          <button data-action="run">Start</button>
          <button data-action="edit">Edit</button>
        </div>
      </div>
    `;
    el.querySelector('[data-action="edit"]').addEventListener('click', () => openEditor(t));
    el.querySelector('[data-action="run"]').addEventListener('click', () => startRun(t));
    list.appendChild(el);
  }
}

function estimateDuration(t) {
  let total = 0;
  for (const ex of t.exercises || []) {
    const repeat = Math.max(1, ex.repeat || 1);
    let per = 0;
    for (const s of ex.steps || []) {
      if (s.type === 'timed' || s.type === 'rest') per += s.duration || 0;
      else per += 30; // est. 30s for reps
    }
    total += per * repeat;
  }
  return total;
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ====== Training templates ======
const TRAINING_TEMPLATES = [
  {
    name: 'Blank',
    desc: 'Start from scratch',
    exercises: [],
  },
  {
    name: 'Ankle stretch',
    desc: '3 sets of L/R/rest, 1 min each',
    exercises: [{
      name: 'Stretch',
      repeat: 3,
      steps: [
        { type: 'timed', label: 'Right leg', duration: 60 },
        { type: 'timed', label: 'Left leg',  duration: 60 },
        { type: 'rest',  label: 'Rest',      duration: 60 },
      ],
    }],
  },
  {
    name: 'Bicep curls',
    desc: '3 sets · 10 reps per arm · 3 min rest · weighted',
    exercises: [{
      name: 'Curls',
      repeat: 3,
      steps: [
        { type: 'reps', label: 'Right arm', reps: 10, weighted: true, plannedWeight: 10 },
        { type: 'reps', label: 'Left arm',  reps: 10, weighted: true, plannedWeight: 10 },
        { type: 'rest', label: 'Rest',      duration: 180 },
      ],
    }],
  },
  {
    name: 'Push/Pull/Legs (PPL) day',
    desc: 'Bench, row, squat — 4 sets, weighted',
    exercises: [
      { name: 'Bench press', repeat: 4, steps: [
        { type: 'reps', label: 'Bench',  reps: 8, weighted: true, plannedWeight: 60 },
        { type: 'rest', label: 'Rest',   duration: 120 },
      ]},
      { name: 'Barbell row', repeat: 4, steps: [
        { type: 'reps', label: 'Row',    reps: 8, weighted: true, plannedWeight: 50 },
        { type: 'rest', label: 'Rest',   duration: 120 },
      ]},
      { name: 'Squat', repeat: 4, steps: [
        { type: 'reps', label: 'Squat',  reps: 8, weighted: true, plannedWeight: 80 },
        { type: 'rest', label: 'Rest',   duration: 150 },
      ]},
    ],
  },
  {
    name: 'Plank circuit',
    desc: '3 sets · 60s plank · 30s rest',
    exercises: [{
      name: 'Plank',
      repeat: 3,
      steps: [
        { type: 'timed', label: 'Plank', duration: 60 },
        { type: 'rest',  label: 'Rest',  duration: 30 },
      ],
    }],
  },
  {
    name: 'Tabata',
    desc: '8 rounds · 20s work · 10s rest',
    exercises: [{
      name: 'HIIT',
      repeat: 8,
      steps: [
        { type: 'timed', label: 'Work', duration: 20 },
        { type: 'rest',  label: 'Rest', duration: 10 },
      ],
    }],
  },
  {
    name: 'Push-ups',
    desc: '4 sets · 15 reps · 1 min rest · bodyweight',
    exercises: [{
      name: 'Push-ups',
      repeat: 4,
      steps: [
        { type: 'reps', label: 'Push-ups', reps: 15 },
        { type: 'rest', label: 'Rest',     duration: 60 },
      ],
    }],
  },
];

function showTemplatePicker() {
  const overlay = document.createElement('div');
  overlay.className = 'session-detail-overlay';
  overlay.innerHTML = `
    <div class="session-detail-card">
      <h3>New training</h3>
      <div class="summary">Pick a template — you can edit anything afterward.</div>
      <div class="template-list">
        ${TRAINING_TEMPLATES.map((t, i) => `
          <button class="template-item" data-idx="${i}">
            <strong>${escapeHtml(t.name)}</strong>
            <span>${escapeHtml(t.desc)}</span>
          </button>
        `).join('')}
      </div>
      <div class="row" style="justify-content: flex-end; margin-top: 1rem;">
        <button data-act="close">Cancel</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.act === 'close') {
      overlay.remove();
      return;
    }
    const item = e.target.closest('.template-item');
    if (!item) return;
    const tmpl = TRAINING_TEMPLATES[parseInt(item.dataset.idx)];
    const cloned = JSON.parse(JSON.stringify(tmpl.exercises));
    cloned.forEach((ex) => { ex.id = uid(); });
    overlay.remove();
    openEditor({
      id: uid(),
      name: tmpl.name === 'Blank' ? '' : tmpl.name,
      exercises: cloned,
      _new: true,
    });
  });
  document.body.appendChild(overlay);
}

document.getElementById('add-training').addEventListener('click', showTemplatePicker);

// ====== Editor ======
function openEditor(training) {
  state.editingTraining = JSON.parse(JSON.stringify(training));
  if (!state.editingTraining.exercises) state.editingTraining.exercises = [];
  document.getElementById('editor-name').value = state.editingTraining.name || '';
  document.getElementById('delete-training').style.display = training._new ? 'none' : '';
  renderEditor();
  switchView('editor');
}

function renderEditor() {
  const root = document.getElementById('editor-exercises');
  root.innerHTML = '';
  state.editingTraining.exercises.forEach((ex, exIdx) => {
    const el = document.createElement('div');
    el.className = 'exercise';
    el.innerHTML = `
      <div class="exercise-head">
        <input type="text" placeholder="Exercise name" value="${escapeHtml(ex.name || '')}" data-k="name" />
        <label class="hint">× <input type="number" min="1" value="${ex.repeat || 1}" data-k="repeat" /> sets</label>
        <button class="danger" data-k="del">✕</button>
      </div>
      <label class="row exercise-opt" style="gap: 0.4rem; margin-bottom: 0.5rem;">
        <input type="checkbox" data-k="skipLast" ${ex.skipLastRest ? 'checked' : ''} />
        <span>Skip last rest</span>
      </label>
      <div class="steps"></div>
      <div class="row">
        <button data-add="timed">+ Timed</button>
        <button data-add="reps">+ Reps</button>
        <button data-add="rest">+ Rest</button>
      </div>
    `;
    el.querySelector('[data-k="name"]').addEventListener('input', (e) => { ex.name = e.target.value; });
    el.querySelector('[data-k="repeat"]').addEventListener('input', (e) => { ex.repeat = Math.max(1, parseInt(e.target.value) || 1); });
    el.querySelector('[data-k="skipLast"]').addEventListener('change', (e) => { ex.skipLastRest = e.target.checked; });
    el.querySelector('[data-k="del"]').addEventListener('click', () => {
      state.editingTraining.exercises.splice(exIdx, 1);
      renderEditor();
    });
    el.querySelectorAll('[data-add]').forEach((b) => {
      b.addEventListener('click', () => {
        const type = b.dataset.add;
        ex.steps = ex.steps || [];
        ex.steps.push(newStep(type));
        renderEditor();
      });
    });
    const stepsEl = el.querySelector('.steps');
    (ex.steps || []).forEach((st, stIdx) => {
      stepsEl.appendChild(renderStepEditor(ex, st, stIdx));
    });
    root.appendChild(el);
  });
}

function newStep(type) {
  if (type === 'timed') return { type, label: '', duration: 60 };
  if (type === 'rest') return { type, label: 'Rest', duration: 60 };
  return { type: 'reps', label: '', reps: 10 };
}

function renderStepEditor(ex, st, idx) {
  const el = document.createElement('div');
  el.className = 'step';
  const pillClass = st.type;
  const placeholder = st.type === 'rest' ? 'Rest' : (st.type === 'reps' ? 'e.g. 10 curls per arm' : 'e.g. Right leg stretch');
  let html = `
    <span class="pill ${pillClass}">${st.type}</span>
    <input type="text" placeholder="${placeholder}" value="${escapeHtml(st.label || '')}" data-k="label" />
    ${st.type === 'reps'
      ? `<input type="number" min="1" value="${st.reps || 1}" data-k="reps" title="reps" />`
      : `<input type="number" min="1" value="${st.duration || 1}" data-k="duration" title="seconds" />`
    }
    <button class="danger" data-k="del">✕</button>
  `;
  if (st.type === 'reps') {
    html += `
      <div class="step-extra">
        <label class="row" style="gap: 0.3rem; align-items: center;">
          <input type="checkbox" data-k="weighted" ${st.weighted ? 'checked' : ''} />
          <span>Weighted</span>
        </label>
        <input type="number" min="0" step="0.5" placeholder="kg" data-k="weight"
          value="${st.plannedWeight ?? ''}" ${st.weighted ? '' : 'hidden'} />
        <span class="hint" data-k="weight-unit" ${st.weighted ? '' : 'hidden'}>kg</span>
      </div>
    `;
  }
  el.innerHTML = html;
  el.querySelector('[data-k="label"]').addEventListener('input', (e) => { st.label = e.target.value; });
  const numInput = el.querySelector('[data-k="reps"], [data-k="duration"]');
  if (numInput) {
    numInput.addEventListener('input', (e) => {
      const v = Math.max(1, parseInt(e.target.value) || 1);
      if (st.type === 'reps') st.reps = v; else st.duration = v;
    });
  }
  if (st.type === 'reps') {
    const wCheck = el.querySelector('[data-k="weighted"]');
    const wInput = el.querySelector('[data-k="weight"]');
    const wUnit = el.querySelector('[data-k="weight-unit"]');
    wCheck.addEventListener('change', (e) => {
      st.weighted = e.target.checked;
      wInput.hidden = !st.weighted;
      wUnit.hidden = !st.weighted;
      if (st.weighted && (st.plannedWeight == null || st.plannedWeight === '')) {
        st.plannedWeight = 10;
        wInput.value = 10;
      }
    });
    wInput.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.plannedWeight = Number.isFinite(v) && v >= 0 ? v : null;
    });
  }
  el.querySelector('[data-k="del"]').addEventListener('click', () => {
    ex.steps.splice(idx, 1);
    renderEditor();
  });
  return el;
}

document.getElementById('add-exercise').addEventListener('click', () => {
  state.editingTraining.exercises.push({ id: uid(), name: '', repeat: 1, steps: [] });
  renderEditor();
});

async function saveCurrentTraining() {
  const t = state.editingTraining;
  if (!t) return;
  t.name = document.getElementById('editor-name').value.trim() || 'Untitled';
  delete t._new;
  await idbPut('trainings', t);
  await loadTrainings();
}

document.getElementById('editor-back').addEventListener('click', async () => {
  await saveCurrentTraining();
  toast('Saved');
  switchView('trainings');
});

document.getElementById('delete-training').addEventListener('click', async () => {
  if (!confirm('Delete this training?')) return;
  await idbDelete('trainings', state.editingTraining.id);
  // Also remove from schedule
  for (const s of state.schedule) {
    if (s.trainingId === state.editingTraining.id) await idbDelete('schedule', s.id);
  }
  await loadTrainings();
  switchView('trainings');
});

// ====== Schedule ======
async function loadSchedule() {
  state.schedule = (await idbAll('schedule')) || [];
  renderSchedule();
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function renderSchedule() {
  const list = document.getElementById('schedule-list');
  list.innerHTML = '';
  if (!state.schedule.length) {
    list.innerHTML = '<p class="hint">No scheduled reminders yet.</p>';
  }
  for (const s of state.schedule) {
    const t = state.trainings.find((x) => x.id === s.trainingId);
    const el = document.createElement('div');
    el.className = 'card';
    const trainingOptions = state.trainings.map((x) =>
      `<option value="${x.id}" ${x.id === s.trainingId ? 'selected' : ''}>${escapeHtml(x.name)}</option>`
    ).join('');
    const isDaily = s.dayOfWeek === 'daily';
    el.innerHTML = `
      <div class="row">
        <select data-k="day">
          <option value="daily" ${isDaily ? 'selected' : ''}>Every day</option>
          ${DAYS.map((d, i) => `<option value="${i}" ${i === s.dayOfWeek ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <input type="time" data-k="time" value="${s.time || '09:00'}" />
        <select data-k="training">${trainingOptions || '<option value="">— no trainings —</option>'}</select>
        <button data-k="run" ${!t ? 'disabled' : ''}>Start now</button>
        <button data-k="del" class="danger">✕</button>
      </div>
      <div class="card-sub">${t ? `Next: ${formatNext(s)}` : 'Select a training'}</div>
    `;
    el.querySelector('[data-k="day"]').addEventListener('change', async (e) => {
      const v = e.target.value;
      s.dayOfWeek = v === 'daily' ? 'daily' : parseInt(v);
      await idbPut('schedule', s);
      renderSchedule();
      scheduleReminders();
    });
    el.querySelector('[data-k="time"]').addEventListener('change', async (e) => {
      s.time = e.target.value;
      await idbPut('schedule', s);
      renderSchedule();
      scheduleReminders();
    });
    el.querySelector('[data-k="training"]').addEventListener('change', async (e) => {
      s.trainingId = e.target.value;
      await idbPut('schedule', s);
      renderSchedule();
    });
    el.querySelector('[data-k="del"]').addEventListener('click', async () => {
      await idbDelete('schedule', s.id);
      await loadSchedule();
      scheduleReminders();
    });
    el.querySelector('[data-k="run"]').addEventListener('click', () => {
      if (t) startRun(t);
    });
    list.appendChild(el);
  }
  renderNextUp();
}

function nextOccurrence(s) {
  const now = new Date();
  const [hh, mm] = (s.time || '09:00').split(':').map(Number);
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  if (s.dayOfWeek === 'daily') {
    if (d < now) d.setDate(d.getDate() + 1);
    return d;
  }
  let diff = s.dayOfWeek - d.getDay();
  if (diff < 0 || (diff === 0 && d < now)) diff += 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function formatNext(s) {
  const d = nextOccurrence(s);
  const now = new Date();
  const diffMs = d - now;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const dayLabel = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : DAYS[d.getDay()];
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return s.dayOfWeek === 'daily' ? `Daily at ${time} · next ${dayLabel.toLowerCase()}` : `${dayLabel} at ${time}`;
}

function renderNextUp() {
  const el = document.getElementById('next-up');
  const upcoming = state.schedule
    .filter((s) => state.trainings.find((t) => t.id === s.trainingId))
    .map((s) => ({ s, at: nextOccurrence(s) }))
    .sort((a, b) => a.at - b.at);
  if (!upcoming.length) { el.classList.add('empty'); return; }
  el.classList.remove('empty');
  const { s, at } = upcoming[0];
  const t = state.trainings.find((x) => x.id === s.trainingId);
  const mins = Math.round((at - new Date()) / 60000);
  const when = mins < 60 ? `in ${mins} min` : mins < 60 * 24 ? `in ${Math.round(mins/60)}h` : `in ${Math.round(mins/60/24)}d`;
  el.innerHTML = `
    <div><strong>Next:</strong> ${escapeHtml(t.name)} ${when}</div>
    <div class="card-sub">${formatNext(s)}</div>
    <div style="margin-top: 0.5rem;"><button class="primary" id="start-next">Start now</button></div>
  `;
  document.getElementById('start-next').addEventListener('click', () => startRun(t));
}

document.getElementById('add-slot').addEventListener('click', async () => {
  const s = { id: uid(), dayOfWeek: 1, time: '09:00', trainingId: state.trainings[0]?.id || '' };
  await idbPut('schedule', s);
  await loadSchedule();
});

// ====== Reminders ======
document.getElementById('enable-notif').addEventListener('click', async () => {
  if (!('Notification' in window)) { toast('Notifications not supported'); return; }
  const res = await Notification.requestPermission();
  toast(res === 'granted' ? 'Notifications enabled' : 'Denied');
  scheduleReminders();
});

let reminderTimers = [];
async function scheduleReminders() {
  reminderTimers.forEach((t) => clearTimeout(t));
  reminderTimers = [];
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  if (!reg) return;

  // Clear previously-scheduled notifications (including ones scheduled via TimestampTrigger)
  try {
    const opts = 'getNotifications' in reg ? { includeTriggered: true } : undefined;
    const existing = await reg.getNotifications(opts);
    for (const n of existing) if (n.tag?.startsWith('training-')) n.close();
  } catch {}

  const supportsTrigger = 'TimestampTrigger' in window;

  for (const s of state.schedule) {
    const t = state.trainings.find((x) => x.id === s.trainingId);
    if (!t) continue;
    const atDate = nextOccurrence(s);
    const when = atDate - Date.now();
    if (when <= 0) continue;

    // Best-effort: TimestampTrigger may fire when the app is closed (Chrome experimental,
    // often shipped-but-non-functional in modern builds). We attempt it but DON'T rely on it.
    if (supportsTrigger) {
      try {
        await reg.showNotification('Training time!', {
          body: t.name,
          tag: 'training-' + s.id,
          showTrigger: new TimestampTrigger(atDate.getTime()),
          data: { trainingId: t.id, when: atDate.getTime() },
          requireInteraction: false,
        });
      } catch (e) {
        console.warn('TimestampTrigger scheduling failed', e);
      }
    }

    // Always also schedule via setTimeout so that, while the app is open, the notification
    // reliably fires even if TimestampTrigger is exposed-but-broken. The matching `tag`
    // means both firings collapse into a single visible notification.
    if (when < 2 ** 31) {
      const timer = setTimeout(async () => {
        try {
          await reg.showNotification('Training time!', { body: t.name, tag: 'training-' + s.id });
        } catch (e) { console.warn('Notification failed', e); }
        scheduleReminders();
      }, when);
      reminderTimers.push(timer);
    }
  }
}

// ====== Run ======
function snapshotTraining(training) {
  // Deep clone via JSON to freeze the planned structure into the history entry.
  return JSON.parse(JSON.stringify({
    id: training.id,
    name: training.name,
    exercises: training.exercises || [],
  }));
}

function expandSteps(training) {
  const out = [];
  for (const ex of training.exercises || []) {
    const repeat = Math.max(1, ex.repeat || 1);
    for (let r = 0; r < repeat; r++) {
      let steps = ex.steps || [];
      // On the last iteration, optionally drop trailing rest steps
      if (ex.skipLastRest && r === repeat - 1) {
        let end = steps.length;
        while (end > 0 && steps[end - 1].type === 'rest') end--;
        steps = steps.slice(0, end);
      }
      for (const st of steps) {
        out.push({
          exerciseName: ex.name || 'Exercise',
          setIndex: r + 1,
          setTotal: repeat,
          type: st.type,
          label: st.label || (st.type === 'rest' ? 'Rest' : ''),
          duration: st.duration,
          reps: st.reps,
          weighted: !!st.weighted,
          plannedWeight: st.plannedWeight,
        });
      }
    }
  }
  return out;
}

function startRun(training) {
  const steps = expandSteps(training);
  if (!steps.length) { toast('No steps in this training'); return; }
  state.run = {
    training,
    steps,
    index: 0,
    remaining: 0,
    timerId: null,
    paused: false,
    startedAt: Date.now(),
    stepsDone: 0,
    log: [],
  };
  document.getElementById('run-title').textContent = training.name;
  updateRunNav();
  switchView('run');
  acquireWakeLock();
  enterStep(0);
}

function clearRunTimer() {
  if (state.run?.timerId) {
    clearInterval(state.run.timerId);
    state.run.timerId = null;
  }
}

function enterStep(i) {
  const run = state.run;
  if (!run) return;
  clearRunTimer();
  if (i > 0) run.stepsDone = Math.max(run.stepsDone, i);
  if (i >= run.steps.length) return finishRun();
  run.index = i;
  run.paused = false;
  const st = run.steps[i];
  document.getElementById('run-pause').textContent = 'Pause';

  const label = st.label || (st.type === 'rest' ? 'Rest' : st.exerciseName);
  document.getElementById('run-label').textContent = label;
  const setInfo = st.setTotal > 1 ? `${st.exerciseName} · set ${st.setIndex}/${st.setTotal}` : st.exerciseName;
  document.getElementById('run-sub').textContent = setInfo;

  const upcoming = run.steps.slice(i + 1, i + 4)
    .map((s, idx) => `${idx === 0 ? '<div class="next-title">Next</div>' : ''}${escapeHtml(s.label || s.exerciseName)} <span class="hint">(${s.type === 'reps' ? s.reps + ' reps' : s.duration + 's'})</span>`)
    .join('<br/>');
  document.getElementById('run-upcoming').innerHTML = upcoming;

  const nextBtn = document.getElementById('run-next');

  // Announce
  let spoken = label;
  if (st.setTotal > 1) spoken = `${label}, set ${st.setIndex} of ${st.setTotal}`;
  if (st.type === 'reps') spoken += `, ${st.reps} reps`;
  speak(spoken);
  beep(700, 150);

  if (st.type === 'timed' || st.type === 'rest') {
    run.remaining = st.duration;
    nextBtn.textContent = 'Skip →';
    updateTimer();
    run.timerId = setInterval(() => {
      if (run.paused) return;
      run.remaining -= 1;
      updateTimer();
      if (run.remaining === 10) speak('10 seconds');
      else if (run.remaining === 3) beep(500, 100);
      else if (run.remaining === 2) beep(500, 100);
      else if (run.remaining === 1) beep(500, 100);
      if (run.remaining <= 0) {
        beep(900, 300);
        run.remaining = 0;
        recordStepResult();
        enterStep(i + 1);
      }
    }, 1000);
  } else {
    // reps: wait for confirm; allow user to enter actual reps done
    run.remaining = null;
    const timerEl = document.getElementById('run-timer');
    let html = `
      <input type="number" class="reps-input" id="reps-actual" min="0" value="${st.reps}" />
      <div class="reps-label">reps (planned: ${st.reps})</div>
    `;
    if (st.weighted) {
      html += `
        <input type="number" class="reps-input weight-input" id="weight-actual" min="0" step="0.5" value="${st.plannedWeight ?? 0}" />
        <div class="reps-label">kg (planned: ${st.plannedWeight ?? 0})</div>
      `;
    }
    timerEl.innerHTML = html;
    nextBtn.textContent = 'Done ✓';
    const input = document.getElementById('reps-actual');
    input?.focus();
    input?.select();
  }
  run.stepStartedAt = Date.now();
}

function recordStepResult() {
  const run = state.run;
  if (!run) return;
  const i = run.index;
  const cur = run.steps[i];
  if (!cur) return;
  const elapsedSec = run.stepStartedAt ? Math.max(0, Math.round((Date.now() - run.stepStartedAt) / 1000)) : 0;
  const entry = {
    exerciseName: cur.exerciseName,
    setIndex: cur.setIndex,
    setTotal: cur.setTotal,
    label: cur.label || (cur.type === 'rest' ? 'Rest' : cur.exerciseName),
    type: cur.type,
    elapsedSec,
  };
  if (cur.type === 'reps') {
    const input = document.getElementById('reps-actual');
    const v = input ? parseInt(input.value) : NaN;
    entry.plannedReps = cur.reps;
    entry.actualReps = Number.isFinite(v) && v >= 0 ? v : cur.reps;
    if (cur.weighted) {
      entry.weighted = true;
      entry.plannedWeight = cur.plannedWeight ?? 0;
      const wInput = document.getElementById('weight-actual');
      const w = wInput ? parseFloat(wInput.value) : NaN;
      entry.actualWeight = Number.isFinite(w) && w >= 0 ? w : (cur.plannedWeight ?? 0);
    }
  } else {
    const elapsed = (cur.duration ?? 0) - (run.remaining ?? 0);
    entry.plannedSec = cur.duration;
    entry.actualSec = Math.max(0, elapsed);
  }
  run.log[i] = entry;
}

function updateTimer() {
  const run = state.run;
  if (!run || run.remaining == null) return;
  const s = Math.max(0, run.remaining);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  document.getElementById('run-timer').textContent = m > 0
    ? `${m}:${String(ss).padStart(2, '0')}`
    : `${s}`;
}

document.getElementById('run-next').addEventListener('click', () => {
  if (!state.run || state.run.finished) return;
  recordStepResult();
  enterStep(state.run.index + 1);
});

document.getElementById('run-pause').addEventListener('click', () => {
  if (!state.run) return;
  state.run.paused = !state.run.paused;
  document.getElementById('run-pause').textContent = state.run.paused ? 'Resume' : 'Pause';
  if (state.run.paused) window.speechSynthesis?.cancel();
});

document.getElementById('stop-run').addEventListener('click', async () => {
  clearRunTimer();
  window.speechSynthesis?.cancel();
  await abortRun();
  await releaseWakeLock();
  state.run = null;
  updateRunNav();
  renderHistory();
  switchView('history');
});

async function finishRun() {
  clearRunTimer();
  const run = state.run;
  if (!run || run.finished) return;
  run.finished = true;
  const endedAt = Date.now();
  const entry = {
    id: uid(),
    trainingId: run.training.id,
    trainingName: run.training.name,
    trainingSnapshot: snapshotTraining(run.training),
    plannedSteps: run.steps.map((s) => ({ ...s })),
    startedAt: run.startedAt,
    endedAt,
    durationSec: Math.round((endedAt - run.startedAt) / 1000),
    stepsCompleted: run.steps.length,
    stepsTotal: run.steps.length,
    completed: true,
    log: run.log.filter(Boolean),
  };
  await idbPut('history', entry);

  const before = state.stats || emptyStats();
  state.history = (await idbAll('history')) || [];
  state.stats = computeStats(state.history);
  const unlocked = newlyUnlocked(before, state.stats);

  speak('Training complete. Good job!');
  document.getElementById('run-label').textContent = 'Done!';
  document.getElementById('run-sub').textContent = `+${entry.durationSec * XP_PER_SEC | 0} XP earned`;
  document.getElementById('run-timer').textContent = '✓';
  document.getElementById('run-upcoming').innerHTML = '';
  document.getElementById('run-next').textContent = 'Close';
  document.getElementById('run-next').onclick = async () => {
    document.getElementById('run-next').onclick = null;
    await releaseWakeLock();
    state.run = null;
    updateRunNav();
    renderHistory();
    switchView('history');
  };

  renderHistory();

  if (state.stats.level > before.level) {
    showLevelUp(state.stats.level);
  }
  if (unlocked.length) {
    setTimeout(() => showAchievementToast(unlocked[0]), state.stats.level > before.level ? 2500 : 300);
  }
}

async function abortRun() {
  const run = state.run;
  if (!run || !run.stepsDone) return;
  // Capture in-progress step before aborting
  recordStepResult();
  const endedAt = Date.now();
  await idbPut('history', {
    id: uid(),
    trainingId: run.training.id,
    trainingName: run.training.name,
    trainingSnapshot: snapshotTraining(run.training),
    plannedSteps: run.steps.map((s) => ({ ...s })),
    startedAt: run.startedAt,
    endedAt,
    durationSec: Math.round((endedAt - run.startedAt) / 1000),
    stepsCompleted: run.stepsDone,
    stepsTotal: run.steps.length,
    completed: false,
    log: run.log.filter(Boolean),
  });
  state.history = (await idbAll('history')) || [];
  state.stats = computeStats(state.history);
}

// ====== Misc ======
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 1800);
}

// ====== Gamification: stats, achievements, history ======
const XP_PER_SEC = 0.2; // 12 XP/min
function xpForLevel(lvl) { return 100 * lvl * (lvl + 1) / 2; } // cumulative XP to reach level
function levelForXp(xp) {
  let lvl = 1;
  while (xpForLevel(lvl + 1) <= xp) lvl++;
  return lvl;
}

function emptyStats() {
  return { total: 0, streak: 0, longest: 0, totalSec: 0, xp: 0, level: 1, lastDate: null, perTraining: {} };
}

function ymd(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function computeStats(history) {
  const completed = history.filter((h) => h.completed);
  const totalSec = completed.reduce((s, h) => s + h.durationSec, 0);
  const xp = Math.round(totalSec * XP_PER_SEC);
  const level = levelForXp(xp);

  const days = new Set(completed.map((h) => ymd(h.startedAt)));
  const sorted = [...days].sort();
  let longest = 0, streak = 0, cur = 0, prev = null;
  for (const d of sorted) {
    if (prev && dayDiff(prev, d) === 1) cur++;
    else cur = 1;
    longest = Math.max(longest, cur);
    prev = d;
  }
  if (sorted.length) {
    const today = ymd(Date.now());
    const yday = ymd(Date.now() - 86400000);
    if (sorted[sorted.length - 1] === today || sorted[sorted.length - 1] === yday) streak = cur;
  }

  const perTraining = {};
  for (const h of completed) {
    perTraining[h.trainingId] = (perTraining[h.trainingId] || 0) + 1;
  }

  return { total: completed.length, streak, longest, totalSec, xp, level, lastDate: sorted[sorted.length - 1] || null, perTraining };
}

function dayDiff(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

const ACHIEVEMENTS = [
  { id: 'first',    emoji: '🎯', title: 'First Step',     desc: 'Complete 1 session',      test: (s) => s.total >= 1 },
  { id: 'five',     emoji: '🔥', title: 'Getting Hot',    desc: 'Complete 5 sessions',     test: (s) => s.total >= 5 },
  { id: 'ten',      emoji: '💪', title: 'Ten Strong',     desc: 'Complete 10 sessions',    test: (s) => s.total >= 10 },
  { id: 'fifty',    emoji: '🏆', title: 'Half Century',   desc: 'Complete 50 sessions',    test: (s) => s.total >= 50 },
  { id: 'streak3',  emoji: '📅', title: '3-Day Streak',   desc: 'Train 3 days in a row',   test: (s) => s.longest >= 3 },
  { id: 'streak7',  emoji: '⚡', title: 'Week Warrior',    desc: 'Train 7 days in a row',   test: (s) => s.longest >= 7 },
  { id: 'streak30', emoji: '🌟', title: 'Monthly Maniac', desc: 'Train 30 days in a row',  test: (s) => s.longest >= 30 },
  { id: 'hour',     emoji: '⏱️', title: 'Hour of Power',  desc: 'Train for 1 hour total',  test: (s) => s.totalSec >= 3600 },
  { id: 'tenhours', emoji: '🕙', title: 'Ten Hour Club',  desc: 'Train for 10 hours total', test: (s) => s.totalSec >= 36000 },
  { id: 'lvl5',     emoji: '🥉', title: 'Level 5',        desc: 'Reach level 5',           test: (s) => s.level >= 5 },
  { id: 'lvl10',    emoji: '🥈', title: 'Level 10',       desc: 'Reach level 10',          test: (s) => s.level >= 10 },
  { id: 'lvl25',    emoji: '🥇', title: 'Level 25',       desc: 'Reach level 25',          test: (s) => s.level >= 25 },
];

function newlyUnlocked(before, after) {
  return ACHIEVEMENTS.filter((a) => !a.test(before) && a.test(after));
}

function showLevelUp(level) {
  const el = document.createElement('div');
  el.className = 'level-up-overlay';
  el.innerHTML = `
    <div class="level-up-card">
      <div class="big">LVL ${level}</div>
      <div class="msg">Level up!</div>
      <button class="primary">Continue</button>
    </div>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
  beep(880, 150);
  setTimeout(() => beep(1100, 200), 150);
  setTimeout(() => beep(1320, 300), 320);
}

function showAchievementToast(ach) {
  toast(`${ach.emoji} ${ach.title} unlocked!`);
  beep(1200, 100);
  setTimeout(() => beep(1500, 150), 120);
}

async function loadHistory() {
  state.history = (await idbAll('history')) || [];
  state.stats = computeStats(state.history);
  renderHistory();
  renderScheduleStats();
}

function renderHistory() {
  if (!state.stats) return;
  const s = state.stats;
  const nextLvlXp = xpForLevel(s.level + 1);
  const curLvlXp = xpForLevel(s.level);
  const pct = Math.min(100, Math.max(0, ((s.xp - curLvlXp) / (nextLvlXp - curLvlXp)) * 100));
  const mins = Math.floor(s.totalSec / 60);

  document.getElementById('stats-cards').innerHTML = `
    <div class="stat level">
      <div class="label">Level</div>
      <div class="value">${s.level}</div>
      <div class="sub">${s.xp} / ${nextLvlXp} XP</div>
      <div class="xp-bar"><div class="fill" style="width:${pct}%"></div></div>
    </div>
    <div class="stat streak">
      <div class="label">Streak</div>
      <div class="value">${s.streak} 🔥</div>
      <div class="sub">Best: ${s.longest} days</div>
    </div>
    <div class="stat total">
      <div class="label">Sessions</div>
      <div class="value">${s.total}</div>
      <div class="sub">Completed</div>
    </div>
    <div class="stat time">
      <div class="label">Total time</div>
      <div class="value">${mins}</div>
      <div class="sub">minutes trained</div>
    </div>
  `;

  document.getElementById('achievements').innerHTML = ACHIEVEMENTS.map((a) => `
    <div class="ach ${a.test(s) ? 'unlocked' : ''}">
      <div class="emoji">${a.emoji}</div>
      <div class="title">${a.title}</div>
      <div class="desc">${a.desc}</div>
    </div>
  `).join('');

  const list = document.getElementById('history-list');
  if (!state.history.length) {
    list.innerHTML = '<p class="hint">No sessions yet. Complete a training to start earning XP.</p>';
  } else {
    const recent = [...state.history].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30);
    list.innerHTML = recent.map((h) => {
      const d = new Date(h.startedAt);
      const when = d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const mm = Math.floor(h.durationSec / 60);
      const ss = h.durationSec % 60;
      const dur = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
      return `
        <div class="card history-entry" data-id="${h.id}">
          <div class="card-head">
            <div>
              <strong>${escapeHtml(h.trainingName)}</strong>
              <div class="date">${when}</div>
            </div>
            <span class="pill ${h.completed ? 'timed' : 'rest'}">${h.completed ? 'Completed' : 'Partial'}</span>
          </div>
          <div class="metrics">
            <span>⏱ <strong>${dur}</strong></span>
            <span>📋 <strong>${h.stepsCompleted}/${h.stepsTotal}</strong> steps</span>
            <span>✨ <strong>+${Math.round(h.durationSec * XP_PER_SEC)}</strong> XP</span>
          </div>
        </div>
      `;
    }).join('');
    list.querySelectorAll('.history-entry').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const session = state.history.find((h) => h.id === id);
        if (session) showSessionDetail(session);
      });
    });
  }
}

function showSessionDetail(h) {
  const d = new Date(h.startedAt);
  const when = d.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const mm = Math.floor(h.durationSec / 60);
  const ss = h.durationSec % 60;
  const dur = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;

  const log = h.log || [];
  const items = log.length ? log.map((s) => {
    const isReps = s.type === 'reps';

    let main, success;
    if (isReps) {
      const repsOk = s.actualReps >= s.plannedReps;
      const weightOk = !s.weighted || (s.actualWeight ?? 0) >= (s.plannedWeight ?? 0);
      success = repsOk && weightOk;
      const repsPart = s.actualReps === s.plannedReps
        ? `${s.actualReps} reps`
        : `${s.actualReps}/${s.plannedReps} reps`;
      let weightPart = '';
      if (s.weighted) {
        weightPart = s.actualWeight === s.plannedWeight
          ? ` × ${formatWeight(s.actualWeight)}`
          : ` × ${formatWeight(s.actualWeight)}/${formatWeight(s.plannedWeight)}`;
      }
      main = repsPart + weightPart;
    } else {
      const planned = s.plannedSec || 0;
      const actual = s.actualSec || 0;
      success = actual >= planned;
      main = success ? formatSec(actual) : `${formatSec(actual)}/${formatSec(planned)}`;
    }

    const repsTime = isReps && s.elapsedSec ? ` <span class="planned">in ${formatSec(s.elapsedSec)}</span>` : '';
    const icon = success ? '<span class="step-icon ok">✓</span>' : '<span class="step-icon partial">⚠</span>';
    const setLabel = s.setTotal > 1 ? ` <span class="hint">(set ${s.setIndex}/${s.setTotal})</span>` : '';
    return `
      <li class="${success ? '' : 'partial'}">
        <span class="pill ${s.type}">${s.type}</span>
        <span>${escapeHtml(s.label)}${setLabel}</span>
        <span class="actual">${main}${repsTime} ${icon}</span>
      </li>
    `;
  }).join('') : '<p class="hint">No step-level data recorded for this session.</p>';

  const overlay = document.createElement('div');
  overlay.className = 'session-detail-overlay';
  overlay.innerHTML = `
    <div class="session-detail-card">
      <h3>${escapeHtml(h.trainingName)}</h3>
      <div class="summary">
        ${when} · ${dur} · ${h.stepsCompleted}/${h.stepsTotal} steps · +${Math.round(h.durationSec * XP_PER_SEC)} XP
        ${h.completed ? '' : ' · <em>partial</em>'}
      </div>
      <ul class="step-log">${items}</ul>
      <div class="row" style="margin-top: 1rem; justify-content: flex-end;">
        <button class="danger" data-act="delete">Delete</button>
        <button data-act="close">Close</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.act === 'close') overlay.remove();
  });
  overlay.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!confirm('Delete this session from history?')) return;
    await idbDelete('history', h.id);
    overlay.remove();
    await loadHistory();
  });
  document.body.appendChild(overlay);
}

function formatSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function formatWeight(kg) {
  if (kg == null) return '0kg';
  return Number.isInteger(kg) ? `${kg}kg` : `${kg.toFixed(1)}kg`;
}

function renderScheduleStats() {
  if (!state.stats) return;
  // compact strip at top of schedule view if user has history
  const existing = document.getElementById('mini-stats');
  if (existing) existing.remove();
  if (!state.stats.total) return;
  const s = state.stats;
  const el = document.createElement('div');
  el.id = 'mini-stats';
  el.className = 'next-up';
  el.style.background = 'linear-gradient(135deg, #1a3326, #1e3a5f)';
  el.innerHTML = `
    <div class="row" style="justify-content: space-around;">
      <div><strong>Lvl ${s.level}</strong> <span class="hint">${s.xp} XP</span></div>
      <div><strong>${s.streak} 🔥</strong> <span class="hint">streak</span></div>
      <div><strong>${s.total}</strong> <span class="hint">sessions</span></div>
    </div>
  `;
  const scheduleView = document.getElementById('view-schedule');
  scheduleView.insertBefore(el, scheduleView.querySelector('.toolbar').nextSibling);
}

// ====== Export / import ======
async function exportData() {
  const data = {
    app: 'training-timer',
    version: 1,
    exportedAt: new Date().toISOString(),
    trainings: await idbAll('trainings'),
    schedule: await idbAll('schedule'),
    history: await idbAll('history'),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `training-timer-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Exported');
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Invalid JSON');
    return;
  }
  if (data.app !== 'training-timer') {
    if (!confirm('File does not look like a Training Timer export. Import anyway?')) return;
  }
  const mode = confirm('OK to MERGE with existing data.\nCancel to REPLACE all existing data.');
  const db = await openDB();
  const stores = ['trainings', 'schedule', 'history'];
  await new Promise((res, rej) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    for (const s of stores) {
      const store = tx.objectStore(s);
      if (!mode) store.clear();
      for (const item of (data[s] || [])) store.put(item);
    }
  });
  toast(mode ? 'Merged' : 'Replaced');
  await loadTrainings();
  await loadSchedule();
  await loadHistory();
  scheduleReminders();
}

document.getElementById('export-data')?.addEventListener('click', exportData);
document.getElementById('import-data')?.addEventListener('click', () => document.getElementById('import-file')?.click());
document.getElementById('import-file')?.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) importData(f);
  e.target.value = '';
});

// ====== PWA install ======
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const btn = document.getElementById('install-btn');
  if (btn) btn.hidden = false;
  console.log('PWA installable');
});
document.getElementById('install-btn').addEventListener('click', async () => {
  if (!deferredInstall) { toast('Install not available yet'); return; }
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  toast('Install: ' + outcome);
  deferredInstall = null;
  document.getElementById('install-btn').hidden = true;
});
window.addEventListener('appinstalled', () => {
  toast('Installed!');
  document.getElementById('install-btn').hidden = true;
});

// ====== Init ======
(async function init() {
  await loadTrainings();
  await loadSchedule();
  await loadHistory();
  scheduleReminders();
  // Re-evaluate reminders every minute (catches clock drift & missed wakeups)
  setInterval(() => {
    renderNextUp();
  }, 60 * 1000);
})();
