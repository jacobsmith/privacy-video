# Decision log

Decisions made while building Privacy Blur in one pass (2026-11-08), roughly in the order they were made. Each entry gives the choice, the reason, and the alternatives considered.

## Architecture & privacy

1. **Plain static web app with no build step and no framework.**
   Why: "extremely simple" was the brief. Vanilla ES modules mean anyone can read the code and run it with one command, and there is no npm supply chain at runtime.
   Alternatives: React/Vite (more tooling, no benefit at this size).

2. **All third-party code and model weights are vendored locally (`vendor/`, `models/`). There are no CDN calls at runtime.**
   Why: with the files local, nothing about the session reaches a third party, not even a request for a model. The app also works offline.
   Cost: about 14 MB in the repo.

3. **A strict Content-Security-Policy in `index.html` (`connect-src 'self'`, `default-src 'none'`, and so on).**
   Why: this makes the browser enforce "nothing leaves the machine". Even a bug or a compromised library cannot POST frames to another host. Verified in testing: even `fetch()` of a blob URL is blocked.
   Note: `'wasm-unsafe-eval'` is allowed because the WebAssembly backend needs it.

4. **The video is read through the File API and `URL.createObjectURL`. It is never sent to the server.**
   `serve.py` binds to 127.0.0.1 only, serves static files, and returns 405 for POST/PUT/PATCH/DELETE. Verified: the server log shows only static GETs.

5. **Must be served over http://127.0.0.1, not opened as `file://`.**
   Why: ES modules and model `fetch` don't work from `file://`. I wrote a small Python server instead of using `python -m http.server` because the stock server (a) binds to all network interfaces and (b) on Python 3.9 doesn't send the `application/wasm` MIME type.

## ML model choice

6. **`@vladmandic/face-api` (TensorFlow.js) instead of compiling a native model to WebAssembly myself.**
   Why: one maintained library gives **both** face detection and a 128-d face-recognition embedding, which is exactly the pair this job needs. MediaPipe's in-browser face detector is fast but has no recognition embeddings, so it can't tell "this is the parent's child". Cross-compiling something like dlib/InsightFace to WASM would be a big project with no clear win.
   On WebAssembly specifically: the bundle includes a WASM backend, and its `.wasm` binaries are vendored. The app tries **WebGL (GPU) first** because it is much faster, then **WASM**, then plain CPU. Both WebGL and WASM were tested.

7. **SSD-MobileNetV1 detector, not TinyFaceDetector.** It is more accurate, especially on non-frontal and smaller faces. Missing a face is the costly error here, so accuracy beats speed.

8. **"Small / distant faces" mode (off by default).** SSD downsizes each frame to 512 px, so tiny faces in a wide classroom shot can be missed. This mode also runs the detector on four overlapping 60% tiles and merges the results (NMS plus a containment check). About 5× slower, so it is opt-in.

## Workflow / UX

9. **Blur by default. Only faces the user explicitly picks stay visible.** Any face not confidently matched to a pick, including children who never appear in the snapshots, is blurred. Every ambiguity resolves toward blurring.

10. **Snapshot faces are grouped into "people"** (average-linkage clustering on descriptor distance < 0.45), so the user clicks one person instead of every snapshot. I used average linkage rather than single linkage, which can chain two different children into one group. The user can still toggle each thumbnail separately, and every kept thumbnail becomes a reference.

11. **Picker thumbnails of not-yet-kept faces are slightly CSS-blurred.** This is a mild nod to privacy on screen. They are still recognisable enough for the operator to pick from.

12. **"Add faces from current frame"** lets the user add reference angles (profile, looking down) by hand. Matching across poses gets better with more references.

13. **A 4-step wizard: choose → pick → process → review/export.** Matching settings live in step 4 and re-apply instantly. Every face's descriptor is cached after analysis, so changing strictness or who is kept does **not** require re-scanning the video.

## Matching, tracking, smoothing

14. **Default match threshold 0.50** (face-api's usual default is 0.6). This is stricter on purpose, to avoid un-blurring a look-alike. It can be adjusted from 0.35 to 0.6.

15. **Scan at 10 frames/sec by default** (5/15/30 are options). Boxes are interpolated between scanned frames. The renderer also draws the blur box from both neighbouring scans, which covers faces moving between samples.

16. **Detections are linked into tracks** using centre distance (normalised by face size), size ratio, and descriptor distance. The keep/blur decision is made **per track by majority vote**. This stops the kept child flickering into blur when they turn their head for one frame. **Guard:** inside a kept track, a single detection must still be within threshold + 0.1 to stay visible. That catches a track that accidentally jumped to another child.

17. **Gap-fill and hold:** detections missing for up to 3 scans inside a track are interpolated, and blurred tracks are held for 2 extra scans (0.2 s) before and after. Both cover detector drop-outs. Over-blurring is safe; under-blurring is not.

18. **Detection confidence default 0.35** (on the low side). This catches more blurry or turned faces, and the occasional false positive just blurs a patch of background.

## Blur rendering

19. **Blur by heavy down-sampling (about 6 blocks across the face), then smooth up-scaling, inside a rounded rectangle.** A light Gaussian blur can sometimes be partly reversed. Down-sampling throws the facial detail away for good. The smooth up-scale makes it look like a blur rather than harsh mosaic squares. Strength can be adjusted.

20. **Padded blur region** (35% of the face box, extra above for hair). Hair, ears and face outline identify people too. This can be adjusted.

## Export

21. **Export uses canvas `captureStream` plus `MediaRecorder`, playing the video once in real time.** The canvas only ever receives frames that have already been blurred, so the raw video can't leak into the file. Audio is routed through Web Audio (`createMediaElementSource` → `MediaStreamDestination`) into the recording, and the speakers are muted while exporting.
    Trade-off: export takes as long as the video runs, and the tab should stay visible. The frame-accurate alternative is WebCodecs `VideoEncoder` plus an MP4 muxer and separate audio re-encoding. That is faster than real time but much more code. It is the natural upgrade if long videos turn out to be common.

22. **Output format: MP4 (H.264/AAC) when the browser's MediaRecorder supports it (recent Chrome does), otherwise WebM.** MP4 plays everywhere a parent might watch it. The bitrate is 8 Mbps, so files are larger than the source (12 MB vs 0.9 MB for the test clip). This is deliberate, to preserve quality.

## Testing

23. **Test video:** with no real classroom footage available, I built a 12 s, 1280×720, 30 fps clip with a 440 Hz audio tone from the two stock group photos bundled with face-api (6 adults). The camera pans across each photo, so faces move and partly leave the frame. I used a temporary ffmpeg (`imageio-ffmpeg`, in a scratch venv) only to make this clip. The app does not depend on it.

24. **End-to-end test in Chrome (WebGL backend):** loaded the file → 18 faces in 8 snapshots, grouped into 6 people plus 1 partial → kept one person → processing took about 15 s for 120 scanned frames → 7 tracks, 1 kept and 6 blurred → exported `test_classroom-blurred.mp4`.
    **Independent check:** re-ran the detector at 0.3 confidence (looser than the app uses) on every 0.1 s of the *exported* file. The kept person was found in 57 samples. Only 4 other "faces" turned up, and all were checked by eye: one was the detector firing on an already-blurred patch (match distance 0.82, not identifiable), and three were the kept person half-out of frame at a shot boundary. **No other person's face was visible.** The exported audio track decodes, and playback runs at about 28 fps.

25. **Polish from testing:** made step 2's "Next" button sticky (it fell below the fold), and added an empty favicon to stop a 404.

## Round 2: manual blur + the half-visible-face fix (2026-11-08)

Feedback: *"when a person's face was half shown, it stopped being blurred and was then recognizable"*, plus a request for a manual blur that applies to part of the video.

26. **Reproduced the bug in the test clip before fixing it.** Listing where each blurred face's track starts and ends showed the detector losing faces right as they slide in or out of the frame edge (for example, a face entering on the right is only detected from 0.6s, and one leaving on the right is lost at 10.7s). With the old 0.2s hold, frames at 0.15s, 11.0s and 11.6s showed clearly recognisable half-faces. Root cause: the detector misses partial faces, so the blur ended too early, at the last *detected* position.

27. **Held blurs now move with the face.** When a face is lost, its blur keeps going in the face's last direction of travel and grows a little for uncertainty (capped at 1.48×). The hold length is now a user setting, *Keep blurring a lost face for* (default **0.6s**, up from 0.2s).

28. **Edge-aware hold.** If a face is lost while cut off by the frame edge and not moving back inward (so it's leaving, entering, or sitting at the edge), the blur keeps following it **until it has fully left the frame**, up to 3s. The held box uses the person's *full* face size from their nearby detections, anchored away from the edge. A cut-off face's own box is smaller than the real face, and that's what let a sliver of mouth show in the first attempt.

29. **Scene-cut detection.** The first edge-hold version carried a blur backwards across the shot change and made a huge blob over the previous shot. While analysing, each scanned frame is now compared with the previous one using a 32×18 grayscale thumbnail. A mean difference above 35 counts as a cut; in the test clip the real cut scored 89.5 and normal camera motion at most 10.3. Held blurs and track linking stop at a cut.
    One rule deliberately ignores cuts: the renderer still draws the *next* scan's blur boxes. A real cut usually falls between two scans, and those boxes are what cover the new shot's faces for the up-to-0.1s before the next scan. A tenth of a second of extra blur on the old shot beats a leak.

30. **Manual blur tool: draw on the preview, with positions over time.** Each manual blur has a start, an end and one or more positions (box plus time), with linear interpolation between positions. Drawing again while a blur is selected adds a position, which is how a box follows a moving person without automatic tracking.
    Why not automatic tracking of the drawn box: pixel trackers drift, and a silent drift is a leak. Positions the user sets are predictable and easy to check in the preview.
    Defaults: the blur starts 0.25s before the moment it was drawn (covers a slightly late pause) and ends 2s after. Drawing past the end extends it to that time + 1s. A plain click makes a box about 1.6× the median face size in the video.

31. **Manual boxes are blurred exactly as drawn** (no extra padding), and the pixelation keeps its blocks roughly square for any box shape. Dashed outlines (yellow = selected) appear only in the preview while drawing or with detection boxes on, never in the export.

32. **Interaction details:** drawing mode pauses playback; pointer events with pointer capture, so dragging outside the canvas still works; screen-to-video coordinate mapping handles letterboxing; drawing controls are disabled and drawing mode switched off during export. Manual blurs are cleared when a new video is loaded.

33. **Tested in Chrome with real mouse input:**
    - Dragged a blur over a shirt badge at 2.0s, then again at 4.9s after the badge had moved. Two positions were recorded, the range extended to 1.75–5.93s, and at 3.5s the box sat on the badge between the two.
    - Deselected, then single-clicked to make a separate face-sized "Blur 2", then removed it.
    - Exported. In the output file, fine detail inside the badge box dropped from about 15 to about 5 during its range (pixelated) and was unchanged outside it.
    - Re-scanned the whole output: the only faces found are the kept person and already-pixelated blobs at the right edge (checked by eye), and the previously leaking frames are now blurred.

## Known limitations / ideas for later

- Faces the detector never finds (strong profile, back of head turning, heavy occlusion, motion blur) are only blurred if they're near a face that was found (hold/edge-hold) or covered by a manual blur. Reviewing the preview is still required.
- Manual blurs aren't saved: reloading the page or loading another video clears them.
- Recognition accuracy on **children** specifically is untested. The face-recognition model was trained mostly on adults, and siblings or look-alikes may score close. The 0.50 default and per-track guard lean toward blurring.
- Real-time export means a 10-minute video takes 10 minutes to export (see #21).
- Long or high-resolution videos take a while to analyse (about 8 scanned frames/sec on this machine at 720p, and slower in Small-faces mode).
- Only tested in Chrome on macOS.
