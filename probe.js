// Privacy Blur — read basic facts from a video file's header, locally.
// Browsers don't report frame rate, codec, HDR or audio format, so for
// MP4 / MOV / M4V files (ISO base media format) we read the 'moov' index box
// with File.slice. Only the index is read, never the video data itself. Other
// formats (WebM, MKV) return {} and the app shows what the browser knows.

const CODECS = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)', dvh1: 'HEVC (H.265)', dvhe: 'HEVC (H.265)',
  av01: 'AV1', vp09: 'VP9', vp08: 'VP8', mp4v: 'MPEG-4', jpeg: 'Motion JPEG', mjpa: 'Motion JPEG',
  apcn: 'ProRes 422', apch: 'ProRes 422 HQ', apcs: 'ProRes 422 LT', apco: 'ProRes 422 Proxy', ap4h: 'ProRes 4444', ap4x: 'ProRes 4444 XQ',
};
const AUDIO = {
  mp4a: 'AAC', 'ac-3': 'Dolby Digital', 'ec-3': 'Dolby Digital Plus', Opus: 'Opus', fLaC: 'FLAC', alac: 'Apple Lossless',
  lpcm: 'PCM', sowt: 'PCM', twos: 'PCM', in24: 'PCM', in32: 'PCM', fl32: 'PCM', '.mp3': 'MP3',
};
const MAX_MOOV = 64 * 1024 * 1024; // index of even very long videos is far smaller

const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

// Iterate child boxes in dv[start, end): yields {type, start (payload), end}.
function* boxes(dv, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = fourcc(dv, o + 4);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); header = 16; } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}
const child = (dv, box, type) => { for (const b of boxes(dv, box.start, box.end)) if (b.type === type) return b; return null; };

async function findMoov(file) {
  let o = 0;
  while (o + 8 <= file.size) {
    const head = new DataView(await file.slice(o, o + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1) size = Number(head.getBigUint64(8)); else if (size === 0) size = file.size - o;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > MAX_MOOV) return null;
      return new DataView(await file.slice(o, o + size).arrayBuffer());
    }
    o += size;
  }
  return null;
}

function readTrack(dv, trak) {
  const mdia = child(dv, trak, 'mdia');
  if (!mdia) return null;
  const hdlr = child(dv, mdia, 'hdlr'), mdhd = child(dv, mdia, 'mdhd');
  const kind = hdlr ? fourcc(dv, hdlr.start + 8) : '';
  let timescale = 0, duration = 0;
  if (mdhd) {
    const v1 = dv.getUint8(mdhd.start) === 1;
    timescale = dv.getUint32(mdhd.start + (v1 ? 20 : 12));
    duration = v1 ? Number(dv.getBigUint64(mdhd.start + 24)) : dv.getUint32(mdhd.start + 16);
  }
  const stbl = (() => { const minf = child(dv, mdia, 'minf'); return minf && child(dv, minf, 'stbl'); })();
  const out = { kind, timescale, duration, codec: '', frames: 0, hdr: '' };
  if (!stbl) return out;
  const stsd = child(dv, stbl, 'stsd');
  if (stsd && stsd.end - stsd.start >= 16) {
    const entry = { start: stsd.start + 8 + 8, end: stsd.start + 8 + dv.getUint32(stsd.start + 8) };
    out.codec = fourcc(dv, stsd.start + 12);
    if (kind === 'vide' && entry.end <= stsd.end) {
      // Visual sample entry: 78 bytes of fixed fields, then child boxes.
      for (const b of boxes(dv, entry.start + 78, entry.end)) {
        if (b.type === 'dvcC' || b.type === 'dvvC') out.hdr = 'Dolby Vision';
        // 'nclx' (MP4, newer iPhones) and 'nclc' (older QuickTime) share this layout
        if (b.type === 'colr' && ['nclx', 'nclc'].includes(fourcc(dv, b.start)) && !out.hdr) {
          const transfer = dv.getUint16(b.start + 6);
          if (transfer === 18) out.hdr = 'HDR (HLG)';
          else if (transfer === 16) out.hdr = 'HDR (HDR10/PQ)';
        }
      }
      if (out.codec === 'dvh1' || out.codec === 'dvhe') out.hdr = 'Dolby Vision';
    }
  }
  const stts = child(dv, stbl, 'stts');
  if (stts) {
    const n = dv.getUint32(stts.start + 4);
    for (let i = 0; i < n && stts.start + 8 + i * 8 + 8 <= stts.end; i++) out.frames += dv.getUint32(stts.start + 8 + i * 8);
  }
  return out;
}

/**
 * {container, videoCodec, videoCodecTag, hdr, fps, frames, audioCodec, hasAudio}
 * — any field may be missing. Never throws.
 */
export async function probeVideoFile(file) {
  try {
    if (!/\.(mp4|mov|m4v|3gp)$/i.test(file.name) && !/^video\/(mp4|quicktime)/.test(file.type)) return {};
    const moov = await findMoov(file);
    if (!moov) return {};
    const info = { container: /\.mov$/i.test(file.name) || file.type === 'video/quicktime' ? 'QuickTime (MOV)' : 'MP4' };
    for (const trak of boxes(moov, 8, moov.byteLength)) {
      if (trak.type !== 'trak') continue;
      const t = readTrack(moov, trak);
      if (!t) continue;
      if (t.kind === 'vide' && !info.videoCodec) {
        info.videoCodecTag = t.codec;
        info.videoCodec = CODECS[t.codec] || t.codec;
        if (t.hdr) info.hdr = t.hdr;
        if (t.frames) info.frames = t.frames;
        if (t.frames && t.duration && t.timescale) info.fps = t.frames / (t.duration / t.timescale);
      } else if (t.kind === 'soun' && !info.audioCodec) {
        info.hasAudio = true;
        info.audioCodec = AUDIO[t.codec] || t.codec;
      }
    }
    if (info.hasAudio === undefined) info.hasAudio = false;
    return info;
  } catch (err) {
    console.warn('[privacy-blur] could not read video header', err);
    return {};
  }
}
