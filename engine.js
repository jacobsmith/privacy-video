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

  // Warm up (first inference compiles shaders and is slow).
  const warm = document.createElement('canvas');
  warm.width = warm.height = 128;
  await faceapi.detectAllFaces(warm, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }));
  return backend;
}

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

/**
 * Detect faces in a frame. With `smallFaces`, additionally run the detector on
 * four overlapping zoomed-in tiles, because the SSD detector downsizes input to
 * 512px and misses small faces in wide classroom shots.
 */
export async function detectFaces(canvas, { minConfidence = 0.4, smallFaces = false } = {}) {
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
export async function analyzeVideo(video, { fps = 10, minConfidence = 0.4, smallFaces = false }, onProgress, isCancelled) {
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
    const dets = await detectFaces(canvas, { minConfidence, smallFaces });
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
        const dd = descriptorDistance(last.descriptor, d.descriptor);
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
    let matched = 0;
    for (const it of tr.items) {
      it.det.dist = keepRefs.length ? minDistance(it.det.descriptor, keepRefs) : Infinity;
      if (it.det.dist < threshold) matched++;
    }
    const trackKeep = matched / tr.items.length >= 0.5;
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
