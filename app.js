// Privacy Blur — UI controller.
import {
  initModels, poseAvailable, seek, grabFrame, detectFaces, cropThumb, clusterFaces, scaleBox, analysisSize,
  analyzeVideo, linkTracks, buildTimeline, regionsAt, drawFrame,
} from './engine.js';
import { VERSION, BUILT_UTC } from './version.js';
import { probeVideoFile } from './probe.js';

const $ = (id) => document.getElementById(id);

// Version stamp next to the app name (YY.MM.DD.HH.MM, UTC), so it's easy to
// tell whether a browser has loaded the latest update.
$('appVersion').textContent = `v${VERSION}`;
$('appVersion').title = `Version ${VERSION}, updated ${BUILT_UTC.replace('T', ' ').replace('Z', ' UTC')}`;
console.info(`[privacy-blur] version ${VERSION} (${BUILT_UTC})`);

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
  if (n === 3) renderScanPlan();
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

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fmtInt = (n) => Math.round(n).toLocaleString();
function resLabel(w, h) {
  const s = Math.min(w, h);
  return s >= 2160 ? '4K' : s >= 1440 ? '1440p' : s >= 1080 ? '1080p' : s >= 720 ? '720p' : s >= 480 ? '480p' : 'low resolution';
}
function fmtDuration(sec) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

// ---------------------------------------------------------------------------
// Video facts (step 2) and what will be scanned (step 3)
// ---------------------------------------------------------------------------
function renderVideoInfo() {
  const el = $('videoInfo');
  const f = state.file, p = state.probe || {};
  if (!f || !video.videoWidth) { el.hidden = true; return; }
  const w = video.videoWidth, h = video.videoHeight, dur = video.duration;
  const a = analysisSize(w, h);
  const orient = w > h ? 'landscape' : h > w ? 'portrait' : 'square';
  const rows = [
    ['File', `${f.name} · ${fmtBytes(f.size)}`],
    ['Resolution', `${w}×${h} · ${resLabel(w, h)} · ${orient}`,
      a.scale < 1 ? `Faces are searched for at ${a.w}×${a.h} to save time and memory. The preview and export keep the full ${w}×${h}.` : ''],
    ['Length', fmtTime(dur)],
  ];
  if (p.fps) rows.push(['Frame rate', `${p.fps >= 10 ? Math.round(p.fps) : p.fps.toFixed(1)} fps · ${fmtInt(p.frames)} frames`]);
  if (p.videoCodec) rows.push(['Video', [p.videoCodec, p.hdr, p.container].filter(Boolean).join(' · ')]);
  if (Number.isFinite(dur) && dur > 0) rows.push(['Bitrate', `${(f.size * 8 / dur / 1e6).toFixed(1)} Mbit/s average${p.hasAudio ? ', incl. sound' : ''}`]);
  if (p.hasAudio !== undefined) rows.push(['Sound', p.hasAudio ? p.audioCodec || 'yes' : 'no sound track']);
  el.innerHTML = '';
  for (const [k, v, note] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    if (note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = note; dd.append(n); }
    el.append(dt, dd);
  }
  el.hidden = false;
}

// Per-frame cost of each mode relative to the snapshot scan (which runs the
// detector with the contrast boost), from the measurements in DECISIONS.md.
const MODE_COST = { fast: 0.47, medium: 1.2, slow: 5.1 };
function renderScanPlan() {
  const dur = video.duration;
  if (!state.file || !Number.isFinite(dur) || !video.videoWidth) { $('scanPlan').textContent = ''; return; }
  const scanFps = +$('fps').value;
  const n = Math.ceil(dur * scanFps);
  const a = analysisSize(video.videoWidth, video.videoHeight);
  const total = state.probe && state.probe.frames;
  let text = `At ${scanFps} frames/sec, ${fmtInt(n)} frames will be scanned${total ? ` (of the video's ${fmtInt(total)})` : ''}, at ${a.w}×${a.h}`
    + (a.scale < 1 ? ` (scaled down from ${video.videoWidth}×${video.videoHeight}; the export keeps full resolution).` : '.');
  const snap = state.snapTimes && state.snapTimes.length ? state.snapTimes.reduce((x, y) => x + y, 0) / state.snapTimes.length : null;
  for (const el of document.querySelectorAll('.mode-est')) {
    el.textContent = snap ? `≈ ${fmtDuration((n * snap * MODE_COST[el.dataset.mode]) / 1000)} on this device` : '';
  }
  text += snap ? ' Time estimates are rough, based on how long the snapshot scan took on this device.' : ' Run the snapshot scan in step 2 to see time estimates for this device.';
  $('scanPlan').textContent = text;
}
$('fps').addEventListener('change', renderScanPlan);

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// Progress bars: set(fraction) for measurable progress, busy() for work that
// can't be measured (shows a moving bar), hide() when done.
function progress(wrapId) {
  const wrap = $(wrapId), bar = wrap.querySelector('.bar');
  return {
    set(f) {
      const pct = Math.round(Math.min(1, Math.max(0, f)) * 1000) / 10;
      wrap.hidden = false;
      wrap.classList.remove('indeterminate');
      bar.style.width = `${pct}%`;
      wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    },
    busy() {
      wrap.hidden = false;
      wrap.classList.add('indeterminate');
      bar.style.width = '';
      wrap.removeAttribute('aria-valuenow');
    },
    hide() { wrap.hidden = true; },
  };
}
const modelBar = progress('modelProgressWrap');
const fileBar = progress('fileProgressWrap');
const scanBar = progress('scanProgressWrap');
const analyzeBar = progress('progressWrap');
const exportBar = progress('exportProgressWrap');
const mb = (n) => (n / 1e6).toFixed(1);

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------
let loadFailed = false;
(async () => {
  try {
    const t0 = performance.now();
    const params = new URLSearchParams(location.search);
    const backend = await initModels(params.get('backend') || undefined, ({ stage, fraction, loaded, total }) => {
      if (loadFailed) return; // a parallel download may still report after another one failed
      modelBar.set(fraction);
      $('modelLoadText').textContent = stage === 'download'
        ? `Downloading face detection models… ${mb(loaded)} of ${mb(total)} MB`
        : stage === 'prepare' ? 'Preparing face detection models…' : 'Starting face detection…';
    });
    state.ready = true;
    $('modelLoad').hidden = true;
    if (!poseAvailable()) { $('poseLayer').checked = false; $('poseLayer').disabled = true; }
    if (!state.file) setStatus($('modelStatus'), `Face detection ready (${((performance.now() - t0) / 1000).toFixed(1)}s).`);
    $('backendInfo').textContent = `Face models run locally via TensorFlow.js (${backend} backend). No data leaves this device.`;
  } catch (err) {
    console.error(err);
    loadFailed = true;
    modelBar.hide();
    $('modelLoad').classList.add('error');
    setStatus($('modelLoadText'), `Could not load the face models: ${err.message}. Make sure you opened the app through the local server (see README), then reload the page.`, true);
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

/**
 * Plain-language explanation for a video the browser can't play. iPhone
 * .mov files recorded in "High Efficiency" (HEVC / H.265) are the usual cause.
 */
function cannotPlay(name, why) {
  const iphone = /\.(mov|hevc)$/i.test(name);
  const hevc = 'iPhone videos are often saved as "High Efficiency" (HEVC), which many browsers can\'t decode.';
  const fixes = iphone
    ? 'To fix it: open the app in Safari, or in Chrome or Edge on a Mac or Windows PC that supports HEVC; or convert the video to MP4 (H.264), for example by exporting it from the Photos app. For future recordings, set the iPhone to Settings → Camera → Formats → Most Compatible.'
    : 'To fix it: try another browser (Chrome, Edge or Safari), or convert the video to MP4 (H.264).';
  if (why === 'audio-only') {
    return `This browser can open ${name} but can only play its sound, not its picture: the video is in a format this browser can't decode. ${iphone ? hevc + ' ' : ''}${fixes}`;
  }
  const cause = `the file may be damaged or incomplete (for example, still copying or downloading), or saved in a format this browser can't decode.${iphone ? ' ' + hevc : ''}`;
  if (why === 'hint') return `${cause} ${fixes}`;
  return `This browser can't ${why === 'decode' ? 'decode' : 'play'} ${name}: ${cause} ${fixes}`;
}

// Get the browser to decode the first frame (see loadFile). Muted, inline
// playback is allowed without a tap on iOS; the sound setting is restored.
async function nudgeFirstFrame() {
  const wasMuted = video.muted;
  video.muted = true;
  try {
    await video.play();
    video.pause();
    video.currentTime = 0;
  } catch (err) {
    console.warn('[privacy-blur] could not start playback to decode the first frame', err);
  } finally {
    video.muted = wasMuted;
  }
}

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
  fileBar.busy();
  const name = file.name;
  const size = file.size >= 1e9 ? `${(file.size / 1e9).toFixed(1)} GB` : `${Math.max(0.1, file.size / 1e6).toFixed(1)} MB`;
  setStatus($('modelStatus'), `Opening ${name} (${size})… Your browser is reading the video from this computer and decoding the first frame. Nothing is uploaded.`);
  let slowTimer = null;
  try {
    await new Promise((res, rej) => {
      // Stage 1: the browser has read the file's header (size, length).
      video.addEventListener('loadedmetadata', () => {
        if (video.videoWidth) setStatus($('modelStatus'), `Opening ${name}: found a ${video.videoWidth}×${video.videoHeight} video, ${fmtTime(video.duration)} long. Decoding the first frame…`);
        // iPhone/iPad Safari reads the file's header but doesn't decode any
        // picture until playback starts, so 'loadeddata' never arrives on its
        // own. If no frame shows up quickly, play muted for a moment and pause.
        setTimeout(() => { if (video.readyState < 2) nudgeFirstFrame(); }, 400);
      }, { once: true });
      // Stage 2: the first frame is decoded. A file whose video the browser
      // can't decode can still get here with only its audio (width 0).
      video.addEventListener('loadeddata', () => (video.videoWidth ? res() : rej(new Error(cannotPlay(name, 'audio-only')))), { once: true });
      video.addEventListener('error', () => {
        const code = video.error && video.error.code;
        rej(new Error(cannotPlay(name, code === 3 ? 'decode' : 'format')));
      }, { once: true });
      // Some browsers never report an error for a format they can't decode;
      // they just keep waiting. Explain what may be going on.
      slowTimer = setTimeout(() => {
        setStatus($('modelStatus'), `Still opening ${name} (${size})… Large files can take a little while. If this doesn't finish within a minute, ${cannotPlay(name, 'hint')}`);
      }, 10000);
    });
  } catch (err) {
    setStatus($('modelStatus'), err.message, true);
    video.removeAttribute('src'); video.load();
    return;
  } finally {
    clearTimeout(slowTimer);
    fileBar.hide();
  }
  setStatus($('modelStatus'), '');
  state.probe = {}; state.snapTimes = [];
  renderVideoInfo(); renderScanPlan();
  probeVideoFile(file).then((p) => {
    if (state.file !== file) return; // another file was chosen meanwhile
    state.probe = p; renderVideoInfo(); renderScanPlan();
  });
  renderPeople();
  enableStep(2); enableStep(3, false); enableStep(4, false);
  $('downloadLink').hidden = true;
  setStatus($('scanStatus'), 'Click "Find faces in snapshots" to look for faces in a few moments of the video.');
  showStep(2);
}

// ---------------------------------------------------------------------------
// Step 2 — snapshot faces + pick who stays visible
// ---------------------------------------------------------------------------
const snapCanvas = document.createElement('canvas');
let faceSeq = 0;

async function scanAt(times) {
  if (!state.ready) { setStatus($('scanStatus'), 'The face detection models are still loading (see the bar at the top). Try again when it finishes.'); return; }
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
      setStatus($('scanStatus'), times.length > 1 ? `Looking for faces in snapshot ${i + 1} of ${times.length}…` : 'Looking for faces in this frame…');
      if (times.length > 1) scanBar.set(i / times.length); else scanBar.busy();
      const t0 = performance.now();
      await seek(video, t);
      const scale = grabFrame(video, snapCanvas);
      // Contrast enhancement here too, so darker-skinned students in dim or
      // backlit shots show up in the picker and can be kept.
      const dets = await detectFaces(snapCanvas, { minConfidence: 0.5, enhance: true });
      state.scannedTimes.add(key);
      // time per snapshot (seek + detection) → processing-time estimates in step 3
      (state.snapTimes ||= []).push(performance.now() - t0);
      for (const d of dets) {
        if (d.box.w < 24 || !d.descriptor) continue; // too small to be useful as a reference
        // thumbnail from the analysis-size frame; box stored at full video resolution
        state.faces.push({ id: ++faceSeq, t, box: scaleBox(d.box, 1 / scale), descriptor: d.descriptor, thumb: cropThumb(snapCanvas, d.box), keep: false });
        found++;
      }
    }
    setStatus($('scanStatus'), `Found ${found} face${found === 1 ? '' : 's'} in ${times.length} snapshot${times.length === 1 ? '' : 's'}. Click the face(s) that should stay visible.`);
  } catch (err) {
    console.error(err);
    setStatus($('scanStatus'), `Face scan failed: ${err.message}`, true);
  } finally {
    state.busy = false;
    scanBar.hide();
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

// Fast / Medium / Slow just set the three layer switches under Advanced
// settings. Changing a switch by hand shows "Custom" unless the switches
// happen to match one of the modes.
const MODES = {
  fast: { enhance: false, poseLayer: false, smallFaces: false },
  medium: { enhance: true, poseLayer: true, smallFaces: false },
  slow: { enhance: true, poseLayer: true, smallFaces: true },
};
const LAYERS = ['enhance', 'poseLayer', 'smallFaces'];
const modeRadios = [...document.querySelectorAll('input[name="mode"]')];
function applyMode(mode) {
  for (const id of LAYERS) if (!$(id).disabled) $(id).checked = MODES[mode][id];
  $('modeCustom').hidden = true;
}
function syncModeFromSwitches() {
  const match = Object.keys(MODES).find((m) => LAYERS.every((id) => $(id).disabled || $(id).checked === MODES[m][id]));
  for (const r of modeRadios) r.checked = r.value === match;
  $('modeCustom').hidden = !!match;
}
for (const r of modeRadios) r.addEventListener('change', () => { if (r.checked) applyMode(r.value); });
for (const id of LAYERS) $(id).addEventListener('change', syncModeFromSwitches);
applyMode('medium');

function analysisOptions() {
  return {
    fps: +$('fps').value, minConfidence: +$('minConf').value, smallFaces: $('smallFaces').checked,
    enhance: $('enhance').checked, pose: $('poseLayer').checked && poseAvailable(),
  };
}

$('analyzeBtn').addEventListener('click', async () => {
  if (!state.ready) return;
  state.busy = true; state.cancel = false;
  $('analyzeBtn').disabled = true; $('cancelBtn').hidden = false;
  $('analysisCanvas').hidden = false;
  analyzeBar.busy();
  setStatus($('analyzeStatus'), 'Starting…');
  const actx = $('analysisCanvas').getContext('2d');
  const opts = analysisOptions();
  const t0 = performance.now();
  try {
    const samples = await analyzeVideo(video, opts, ({ i, n, canvas, dets, eta }) => {
      analyzeBar.set(i / n);
      setStatus($('analyzeStatus'), `Scanning frame ${i} of ${n} — ${dets.length} face${dets.length === 1 ? '' : 's'} in this frame — about ${Math.ceil(eta)}s left`);
      if (i % 2 === 0 || i === n) {
        const ac = $('analysisCanvas');
        ac.width = canvas.width; ac.height = canvas.height;
        actx.drawImage(canvas, 0, 0);
        actx.lineWidth = Math.max(2, canvas.width / 400);
        // yellow = face detector, cyan = found after contrast boost,
        // orange = found via the body-pose backup
        const colour = { face: '#facc15', enhanced: '#22d3ee', 'pose+face': '#fb923c', pose: '#fb923c' };
        for (const d of dets) {
          actx.strokeStyle = colour[d.source] || '#facc15';
          actx.setLineDash(d.source === 'pose' ? [actx.lineWidth * 3, actx.lineWidth * 2] : []);
          actx.strokeRect(d.box.x, d.box.y, d.box.w, d.box.h);
        }
        actx.setLineDash([]);
      }
    }, () => state.cancel);
    state.samples = samples;
    analyzeBar.set(1);
    state.tracks = linkTracks(samples);
    state.analysisKey = JSON.stringify(opts);
    const total = samples.reduce((s, x) => s + x.dets.length, 0);
    setStatus($('analyzeStatus'), `Done in ${((performance.now() - t0) / 1000).toFixed(0)}s — ${total} face detections across ${samples.length} frames.`);
    enableStep(4);
    showStep(4);
  } catch (err) {
    analyzeBar.hide();
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
  exportBar.busy();
  setStatus($('exportStatus'), 'Getting ready to record…');
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
      exportBar.set(t / video.duration);
      setStatus($('exportStatus'), `Recording… ${fmtTime(t)} / ${fmtTime(video.duration)}`);
    };
    const ended = new Promise((res) => video.addEventListener('ended', res, { once: true }));
    startPreviewLoop();
    await video.play();
    await ended;
    // allow last frame to flush
    exportBar.busy();
    setStatus($('exportStatus'), 'Finishing the file…');
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
    exportBar.set(1);
    setStatus($('exportStatus'), 'Export finished. The file is created on this computer; click Download to save it.');
  } catch (err) {
    console.error(err);
    exportBar.hide();
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
