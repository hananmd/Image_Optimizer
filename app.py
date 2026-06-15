"""Single Image Optimization Web App (Flask).

Accepts a single JPEG/PNG/WebP upload and produces an optimized "after" image
with user-controlled options (quality, resize %, metadata stripping, EXIF
auto-orient, and speed/quality presets). Before/after are shown side by side.

No retention: images are processed entirely in memory and returned as data
URIs. Nothing is written to disk, so there are no temp files to retain. A
scheduled cleanup of the temp dir is kept as a defensive no-op safety net.

Image I/O is handled by Pillow; OpenCV is kept imported for future features.
"""

from __future__ import annotations

import atexit
import base64
import os
import shutil
import tempfile
import time
from io import BytesIO

from flask import Flask, flash, jsonify, redirect, render_template, request, url_for
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.utils import secure_filename

# OpenCV is intentionally imported to keep it wired up for future features
# (e.g. denoise, smart resize). It is not used by the current pipeline.
import cv2  # noqa: F401


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

# Allowed extensions -> the Pillow format string we expect to decode.
# SVG and GIF are deliberately excluded.
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
ALLOWED_PIL_FORMATS = {"JPEG", "PNG", "WEBP"}
FORMAT_EXT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}
FORMAT_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}

MAX_CONTENT_LENGTH = 25 * 1024 * 1024  # 25 MB

# Quality slider bounds (apply to JPEG/WebP; ignored for lossless PNG).
QUALITY_MIN, QUALITY_MAX, QUALITY_DEFAULT = 1, 95, 85
# Resize percent bounds (preserves aspect ratio).
RESIZE_MIN, RESIZE_MAX, RESIZE_DEFAULT = 10, 200, 100

# Speed vs. quality presets. These map to encoder parameters and *softly*
# override the quality slider bounds (documented in PRESET_NOTES):
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
    default_limits=["30 per minute"],
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


def parse_options(form) -> dict:
    """Read + clamp optimization options from the submitted form."""
    try:
        quality = int(form.get("quality", QUALITY_DEFAULT))
    except (TypeError, ValueError):
        quality = QUALITY_DEFAULT
    try:
        resize_pct = int(form.get("resize_pct", RESIZE_DEFAULT))
    except (TypeError, ValueError):
        resize_pct = RESIZE_DEFAULT

    preset = form.get("preset", DEFAULT_PRESET)
    if preset not in PRESETS:
        preset = DEFAULT_PRESET

    # Checkboxes: present in form data when checked.
    strip_metadata = form.get("strip_metadata") is not None
    auto_orient = form.get("auto_orient") is not None
    # On a fresh (non-checkbox-aware) request default both on; the form always
    # submits hidden companions so absence here genuinely means "unchecked".

    return {
        "quality": clamp(quality, QUALITY_MIN, QUALITY_MAX),
        "resize_pct": clamp(resize_pct, RESIZE_MIN, RESIZE_MAX),
        "preset": preset,
        "strip_metadata": strip_metadata,
        "auto_orient": auto_orient,
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
# Optimization pipeline (in-memory)
# --------------------------------------------------------------------------- #

# Quality levels sampled for the "quality vs file size" chart.
QUALITY_CURVE_STEPS = (10, 20, 30, 40, 50, 60, 70, 80, 90)


def _prepare_image(raw: bytes, fmt: str, opts: dict):
    """Decode -> auto-orient -> resize -> mode-normalize. Returns (image, exif).

    The expensive work (decode/orient/resize) happens here once so both the
    single optimize pass and the quality-curve sweep can reuse the same image.
    """
    img = Image.open(BytesIO(raw))
    img.load()

    if opts["auto_orient"]:
        img = ImageOps.exif_transpose(img)

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

    if fmt == "JPEG":
        # JPEG has no alpha; flatten transparency onto white.
        if img.mode in ("RGBA", "LA", "P"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            rgba = img.convert("RGBA")
            bg.paste(rgba, mask=rgba.split()[-1])
            img = bg
        else:
            img = img.convert("RGB")

    return img, exif


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


def optimize_bytes(raw: bytes, fmt: str, opts: dict) -> dict:
    """Optimize raw image bytes -> optimized bytes + metadata (in memory)."""
    quality = effective_quality(opts["quality"], opts["preset"])
    img, exif = _prepare_image(raw, fmt, opts)
    data = _encode(img, fmt, quality, opts["preset"], exif)
    return {
        "bytes": data,
        "width": img.width,
        "height": img.height,
        "size_bytes": len(data),
        "effective_quality": quality,
    }


def optimize_with_curve(raw: bytes, fmt: str, opts: dict) -> tuple[dict, list[dict]]:
    """Optimize the image and build its quality-vs-size curve in one decode.

    Decodes/orients/resizes once, then re-encodes at each sampled quality. The
    encode at the effective quality is reused as the optimized result. PNG is
    lossless, so its curve is a single point.
    """
    preset = opts["preset"]
    eff_q = effective_quality(opts["quality"], preset)
    img, exif = _prepare_image(raw, fmt, opts)

    opt_bytes = _encode(img, fmt, eff_q, preset, exif)
    result = {
        "bytes": opt_bytes,
        "width": img.width,
        "height": img.height,
        "size_bytes": len(opt_bytes),
        "effective_quality": eff_q,
    }

    if fmt == "PNG":
        curve = [{"quality": 100, "size_bytes": len(opt_bytes)}]
    else:
        curve = []
        for q in sorted(set(QUALITY_CURVE_STEPS) | {eff_q}):
            size = len(opt_bytes) if q == eff_q else len(_encode(img, fmt, q, preset, exif))
            curve.append({"quality": q, "size_bytes": size})

    return result, curve


def to_data_uri(raw: bytes, fmt: str) -> str:
    mime = FORMAT_MIME.get(fmt, "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


# --------------------------------------------------------------------------- #
# Cleanup (defensive safety net; no files are written in normal operation)
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


@app.before_request
def _cleanup_before_request() -> None:
    cleanup_old_files()


@atexit.register
def _cleanup_on_exit() -> None:
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #

@app.route("/", methods=["GET"])
def index():
    return render_template("index.html", defaults=_ui_defaults())


@app.route("/upload", methods=["POST"])
@limiter.limit("30 per minute")
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
            "saved_human": _human_size(abs(saved)),
            "saved_pct": round(saved_pct, 1),
            "smaller": saved > 0,
            "after_uri": to_data_uri(result["bytes"], fmt),
            "download_name": f"{base_name}_optimized.{out_ext}",
        },
        "options": {
            **opts,
            "effective_quality": result["effective_quality"],
            "quality_adjusted": result["effective_quality"] != opts["quality"],
        },
    }

    if wants_json:
        # Omit the heavy before data URI from JSON to keep payloads sane.
        slim = {k: v for k, v in image.items() if k != "before_uri"}
        return jsonify({"ok": True, "image": slim})

    return render_template("index.html", image=image, defaults=_ui_defaults())


# --------------------------------------------------------------------------- #
# Error handling + helpers
# --------------------------------------------------------------------------- #

@app.errorhandler(413)
def too_large(_err):
    msg = "File is too large. Maximum upload size is 25 MB."
    if request.accept_mimetypes.accept_json and not request.accept_mimetypes.accept_html:
        return jsonify({"ok": False, "error": msg}), 413
    flash(msg)
    return render_template("index.html", defaults=_ui_defaults()), 413


@app.errorhandler(429)
def ratelimit_handler(_err):
    msg = "Rate limit exceeded. Please wait a moment (limit: 30 requests/minute)."
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
        "presets": PRESETS,
        "default_preset": DEFAULT_PRESET,
    }


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)
