# Privacy Blur

A simple browser app that blurs every face in a video **except** the student(s) you choose, so a parent can be shown footage of their own child without revealing other children.

**Everything runs on your computer.** The video is opened directly by the browser from disk; it is never uploaded. The face models run in the browser (TensorFlow.js on WebGL, with a WebAssembly fallback), and the page's Content-Security-Policy blocks connections to any server other than the local one that serves the app.

## Use it online

**https://jacobsmith.github.io/privacy-video/**

This is the same static app served by GitHub Pages. The page and models download from GitHub; your video is opened locally by your browser and is **never** uploaded (the page's security policy only allows requests back to the site it was loaded from, and there is nothing there that accepts uploads).

## Run it locally (works offline)

```bash
cd privacy-video
python3 serve.py          # → http://127.0.0.1:8000/
```

Open <http://127.0.0.1:8000/> in a recent Chrome or Edge (Firefox and Safari should work but were not tested). The server listens on 127.0.0.1 only and serves static files. It refuses any upload.

No install or build step. All libraries and model weights live in `vendor/` and `models/`, so the app also works offline.

## How to use

1. **Choose video**: pick or drag in an MP4/MOV/WebM file.
2. **Who stays visible**: click **Find faces in snapshots**. The faces it finds are grouped by person. Click a student's face, or **Keep all** for that person, to keep them visible. Everyone else is blurred by default. For better recognition, pause on a clear shot of the student and click **Add faces from current frame**.
3. **Process**: scans the whole video (10 frames/sec by default). For wide shots with small faces, turn on *Small / distant faces mode* under Detection settings.
4. **Review & export**: watch the blurred preview. Turn on *Show detection boxes* to see what was kept (green) and blurred (red). If needed, adjust *Match strictness*, *Blur area*, *Blur strength* or *Keep blurring a lost face for*; these apply instantly without re-processing. Then click **Export blurred video** and **Download**.

### Manual blur (for anything the automatic blur missed)

In step 4, pause where something identifiable is visible and click **✎ Draw blur box**:

- **Drag** a box over it, or **click** to drop a face-sized box. The blur lasts from just before that moment to 2 seconds after. Change the times in the list, or use **⇤ now**, **now ⇥** or **Whole video**.
- **If the person moves:** keep the blur selected (yellow), go to a later moment and drag again where they are now. The box glides between your drawings and the time range extends automatically. Repeat as often as needed.
- To start a **separate** blur, click the selected one in the list to deselect it first. Use **Remove** to delete one.
- Manual blurs work on anything, not just faces: name tags, logos, a name written on a whiteboard.

> ⚠️ Automatic face detection is not perfect. Faces in strong profile, very small, or partly hidden can be missed. Always watch the full preview before sharing.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `style.css` | UI (4-step wizard) plus the CSP privacy lock |
| `app.js` | UI controller: file loading, face picker, preview, export |
| `engine.js` | Detection, matching, tracking, smoothing, blur rendering |
| `serve.py` | Local static server, loopback only, with the correct `.wasm` MIME type |
| `vendor/` | `@vladmandic/face-api` 1.7.15 (bundles TF.js 4.22), plus TF.js WASM binaries (MIT / Apache-2.0) |
| `models/` | SSD-MobileNetV1 face detector, 68-point landmarks, and a 128-d face-recognition model |
| `DECISIONS.md` | Log of the design decisions made while building this |

Debug: append `?backend=wasm` or `?backend=cpu` to the URL to force a backend.
