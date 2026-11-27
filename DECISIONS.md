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

## Round 3: darker-skinned faces missed in poor lighting (2026-11-27)

Feedback: *"it's often missing faces with dark skin during testing."*

34. **Measured before changing anything.** No skin-tone-labelled dataset could be downloaded in the build environment, so the test is a controlled simulation. Ten photos (27 faces the detector finds confidently in the originals) were rendered as 1280×720, JPEG-compressed frames. The face region was darkened in steps (×1, ×0.5, ×0.35, ×0.25) to approximate darker skin under the same light, and combined with lighting (normal, dim ×0.55, very dim ×0.3 + sensor noise, backlit, hard side light, warm cast) and face size (full, half, 30%). The harness ran the app's own `engine.js` in headless Chromium (WASM backend). Caveats: darkening is a feathered oval on the face only (neck and arms untouched), so it shows the trend and size of the effect, not a demographic benchmark; it also flatters the pose layer, which sees untouched bodies, except in the very-dim case, which darkens everything.

35. **Findings.** In good light with large faces, darker faces were found as reliably as lighter ones. The gap opens when light gets worse or faces get smaller, the normal case for classroom footage. Examples (faces found of 27, old pipeline): half size, dim, ×0.35 → 16 (vs 24 untouched); half size, backlit, ×0.35 → 9 (vs 24); 30% size, normal light, ×0.35 → 12 (vs 19); full size, very dim, ×0.5 → 5 (vs 24). **Lowering the confidence threshold barely helps** (backlit ×0.35: 12 → 12): the detector isn't scoring these faces just under the cut-off, it isn't seeing them. The two levers that do help are **contrast** and **pixels on the face**.

36. **Contrast-enhanced second pass (CLAHE), on by default.** The SSD detector is run again on a copy of the frame with contrast-limited adaptive histogram equalisation on luminance (8 regions across, clip 3; colour kept by scaling RGB by Y'/Y). Each region gets its own tone curve, so a dark face next to a bright window is lifted without blowing out the window. Compared against plain gamma brightening (γ 0.5 and 0.35): CLAHE won clearly in very dim footage (full size ×0.5: 19/27 vs 10–11 for gamma vs 5 today) and was at least as good everywhere else, for 0–2 extra boxes over all 10 images. Faces already found in the original frame keep their original descriptor; only new faces come from the enhanced copy. It is also used for the step-2 snapshots, so darker-skinned students show up in the picker and can be kept. Cost: about 2× detection time.

37. **Body-pose backup layer (MoveNet MultiPose), on by default.** A different kind of signal: it finds people from body shape, not facial contrast. For each person whose estimated head has no face box yet, the head area is cropped (2.2× the head), enlarged to ~256 px, contrast-enhanced, and searched with the face detector again; if a face is found there it is used like any other detection. If not, the estimated head box itself is blurred.
    - Model: Google's MoveNet MultiPose Lightning (Apache-2.0), TF.js conversion from `@vladmandic/human-models` 3.0.4, vendored in `models/` (9.4 MB). It runs on the TF.js already bundled with face-api, so no new library.
    - Input long side 320 px: larger inputs found *fewer* people (512×352 found 1 of 4 in a test photo; 256–320 found 4 of 4). Person score ≥ 0.2, keypoints ≥ 0.25. Head size comes from the largest of ear distance, eye distance, shoulder width and keypoint spread; with no head keypoints, it is placed above the shoulders.
    - **Pose-only boxes can only add blur.** They have no face descriptor, so they never match a kept student, and they are excluded from a track's keep vote (otherwise frames where only the pose saw the kept child could outvote the frames where their face matched). Track linking uses geometry alone when a descriptor is missing.
    - Limits: at most 6 people per pass (the model's cap); *Small / distant faces mode* also runs it on the 4 tiles. Pose models have their own skin-tone biases; this layer is a backup, not a guarantee.

38. **End-to-end results** (faces covered by a blur box after the usual padding, of 27; old → contrast → contrast + pose → + small-faces tiles):
    - half size, backlit, ×0.35: 9 → 12 → 21 → 27
    - half size, backlit, ×0.5: 13 → 18 → 25 → 27
    - half size, dim, ×0.35: 16 → 22 → 25 → 27
    - half size, side-lit, ×0.35: 16 → 22 → 25 → 26
    - full size, very dim, ×0.5: 5 → 19 → 22
    - half size, very dim, ×0.35: 1 → 8 → 11 → 20 (still the weak spot)
    - untouched faces, any lighting: unchanged or better (24–26 → 26–27)
    - extra boxes: 0–1 per 10 images without tiles, up to 4 with tiles. Time per frame (WASM, 720p): 0.35 s → 0.75 s → 0.9 s → 3.8 s.
    *Small / distant faces mode* stays off by default because of its cost, but its label now says it also helps darker faces in poor light.

39. **App smoke test** (real UI through `serve.py` and its CSP, 8 s generated clip, 4 s backlit + 4 s very dim with noise): no errors; processing 46 s → 96 s; the kept person stayed visible (match distance 0.05–0.07) with both settings, so the new layers don't disturb the keep path. The processing preview now colours boxes by source: yellow = face detector, cyan = contrast pass, orange = pose backup (dashed = head estimate only).

40. **Fast / Medium / Slow picker instead of three loose checkboxes** (requested). The layers are optional, and the trade-offs are written on each option, so the choice is made by what the footage looks like rather than by knowing what CLAHE or MoveNet are.
    - **Fast** = face detector only (the pre-round-3 behaviour). **Medium** (default) = + contrast boost + body-pose backup. **Slow** = + small / distant faces tiles.
    - Times are relative to Fast (≈1×, 2–3×, 10×) rather than seconds, because speed depends on the computer and backend (WebGL vs WASM). Measured per 720p frame on the WASM backend: 0.35 s, 0.9 s, 3.8 s.
    - The three switches stay under *Advanced settings* with a one-line trade-off each. The picker just sets them; changing one by hand shows "Custom" unless the switches match a mode again. If the pose model fails to load, its switch is disabled and ignored when matching modes.
    - Medium is the default rather than Fast: the app's rule is that ambiguity resolves toward blurring (#9), and Fast was the mode that produced the original complaint.

41. **Main branch.** Round 3 was built on `claude/dark-skin-detection-eval-9w01qp` and merged into `main` on request.

## Round 4: progress bars for every slow operation (2026-11-27)

42. **Every asynchronous operation shows a progress bar** (requested). A moving bar is used only where progress can't be measured.
    - **Loading the models** (about 22 MB). This is a bar under the step tabs, visible on every step until the models are ready, because people can reach step 2 before loading finishes. It counts up in megabytes ("8.2 of 21.9 MB"), then shows "Preparing…" while the models warm up.
      - The libraries' own loaders (`loadFromUri`, `loadGraphModel`) report nothing useful, so `engine.js` now fetches the weight files itself with a streamed reader and hands them over in memory (`loadFromWeightMap`, `tf.io.fromMemory`). Results are unchanged: the same test clip gave the same 270 detections as before.
      - The total comes from the model manifests, which match the `.bin` sizes exactly, so it stays right where a server compresses responses or omits Content-Length (GitHub Pages).
      - The bar starts in the moving state in the HTML itself, so it shows activity while the 1.3 MB library script is still downloading.
      - If a face model fails, the bar turns into an error message that asks for a reload. A pose download still running in parallel can no longer overwrite that message. If only the pose model fails, the app loads and the body-pose switch is disabled.
    - **Opening the video file.** This shows a moving bar until the first frame decodes. It is usually too fast to see, and is there for large or unusual files.
    - **Finding faces in snapshots.** Progress is shown per snapshot. A single "current frame" scan uses the moving bar.
    - **Processing.** The bar is reset and shows "Starting…" before the first frame (it used to sit empty, or show the previous run's value), then counts per frame.
    - **Export.** A moving bar while getting ready, then the bar follows the recorded time, then a moving bar for "Finishing the file…", then 100%.
    - The bars have `role="progressbar"` with `aria-valuenow`, the status lines are `aria-live="polite"`, and the moving bar becomes a gentle pulse under `prefers-reduced-motion`.

43. **Explain what "Opening …" means, and why it might not finish** (feedback: *"Opening IMG_8292.mov… give more info on what this means"*). The status now says what the browser is doing and what it found:
    - First: "Opening IMG_8292.mov (240 MB)… Your browser is reading the video from this computer and decoding the first frame. Nothing is uploaded."
    - Then: "found a 1920×1080 video, 2:31 long. Decoding the first frame…"
    - If it fails, a plain-language reason and a fix. The commonest cause is an iPhone .mov recorded as "High Efficiency" (HEVC), which many browsers can't decode. Three cases are told apart:
      - can't play at all (unsupported or damaged file)
      - can't decode (the decode error)
      - plays sound only (Chrome on Linux opens HEVC files with audio but no picture, which used to slip through with a 0×0 video)
    - iPhone-specific advice (Safari or an HEVC-capable PC, export as MP4, or Camera → Formats → Most Compatible) is shown only for .mov files. Other files get "try another browser or convert to MP4 (H.264)".
    - Some browsers never report an error for a format they can't decode, and just keep waiting. After 10 s the message says it's still opening and explains the likely cause.
    - Tested in Chromium with an H.264 .mov (opens), an HEVC .mov with and without audio, random bytes named .mov, a truncated MP4, and a simulated hang.

44. **iPhone/iPad Safari stuck on "Opening …"** (reported on iPhone Safari with an iPhone .mov). The format wasn't the cause: iOS Safari plays HEVC natively. iOS Safari reads a video's header but decodes no picture until playback starts, so `loadeddata` (which the app waited for) never fired. Now, if no frame has arrived 0.4 s after the header is read, the app plays the video muted for a moment, pauses and rewinds to 0:00. Muted inline playback (the `<video>` already has `playsinline`) needs no tap on iOS, and the sound setting is restored.
    - Tested in Chromium with a script that imitates iOS: it withholds `loadeddata` and keeps `readyState` at 1 until `play()` is called. Without the fix the app stuck on "Decoding the first frame…", as reported; with it, step 2 opens with the video paused at 0:00 and unmuted. Desktop behaviour is unchanged.
    - Not tested on a real iPhone (none available in the build environment). The later steps on iOS are also unverified: frame-by-frame seeking, memory use with the models loaded, and export, which plays the video with sound and records it.

## Known limitations / ideas for later

- **Recognition on darker faces is untested.** This round fixed *detection*. If the recognition model also separates darker-skinned children less well, two of them could score as the same person and the wrong child could be kept visible. That is worse than a missed detection and needs its own test, ideally with consenting real footage.
- Very dark, noisy footage of darker-skinned people is still missed often without *Small / distant faces mode*. A newer face detector (e.g. MediaPipe BlazeFace full-range, or YuNet) could be benchmarked against SSD-MobileNetV1 in the same harness.
- The skin-tone results above are a simulation; checking against real classroom footage covering a range of skin tones is the next step.

- Faces the detector never finds (strong profile, back of head turning, heavy occlusion, motion blur) are only blurred if they're near a face that was found (hold/edge-hold) or covered by a manual blur. Reviewing the preview is still required.
- Manual blurs aren't saved: reloading the page or loading another video clears them.
- Recognition accuracy on **children** specifically is untested. The face-recognition model was trained mostly on adults, and siblings or look-alikes may score close. The 0.50 default and per-track guard lean toward blurring.
- Real-time export means a 10-minute video takes 10 minutes to export (see #21).
- Long or high-resolution videos take a while to analyse (about 8 scanned frames/sec on this machine at 720p, and slower in Small-faces mode).
- Only tested in Chrome on macOS.
