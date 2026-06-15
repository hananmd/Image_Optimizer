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

## Possible next steps / open trade-offs

- Data URIs make a 25 MB upload produce a heavy (~33 MB) HTML response. If
  lighter pages are wanted, switch to short-lived signed temp files deleted in an
  `after_request` hook.
- OpenCV is imported but unused — reserved for future features (denoise, smart
  resize, etc.).
- PNG metadata preservation is limited to EXIF where supported.
