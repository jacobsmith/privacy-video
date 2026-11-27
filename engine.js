// Privacy Blur — detection, matching, tracking and rendering engine.
// Everything here runs locally in the browser. No network calls except loading
// the bundled model files from this same local server.

import * as faceapi from './vendor/face-api.esm.js';

export { faceapi };

// ---------------------------------------------------------------------------
// Model / backend setup
// ---------------------------------------------------------------------------

export async function initModels(preferredBackend) {
  const tf = faceapi.tf;
  // Point the WebAssembly backend at our locally vendored .wasm files so it
  // never tries to download them from a CDN.
  tf.setWasmPaths(new URL('./vendor/tfjs-wasm/', import.meta.url).href);

  const order = preferredBackend
    ? [preferredBackend, 'webgl', 'wasm', 'cpu']
    : ['webgl', 'wasm', 'cpu'];
  let backend = null;
  for (const b of order) {
    try {
      if (await tf.setBackend(b)) {
        await tf.ready();
        backend = tf.getBackend();
        break;
      }
    } catch (err) {
      console.warn(`[privacy-blur] backend ${b} unavailable`, err);
    }
  }
  if (!backend) throw new Error('No TensorFlow.js backend could be initialised.');

  const modelUrl = new URL('./models', import.meta.url).href;
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(modelUrl),
    faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl),
    faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl),
  ]);
  // Body-pose model (MoveNet MultiPose). Optional: if it fails to load, face
  // detection still works and the pose backup is simply unavailable.
  try {
    poseModel = await tf.loadGraphModel(new URL('./models/movenet-multipose.json', import.meta.url).href);
  } catch (err) {
    console.warn('[privacy-blur] pose model unavailable', err);
    poseModel = null;
  }

  // Warm up (first inference compiles shaders and is slow).
  const warm = document.createElement('canvas');
  warm.width = warm.height = 128;
  await faceapi.detectAllFaces(warm, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }));
  if (poseModel) await detectPeople(warm);
  return backend;
}

let poseModel = null;
export const poseAvailable = () => !!poseModel;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);

function intersection(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

export function iou(a, b) {
  const i = intersection(a, b);
  return i / (area(a) + area(b) - i || 1);
}

export function lerpBox(a, b, f) {
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    w: a.w + (b.w - a.w) * f,
    h: a.h + (b.h - a.h) * f,
  };
}

const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];

export function descriptorDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

export function minDistance(desc, refs) {
  let best = Infinity;
  for (const r of refs) best = Math.min(best, descriptorDistance(desc, r));
  return best;
}

// Non-max suppression; also drops boxes mostly contained inside a stronger one
// (happens when the same face is found in two overlapping tiles).
function nms(dets, thr = 0.35) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of sorted) {
    const dup = kept.some((k) => {
      const inter = intersection(k.box, d.box);
      return iou(k.box, d.box) > thr || inter / Math.min(area(k.box), area(d.box)) > 0.6;
    });
    if (!dup) kept.push(d);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Frame access + face detection
// ---------------------------------------------------------------------------

export function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.001));
  });
}

export function grabFrame(video, canvas) {
  if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
  if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function detectOn(input, minConfidence) {
  const res = await faceapi
    .detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence, maxResults: 100 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  return res.map((r) => ({
    box: { x: r.detection.box.x, y: r.detection.box.y, w: r.detection.box.width, h: r.detection.box.height },
    score: r.detection.score,
    descriptor: r.descriptor,
  }));
}

const tileCanvas = document.createElement('canvas');

async function detectWithTiles(canvas, minConfidence, smallFaces) {
  let dets = await detectOn(canvas, minConfidence);
  if (smallFaces) {
    const W = canvas.width, H = canvas.height;
    const tw = Math.round(W * 0.6), th = Math.round(H * 0.6);
    tileCanvas.width = tw; tileCanvas.height = th;
    const tctx = tileCanvas.getContext('2d');
    for (const [ox, oy] of [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]]) {
      tctx.drawImage(canvas, ox, oy, tw, th, 0, 0, tw, th);
      const tdets = await detectOn(tileCanvas, minConfidence);
      for (const d of tdets) { d.box.x += ox; d.box.y += oy; dets.push(d); }
    }
    dets = nms(dets);
  }
  return dets;
}

// True if box `b` substantially overlaps any detection already in `dets`.
const overlapsAny = (b, dets, frac = 0.3) =>
  dets.some((d) => iou(d.box, b) > 0.1 || intersection(d.box, b) / Math.min(area(d.box), area(b)) > frac);

/**
 * Detect faces in a frame. Layers, each only adding faces the earlier ones missed:
 *  1. The SSD face detector on the frame as-is (plus 4 zoomed tiles with
 *     `smallFaces`, because SSD downsizes input to 512px).
 *  2. `enhance`: the same detector on a local-contrast-enhanced copy (CLAHE).
 *     Recovers faces with little contrast: darker skin in dim, backlit or
 *     side-lit footage. Faces already found in layer 1 keep their original
 *     descriptor (from the unaltered pixels) for matching.
 *  3. `pose`: a body-pose model finds people; for each person whose head has
 *     no face box yet, the head region is enlarged, contrast-enhanced and
 *     searched again. If still no face is found, the estimated head box is
 *     returned with `descriptor: null`, which is always blurred.
 * Every layer can only add blur, never remove it.
 */
export async function detectFaces(canvas, { minConfidence = 0.4, smallFaces = false, enhance = false, pose = false } = {}) {
  const dets = await detectWithTiles(canvas, minConfidence, smallFaces);
  for (const d of dets) d.source = 'face';
  let enhanced = null;
  if (enhance) {
    enhanced = enhanceContrast(canvas);
    for (const d of await detectWithTiles(enhanced, minConfidence, smallFaces)) {
      if (!overlapsAny(d.box, dets)) { d.source = 'enhanced'; dets.push(d); }
    }
  }
  if (pose && poseModel) {
    const people = await detectPeople(enhanced || canvas, smallFaces);
    for (const p of people) {
      if (overlapsAny(p.head, dets)) continue;
      const found = await searchHead(canvas, p.head, minConfidence);
      if (found && !overlapsAny(found.box, dets)) { found.source = 'pose+face'; dets.push(found); }
      else if (!found) dets.push({ box: p.head, score: p.score, descriptor: null, source: 'pose' });
    }
  }
  return dets;
}

// ---------------------------------------------------------------------------
// Contrast enhancement (CLAHE on luminance)
// ---------------------------------------------------------------------------

/**
 * Contrast-limited adaptive histogram equalisation on luminance, with colour
 * kept by scaling RGB by Y'/Y. Each region of the frame gets its own tone
 * curve, so a dark face next to a bright window is lifted without blowing out
 * the window. Returns a new canvas; the input is untouched.
 */
export function enhanceContrast(src, { clip = 3, grid = 8 } = {}) {
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const x = out.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0);
  const im = x.getImageData(0, 0, w, h), d = im.data;
  const Y = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) Y[i] = Math.min(255, (77 * d[p] + 150 * d[p + 1] + 29 * d[p + 2]) >> 8);
  const gx = grid, gy = Math.max(1, Math.round((grid * h) / w)), tw = w / gx, th = h / gy;
  const maps = [];
  const hist = new Float32Array(256);
  for (let ty = 0; ty < gy; ty++) for (let tx = 0; tx < gx; tx++) {
    hist.fill(0);
    let n = 0;
    for (let yy = Math.floor(ty * th); yy < Math.floor((ty + 1) * th); yy++) {
      for (let xx = Math.floor(tx * tw); xx < Math.floor((tx + 1) * tw); xx++) { hist[Y[yy * w + xx]]++; n++; }
    }
    const lim = Math.max(1, (clip * n) / 256);
    let excess = 0;
    for (let k = 0; k < 256; k++) if (hist[k] > lim) { excess += hist[k] - lim; hist[k] = lim; }
    const add = excess / 256, m = new Float32Array(256);
    let acc = 0;
    for (let k = 0; k < 256; k++) { acc += hist[k] + add; m[k] = (acc / Math.max(1, n)) * 255; }
    maps.push(m);
  }
  for (let yy = 0; yy < h; yy++) {
    const fy = Math.min(gy - 1, Math.max(0, yy / th - 0.5)), y0 = Math.floor(fy), y1 = Math.min(gy - 1, y0 + 1), ay = fy - y0;
    for (let xx = 0; xx < w; xx++) {
      const fx = Math.min(gx - 1, Math.max(0, xx / tw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(gx - 1, x0 + 1), ax = fx - x0;
      const i = yy * w + xx, v = Y[i];
      const nv = (maps[y0 * gx + x0][v] * (1 - ax) + maps[y0 * gx + x1][v] * ax) * (1 - ay)
        + (maps[y1 * gx + x0][v] * (1 - ax) + maps[y1 * gx + x1][v] * ax) * ay;
      const p = i * 4;
      if (v > 4) { const g = Math.min(6, nv / v); d[p] *= g; d[p + 1] *= g; d[p + 2] *= g; }
      else { const a = nv - v; d[p] += a; d[p + 1] += a; d[p + 2] += a; }
    }
  }
  x.putImageData(im, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Body-pose layer (MoveNet MultiPose): find people, estimate head boxes
// ---------------------------------------------------------------------------

// MoveNet keypoint order: 0 nose, 1-2 eyes, 3-4 ears, 5-6 shoulders, ...
const KP_SCORE = 0.25;

/** Estimate a face-sized box from a person's head/shoulder keypoints (pixels). */
function headBox(kps) {
  const ok = (i) => kps[i].s >= KP_SCORE;
  const dist = (a, b) => Math.hypot(kps[a].x - kps[b].x, kps[a].y - kps[b].y);
  const head = [0, 1, 2, 3, 4].filter(ok);
  const sw = ok(5) && ok(6) ? dist(5, 6) : 0;
  const sizes = [];
  if (ok(3) && ok(4)) sizes.push(dist(3, 4) * 1.25);
  if (ok(1) && ok(2)) sizes.push(dist(1, 2) * 3.0);
  if (sw) sizes.push(sw * 0.5);
  if (head.length >= 2) {
    const xs = head.map((i) => kps[i].x), ys = head.map((i) => kps[i].y);
    sizes.push(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.6);
  }
  let cx, cy;
  if (head.length) {
    cx = head.reduce((s, i) => s + kps[i].x, 0) / head.length;
    cy = head.reduce((s, i) => s + kps[i].y, 0) / head.length;
  } else if (sw) {
    cx = (kps[5].x + kps[6].x) / 2;
    cy = (kps[5].y + kps[6].y) / 2 - sw * 0.6;
  } else return null;
  if (!sizes.length) return null;
  const s = Math.max(...sizes);
  if (s < 10) return null;
  return { x: cx - s / 2, y: cy - s * 0.55, w: s, h: s * 1.15 };
}

const poseCanvas = document.createElement('canvas');

async function runPose(src, sx, sy, sw, sh) {
  const tf = faceapi.tf;
  // MoveNet MultiPose works best with the long side near 256-320 px (a larger
  // input finds fewer people). Both sides must be multiples of 32.
  const long = 320;
  const k = long / Math.max(sw, sh);
  const iw = Math.max(32, Math.round((sw * k) / 32) * 32), ih = Math.max(32, Math.round((sh * k) / 32) * 32);
  poseCanvas.width = iw; poseCanvas.height = ih;
  poseCanvas.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, iw, ih);
  const input = tf.tidy(() => tf.browser.fromPixels(poseCanvas).toInt().expandDims(0));
  const res = poseModel.execute(input);
  const out = (await res.array())[0];
  input.dispose(); res.dispose();
  const people = [];
  for (const p of out) {
    if (p[55] < 0.2) continue;
    const kps = [];
    for (let j = 0; j < 17; j++) kps.push({ y: sy + p[j * 3] * sh, x: sx + p[j * 3 + 1] * sw, s: p[j * 3 + 2] });
    const head = headBox(kps);
    if (head) people.push({ score: p[55], head });
  }
  return people;
}

/**
 * People in the frame with an estimated head box each. With `tiles`, also
 * runs on the 4 overlapping 60% tiles (the model handles at most 6 people per
 * pass and works at ~320px, so tiles help with crowded or wide shots).
 */
export async function detectPeople(canvas, tiles = false) {
  if (!poseModel) return [];
  const W = canvas.width, H = canvas.height;
  let people = await runPose(canvas, 0, 0, W, H);
  if (tiles) {
    const tw = Math.round(W * 0.6), th = Math.round(H * 0.6);
    for (const [ox, oy] of [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]]) people.push(...await runPose(canvas, ox, oy, tw, th));
    people = nms(people.map((p) => ({ box: p.head, score: p.score, head: p.head })), 0.3);
  }
  return people;
}

const headCanvas = document.createElement('canvas');

/**
 * Cascade: re-run the face detector on an enlarged, contrast-enhanced crop
 * around an estimated head. Returns a detection in frame coordinates, or null.
 */
async function searchHead(canvas, head, minConfidence) {
  const s = Math.max(head.w, head.h) * 2.2;
  const cx = head.x + head.w / 2, cy = head.y + head.h / 2;
  const x0 = Math.max(0, cx - s / 2), y0 = Math.max(0, cy - s / 2);
  const x1 = Math.min(canvas.width, cx + s / 2), y1 = Math.min(canvas.height, cy + s / 2);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const k = Math.max(1, 256 / Math.max(x1 - x0, y1 - y0)); // enlarge small heads
  headCanvas.width = Math.round((x1 - x0) * k); headCanvas.height = Math.round((y1 - y0) * k);
  headCanvas.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, headCanvas.width, headCanvas.height);
  const dets = await detectOn(enhanceContrast(headCanvas, { grid: 2 }), minConfidence);
  let best = null;
  for (const d of dets) {
    const b = { x: x0 + d.box.x / k, y: y0 + d.box.y / k, w: d.box.w / k, h: d.box.h / k };
    // must be roughly where the pose model put the head
    if (iou(b, head) < 0.1 && intersection(b, head) / area(b) < 0.5) continue;
    if (!best || d.score > best.score) best = { ...d, box: b };
  }
  return best;
}

export function cropThumb(canvas, box, size = 112) {
  const pad = 0.25;
  const side = Math.max(box.w, box.h) * (1 + pad * 2);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(canvas, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.85);
}

// ---------------------------------------------------------------------------
// Grouping snapshot faces into "people" for the picker
// ---------------------------------------------------------------------------

export function clusterFaces(faces, thr = 0.45) {
  const clusters = [];
  for (const f of faces) {
    let best = null, bestD = Infinity;
    for (const c of clusters) {
      // average linkage: less prone than single-linkage to chaining two kids together
      let s = 0;
      for (const g of c.faces) s += descriptorDistance(f.descriptor, g.descriptor);
      const d = s / c.faces.length;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best && bestD < thr) best.faces.push(f);
    else clusters.push({ faces: [f] });
  }
  clusters.sort((a, b) => b.faces.length - a.faces.length);
  return clusters;
}

// ---------------------------------------------------------------------------
// Full-video analysis
// ---------------------------------------------------------------------------

/**
 * Seek through the video at `fps` samples per second and detect every face.
 * Returns [{t, dets:[{box, score, descriptor}]}].
 */
export async function analyzeVideo(video, { fps = 10, minConfidence = 0.4, smallFaces = false, enhance = false, pose = false }, onProgress, isCancelled) {
  const canvas = document.createElement('canvas');
  const step = 1 / fps;
  const times = [];
  for (let t = 0; t < video.duration; t += step) times.push(+t.toFixed(4));
  const samples = [];
  const started = performance.now();
  // Scene-cut detection: compare a tiny grayscale thumbnail of each scanned
  // frame with the previous one.
  const sig = document.createElement('canvas');
  sig.width = 32; sig.height = 18;
  const sctx = sig.getContext('2d', { willReadFrequently: true });
  let prevSig = null;
  for (let i = 0; i < times.length; i++) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    await seek(video, times[i]);
    grabFrame(video, canvas);
    sctx.drawImage(canvas, 0, 0, 32, 18);
    const px = sctx.getImageData(0, 0, 32, 18).data;
    const cur = new Float32Array(32 * 18);
    for (let p = 0; p < cur.length; p++) cur[p] = 0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2];
    let diff = 0;
    if (prevSig) { for (let p = 0; p < cur.length; p++) diff += Math.abs(cur[p] - prevSig[p]); diff /= cur.length; }
    prevSig = cur;
    const dets = await detectFaces(canvas, { minConfidence, smallFaces, enhance, pose });
    samples.push({ t: times[i], dets, cut: diff > 35, diff });
    if (onProgress) {
      const elapsed = (performance.now() - started) / 1000;
      onProgress({ i: i + 1, n: times.length, canvas, dets, eta: (elapsed / (i + 1)) * (times.length - i - 1) });
    }
  }
  return samples;
}

/**
 * Link detections in consecutive samples into tracks (same face over time).
 * Purely geometric + appearance; does not depend on who is "kept", so it is
 * computed once after analysis.
 */
export function linkTracks(samples, maxGap = 3) {
  const tracks = [];
  samples.forEach((s, si) => {
    // A scene cut ends every track: a face in the new shot is a new track.
    const active = s.cut ? [] : tracks.filter((tr) => si - tr.lastSi <= maxGap + 1);
    const cands = [];
    for (const tr of active) {
      const last = tr.items[tr.items.length - 1].det;
      const gap = si - tr.lastSi;
      s.dets.forEach((d, di) => {
        const [ax, ay] = center(last.box), [bx, by] = center(d.box);
        const norm = Math.max(last.box.w, last.box.h, d.box.w, d.box.h);
        const cd = Math.hypot(ax - bx, ay - by) / norm;
        const sizeRatio = d.box.w / last.box.w;
        // Pose-only head boxes have no descriptor: link them on geometry alone.
        const dd = last.descriptor && d.descriptor ? descriptorDistance(last.descriptor, d.descriptor) : 0.4;
        if (cd < 0.9 + 0.4 * (gap - 1) && sizeRatio > 0.5 && sizeRatio < 2 && dd < 0.75) {
          cands.push({ tr, di, cost: cd + dd });
        }
      });
    }
    cands.sort((a, b) => a.cost - b.cost);
    const usedT = new Set(), usedD = new Set();
    for (const c of cands) {
      if (usedT.has(c.tr) || usedD.has(c.di)) continue;
      usedT.add(c.tr); usedD.add(c.di);
      c.tr.items.push({ si, det: s.dets[c.di] });
      c.tr.lastSi = si;
    }
    s.dets.forEach((d, di) => {
      if (!usedD.has(di)) tracks.push({ id: tracks.length, items: [{ si, det: d }], lastSi: si });
    });
  });
  return tracks;
}

/**
 * Decide keep/blur for every detection and build the per-sample render list.
 *  - A detection's distance to the nearest "keep" reference face is computed.
 *  - A track is "kept" if >= 50% of its detections match (smooths out frames
 *    where the child turns their head) — but an individual detection is only
 *    kept if it is also within threshold + 0.1 (guards against a track that
 *    accidentally jumped from one child to another).
 *  - Gaps inside a track are filled by interpolation, and blurred tracks are
 *    held for `hold` extra samples at either end, to cover missed detections.
 */
export function buildTimeline(samples, tracks, keepRefs, { threshold = 0.5, hold = 2, edgeHold = 30, frameW = 0, frameH = 0 } = {}) {
  for (const s of samples) s.render = [];
  for (const tr of tracks) {
    let matched = 0, voters = 0;
    for (const it of tr.items) {
      // No descriptor (pose-only head box) = can't be matched = always blurred.
      it.det.dist = keepRefs.length && it.det.descriptor ? minDistance(it.det.descriptor, keepRefs) : Infinity;
      if (it.det.descriptor) voters++;
      if (it.det.dist < threshold) matched++;
    }
    // Only real face detections vote, so frames where just the pose backup saw
    // the kept child don't outvote the frames where their face was matched.
    const trackKeep = voters > 0 && matched / voters >= 0.5;
    for (const it of tr.items) it.det.keep = trackKeep && it.det.dist < threshold + 0.1;

    const pos = new Map();
    const items = tr.items;
    for (let k = 0; k < items.length; k++) {
      const a = items[k];
      pos.set(a.si, { box: a.det.box, blur: !a.det.keep, dist: a.det.dist });
      const b = items[k + 1];
      if (b) {
        for (let si = a.si + 1; si < b.si; si++) {
          const f = (si - a.si) / (b.si - a.si);
          pos.set(si, { box: lerpBox(a.det.box, b.det.box, f), blur: !(a.det.keep && b.det.keep), ghost: true });
        }
      }
    }
    // Hold: keep blurring a face for `hold` samples after it is lost (and
    // before it is first found). Faces are usually lost because they are
    // leaving the frame / turning / half hidden — exactly when they are still
    // partly recognisable — so the held box keeps moving with the face's last
    // velocity and grows a little each step to absorb uncertainty.
    const first = items[0], last = items[items.length - 1];
    const vel = (a, b) => {
      if (!a || !b || a.si === b.si) return { x: 0, y: 0 };
      const n = b.si - a.si;
      return { x: (b.det.box.x + b.det.box.w / 2 - a.det.box.x - a.det.box.w / 2) / n, y: (b.det.box.y + b.det.box.h / 2 - a.det.box.y - a.det.box.h / 2) / n };
    };
    const vEnd = vel(items[items.length - 2], last);
    const vStart = vel(first, items[1]);

    // A face cut off by the frame edge gets a smaller box than the real face.
    // Use the person's full face size (largest of the nearby detections),
    // anchored on the side away from the edge.
    const W = frameW, H = frameH;
    // "Touching" = the box is at (or within 10% of its size from) the frame
    // edge, i.e. the face is probably cut off.
    const touches = (b) => ({
      l: b.x < b.w * 0.1, r: b.x + b.w > W - b.w * 0.1,
      t: b.y < b.h * 0.1, b: b.y + b.h > H - b.h * 0.1,
    });
    const fullBox = (end) => {
      const near = end ? items.slice(-6) : items.slice(0, 6);
      const b = (end ? last : first).det.box;
      const w = Math.max(...near.map((i) => i.det.box.w)), h = Math.max(...near.map((i) => i.det.box.h));
      const e = W ? touches(b) : {};
      return {
        x: e.r && !e.l ? b.x : e.l && !e.r ? b.x + b.w - w : b.x + b.w / 2 - w / 2,
        y: e.b && !e.t ? b.y : e.t && !e.b ? b.y + b.h - h : b.y + b.h / 2 - h / 2,
        w, h,
      };
    };
    const atEdge = (b) => { if (!W) return false; const e = touches(b); return e.l || e.r || e.t || e.b; };
    const outside = (b) => b.x >= W || b.y >= H || b.x + b.w <= 0 || b.y + b.h <= 0;
    const ghostBox = (b, v, h) => {
      const g = 1 + 0.08 * Math.min(Math.abs(h), 6); // grow ≤ 1.48× for uncertainty
      const w = b.w * g, hh = b.h * g;
      return { x: b.x + b.w / 2 + v.x * h - w / 2, y: b.y + b.h / 2 + v.y * h - hh / 2, w, h: hh };
    };
    // Faces lost at the frame edge are usually sliding out of view: keep
    // following them until the box has left the frame (up to edgeHold).
    const startBox = fullBox(false), endBox = fullBox(true);
    // Edge hold only when the face is cut off by the edge and not moving
    // inward (i.e. it is leaving / entering through that edge, or parked there).
    const leaving = (b, v, dir) => {
      if (!atEdge(b)) return false;
      const e = touches(b), vx = v.x * dir, vy = v.y * dir;
      return (e.l && vx <= 0.5) || (e.r && vx >= -0.5) || (e.t && vy <= 0.5) || (e.b && vy >= -0.5);
    };
    const holdStart = leaving(first.det.box, vStart, -1) ? Math.max(hold, edgeHold) : hold;
    const holdEnd = leaving(last.det.box, vEnd, 1) ? Math.max(hold, edgeHold) : hold;
    // Never carry a held blur across a scene cut into a different shot.
    for (let h = 1; h <= holdStart; h++) {
      const si = first.si - h;
      if (si < 0 || samples[si + 1].cut) break;
      const box = ghostBox(startBox, vStart, -h);
      if (h > hold && outside(box)) break;
      if (!pos.has(si)) pos.set(si, { box, blur: !first.det.keep, ghost: true });
    }
    for (let h = 1; h <= holdEnd; h++) {
      const si = last.si + h;
      if (si >= samples.length || samples[si].cut) break;
      const box = ghostBox(endBox, vEnd, h);
      if (h > hold && outside(box)) break;
      if (!pos.has(si)) pos.set(si, { box, blur: !last.det.keep, ghost: true });
    }
    for (const [si, p] of pos) {
      const nxt = pos.get(si + 1);
      p.nextBox = nxt ? nxt.box : null;
      p.track = tr.id;
      samples[si].render.push(p);
    }
  }
  const stats = { tracks: tracks.length, keptTracks: 0, blurredTracks: 0 };
  for (const tr of tracks) (tr.items.some((i) => i.det.keep) ? stats.keptTracks++ : stats.blurredTracks++);
  return stats;
}

function sampleIndexAt(samples, t) {
  let lo = 0, hi = samples.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ---------------------------------------------------------------------------
// Manual blurs: user-drawn boxes with a time range and optional keyframes
// ({id, start, end, keys:[{t, box}]}); the box is interpolated between
// keyframes so it can follow a moving face.
// ---------------------------------------------------------------------------

export function manualBoxAt(m, t) {
  const k = m.keys;
  if (t <= k[0].t) return k[0].box;
  if (t >= k[k.length - 1].t) return k[k.length - 1].box;
  for (let i = 0; i < k.length - 1; i++) {
    if (t >= k[i].t && t <= k[i + 1].t) return lerpBox(k[i].box, k[i + 1].box, (t - k[i].t) / (k[i + 1].t - k[i].t || 1));
  }
  return k[k.length - 1].box;
}

/** Regions to blur (and kept regions, for the debug overlay) at media time t. */
export function regionsAt(samples, t, manual = []) {
  const blur = [], keep = [];
  const manualRegions = [];
  for (const m of manual) {
    if (t >= m.start - 1e-3 && t <= m.end + 1e-3) manualRegions.push({ id: m.id, box: manualBoxAt(m, t) });
  }
  if (!samples || !samples.length) return { blur, keep, manual: manualRegions };
  const i = sampleIndexAt(samples, t);
  const s = samples[i], n = samples[i + 1];
  const a = n ? Math.min(1, Math.max(0, (t - s.t) / (n.t - s.t))) : 0;
  for (const p of s.render) {
    const box = p.nextBox ? lerpBox(p.box, p.nextBox, a) : p.box;
    if (p.blur) { blur.push(p.box); if (p.nextBox) blur.push(box); }
    else keep.push({ box, dist: p.dist });
  }
  // Also draw the next scan's blur boxes (even across a cut: a cut between two
  // scans means the new shot's faces are on screen before the next scan).
  if (n) for (const p of n.render) if (p.blur) blur.push(p.box);
  return { blur, keep, manual: manualRegions };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const cellCanvas = document.createElement('canvas');

function padBox(b, pad, W, H) {
  const x = b.x - b.w * pad;
  const y = b.y - b.h * pad * 1.3; // a bit more above: hair is identifying too
  const w = b.w * (1 + pad * 2);
  const h = b.h * (1 + pad * 2.3);
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  return { x: x0, y: y0, w: Math.min(W, x + w) - x0, h: Math.min(H, y + h) - y0 };
}

/**
 * Draw one output frame: the video frame, with each blur region replaced by a
 * heavily down-sampled (≈`cells` blocks across) and smoothly up-scaled copy.
 * Down-sampling discards the facial detail outright, so unlike a light Gaussian
 * blur it cannot be "sharpened" back.
 */
function clampBox(b, W, H) {
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
  return { x: x0, y: y0, w: Math.min(W, b.x + b.w) - x0, h: Math.min(H, b.y + b.h) - y0 };
}

function pixelate(ctx, video, r, cells, rounded = true) {
  if (r.w < 2 || r.h < 2) return;
  const cctx = cellCanvas.getContext('2d');
  // Keep blocks roughly square; `cells` is the count across the shorter side.
  const cw = Math.max(1, Math.round(cells * Math.max(1, r.w / r.h)));
  const ch = Math.max(1, Math.round(cells * Math.max(1, r.h / r.w)));
  cellCanvas.width = cw; cellCanvas.height = ch;
  cctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
  ctx.save();
  ctx.beginPath();
  const rad = rounded ? Math.min(r.w, r.h) * 0.25 : 0;
  if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, rad); else ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cellCanvas, 0, 0, cw, ch, r.x, r.y, r.w, r.h);
  ctx.restore();
}

export function drawFrame(ctx, video, regions, { pad = 0.35, cells = 6, debug = false, showManual = false, selectedManual = null } = {}) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.drawImage(video, 0, 0, W, H);
  for (const b of regions.blur) pixelate(ctx, video, padBox(b, pad, W, H), cells);
  // Manual boxes are drawn exactly as the user drew them (no extra padding).
  for (const m of regions.manual || []) pixelate(ctx, video, clampBox(m.box, W, H), cells, false);
  if (showManual) {
    ctx.save();
    ctx.lineWidth = Math.max(2, W / 450);
    ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 3]);
    for (const m of regions.manual || []) {
      ctx.strokeStyle = m.id === selectedManual ? '#facc15' : 'rgba(96,165,250,0.95)';
      ctx.strokeRect(m.box.x, m.box.y, m.box.w, m.box.h);
    }
    ctx.restore();
  }
  if (debug) {
    const lw = Math.max(2, W / 400);
    ctx.lineWidth = lw;
    ctx.font = `${Math.round(W / 70)}px system-ui, sans-serif`;
    for (const k of regions.keep) {
      ctx.strokeStyle = '#22c55e';
      ctx.strokeRect(k.box.x, k.box.y, k.box.w, k.box.h);
      ctx.fillStyle = '#22c55e';
      ctx.fillText(`keep ${Number.isFinite(k.dist) ? k.dist.toFixed(2) : ''}`, k.box.x, k.box.y - lw * 2);
    }
    ctx.strokeStyle = 'rgba(239,68,68,0.9)';
    for (const b of regions.blur) {
      const r = padBox(b, pad, W, H);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  }
}
