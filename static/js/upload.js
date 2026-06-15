(function () {
  "use strict";

  var MAX_BYTES = 25 * 1024 * 1024;
  var ALLOWED_EXT = ["jpg", "jpeg", "png", "webp"];
  var ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

  var form = document.getElementById("upload-form");
  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("file-input");
  var browseBtn = document.getElementById("browse-btn");
  var clientError = document.getElementById("client-error");

  var controls = document.getElementById("controls");
  var localPreview = document.getElementById("local-preview");
  var localName = document.getElementById("local-name");
  var localMeta = document.getElementById("local-meta");
  var clearBtn = document.getElementById("clear-btn");

  var qualityInput = document.getElementById("quality");
  var qualityVal = document.getElementById("quality-val");
  var resizeInput = document.getElementById("resize_pct");
  var resizeVal = document.getElementById("resize-val");
  var resizeHint = document.getElementById("resize-hint");
  var stripInput = document.getElementById("strip_metadata");
  var orientInput = document.getElementById("auto_orient");
  var presetInputs = form ? form.querySelectorAll('input[name="preset"]') : [];
  var presetHint = document.getElementById("preset-hint");
  var paramSummary = document.getElementById("param-summary");
  var optimizeBtn = document.getElementById("optimize-btn");

  // Compare slider elements
  var compareWrapper = document.getElementById("compare-wrapper");
  var compareHandle = document.getElementById("compare-handle");
  var compareAfterLayer = document.querySelector(".compare__layer--after");

  // Quality curve elements
  var qualityCurveCanvas = document.getElementById("quality-curve-chart");
  var qualityCurveNote = document.getElementById("quality-curve-note");

  if (!form || !dropzone || !fileInput) return;

  // Soft preset bounds — must mirror the server (PRESET_QUALITY_CAP in app.py).
  var PRESET_BOUNDS = {
    speed: { cap: 85, note: "fastest encode; quality capped at 85, 4:2:0 chroma" },
    balanced: { note: "default; uses your quality as-is" },
    max_quality: { floor: 70, note: "best fidelity; quality raised to at least 70, 4:4:4 chroma" }
  };

  var selectedFile = null;
  var naturalW = 0;
  var naturalH = 0;

  function showError(msg) { clientError.textContent = msg; clientError.hidden = false; }
  function clearError() { clientError.textContent = ""; clientError.hidden = true; }

  function extOf(name) {
    var i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i + 1).toLowerCase();
  }

  function humanSize(bytes) {
    var units = ["B", "KB", "MB", "GB"], i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i];
  }

  function validate(file) {
    var ext = extOf(file.name);
    if (ALLOWED_EXT.indexOf(ext) === -1) {
      return "Only JPEG, PNG, and WebP are allowed (SVG and GIF are rejected).";
    }
    if (file.type && ALLOWED_MIME.indexOf(file.type) === -1) {
      return "Unsupported image type: " + file.type + ".";
    }
    if (file.size > MAX_BYTES) {
      return "File is too large. Maximum upload size is 25 MB.";
    }
    return null;
  }

  function currentPreset() {
    for (var i = 0; i < presetInputs.length; i++) {
      if (presetInputs[i].checked) return presetInputs[i].value;
    }
    return "balanced";
  }

  function isPng() {
    return selectedFile && extOf(selectedFile.name) === "png";
  }

  // Reflect chosen options live (no image processing, just labels/summary).
  function refreshUI() {
    var q = parseInt(qualityInput.value, 10);
    var pct = parseInt(resizeInput.value, 10);
    var preset = currentPreset();
    var bounds = PRESET_BOUNDS[preset] || {};

    // Effective quality after soft preset bounds.
    var eff = q;
    if (bounds.floor != null) eff = Math.max(eff, bounds.floor);
    if (bounds.cap != null) eff = Math.min(eff, bounds.cap);

    qualityVal.textContent = q + (eff !== q ? " → " + eff : "");
    resizeVal.textContent = pct + "%";
    presetHint.textContent = bounds.note || "";

    // Resize hint with projected output dimensions.
    if (naturalW && naturalH) {
      var ow = Math.max(1, Math.round(naturalW * pct / 100));
      var oh = Math.max(1, Math.round(naturalH * pct / 100));
      resizeHint.textContent = "Aspect ratio preserved → " + ow + " × " + oh + " px";
    } else {
      resizeHint.textContent = "Aspect ratio preserved.";
    }

    // Plain-language summary of what will be applied.
    var parts = [];
    parts.push("Preset: " + preset.replace("_", " "));
    if (isPng()) {
      parts.push("Quality: n/a (PNG is lossless)");
    } else {
      parts.push("Quality: " + eff + (eff !== q ? " (adjusted from " + q + ")" : ""));
    }
    parts.push("Resize: " + pct + "%");
    parts.push(stripInput.checked ? "metadata stripped" : "metadata kept");
    parts.push(orientInput.checked ? "auto-orient on" : "auto-orient off");
    paramSummary.textContent = parts.join("  •  ");
  }

  function showControlsFor(file) {
    selectedFile = file;
    naturalW = naturalH = 0;

    var reader = new FileReader();
    reader.onload = function (e) {
      localPreview.src = e.target.result;
      var probe = new Image();
      probe.onload = function () {
        naturalW = probe.naturalWidth;
        naturalH = probe.naturalHeight;
        localMeta.textContent =
          extOf(file.name).toUpperCase() + " · " + naturalW + " × " + naturalH +
          " px · " + humanSize(file.size);
        refreshUI();
      };
      probe.src = e.target.result;
    };
    reader.readAsDataURL(file);

    localName.textContent = file.name;
    localMeta.textContent = humanSize(file.size);
    dropzone.hidden = true;
    controls.hidden = false;
    refreshUI();
  }

  function selectFile(file) {
    clearError();
    var err = validate(file);
    if (err) { showError(err); return; }

    var dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    showControlsFor(file);
  }

  function resetSelection() {
    selectedFile = null;
    fileInput.value = "";
    controls.hidden = true;
    dropzone.hidden = false;
    clearError();
  }

  // --- File selection wiring ---
  if (browseBtn) {
    browseBtn.addEventListener("click", function (e) { e.stopPropagation(); fileInput.click(); });
  }
  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) selectFile(fileInput.files[0]);
  });
  if (clearBtn) clearBtn.addEventListener("click", resetSelection);

  // --- Drag & drop ---
  ["dragenter", "dragover"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove("is-dragover");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) selectFile(files[0]);
  });
  ["dragover", "drop"].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      if (!dropzone.contains(e.target)) e.preventDefault();
    });
  });

  // --- Live parameter preview ---
  [qualityInput, resizeInput, stripInput, orientInput].forEach(function (el) {
    if (el) { el.addEventListener("input", refreshUI); el.addEventListener("change", refreshUI); }
  });
  for (var i = 0; i < presetInputs.length; i++) {
    presetInputs[i].addEventListener("change", refreshUI);
  }

  // --- Submit ---
  form.addEventListener("submit", function () {
    if (optimizeBtn) {
      optimizeBtn.disabled = true;
      optimizeBtn.textContent = "Optimizing…";
    }
  });

  // --- Compare slider ---
  function initCompareSlider() {
    if (!compareWrapper || !compareHandle || !compareAfterLayer) return;

    var isDragging = false;
    var wrapperRect = null;

    function updateHandlePosition(clientX) {
      if (!wrapperRect) return;
      var x = clientX - wrapperRect.left;
      var pct = Math.max(0, Math.min(100, (x / wrapperRect.width) * 100));
      compareHandle.style.left = pct + "%";
      compareAfterLayer.style.clipPath = "inset(0 0 0 " + pct + "%)";
      compareHandle.setAttribute("aria-valuenow", Math.round(pct));
    }

    function onPointerDown(e) {
      isDragging = true;
      wrapperRect = compareWrapper.getBoundingClientRect();
      compareHandle.style.transition = "none";
      updateHandlePosition(e.clientX || (e.touches && e.touches[0].clientX));
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      var clientX = e.clientX || (e.touches && e.touches[0].clientX);
      if (clientX != null) updateHandlePosition(clientX);
    }

    function onPointerUp() {
      if (!isDragging) return;
      isDragging = false;
      compareHandle.style.transition = "left 0.05s linear";
      wrapperRect = null;
    }

    compareHandle.addEventListener("mousedown", onPointerDown);
    compareHandle.addEventListener("touchstart", onPointerDown, { passive: false });
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("touchmove", onPointerMove, { passive: false });
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("touchend", onPointerUp);

    // Keyboard support
    compareHandle.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 10 : 1;
      var current = parseInt(compareHandle.style.left || "50", 10);
      var newPos = current;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") newPos = Math.min(100, current + step);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") newPos = Math.max(0, current - step);
      else if (e.key === "Home") newPos = 0;
      else if (e.key === "End") newPos = 100;
      else return;
      e.preventDefault();
      compareHandle.style.left = newPos + "%";
      compareAfterLayer.style.clipPath = "inset(0 0 0 " + newPos + "%)";
      compareHandle.setAttribute("aria-valuenow", newPos);
    });

    // Handle window resize
    window.addEventListener("resize", function () {
      wrapperRect = compareWrapper.getBoundingClientRect();
    });
  }

  // --- Quality curve chart (data embedded server-side; no re-upload) ---
  var lastCurve = null;
  var lastFmt = null;

  function renderQualityCurve(curve, fmt) {
    lastCurve = curve;
    lastFmt = fmt;
    var ctx = qualityCurveCanvas.getContext("2d");
    if (!ctx) return;

    var dpr = window.devicePixelRatio || 1;
    var cssWidth = qualityCurveCanvas.clientWidth || 400;
    var cssHeight = qualityCurveCanvas.clientHeight || 200;
    qualityCurveCanvas.width = cssWidth * dpr;
    qualityCurveCanvas.height = cssHeight * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    var padding = { top: 20, right: 10, bottom: 30, left: 50 };
    var plotW = cssWidth - padding.left - padding.right;
    var plotH = cssHeight - padding.top - padding.bottom;

    // Find min/max
    var sizes = curve.map(function (p) { return p.size_bytes; });
    var minSize = Math.min.apply(null, sizes);
    var maxSize = Math.max.apply(null, sizes);
    var qualities = curve.map(function (p) { return p.quality; });
    var minQ = Math.min.apply(null, qualities);
    var maxQ = Math.max.apply(null, qualities);

    // Handle single point (PNG)
    if (curve.length === 1) {
      minSize = maxSize = curve[0].size_bytes;
      minQ = maxQ = curve[0].quality;
    }

    var sizeRange = maxSize - minSize || 1;
    var qRange = maxQ - minQ || 1;

    // Grid lines
    ctx.strokeStyle = "#2e3946";
    ctx.lineWidth = 1;
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "#8b97a6";

    // Horizontal grid (4 lines)
    for (var i = 0; i <= 4; i++) {
      var y = padding.top + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();

      var val = maxSize - (sizeRange / 4) * i;
      ctx.fillText(humanSize(val), 4, y + 3);
    }

    // Vertical grid (5 lines)
    for (var j = 0; j <= 5; j++) {
      var x = padding.left + (plotW / 5) * j;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + plotH);
      ctx.stroke();

      var q = minQ + (qRange / 5) * j;
      ctx.fillText(Math.round(q), x - 10, cssHeight - 6);
    }

    // Axes
    ctx.strokeStyle = "#4a5565";
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotH);
    ctx.lineTo(padding.left + plotW, padding.top + plotH);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = "#8b97a6";
    ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Quality", padding.left + plotW / 2, cssHeight - 2);
    ctx.save();
    ctx.translate(10, padding.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("File Size", 0, 0);
    ctx.restore();

    // Draw curve
    if (curve.length > 1) {
      ctx.strokeStyle = "#4f9cff";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();

      curve.forEach(function (point, idx) {
        var x = padding.left + ((point.quality - minQ) / qRange) * plotW;
        var y = padding.top + plotH - ((point.size_bytes - minSize) / sizeRange) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Draw points
      ctx.fillStyle = "#4f9cff";
      curve.forEach(function (point) {
        var x = padding.left + ((point.quality - minQ) / qRange) * plotW;
        var y = padding.top + plotH - ((point.size_bytes - minSize) / sizeRange) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      // Single point for PNG
      var x = padding.left + plotW / 2;
      var y = padding.top + plotH / 2;
      ctx.fillStyle = "#4f9cff";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e6edf3";
      ctx.font = "bold 13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("PNG (lossless)", x, y - 15);
      ctx.font = "11px sans-serif";
      ctx.fillStyle = "#8b97a6";
      ctx.fillText(humanSize(curve[0].size_bytes), x, y + 5);
    }

    qualityCurveNote.textContent = fmt === "PNG" ? "PNG is lossless — quality slider has no effect." : "Hover the slider to see file size at different quality levels.";
  }

  // --- Render quality curve from server-embedded JSON (no second request) ---
  function renderEmbeddedCurve() {
    var el = document.getElementById("curve-data");
    if (!el || !qualityCurveCanvas) return;
    var data;
    try { data = JSON.parse(el.textContent); } catch (e) { return; }
    if (!data.curve || !data.curve.length) {
      if (qualityCurveNote) qualityCurveNote.textContent = "Could not generate chart.";
      return;
    }
    renderQualityCurve(data.curve, data.format);
  }

  // Redraw the chart on resize so the canvas stays crisp at the new width.
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    if (!lastCurve) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { renderQualityCurve(lastCurve, lastFmt); }, 150);
  });

  // Init
  initCompareSlider();
  renderEmbeddedCurve();
  refreshUI();
})();
