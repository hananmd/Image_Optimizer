"""Single + Batch Image Optimization Web App (Flask).

Accepts JPEG/PNG/WebP uploads and produces optimized output with user-controlled
options (quality, resize %, metadata stripping, EXIF auto-orient, speed/quality
presets, optional noise reduction, and optional SSIM-driven auto quality).

Two modes:
  * Single  — one image, before/after compare slider + quality-vs-size curve.
  * Batch   — up to 20 images, processed with live SSE progress, downloaded as a
              single ZIP.

Honesty guarantees:
  * The optimizer never silently returns a file *larger* than the original when
    no pixel-changing transform was requested (resize/denoise/reorient): it
    falls back to the original bytes ("smallest wins").
  * When a transform *was* requested and the result is larger, the result is
    reported truthfully as larger — never dressed up as a saving.

No persistent retention: single-image work is fully in memory and returned as
data URIs. Batch ZIPs live in an in-memory job store with a short TTL and are
never written to disk. Image I/O is Pillow; OpenCV/NumPy power denoise + SSIM.
"""

from __future__ import annotations

import atexit
import base64
import json
import os
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from io import BytesIO

import cv2
import numpy as np
from flask import (
    Flask,
    Response,
    abort,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.utils import secure_filename


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

# Allowed extensions -> the Pillow format string we expect to decode.
# SVG and GIF are deliberately excluded.
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
ALLOWED_PIL_FORMATS = {"JPEG", "PNG", "WEBP"}
FORMAT_EXT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}
FORMAT_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}

# Per-file cap. The global MAX_CONTENT_LENGTH is larger to allow a batch of
# several files, so per-file size is enforced manually in the routes.
MAX_FILE_BYTES = 25 * 1024 * 1024            # 25 MB per image
BATCH_MAX_FILES = 20
BATCH_MAX_TOTAL_BYTES = 200 * 1024 * 1024    # 200 MB across the whole batch
MAX_CONTENT_LENGTH = BATCH_MAX_TOTAL_BYTES + (2 * 1024 * 1024)  # + form overhead

# Quality slider bounds (apply to JPEG/WebP; ignored for lossless PNG).
QUALITY_MIN, QUALITY_MAX, QUALITY_DEFAULT = 1, 95, 85
# Resize percent bounds (preserves aspect ratio).
RESIZE_MIN, RESIZE_MAX, RESIZE_DEFAULT = 10, 200, 100
# Noise-reduction strength (maps to OpenCV fastNlMeansDenoisingColored `h`).
DENOISE_MIN, DENOISE_MAX, DENOISE_DEFAULT = 1, 30, 7
# Auto-quality target structural similarity.
SSIM_TARGET = 0.92

# Speed vs. quality presets. These map to encoder parameters and *softly*
# override the quality slider bounds:
#   - "speed":       fastest encode, caps quality at <= 85
#   - "balanced":    default; uses the slider quality as-is
#   - "max_quality": best fidelity, raises quality to >= 70
PRESETS = ("speed", "balanced", "max_quality")
DEFAULT_PRESET = "balanced"
PRESET_QUALITY_CAP = {"speed": (None, 85), "balanced": (None, None), "max_quality": (70, None)}
# JPEG chroma subsampling per preset: 2 = 4:2:0 (smaller), 0 = 4:4:4 (best).
PRESET_JPEG_SUBSAMPLING = {"speed": 2, "balanced": 2, "max_quality": 0}
# WebP encoder effort (0 fast .. 6 best).
PRESET_WEBP_METHOD = {"speed": 1, "balanced": 4, "max_quality": 6}
# PNG zlib compression level (0 none .. 9 best).
PRESET_PNG_LEVEL = {"speed": 1, "balanced": 6, "max_quality": 9}

# Batch job store (in memory). Jobs expire after this TTL.
JOB_TTL_SECONDS = 15 * 60
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

# Defensive scheduled-cleanup target (no files are written here anymore).
FILE_TTL_SECONDS = 30 * 60
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "imagetools_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # no stale CSS/JS during dev
app.secret_key = os.environ.get("SECRET_KEY", os.urandom(24).hex())

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["60 per minute"],
    storage_uri="memory://",
)


# --------------------------------------------------------------------------- #
# Validators
# --------------------------------------------------------------------------- #

def has_allowed_extension(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def validate_image(raw: bytes) -> tuple[bool, str | None, str | None]:
    """Confirm bytes decode to a real JPEG/PNG/WebP. Returns (ok, fmt, error)."""
    try:
        with Image.open(BytesIO(raw)) as img:
            img.verify()
            fmt = img.format
    except (UnidentifiedImageError, OSError, ValueError):
        return False, None, "File is not a valid image."

    if fmt not in ALLOWED_PIL_FORMATS:
        return False, None, (
            f"Unsupported image format: {fmt or 'unknown'}. "
            "Only JPEG, PNG, and WebP are allowed."
        )
    return True, fmt, None


def clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def _int_field(form, name: str, default: int) -> int:
    try:
        return int(form.get(name, default))
    except (TypeError, ValueError):
        return default


def parse_options(form) -> dict:
    """Read + clamp optimization options from the submitted form."""
    quality = _int_field(form, "quality", QUALITY_DEFAULT)
    resize_pct = _int_field(form, "resize_pct", RESIZE_DEFAULT)
    denoise_strength = _int_field(form, "denoise_strength", DENOISE_DEFAULT)

    preset = form.get("preset", DEFAULT_PRESET)
    if preset not in PRESETS:
        preset = DEFAULT_PRESET

    # Checkboxes: present in form data when checked.
    strip_metadata = form.get("strip_metadata") is not None
    auto_orient = form.get("auto_orient") is not None
    denoise = form.get("denoise") is not None
    auto_quality = form.get("auto_quality") is not None

    return {
        "quality": clamp(quality, QUALITY_MIN, QUALITY_MAX),
        "resize_pct": clamp(resize_pct, RESIZE_MIN, RESIZE_MAX),
        "preset": preset,
        "strip_metadata": strip_metadata,
        "auto_orient": auto_orient,
        "denoise": denoise,
        "denoise_strength": clamp(denoise_strength, DENOISE_MIN, DENOISE_MAX),
        "auto_quality": auto_quality,
    }


def effective_quality(quality: int, preset: str) -> int:
    """Apply a preset's soft override to the requested quality."""
    floor, cap = PRESET_QUALITY_CAP[preset]
    if floor is not None:
        quality = max(quality, floor)
    if cap is not None:
        quality = min(quality, cap)
    return quality


# --------------------------------------------------------------------------- #
# Image quality (SSIM) — used by the auto-quality feature
# --------------------------------------------------------------------------- #

def _gray_array(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("L"), dtype=np.float64)


def compute_ssim(ref: np.ndarray, other: np.ndarray) -> float:
    """Mean structural similarity between two single-channel float arrays.

    Standard Wang et al. SSIM with an 11x11 Gaussian window (sigma 1.5),
    implemented on top of OpenCV's separable filtering.
    """
    if ref.shape != other.shape:
        other = cv2.resize(other, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)

    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    kernel = cv2.getGaussianKernel(11, 1.5)
    window = np.outer(kernel, kernel.transpose())

    mu1 = cv2.filter2D(ref, -1, window)[5:-5, 5:-5]
    mu2 = cv2.filter2D(other, -1, window)[5:-5, 5:-5]
    mu1_sq, mu2_sq, mu1_mu2 = mu1 ** 2, mu2 ** 2, mu1 * mu2

    sigma1_sq = cv2.filter2D(ref ** 2, -1, window)[5:-5, 5:-5] - mu1_sq
    sigma2_sq = cv2.filter2D(other ** 2, -1, window)[5:-5, 5:-5] - mu2_sq
    sigma12 = cv2.filter2D(ref * other, -1, window)[5:-5, 5:-5] - mu1_mu2

    ssim_map = ((2 * mu1_mu2 + c1) * (2 * sigma12 + c2)) / (
        (mu1_sq + mu2_sq + c1) * (sigma1_sq + sigma2_sq + c2)
    )
    return float(ssim_map.mean())


def auto_select_quality(img: Image.Image, fmt: str, preset: str, exif, target: float = SSIM_TARGET):
    """Binary-search the lowest quality whose SSIM vs the source is >= target.

    Returns (quality, ssim_at_quality). Lossless PNG has no quality knob, so it
    returns (QUALITY_MAX, 1.0). The search re-encodes ~log2(range) times.
    """
    if fmt == "PNG":
        return QUALITY_MAX, 1.0

    ref = _gray_array(img)
    lo, hi = QUALITY_MIN, QUALITY_MAX
    best_q, best_ssim = hi, 0.0

    # Evaluate SSIM at a candidate quality (encode -> decode -> compare).
    def ssim_at(q: int) -> float:
        enc = _encode(img, fmt, q, preset, exif)
        with Image.open(BytesIO(enc)) as dec:
            return compute_ssim(ref, _gray_array(dec))

    # If even max quality cannot reach the target, return max quality.
    if ssim_at(hi) < target:
        return hi, ssim_at(hi)

    while lo <= hi:
        mid = (lo + hi) // 2
        s = ssim_at(mid)
        if s >= target:
            best_q, best_ssim = mid, s
            hi = mid - 1
        else:
            lo = mid + 1
    return best_q, best_ssim


# --------------------------------------------------------------------------- #
# Optimization pipeline (in-memory)
# --------------------------------------------------------------------------- #

# Quality levels sampled for the "quality vs file size" chart.
QUALITY_CURVE_STEPS = (10, 20, 30, 40, 50, 60, 70, 80, 90)


def _denoise(img: Image.Image, strength: int) -> Image.Image:
    """Apply OpenCV colored Non-Local Means denoising, preserving any alpha."""
    has_alpha = img.mode in ("RGBA", "LA", "PA") or (
        img.mode == "P" and "transparency" in img.info
    )
    alpha = None
    if has_alpha:
        rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A")
        rgb = rgba.convert("RGB")
    else:
        rgb = img.convert("RGB")

    bgr = np.asarray(rgb)[:, :, ::-1].copy()
    den = cv2.fastNlMeansDenoisingColored(bgr, None, strength, strength, 7, 21)
    out = Image.fromarray(den[:, :, ::-1])
    if alpha is not None:
        out.putalpha(alpha)
    return out


def _prepare_image(raw: bytes, fmt: str, opts: dict):
    """Decode -> auto-orient -> resize -> denoise -> mode-normalize.

    Returns (image, exif, transformed) where `transformed` is True when any
    pixel-changing step (reorient/resize/denoise) actually altered the image.
    The expensive work happens once so the single optimize pass and the
    quality-curve sweep can reuse the same prepared image.
    """
    img = Image.open(BytesIO(raw))
    img.load()
    transformed = False

    if opts["auto_orient"]:
        oriented = ImageOps.exif_transpose(img)
        if oriented is not img and oriented.size != img.size:
            transformed = True
        elif oriented is not img:
            # exif_transpose returns a new image only when orientation != 1.
            orientation = img.getexif().get(0x0112)
            if orientation not in (None, 1):
                transformed = True
        img = oriented

    # Capture EXIF before resizing (resize does not carry the info dict over).
    # exif_transpose already normalized orientation, so re-attaching is safe.
    exif = None if opts["strip_metadata"] else img.info.get("exif")

    if opts["resize_pct"] != 100:
        factor = opts["resize_pct"] / 100.0
        new_size = (
            max(1, round(img.width * factor)),
            max(1, round(img.height * factor)),
        )
        img = img.resize(new_size, Image.LANCZOS)
        transformed = True

    if opts.get("denoise") and opts.get("denoise_strength", 0) > 0:
        img = _denoise(img, opts["denoise_strength"])
        transformed = True

    if fmt == "JPEG":
        # JPEG has no alpha; flatten transparency onto white.
        if img.mode in ("RGBA", "LA", "P"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            rgba = img.convert("RGBA")
            bg.paste(rgba, mask=rgba.split()[-1])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")

    return img, exif, transformed


def _encode(img, fmt: str, quality: int, preset: str, exif) -> bytes:
    """Encode an already-prepared image to bytes for the given format."""
    buf = BytesIO()
    if fmt == "JPEG":
        params = dict(
            format="JPEG",
            quality=quality,
            optimize=preset != "speed",
            progressive=preset != "speed",
            subsampling=PRESET_JPEG_SUBSAMPLING[preset],
        )
        if exif:
            params["exif"] = exif
        img.save(buf, **params)
    elif fmt == "WEBP":
        params = dict(format="WEBP", quality=quality, method=PRESET_WEBP_METHOD[preset])
        if exif:
            params["exif"] = exif
        img.save(buf, **params)
    elif fmt == "PNG":
        # PNG is lossless: quality is ignored; the preset controls zlib effort.
        img.save(buf, format="PNG", optimize=True, compress_level=PRESET_PNG_LEVEL[preset])
    else:  # pragma: no cover - validation prevents other formats
        raise ValueError(f"Unsupported format: {fmt}")
    return buf.getvalue()


def _finalize(raw: bytes, fmt: str, opts: dict):
    """Shared prep + auto-quality resolution used by both single and batch.

    Returns (img, exif, transformed, eff_quality, ssim, auto_used).
    """
    preset = opts["preset"]
    img, exif, transformed = _prepare_image(raw, fmt, opts)

    ssim = None
    auto_used = False
    if opts.get("auto_quality") and fmt != "PNG":
        eff_q, ssim = auto_select_quality(img, fmt, preset, exif)
        auto_used = True
    else:
        eff_q = effective_quality(opts["quality"], preset)
    return img, exif, transformed, eff_q, ssim, auto_used


def optimize_bytes(raw: bytes, fmt: str, opts: dict) -> dict:
    """Optimize raw image bytes -> optimized bytes + metadata (in memory).

    Applies "smallest wins": if no pixel-changing transform was requested and
    the re-encoded result is not smaller than the original, the original bytes
    are returned unchanged so we never hand back a larger file.
    """
    img, exif, transformed, eff_q, ssim, auto_used = _finalize(raw, fmt, opts)
    data = _encode(img, fmt, eff_q, opts["preset"], exif)

    fell_back = False
    if not transformed and len(data) >= len(raw):
        data, fell_back = raw, True

    return {
        "bytes": data,
        "width": img.width,
        "height": img.height,
        "size_bytes": len(data),
        "effective_quality": eff_q,
        "ssim": ssim,
        "auto_quality_used": auto_used,
        "fell_back": fell_back,
    }


def optimize_with_curve(raw: bytes, fmt: str, opts: dict) -> tuple[dict, list[dict]]:
    """Optimize the image and build its quality-vs-size curve in one decode."""
    preset = opts["preset"]
    img, exif, transformed, eff_q, ssim, auto_used = _finalize(raw, fmt, opts)

    opt_bytes = _encode(img, fmt, eff_q, preset, exif)
    encoded_size = len(opt_bytes)  # encoded size at eff_q (for the curve point)

    fell_back = False
    if not transformed and len(opt_bytes) >= len(raw):
        opt_bytes, fell_back = raw, True

    result = {
        "bytes": opt_bytes,
        "width": img.width,
        "height": img.height,
        "size_bytes": len(opt_bytes),
        "effective_quality": eff_q,
        "ssim": ssim,
        "auto_quality_used": auto_used,
        "fell_back": fell_back,
    }

    if fmt == "PNG":
        curve = [{"quality": 100, "size_bytes": result["size_bytes"]}]
    else:
        curve = []
        for q in sorted(set(QUALITY_CURVE_STEPS) | {eff_q}):
            size = encoded_size if q == eff_q else len(_encode(img, fmt, q, preset, exif))
            curve.append({"quality": q, "size_bytes": size})

    return result, curve


def to_data_uri(raw: bytes, fmt: str) -> str:
    mime = FORMAT_MIME.get(fmt, "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


# --------------------------------------------------------------------------- #
# Cleanup (defensive safety net + batch job expiry)
# --------------------------------------------------------------------------- #

def cleanup_old_files() -> None:
    now = time.time()
    try:
        entries = os.listdir(UPLOAD_DIR)
    except FileNotFoundError:
        return
    for name in entries:
        path = os.path.join(UPLOAD_DIR, name)
        try:
            if now - os.path.getmtime(path) > FILE_TTL_SECONDS:
                os.remove(path)
        except OSError:
            pass


def cleanup_jobs() -> None:
    now = time.time()
    with JOBS_LOCK:
        stale = [jid for jid, job in JOBS.items() if now - job["created"] > JOB_TTL_SECONDS]
        for jid in stale:
            JOBS.pop(jid, None)


@app.before_request
def _cleanup_before_request() -> None:
    cleanup_old_files()
    cleanup_jobs()


@atexit.register
def _cleanup_on_exit() -> None:
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Routes — single image
# --------------------------------------------------------------------------- #

@app.route("/", methods=["GET"])
def index():
    return render_template("index.html", defaults=_ui_defaults())


@app.route("/upload", methods=["POST"])
@limiter.limit("60 per minute")
def upload():
    wants_json = request.accept_mimetypes.accept_json and not request.accept_mimetypes.accept_html

    if "image" not in request.files:
        return _upload_error("No file part in the request.", wants_json)
    file = request.files["image"]
    if not file or file.filename == "":
        return _upload_error("No file selected.", wants_json)
    if not has_allowed_extension(file.filename):
        return _upload_error(
            "Invalid file type. Only JPEG, PNG, and WebP are allowed (SVG and GIF are rejected).",
            wants_json,
        )

    raw = file.read()
    if len(raw) > MAX_FILE_BYTES:
        return _upload_error("File is too large. Maximum size is 25 MB.", wants_json)
    is_valid, fmt, error = validate_image(raw)
    if not is_valid:
        return _upload_error(error or "Invalid image.", wants_json)

    opts = parse_options(request.form)

    # Original dimensions (as stored, pre-orient) for the "before" panel.
    with Image.open(BytesIO(raw)) as img:
        orig_w, orig_h = img.size

    try:
        # One decode pass produces both the optimized image and the curve.
        result, curve = optimize_with_curve(raw, fmt, opts)
    except (OSError, ValueError) as exc:
        return _upload_error(f"Could not optimize image: {exc}", wants_json)

    orig_size = len(raw)
    saved = orig_size - result["size_bytes"]
    saved_pct = (saved / orig_size * 100) if orig_size else 0
    base_name = secure_filename(file.filename).rsplit(".", 1)[0] or "image"
    out_ext = FORMAT_EXT[fmt]

    image = {
        "filename": secure_filename(file.filename),
        "format": fmt,
        "width": orig_w,
        "height": orig_h,
        "size_bytes": orig_size,
        "size_human": _human_size(orig_size),
        "before_uri": to_data_uri(raw, fmt),
        "curve": curve,
        "optimized": {
            "format": fmt,
            "width": result["width"],
            "height": result["height"],
            "size_bytes": result["size_bytes"],
            "size_human": _human_size(result["size_bytes"]),
            "delta_human": _human_size(abs(saved)),
            "saved_pct": round(saved_pct, 1),
            "abs_pct": round(abs(saved_pct), 1),
            "smaller": saved > 0,
            "same": saved == 0,
            "larger": saved < 0,
            "fell_back": result["fell_back"],
            "after_uri": to_data_uri(result["bytes"], fmt),
            "download_name": f"{base_name}_optimized.{out_ext}",
        },
        "options": {
            **opts,
            "effective_quality": result["effective_quality"],
            "quality_adjusted": (not result["auto_quality_used"])
            and result["effective_quality"] != opts["quality"],
            "auto_quality_used": result["auto_quality_used"],
            "ssim": round(result["ssim"], 4) if result["ssim"] is not None else None,
        },
    }

    if wants_json:
        # Omit the heavy before data URI from JSON to keep payloads sane.
        slim = {k: v for k, v in image.items() if k != "before_uri"}
        return jsonify({"ok": True, "image": slim})

    return render_template("index.html", image=image, defaults=_ui_defaults())


# --------------------------------------------------------------------------- #
# Routes — batch (ZIP) with SSE progress
# --------------------------------------------------------------------------- #

@app.route("/batch", methods=["POST"])
@limiter.limit("20 per minute")
def batch_create():
    """Validate a multi-file upload, stash it as a job, return a job id.

    Processing + ZIP building happen lazily in the SSE stream so the client can
    show per-file progress.
    """
    files = request.files.getlist("images")
    files = [f for f in files if f and f.filename]
    if not files:
        return jsonify({"ok": False, "error": "No files selected."}), 400
    if len(files) > BATCH_MAX_FILES:
        return jsonify({"ok": False, "error": f"Too many files (max {BATCH_MAX_FILES})."}), 400

    items = []
    total = 0
    for f in files:
        name = f.filename
        if not has_allowed_extension(name):
            return jsonify({"ok": False, "error": f"{name}: invalid type (JPEG/PNG/WebP only)."}), 400
        raw = f.read()
        total += len(raw)
        if len(raw) > MAX_FILE_BYTES:
            return jsonify({"ok": False, "error": f"{name}: exceeds 25 MB."}), 400
        if total > BATCH_MAX_TOTAL_BYTES:
            return jsonify({"ok": False, "error": "Batch total exceeds 200 MB."}), 400
        ok, fmt, err = validate_image(raw)
        if not ok:
            return jsonify({"ok": False, "error": f"{name}: {err}"}), 400
        items.append({"name": name, "raw": raw, "fmt": fmt})

    opts = parse_options(request.form)
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "items": items,
            "opts": opts,
            "created": time.time(),
            "zip": None,
            "started": False,
        }
    return jsonify({"ok": True, "job_id": job_id, "count": len(items)})


@app.route("/batch/stream/<job_id>", methods=["GET"])
def batch_stream(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            abort(404)
        if job["started"]:
            abort(409)  # a stream is already consuming this job
        job["started"] = True

    def sse(event: str | None, payload: dict) -> str:
        prefix = f"event: {event}\n" if event else ""
        return f"{prefix}data: {json.dumps(payload)}\n\n"

    def generate():
        items = job["items"]
        opts = job["opts"]
        total = len(items)
        zip_buf = BytesIO()
        used_names: set[str] = set()
        orig_total = opt_total = 0

        yield sse("start", {"total": total})

        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for idx, item in enumerate(items, start=1):
                name, raw, fmt = item["name"], item["raw"], item["fmt"]
                try:
                    result = optimize_bytes(raw, fmt, opts)
                    saved = len(raw) - result["size_bytes"]
                    saved_pct = round(saved / len(raw) * 100, 1) if raw else 0.0
                    orig_total += len(raw)
                    opt_total += result["size_bytes"]

                    base = secure_filename(name).rsplit(".", 1)[0] or "image"
                    out_name = f"{base}_optimized.{FORMAT_EXT[fmt]}"
                    n, candidate = 2, out_name
                    while candidate in used_names:
                        candidate = f"{base}_optimized_{n}.{FORMAT_EXT[fmt]}"
                        n += 1
                    used_names.add(candidate)
                    zf.writestr(candidate, result["bytes"])

                    yield sse("progress", {
                        "index": idx, "total": total, "name": name, "ok": True,
                        "saved_pct": saved_pct,
                        "orig_human": _human_size(len(raw)),
                        "opt_human": _human_size(result["size_bytes"]),
                    })
                except (OSError, ValueError) as exc:
                    yield sse("progress", {
                        "index": idx, "total": total, "name": name,
                        "ok": False, "error": str(exc),
                    })

        zip_bytes = zip_buf.getvalue()
        with JOBS_LOCK:
            # Free the source images; keep only the finished ZIP for download.
            job["items"] = []
            job["zip"] = zip_bytes

        total_saved = orig_total - opt_total
        total_pct = round(total_saved / orig_total * 100, 1) if orig_total else 0.0
        yield sse("done", {
            # Built as a plain path: the generator runs after the request
            # context has closed, so url_for() is unavailable here.
            "download": f"/batch/download/{job_id}",
            "count": total,
            "orig_human": _human_size(orig_total),
            "opt_human": _human_size(opt_total),
            "saved_pct": total_pct,
            "zip_human": _human_size(len(zip_bytes)),
        })

    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(generate(), headers=headers)


@app.route("/batch/download/<job_id>", methods=["GET"])
def batch_download(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        zip_bytes = job["zip"] if job else None
    if not zip_bytes:
        abort(404)
    return send_file(
        BytesIO(zip_bytes),
        mimetype="application/zip",
        as_attachment=True,
        download_name="optimized_images.zip",
    )


# --------------------------------------------------------------------------- #
# Error handling + helpers
# --------------------------------------------------------------------------- #

@app.errorhandler(413)
def too_large(_err):
    msg = "Upload is too large. Per-file max is 25 MB; batch max is 200 MB."
    if request.accept_mimetypes.accept_json and not request.accept_mimetypes.accept_html:
        return jsonify({"ok": False, "error": msg}), 413
    flash(msg)
    return render_template("index.html", defaults=_ui_defaults()), 413


@app.errorhandler(429)
def ratelimit_handler(_err):
    msg = "Rate limit exceeded. Please wait a moment."
    if request.accept_mimetypes.accept_json and not request.accept_mimetypes.accept_html:
        return jsonify({"ok": False, "error": msg}), 429
    flash(msg)
    return render_template("index.html", defaults=_ui_defaults()), 429


def _upload_error(message: str, wants_json: bool):
    if wants_json:
        return jsonify({"ok": False, "error": message}), 400
    flash(message)
    return redirect(url_for("index"))


def _ui_defaults() -> dict:
    return {
        "quality_min": QUALITY_MIN,
        "quality_max": QUALITY_MAX,
        "quality_default": QUALITY_DEFAULT,
        "resize_min": RESIZE_MIN,
        "resize_max": RESIZE_MAX,
        "resize_default": RESIZE_DEFAULT,
        "denoise_min": DENOISE_MIN,
        "denoise_max": DENOISE_MAX,
        "denoise_default": DENOISE_DEFAULT,
        "presets": PRESETS,
        "default_preset": DEFAULT_PRESET,
        "ssim_target": SSIM_TARGET,
        "batch_max_files": BATCH_MAX_FILES,
    }


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


if __name__ == "__main__":
    # threaded=True so the SSE stream and its download request can run together.
    app.run(debug=True, host="127.0.0.1", port=5000, threaded=True)
