# Session Notes — Single Image Optimizer

## Session 1

A Flask web app that optimizes a single uploaded image (JPEG/PNG/WebP) with
user-controlled options, showing a Before/After comparison. Built and iterated
over one session.

## What was built

### 1. Initial Flask app

- Flask WebUI with drag-and-drop upload.
- Accepts **JPEG / PNG / WebP only**; rejects SVG and GIF (by extension **and**
  by decoding the bytes with Pillow — extension alone isn't trusted).
- **Rate limiting:** 30 requests/min per IP (Flask-Limiter).
- **Max upload size:** 25 MB (`MAX_CONTENT_LENGTH`, with a 413 handler).
- Before/After panels; After started as a placeholder.
- Pillow for image I/O; OpenCV imported and kept available for future features.

### 2. Bug fix — stale layout / oversized image

- Root cause: browser served a **cached old stylesheet**, so the uploaded image
  rendered full-size and panels were unbalanced.
- Fixes: `SEND_FILE_MAX_AGE_DEFAULT = 0` (no static caching in dev), fixed
  `.panel__media` height (420px) with `object-fit: contain`, `align-items: start`
  on the panels grid, and meta `<dl>` grid updated to `auto 1fr`.

### 3. Real optimization pipeline

- Replaced the "coming soon" placeholder with an actual compressed result in the
  After panel, including **% smaller**, saved bytes, and a download button.

### 4. Full feature set (current state)

- **Quality slider** (1–95, default 85) for JPEG/WebP; ignored for PNG (lossless).
- **Resize by percent** (10–200%, aspect ratio preserved).
- **Strip metadata** toggle (default: strip). When off, EXIF re-attached for
  JPEG/WebP.
- **Auto-orient via EXIF** toggle (default on) — `ImageOps.exif_transpose`.
- **Presets:** `speed` / **`balanced`** (default) / `max_quality`, mapping to
  encoder params:
  - JPEG subsampling: 4:2:0 (speed/balanced) vs 4:4:4 (max_quality)
  - WebP `method`: 1 / 4 / 6
  - PNG `compress_level`: 1 / 6 / 9
- **Soft bound overrides** (documented in code, mirrored in JS):
  - `speed` caps quality at **≤ 85**
  - `max_quality` floors quality at **≥ 70**
  - `balanced` uses the slider value as-is
  - Result panel flags "(adjusted by preset)" when this changes the value.
- **Live parameter preview** in the UI (labels/summary only — no client-side
  image processing). Picking a file reveals the options panel with a local
  preview; submit happens on the "Optimize" click (not auto-submit).
- **Before/After shown side-by-side** with real images.
- **No retention:** images are processed **entirely in memory** and returned as
  base64 **data URIs** — nothing is written to disk. A scheduled cleanup of the
  temp dir (30-min TTL) + `atexit` rmtree remain as a defensive safety net.

## Project structure

```text
IMAGETOOLS/
├── app.py                  # Flask app: config, validators, optimizer, routes, cleanup
├── requirements.txt        # Flask, Flask-Limiter, Pillow, opencv-python-headless
├── SESSION_NOTES.md        # this file
├── .gitignore
├── templates/
│   └── index.html          # drag-drop UI, options controls, before/after panels
└── static/
    ├── css/style.css       # dark theme, controls, sliders, presets, layout
    └── js/upload.js         # file pick, drag/drop, live param preview, submit
```

## Key files / locations

- Optimizer: `optimize_bytes()` in app.py.
- Option parsing + clamping: `parse_options()`; soft bounds: `effective_quality()`
  and the `PRESET_*` config dicts near the top of app.py.
- In-memory encoding to data URI: `to_data_uri()`.
- JS soft-bound mirror: `PRESET_BOUNDS` in static/js/upload.js (must stay in sync
  with `PRESET_QUALITY_CAP` in app.py).

## Environment notes

- Python venv: `.venv/` (Python **3.14.0**).
- `requirements.txt` uses minimum-version pins (`Pillow>=11.3`, `opencv>=4.12`)
  because Python 3.14 needs newer wheels — the originally pinned Pillow 10.4.0
  had no 3.14 build.

## Run

```powershell
.\.venv\Scripts\Activate.ps1
python app.py
# http://127.0.0.1:5000  (hard-refresh Ctrl+F5 after CSS/JS changes)
```

## Verified (smoke tests, run then removed)

- balanced JPEG: ~61% smaller; speed q95 → 85; max_quality q30 → 70.
- resize 50% of 1000×800 → 500×400.
- clamping: quality 999 → 95, resize 9999 → 200.
- PNG: quality ignored, still smaller.
- After data URI present; **0 files** left in temp dir (no retention).
- GIF rejected with 400.

## Session 2 — Drag-to-compare slider + Quality curve chart

Added two client-side visual features without changing the optimization kernel.

### 1. Drag-to-compare slider (replaces side-by-side panels)

- **Before/After** images are stacked with a draggable vertical handle.
- The "after" image uses `clip-path: inset()` to reveal only the portion to the
  right of the handle; the "before" image fills the container beneath.
- Drag via mouse or touch; keyboard arrow keys, Home/End, and Shift+arrow for
  finer steps.
- HiDPI-aware; handle icon is an inline SVG chevron.

### 2. Quality vs file-size curve chart

- A **new `/quality_curve` endpoint** runs silent optimization passes at quality
  levels 10, 20, 30, …, 90 (plus the current effective quality) and returns the
  file size at each point.
- For PNG, returns a single point (lossless — quality has no effect).
- Canvas line chart with a dark theme, grid lines, axis labels, and HiDPI
  support.
- On the result page, the original image is embedded as a **`data-before-uri`**
  attribute on a hidden `<div>`; JavaScript converts it back to a `File` (via
  `atob` + `Uint8Array`) and POSTs it to `/quality_curve` to generate the chart
  automatically.

### 3. Project structure (updated)

```text
IMAGETOOLS/
├── app.py                  # + quality_curve_bytes(), /quality_curve route
├── templates/
│   └── index.html          # compare slider + quality curve canvas + result-payload
├── static/
│   ├── css/style.css       # .compare*, .quality-curve* styles
│   └── js/upload.js        # initCompareSlider, fetchAndRenderQualityCurve,
│                           # renderQualityCurve, autoFetchQualityCurve
```

### Key locations (new/changed)

- Quality curve endpoint + generator: `quality_curve_bytes()` in app.py — 9
  silent passes, sorted with current effective quality inserted.
- Compare slider JS: `initCompareSlider()` in upload.js — pointer events,
  touch, keyboard, resize handling.
- Canvas chart: `renderQualityCurve()` in upload.js — dark grid, line + points,
  PNG single-point fallback.
- Result page auto-fetch: `autoFetchQualityCurve()` in upload.js — reads the
  `data-before-uri` attribute from `#result-payload`, converts to File, POSTs
  to `/quality_curve`.

### Trade-offs / notes

- The `data-before-uri` attribute can be very large (up to ~33 MB for a 25 MB
  upload). HTML attribute length limits are not a concern in modern browsers,
  but the page source weight is doubled (once for the `<img>` tag, once for the
  hidden attribute). Acceptable for this demo.
- The quality curve fetch counts toward the 30 req/min rate limit.
- The old `.panels` grid and `.panel` styles are retained (unused) to avoid
  breaking any existing references; the placeholder still uses `.panel__media`.

## Session 3 — Optimization + bug fix pass

Reviewed the Session-2 additions for correctness and efficiency.

### Bug fixed — compare slider showed nothing

- Both `.compare__layer` elements were `position: absolute; inset: 0`, so the
  `.compare__wrapper` collapsed to **0 height** and neither image rendered.
- Fix: the **before** layer is now in normal flow (`position: relative`) to give
  the wrapper its height; the **after** layer overlays absolutely and is revealed
  via `clip-path`. Images capped at `max-height: 70vh`.

### Optimization — quality curve no longer re-uploads the image

- **Before:** the result page converted the embedded `data-before-uri` (up to
  ~33 MB) back into a `File` and POSTed it to a second `/quality_curve` endpoint,
  which **re-decoded and re-resized the image 9 times**. The huge URI was also
  duplicated in the HTML (`<img>` + `data-before-uri`), and the extra request
  counted against the 30 req/min limit.
- **After:** the curve is computed **inline during `/upload`** and embedded as a
  small JSON `<script id="curve-data">`. Removed: the `/quality_curve` route,
  `quality_curve_bytes()`, the `data-before-uri` attribute / `#result-payload`,
  and the JS `fetchAndRenderQualityCurve` / `dataURIToFile` / `autoFetchQualityCurve`.
- **Single decode:** new `_prepare_image()` (decode → auto-orient → resize →
  mode-normalize) + `_encode()` (format-specific save) are shared by
  `optimize_bytes()` and `optimize_with_curve()`. The curve now re-encodes the
  already-prepared image at each quality (decode/resize happen **once**, not 10×),
  and the encode at the effective quality is reused as the optimized result.
- Chart now redraws on window resize (debounced) so the canvas stays crisp.

### Net effect

- Result page = **1 request** (was 2); no multi-MB re-upload; ~9× fewer
  decode/resize operations for the curve; smaller HTML (one copy of each image).
- Still in-memory / no retention; verified 0 files on disk and `/quality_curve`
  now returns 404.

## Session 4 — Optimization-honesty fix + 3 new features

### Diagnosis: "is it actually optimizing?"

Optimization *was* working for normal photos (q95 JPEG → ~60% smaller), but two
real defects made it feel broken:

1. **It could return a file LARGER than the original and still claim success.**
   Uploading an already-compressed JPEG (q40, 64 KB) at default quality 85
   produced an 88 KB file, yet the result panel always rendered the green
   `savings--good` "↓ X% smaller" label — showing "↓ -36.5% smaller". The
   template ignored the backend's `smaller` flag.
2. **No "smallest wins" guarantee** — the re-encoded bytes were always returned.

### Fixes

- **Smallest-wins fallback** (`optimize_bytes` / `optimize_with_curve`): when no
  pixel-changing transform was requested (resize 100%, no denoise, no actual
  reorient) and the re-encode isn't smaller, the **original bytes are returned**
  — the optimizer never hands back a larger file. `_prepare_image` now returns a
  `transformed` flag; `_finalize()` centralizes prep + quality resolution.
- **Honest result panel**: three states — `savings--good` (smaller),
  `savings--none` (no change / "already optimal — original kept"),
  `savings--bad` (larger, only possible when you resize-up or denoise).

### New features

1. **Auto-quality via SSIM** — `auto_select_quality()` binary-searches the
   lowest JPEG/WebP quality whose SSIM vs the source ≥ `SSIM_TARGET` (0.92),
   ~7 encodes. SSIM implemented in `compute_ssim()` (Wang et al., 11×11 Gaussian
   window on OpenCV filtering). UI: "Auto quality" toggle that disables the
   quality slider; result shows `(auto · SSIM x.xxxx)`. PNG = n/a (lossless).
2. **Noise reduction** — `_denoise()` wraps `cv2.fastNlMeansDenoisingColored`
   (alpha-preserving), applied in `_prepare_image` after resize. UI: "Reduce
   noise" toggle + strength slider (1–30, default 7).
3. **Batch ZIP with SSE** — up to 20 images / 200 MB total. Flow:
   `POST /batch` (validate, stash job in in-memory `JOBS` with 15-min TTL) →
   `GET /batch/stream/<id>` (Server-Sent Events: `start`/`progress`/`done`,
   builds the ZIP in memory) → `GET /batch/download/<id>`. New "Batch (ZIP)" tab
   with multi-file dropzone, per-file progress list, progress bar, overall
   savings summary, and ZIP download. `app.run(threaded=True)` so the stream and
   its download can overlap.

### Backend structure changes (app.py)

- `MAX_CONTENT_LENGTH` raised to ~200 MB for batch; **per-file 25 MB enforced
  manually** in both `/upload` and `/batch` (so the single route still rejects
  oversize files even though the global limit is higher).
- New deps used directly: `numpy` (added to requirements), plus `cv2`.
- `parse_options` now also reads `denoise`, `denoise_strength`, `auto_quality`.
- Rate limits: default 60/min; `/upload` 60/min; `/batch` 20/min.
- `cleanup_jobs()` expires stale batch jobs in `before_request`.

### Front-end structure changes

- `index.html`: Single/Batch **mode switcher**; shared `options_controls()`
  Jinja macro (JS hooks are now `.js-*` **classes**, not IDs, so one wiring
  function serves both forms); honest savings states; batch dropzone/list/
  progress UI.
- `upload.js`: rewritten into scoped IIFEs — `setupOptions(form, getDims)`,
  generic `wireDropzone`, single mode, batch mode (FormData POST + `EventSource`
  stream consumer), mode switcher, compare slider, quality curve.
- `style.css`: `.mode-switch`/`.mode-tab`, `.savings--bad`, `.ctl--feature`,
  `.batch-files*`, `.batch-progress*`.

### Verified (Session 4)

- Smallest-wins: already-small JPEG → output ≤ original, `fell_back=True`.
- Normal JPEG: ~59–60% smaller across presets.
- Auto-quality: returns a quality whose SSIM ≥ 0.92 (or 95 if unreachable).
- Denoise: runs, preserves alpha.
- Result page: normal → `savings--good`; already-small → `savings--none`
  ("already optimal"), **no false green**; auto → `(auto · SSIM …)`.
- Batch over **real HTTP** (curl): create → SSE start/progress×3/done → ZIP
  download (200, correct member names).

## Possible next steps / open trade-offs

- Data URIs make a 25 MB upload produce a heavy (~33 MB) HTML response. If
  lighter pages are wanted, switch to short-lived signed temp files deleted in an
  `after_request` hook.
- OpenCV is imported but unused — reserved for future features (denoise, smart
  resize, etc.).
- PNG metadata preservation is limited to EXIF where supported.
- The quality curve chart could be extended to show the current quality point
  highlighted on the curve.
