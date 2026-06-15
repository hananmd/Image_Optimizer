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

  refreshUI();
})();
