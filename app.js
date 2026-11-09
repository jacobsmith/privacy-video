// Privacy Blur — UI controller.
import {
  initModels, seek, grabFrame, detectFaces, cropThumb, clusterFaces,
  analyzeVideo, linkTracks, buildTimeline, regionsAt, drawFrame,
} from './engine.js';

const $ = (id) => document.getElementById(id);

const state = {
  ready: false,
  file: null,
  objectUrl: null,
  faces: [],        // snapshot faces: {id, t, box, descriptor, thumb, keep}
  scannedTimes: new Set(),
  samples: null,    // full-video analysis
  tracks: null,
  analysisKey: null,
  busy: false,
  cancel: false,
  exporting: false,
  manual: [],        // manual blurs: {id, start, end, keys:[{t, box}]}
  selectedManual: null,
  drawing: false,
};
let manualSeq = 0;
window.__privacyBlur = state; // handy for debugging in the console (local only)

const video = $('video');
const previewCanvas = $('previewCanvas');
const pctx = previewCanvas.getContext('2d');

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------
let currentStep = 1;
function showStep(n) {
  currentStep = n;
  for (let i = 1; i <= 4; i++) $(`step${i}`).hidden = i !== n;
  document.querySelectorAll('#steps button').forEach((b) => {
    b.classList.toggle('active', +b.dataset.step === n);
  });
  if (n !== 2 && !video.paused) video.pause();
  if (n === 4) enterPreview();
  if (n !== 4) stopPreviewLoop();
}
function enableStep(n, on = true) {
  document.querySelector(`#steps button[data-step="${n}"]`).disabled = !on;
}
document.querySelectorAll('#steps button').forEach((b) => {
  b.addEventListener('click', () => { if (!state.busy && !state.exporting) showStep(+b.dataset.step); });
});

function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------
(async () => {
  try {
    const t0 = performance.now();
    const params = new URLSearchParams(location.search);
    const backend = await initModels(params.get('backend') || undefined);
    state.ready = true;
    setStatus($('modelStatus'), `Face detection ready (${((performance.now() - t0) / 1000).toFixed(1)}s).`);
    $('backendInfo').textContent = `Face models run locally via TensorFlow.js (${backend} backend). No data leaves this device.`;
  } catch (err) {
    console.error(err);
    setStatus($('modelStatus'), `Could not load the face models: ${err.message}. Make sure you opened the app through the local server (see README).`, true);
  }
})();

// ---------------------------------------------------------------------------
// Step 1 — choose file
// ---------------------------------------------------------------------------
const drop = $('drop');
$('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) {
    setStatus($('modelStatus'), 'That does not look like a video file.', true);
    return;
  }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = file;
  // A blob: URL points at the file on disk. The browser reads it locally.
  state.objectUrl = URL.createObjectURL(file);
  state.faces = []; state.scannedTimes.clear();
  state.samples = null; state.tracks = null; state.analysisKey = null;
  state.manual = []; state.selectedManual = null;
  renderManualList();
  video.src = state.objectUrl;
  try {
    await new Promise((res, rej) => {
      video.addEventListener('loadeddata', res, { once: true });
      video.addEventListener('error', () => rej(new Error('This browser cannot play this video format.')), { once: true });
    });
  } catch (err) {
    setStatus($('modelStatus'), err.message, true);
    return;
  }
  renderPeople();
  enableStep(2); enableStep(3, false); enableStep(4, false);
  $('downloadLink').hidden = true;
  setStatus($('scanStatus'), `${file.name} — ${video.videoWidth}×${video.videoHeight}, ${fmtTime(video.duration)}`);
  showStep(2);
}

// ---------------------------------------------------------------------------
// Step 2 — snapshot faces + pick who stays visible
// ---------------------------------------------------------------------------
const snapCanvas = document.createElement('canvas');
let faceSeq = 0;

async function scanAt(times) {
  if (!state.ready) { setStatus($('scanStatus'), 'Models are still loading, one moment…'); return; }
  state.busy = true;
  $('scanBtn').disabled = $('scanFrameBtn').disabled = true;
  const wasTime = video.currentTime;
  video.pause();
  let found = 0;
  try {
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const key = t.toFixed(2);
      if (state.scannedTimes.has(key)) continue;
      setStatus($('scanStatus'), `Looking for faces in snapshot ${i + 1} of ${times.length}…`);
      await seek(video, t);
      grabFrame(video, snapCanvas);
      const dets = await detectFaces(snapCanvas, { minConfidence: 0.5 });
      state.scannedTimes.add(key);
      for (const d of dets) {
        if (d.box.w < 24) continue; // too small to be useful as a reference
        state.faces.push({ id: ++faceSeq, t, box: d.box, descriptor: d.descriptor, thumb: cropThumb(snapCanvas, d.box), keep: false });
        found++;
      }
    }
    setStatus($('scanStatus'), `Found ${found} face${found === 1 ? '' : 's'} in ${times.length} snapshot${times.length === 1 ? '' : 's'}. Click the face(s) that should stay visible.`);
  } catch (err) {
    console.error(err);
    setStatus($('scanStatus'), `Face scan failed: ${err.message}`, true);
  } finally {
    state.busy = false;
    $('scanBtn').disabled = $('scanFrameBtn').disabled = false;
    if (times.length > 1) await seek(video, wasTime);
    renderPeople();
  }
}

$('scanBtn').addEventListener('click', () => {
  const n = Math.max(2, Math.min(40, +$('snapCount').value || 8));
  const times = Array.from({ length: n }, (_, i) => +(((i + 0.5) / n) * video.duration).toFixed(3));
  scanAt(times);
});
$('scanFrameBtn').addEventListener('click', () => scanAt([+video.currentTime.toFixed(3)]));

function keepRefs() {
  return state.faces.filter((f) => f.keep).map((f) => f.descriptor);
}

function renderPeople() {
  const host = $('people');
  host.innerHTML = '';
  const clusters = clusterFaces(state.faces);
  clusters.forEach((c, idx) => {
    const box = document.createElement('div');
    box.className = 'person';
    const head = document.createElement('div');
    head.className = 'person-head';
    const anyKeep = c.faces.some((f) => f.keep);
    head.innerHTML = `<span>Person ${idx + 1} · seen ${c.faces.length}×</span>`;
    const toggleAll = document.createElement('button');
    toggleAll.textContent = anyKeep ? 'Blur all' : 'Keep all';
    toggleAll.addEventListener('click', () => {
      const v = !anyKeep;
      c.faces.forEach((f) => { f.keep = v; });
      onKeepChanged();
    });
    head.appendChild(toggleAll);
    box.appendChild(head);
    const row = document.createElement('div');
    row.className = 'faces';
    for (const f of c.faces) {
      const b = document.createElement('button');
      b.className = 'face' + (f.keep ? ' keep' : '');
      b.title = `${fmtTime(f.t)} — click to ${f.keep ? 'blur' : 'keep visible'}`;
      b.innerHTML = `<img alt="Face at ${fmtTime(f.t)}" src="${f.thumb}"><span class="tag">${f.keep ? 'KEEP' : 'BLUR'}</span>`;
      b.addEventListener('click', () => { f.keep = !f.keep; onKeepChanged(); });
      b.addEventListener('dblclick', () => { video.currentTime = f.t; });
      row.appendChild(b);
    }
    box.appendChild(row);
    host.appendChild(box);
  });
  const kept = state.faces.filter((f) => f.keep).length;
  const keptPeople = clusters.filter((c) => c.faces.some((f) => f.keep)).length;
  $('keepSummary').textContent = state.faces.length
    ? (kept ? `Keeping ${keptPeople} person${keptPeople === 1 ? '' : 's'} visible (${kept} reference photo${kept === 1 ? '' : 's'}). Everyone else is blurred.` : 'All faces will be blurred. Click a face to keep it visible.')
    : 'No faces found yet — click “Find faces in snapshots”.';
  $('toStep3').disabled = state.faces.length === 0;
}

function onKeepChanged() {
  renderPeople();
  if (state.samples) refreshTimeline();
}

$('toStep3').addEventListener('click', () => {
  enableStep(3);
  if (state.samples) { enableStep(4); showStep(4); } else showStep(3);
});

// ---------------------------------------------------------------------------
// Step 3 — analyse the whole video
// ---------------------------------------------------------------------------
$('minConf').addEventListener('input', (e) => { $('minConfOut').textContent = (+e.target.value).toFixed(2); });

function analysisOptions() {
  return { fps: +$('fps').value, minConfidence: +$('minConf').value, smallFaces: $('smallFaces').checked };
}

$('analyzeBtn').addEventListener('click', async () => {
  if (!state.ready) return;
  state.busy = true; state.cancel = false;
  $('analyzeBtn').disabled = true; $('cancelBtn').hidden = false;
  $('progressWrap').hidden = false; $('analysisCanvas').hidden = false;
  const actx = $('analysisCanvas').getContext('2d');
  const opts = analysisOptions();
  const t0 = performance.now();
  try {
    const samples = await analyzeVideo(video, opts, ({ i, n, canvas, dets, eta }) => {
      $('progressBar').style.width = `${(100 * i) / n}%`;
      setStatus($('analyzeStatus'), `Scanning frame ${i} of ${n} — ${dets.length} face${dets.length === 1 ? '' : 's'} in this frame — about ${Math.ceil(eta)}s left`);
      if (i % 2 === 0 || i === n) {
        const ac = $('analysisCanvas');
        ac.width = canvas.width; ac.height = canvas.height;
        actx.drawImage(canvas, 0, 0);
        actx.lineWidth = Math.max(2, canvas.width / 400);
        actx.strokeStyle = '#facc15';
        for (const d of dets) actx.strokeRect(d.box.x, d.box.y, d.box.w, d.box.h);
      }
    }, () => state.cancel);
    state.samples = samples;
    state.tracks = linkTracks(samples);
    state.analysisKey = JSON.stringify(opts);
    const total = samples.reduce((s, x) => s + x.dets.length, 0);
    setStatus($('analyzeStatus'), `Done in ${((performance.now() - t0) / 1000).toFixed(0)}s — ${total} face detections across ${samples.length} frames.`);
    enableStep(4);
    showStep(4);
  } catch (err) {
    if (err.message === 'cancelled') setStatus($('analyzeStatus'), 'Cancelled.');
    else { console.error(err); setStatus($('analyzeStatus'), `Processing failed: ${err.message}`, true); }
  } finally {
    state.busy = false;
    $('analyzeBtn').disabled = false; $('cancelBtn').hidden = true;
    $('analysisCanvas').hidden = true;
  }
});
$('cancelBtn').addEventListener('click', () => { state.cancel = true; });

// ---------------------------------------------------------------------------
// Step 4 — preview + export
// ---------------------------------------------------------------------------
function renderOptions() {
  const preview = !state.exporting;
  return {
    pad: +$('pad').value,
    cells: +$('cells').value,
    debug: $('debugBoxes').checked && preview,
    showManual: preview && (state.drawing || $('debugBoxes').checked),
    selectedManual: state.selectedManual,
  };
}

for (const [id, out, digits, suffix] of [['threshold', 'thresholdOut', 2, ''], ['pad', 'padOut', 2, ''], ['cells', 'cellsOut', 0, ''], ['holdSec', 'holdSecOut', 1, ' s']]) {
  $(id).addEventListener('input', () => {
    $(out).textContent = (+$(id).value).toFixed(digits) + suffix;
    if (id === 'threshold' || id === 'holdSec') refreshTimeline();
    drawCurrent();
  });
}
$('debugBoxes').addEventListener('change', drawCurrent);

function refreshTimeline() {
  if (!state.samples) return;
  const spacing = state.samples.length > 1 ? state.samples[1].t - state.samples[0].t : 0.1;
  const hold = Math.round(+$('holdSec').value / spacing);
  const stats = buildTimeline(state.samples, state.tracks, keepRefs(), { threshold: +$('threshold').value, hold, edgeHold: Math.round(3 / spacing), frameW: video.videoWidth, frameH: video.videoHeight });
  setStatus($('timelineStats'), `${stats.tracks} face track${stats.tracks === 1 ? '' : 's'} found: ${stats.keptTracks} kept visible, ${stats.blurredTracks} blurred.`);
  drawCurrent();
}

function drawAt(t) {
  if (previewCanvas.width !== video.videoWidth) { previewCanvas.width = video.videoWidth; previewCanvas.height = video.videoHeight; }
  drawFrame(pctx, video, regionsAt(state.samples, t, state.manual), renderOptions());
  if (dragRect) {
    pctx.save();
    pctx.lineWidth = Math.max(2, previewCanvas.width / 450);
    pctx.strokeStyle = '#facc15';
    pctx.fillStyle = 'rgba(250,204,21,0.15)';
    pctx.fillRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    pctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    pctx.restore();
  }
  $('timeLabel').textContent = `${fmtTime(t)} / ${fmtTime(video.duration)}`;
  if (!seeking) $('seekBar').value = Math.round((t / video.duration) * 1000);
}
function drawCurrent() { if (currentStep === 4 && video.readyState >= 2) drawAt(video.currentTime); }

let audio = null;
function ensureAudioGraph() {
  // Route the video's audio through Web Audio so we can (a) record it into the
  // export and (b) still hear it. Must be created after a user gesture.
  if (audio) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return audio; }
  const ctx = new AudioContext();
  const src = ctx.createMediaElementSource(video);
  const speakers = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  src.connect(speakers).connect(ctx.destination);
  src.connect(dest);
  audio = { ctx, src, speakers, dest };
  return audio;
}

let loopActive = false;
let rafId = 0;
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let onFrameHook = null;
function frameLoop() {
  if (!loopActive) return;
  if (hasRVFC) {
    video.requestVideoFrameCallback((_now, meta) => {
      if (!loopActive) return;
      drawAt(meta.mediaTime);
      if (onFrameHook) onFrameHook(meta.mediaTime);
      frameLoop();
    });
  } else {
    rafId = requestAnimationFrame(() => { drawAt(video.currentTime); if (onFrameHook) onFrameHook(video.currentTime); frameLoop(); });
  }
}
function startPreviewLoop() { if (!loopActive) { loopActive = true; frameLoop(); } }
function stopPreviewLoop() { loopActive = false; cancelAnimationFrame(rafId); }

function enterPreview() {
  refreshTimeline();
  if (video.readyState >= 2) drawAt(video.currentTime);
  else video.addEventListener('loadeddata', () => drawAt(video.currentTime), { once: true });
}

let seeking = false;
$('seekBar').addEventListener('input', () => {
  seeking = true;
  video.currentTime = (+$('seekBar').value / 1000) * video.duration;
});
video.addEventListener('seeked', () => { seeking = false; if (currentStep === 4 && !state.busy) drawAt(video.currentTime); });

$('playBtn').addEventListener('click', async () => {
  if (state.exporting) return;
  ensureAudioGraph();
  if (video.paused) {
    if (video.ended || video.currentTime >= video.duration - 0.05) await seek(video, 0);
    startPreviewLoop();
    await video.play();
  } else {
    video.pause();
  }
});
video.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; });
video.addEventListener('pause', () => { $('playBtn').textContent = '▶'; if (currentStep === 4 && !state.exporting) { stopPreviewLoop(); drawCurrent(); } });

// ---------------------------------------------------------------------------
// Manual blur boxes
// ---------------------------------------------------------------------------
let dragRect = null;
let dragStart = null;

function setDrawing(on) {
  state.drawing = on;
  $('drawToggle').setAttribute('aria-pressed', String(on));
  $('drawToggle').textContent = on ? '✓ Done drawing' : '✎ Draw blur box';
  previewCanvas.classList.toggle('drawing', on);
  $('drawHint').hidden = !on;
  if (on && !video.paused) video.pause();
  drawCurrent();
}
$('drawToggle').addEventListener('click', () => { if (!state.exporting) setDrawing(!state.drawing); });

// Convert a pointer position to video-pixel coordinates (canvas uses object-fit: contain).
function toVideoCoords(e) {
  const r = previewCanvas.getBoundingClientRect();
  const cw = previewCanvas.width, ch = previewCanvas.height;
  const s = Math.min(r.width / cw, r.height / ch);
  const ox = (r.width - cw * s) / 2, oy = (r.height - ch * s) / 2;
  return {
    x: Math.min(cw, Math.max(0, (e.clientX - r.left - ox) / s)),
    y: Math.min(ch, Math.max(0, (e.clientY - r.top - oy) / s)),
  };
}

// Default box for a single click: about the size of a typical face in this video.
function defaultBoxSize() {
  const sizes = [];
  for (const s of state.samples || []) for (const d of s.dets) sizes.push(Math.max(d.box.w, d.box.h));
  sizes.sort((a, b) => a - b);
  const median = sizes.length ? sizes[sizes.length >> 1] : previewCanvas.width * 0.08;
  return Math.max(40, median * 1.6);
}

previewCanvas.addEventListener('pointerdown', (e) => {
  if (!state.drawing || state.exporting) return;
  e.preventDefault();
  if (!video.paused) video.pause();
  previewCanvas.setPointerCapture(e.pointerId);
  dragStart = toVideoCoords(e);
  dragRect = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
});
previewCanvas.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = toVideoCoords(e);
  dragRect = { x: Math.min(p.x, dragStart.x), y: Math.min(p.y, dragStart.y), w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y) };
  drawCurrent();
});
previewCanvas.addEventListener('pointerup', () => {
  if (!dragStart) return;
  let box = dragRect;
  // A click (tiny drag) makes a face-sized box centred on the click.
  if (box.w < 12 || box.h < 12) {
    const size = defaultBoxSize();
    box = { x: dragStart.x - size / 2, y: dragStart.y - size / 2, w: size, h: size * 1.15 };
  }
  dragStart = null; dragRect = null;
  addManualKey(box, video.currentTime);
});
previewCanvas.addEventListener('pointercancel', () => { dragStart = null; dragRect = null; drawCurrent(); });

function addManualKey(box, t) {
  const sel = state.manual.find((m) => m.id === state.selectedManual);
  if (sel) {
    // Add a keyframe to the selected blur so it follows the person over time.
    const existing = sel.keys.find((k) => Math.abs(k.t - t) < 0.05);
    if (existing) existing.box = box; else sel.keys.push({ t, box });
    sel.keys.sort((a, b) => a.t - b.t);
    if (t < sel.start) sel.start = Math.max(0, t - 0.25);
    if (t > sel.end) sel.end = Math.min(video.duration, t + 1);
  } else {
    const m = {
      id: ++manualSeq,
      start: Math.max(0, t - 0.25),
      end: Math.min(video.duration, t + 2),
      keys: [{ t, box }],
    };
    state.manual.push(m);
    state.selectedManual = m.id;
  }
  renderManualList();
  drawCurrent();
}

function renderManualList() {
  const host = $('manualList');
  host.innerHTML = '';
  if (!state.manual.length) {
    host.innerHTML = '<div class="manual-empty">No manual blurs yet.</div>';
    return;
  }
  const dur = video.duration || 0;
  state.manual.forEach((m, idx) => {
    const el = document.createElement('div');
    el.className = 'manual-item' + (m.id === state.selectedManual ? ' selected' : '');
    el.innerHTML = `
      <div class="mi-head">
        <span><b>Blur ${idx + 1}</b> · ${m.keys.length} position${m.keys.length === 1 ? '' : 's'}${m.id === state.selectedManual ? ' · <i>selected (new drawings move this box)</i>' : ''}</span>
        <button data-act="delete" title="Remove this manual blur">Remove</button>
      </div>
      <div class="mi-times">
        <label>From <input type="number" data-f="start" min="0" max="${dur.toFixed(2)}" step="0.1" value="${m.start.toFixed(1)}"> s</label>
        <button data-act="start-now" title="Start this blur at the current moment">⇤ now</button>
        <label>to <input type="number" data-f="end" min="0" max="${dur.toFixed(2)}" step="0.1" value="${m.end.toFixed(1)}"> s</label>
        <button data-act="end-now" title="End this blur at the current moment">now ⇥</button>
        <button data-act="whole" title="Blur this area for the whole video">Whole video</button>
      </div>`;
    el.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (e.target.tagName === 'INPUT') return;
      if (act === 'delete') {
        state.manual = state.manual.filter((x) => x.id !== m.id);
        if (state.selectedManual === m.id) state.selectedManual = null;
      } else if (act === 'start-now') {
        m.start = Math.min(video.currentTime, m.end);
      } else if (act === 'end-now') {
        m.end = Math.max(video.currentTime, m.start);
      } else if (act === 'whole') {
        m.start = 0; m.end = dur;
      } else {
        // Select / deselect, and jump to where this blur starts.
        const wasSelected = state.selectedManual === m.id;
        state.selectedManual = wasSelected ? null : m.id;
        if (!wasSelected && (video.currentTime < m.start || video.currentTime > m.end)) video.currentTime = m.keys[0].t;
      }
      renderManualList();
      drawCurrent();
    });
    el.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const v = Math.min(dur, Math.max(0, +inp.value || 0));
        if (inp.dataset.f === 'start') m.start = Math.min(v, m.end); else m.end = Math.max(v, m.start);
        renderManualList();
        drawCurrent();
      });
    });
    host.appendChild(el);
  });
  const deselect = document.createElement('small');
  deselect.className = 'manual-empty';
  deselect.textContent = state.selectedManual
    ? 'Click the selected blur again to deselect it, so your next drawing starts a new blur.'
    : 'Your next drawing starts a new blur.';
  host.appendChild(deselect);
}
renderManualList();

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

$('exportBtn').addEventListener('click', async () => {
  if (state.exporting || !state.samples) return;
  if (!window.MediaRecorder || !previewCanvas.captureStream) {
    setStatus($('exportStatus'), 'This browser cannot record video. Please use a recent Chrome, Edge or Firefox.', true);
    return;
  }
  state.exporting = true;
  setDrawing(false);
  const a = ensureAudioGraph();
  await a.ctx.resume();
  a.speakers.gain.value = 0; // silence speakers while recording; recording still gets audio
  ['exportBtn', 'playBtn', 'seekBar', 'threshold', 'pad', 'cells', 'holdSec', 'drawToggle'].forEach((id) => { $(id).disabled = true; });
  $('downloadLink').hidden = true;
  $('exportProgressWrap').hidden = false;
  video.pause();
  stopPreviewLoop();

  const mimeType = pickMimeType();
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  const canvasStream = previewCanvas.captureStream(0);
  const vTrack = canvasStream.getVideoTracks()[0];
  const tracks = [vTrack, ...a.dest.stream.getAudioTracks()];
  const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { recorder.onstop = res; });

  try {
    await seek(video, 0);
    drawAt(0);
    recorder.start(1000);
    vTrack.requestFrame();
    onFrameHook = (t) => {
      vTrack.requestFrame();
      $('exportProgressBar').style.width = `${(100 * t) / video.duration}%`;
      setStatus($('exportStatus'), `Recording… ${fmtTime(t)} / ${fmtTime(video.duration)}`);
    };
    const ended = new Promise((res) => video.addEventListener('ended', res, { once: true }));
    startPreviewLoop();
    await video.play();
    await ended;
    // allow last frame to flush
    await new Promise((r) => setTimeout(r, 250));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const link = $('downloadLink');
    const base = state.file.name.replace(/\.[^.]+$/, '');
    link.href = url;
    link.download = `${base}-blurred.${ext}`;
    link.textContent = `Download ${link.download} (${(blob.size / 1e6).toFixed(1)} MB)`;
    link.hidden = false;
    $('exportProgressBar').style.width = '100%';
    setStatus($('exportStatus'), 'Export finished. The file is created on this computer; click Download to save it.');
  } catch (err) {
    console.error(err);
    setStatus($('exportStatus'), `Export failed: ${err.message}`, true);
    if (recorder.state !== 'inactive') recorder.stop();
  } finally {
    onFrameHook = null;
    stopPreviewLoop();
    state.exporting = false;
    a.speakers.gain.value = 1;
    ['exportBtn', 'playBtn', 'seekBar', 'threshold', 'pad', 'cells', 'holdSec', 'drawToggle'].forEach((id) => { $(id).disabled = false; });
    drawCurrent();
  }
});
