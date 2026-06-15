# 🖼️ Image Optimizer

## A fast, honest, in-memory image optimizer for the web — single shots or batch ZIPs

[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![OpenCV](https://img.shields.io/badge/OpenCV-4.12-5C3EE8?logo=opencv&logoColor=white)](https://opencv.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![No Retention](https://img.shields.io/badge/Privacy-No%20Retention-4f9cff.svg)](#-privacy--security)

Compress **JPEG · PNG · WebP** with quality, resize, noise reduction, and an
SSIM-driven *auto-quality* mode — with a live before/after compare slider and a
quality-vs-filesize chart. Everything runs **in memory**; nothing is written to
disk.

---

## ✨ Highlights

- 🎚️ **Full optimization controls** — quality slider, resize %, metadata strip, EXIF auto-orient, and `speed` / `balanced` / `max_quality` presets.
- 🤖 **Auto quality (SSIM)** — binary-searches for the *lowest* JPEG/WebP quality that stays visually identical (structural similarity ≥ 0.92), so you ship the smallest file no one can tell apart.
- 🧹 **Noise reduction** — OpenCV Non-Local Means denoising with an adjustable strength slider (alpha-preserving).
- 🪄 **Drag-to-compare slider** — before/after with mouse, touch, and keyboard support.
- 📈 **Quality vs file-size curve** — a canvas chart computed inline during optimization (no second upload).
- 📦 **Batch ZIP mode** — up to 20 images (200 MB total) with **live Server-Sent-Events progress** and a one-click ZIP download.
- ✅ **"Smallest wins" honesty** — never silently returns a file *larger* than the original when no pixel-changing transform was requested; results are reported truthfully as smaller / unchanged / larger.
- 🔒 **No retention** — single images are returned as data URIs; batch ZIPs live briefly in memory with TTL expiry. Nothing touches disk.
- 🛡️ **Hardened uploads** — extension **and** decoded-bytes validation (SVG/GIF rejected), per-file 25 MB cap, and per-IP rate limiting.

---

## 🚀 Quick start

```bash
# 1. Clone
git clone <YOUR_REPO_URL>        # ← replace with your repo URL
cd IMAGETOOLS

# 2. Create & activate a virtual environment
python -m venv .venv
source .venv/bin/activate         # Linux / macOS
.venv\Scripts\Activate.ps1        # Windows PowerShell

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run
python app.py
```

Then open **<http://127.0.0.1:5000>** in your browser.
> 💡 After editing CSS/JS, hard-refresh with **Ctrl+F5** to bypass the cache.

---

## 🖥️ Usage

**Single mode** — drop an image, tune the options (or flip on *Auto quality* /
*Reduce noise*), and hit **Optimize**. You get a drag-to-compare slider, an
honest savings badge, a quality-vs-size chart, and a download button.

**Batch mode** — switch to the **Batch (ZIP)** tab, drop up to 20 images, set
shared options, and watch each file optimize in real time before downloading a
single ZIP.

---

## 🔌 API

### `POST /upload` — optimize a single image

Multipart form with an `image` file plus optional fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `quality` | int (1–95) | 85 | JPEG/WebP quality; ignored for PNG (lossless) |
| `resize_pct` | int (10–200) | 100 | Resize percentage (aspect ratio preserved) |
| `preset` | string | `balanced` | `speed`, `balanced`, or `max_quality` |
| `strip_metadata` | checkbox | on | Strip EXIF and other metadata |
| `auto_orient` | checkbox | on | Auto-rotate via EXIF orientation |
| `auto_quality` | checkbox | off | Auto-select quality via SSIM (overrides `quality`) |
| `denoise` | checkbox | off | Apply Non-Local Means noise reduction |
| `denoise_strength` | int (1–30) | 7 | Denoising strength |

Returns the HTML result page, or JSON when `Accept: application/json` is sent.

### Batch endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/batch` | `POST` | Validate a multi-file upload (`images`) + options → returns `{ job_id }` |
| `/batch/stream/<job_id>` | `GET` | Server-Sent Events: `start` → `progress` (per file) → `done` (with `download` path) |
| `/batch/download/<job_id>` | `GET` | Download the finished ZIP |

---

## ⚙️ Presets

| Preset | Quality bounds | JPEG subsampling | WebP method | PNG compress level |
|---|---|---|---|---|
| `speed` | capped at ≤ 85 | 4:2:0 | 1 | 1 |
| `balanced` | used as-is | 4:2:0 | 4 | 6 |
| `max_quality` | floored at ≥ 70 | 4:4:4 | 6 | 9 |

## 📏 Limits

- **Per file:** 25 MB
- **Batch:** 20 files / 200 MB total
- **Rate limit:** 60 req/min default · `/upload` 60/min · `/batch` 20/min
- **Batch job TTL:** 15 minutes (in-memory)

---

## 🔐 Privacy & security

- Images are processed **entirely in memory** — single results come back as data
  URIs, batch ZIPs are held in a TTL-expiring in-memory store. Nothing is written
  to disk.
- Uploads are validated by **extension *and* by decoding the bytes** with Pillow;
  SVG and GIF are rejected. Per-file size and per-IP rate limits are enforced.

---

## 📦 Deploying to production

The built-in server (`app.py`) is for development only. For a public release:

1. **Use a production WSGI server with streaming/concurrency support** (required
   for the batch SSE route):

   ```bash
   # Windows-friendly
   pip install waitress
   waitress-serve --listen=0.0.0.0:8000 --threads=8 app:app

   # Linux (gevent workers stream SSE without tying up a worker)
   pip install "gunicorn[gevent]"
   gunicorn -k gevent -w 4 -b 0.0.0.0:8000 app:app
   ```

2. **Set a stable secret** via the `SECRET_KEY` environment variable.
3. **Scale the shared state** — the batch job store and rate-limiter are
   in-process (`memory://`). For multiple workers, back them with **Redis** so
   jobs created on one worker are visible to others.
4. Put it behind a reverse proxy (nginx/Caddy) for TLS and buffering control
   (the SSE route already sends `X-Accel-Buffering: no`).

---

## 🗂️ Project structure

```text
IMAGETOOLS/
├── app.py                # Flask app: config, validators, optimizer, SSIM, routes, cleanup
├── requirements.txt      # Python dependencies
├── templates/
│   └── index.html        # Single-page UI: dropzone, controls, compare slider, batch UI
├── static/
│   ├── css/style.css     # Dark theme, controls, compare slider, chart, batch styles
│   └── js/upload.js      # Client logic: single mode, batch mode, compare slider, chart
├── README.md
└── LICENSE
```

## 🧰 Tech stack

| Package | Min version | Role |
|---|---|---|
| Flask | 3.0 | Web framework & routing |
| Flask-Limiter | 3.8 | Per-IP rate limiting |
| Pillow | 11.3 | Image decode/encode |
| opencv-python-headless | 4.12 | Denoising & SSIM |
| NumPy | 2.1 | Array math for SSIM |

---

## 👤 Author

**M.Y HANAN MOHAMED**
📧 [hananmdofficials@gmail.com](mailto:hananmdofficials@gmail.com)

## 📄 License

Released under the **MIT License** — see [LICENSE](LICENSE) for details.

⭐ If you find this useful, consider starring the repo!
