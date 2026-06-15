(function () {
  "use strict";

  var MAX_BYTES = 25 * 1024 * 1024;
  var ALLOWED_EXT = ["jpg", "jpeg", "png", "webp"];
  var ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
  var BATCH_MAX_FILES = 20;

  // Soft preset bounds — must mirror the server (PRESET_QUALITY_CAP in app.py).
  var PRESET_BOUNDS = {
    speed: { cap: 85, note: "fastest encode; quality capped at 85, 4:2:0 chroma" },
    balanced: { note: "default; uses your quality as-is" },
    max_quality: { floor: 70, note: "best fidelity; quality raised to at least 70, 4:4:4 chroma" }
  };

  // --------------------------------------------------------------------- //
  // Helpers
  // --------------------------------------------------------------------- //
  function $(sel, root) { return (root || document).querySelector(sel); }
  function extOf(name) { var i = name.lastIndexOf("."); return i === -1 ? "" : name.slice(i + 1).toLowerCase(); }
  function humanSize(bytes) {
    var units = ["B", "KB", "MB", "GB"], i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i];
  }
  function validateFile(file) {
    if (ALLOWED_EXT.indexOf(extOf(file.name)) === -1)
      return "Only JPEG, PNG, and WebP are allowed (SVG and GIF are rejected).";
    if (file.type && ALLOWED_MIME.indexOf(file.type) === -1)
      return "Unsupported image type: " + file.type + ".";
    if (file.size > MAX_BYTES) return "File is too large. Maximum size is 25 MB.";
    return null;
  }

  // --------------------------------------------------------------------- //
  // Shared option-control wiring (works for both single & batch forms).
  // `getDims` optionally returns {w, h} of a single selected image so the
  // resize hint can project output dimensions.
  // --------------------------------------------------------------------- //
  function setupOptions(form, getDims) {
    if (!form) return function () {};

    var presets = form.querySelectorAll(".js-preset");
    var quality = $(".js-quality", form);
    var qualityVal = $(".js-quality-val", form);
    var resize = $(".js-resize", form);
    var resizeVal = $(".js-resize-val", form);
    var resizeHint = $(".js-resize-hint", form);
    var strip = $(".js-strip", form);
    var orient = $(".js-orient", form);
    var autoq = $(".js-autoq", form);
    var denoise = $(".js-denoise", form);
    var denoiseRow = $(".js-denoise-row", form);
    var denoiseStrength = $(".js-denoise-strength", form);
    var denoiseVal = $(".js-denoise-val", form);
    var presetHint = $(".js-preset-hint", form);
    var summary = $(".js-summary", form);

    function currentPreset() {
      for (var i = 0; i < presets.length; i++) if (presets[i].checked) return presets[i].value;
      return "balanced";
    }

    function refresh() {
      var q = parseInt(quality.value, 10);
      var pct = parseInt(resize.value, 10);
      var preset = currentPreset();
      var bounds = PRESET_BOUNDS[preset] || {};
      var auto = autoq && autoq.checked;

      var eff = q;
      if (bounds.floor != null) eff = Math.max(eff, bounds.floor);
      if (bounds.cap != null) eff = Math.min(eff, bounds.cap);

      // Auto-quality overrides the manual slider on the server.
      quality.disabled = !!auto;
      if (auto) qualityVal.textContent = "auto";
      else qualityVal.textContent = q + (eff !== q ? " → " + eff : "");

      resizeVal.textContent = pct + "%";
      if (presetHint) presetHint.textContent = bounds.note || "";

      var dims = getDims && getDims();
      if (dims && dims.w && dims.h) {
        resizeHint.textContent = "Aspect ratio preserved → " +
          Math.max(1, Math.round(dims.w * pct / 100)) + " × " +
          Math.max(1, Math.round(dims.h * pct / 100)) + " px";
      } else {
        resizeHint.textContent = "Aspect ratio preserved.";
      }

      if (denoiseRow) denoiseRow.hidden = !(denoise && denoise.checked);
      if (denoiseVal && denoiseStrength) denoiseVal.textContent = denoiseStrength.value;

      if (summary) {
        var parts = ["Preset: " + preset.replace("_", " ")];
        if (auto) parts.push("Quality: auto (SSIM target)");
        else parts.push("Quality: " + eff + (eff !== q ? " (adjusted from " + q + ")" : ""));
        parts.push("Resize: " + pct + "%");
        if (denoise && denoise.checked) parts.push("denoise " + denoiseStrength.value);
        parts.push(strip.checked ? "metadata stripped" : "metadata kept");
        parts.push(orient.checked ? "auto-orient on" : "auto-orient off");
        summary.textContent = parts.join("  •  ");
      }
    }

    var inputs = [quality, resize, strip, orient, autoq, denoise, denoiseStrength];
    inputs.forEach(function (el) {
      if (el) { el.addEventListener("input", refresh); el.addEventListener("change", refresh); }
    });
    for (var i = 0; i < presets.length; i++) presets[i].addEventListener("change", refresh);
    refresh();
    return refresh;
  }

  // --------------------------------------------------------------------- //
  // Generic dropzone wiring
  // --------------------------------------------------------------------- //
  function wireDropzone(dropzone, input, onFiles) {
    if (!dropzone || !input) return;
    dropzone.addEventListener("click", function () { input.click(); });
    dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    input.addEventListener("change", function () {
      if (input.files && input.files.length) onFiles(Array.prototype.slice.call(input.files));
      input.value = "";
    });
    ["dragenter", "dragover"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation(); dropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation(); dropzone.classList.remove("is-dragover");
      });
    });
    dropzone.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) onFiles(Array.prototype.slice.call(files));
    });
  }

  // Prevent the browser from navigating to dropped files outside a dropzone.
  ["dragover", "drop"].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      var z = e.target.closest && e.target.closest(".dropzone");
      if (!z) e.preventDefault();
    });
  });

  // --------------------------------------------------------------------- //
  // SINGLE MODE
  // --------------------------------------------------------------------- //
  (function single() {
    var form = $("#upload-form");
    var dropzone = $("#dropzone");
    var input = $("#file-input");
    if (!form || !dropzone || !input) return;

    var browseBtn = $("#browse-btn");
    var clientError = $("#client-error");
    var controls = $("#controls");
    var preview = $("#local-preview");
    var nameEl = $("#local-name");
    var metaEl = $("#local-meta");
    var clearBtn = $("#clear-btn");
    var optimizeBtn = $("#optimize-btn");

    var natural = { w: 0, h: 0 };
    var refresh = setupOptions(form, function () { return natural.w ? natural : null; });

    function showError(m) { clientError.textContent = m; clientError.hidden = false; }
    function clearError() { clientError.textContent = ""; clientError.hidden = true; }

    function showControlsFor(file) {
      natural = { w: 0, h: 0 };
      var reader = new FileReader();
      reader.onload = function (e) {
        preview.src = e.target.result;
        var probe = new Image();
        probe.onload = function () {
          natural = { w: probe.naturalWidth, h: probe.naturalHeight };
          metaEl.textContent = extOf(file.name).toUpperCase() + " · " +
            natural.w + " × " + natural.h + " px · " + humanSize(file.size);
          refresh();
        };
        probe.src = e.target.result;
      };
      reader.readAsDataURL(file);
      nameEl.textContent = file.name;
      metaEl.textContent = humanSize(file.size);
      dropzone.hidden = true;
      controls.hidden = false;
      refresh();
    }

    function selectFile(file) {
      clearError();
      var err = validateFile(file);
      if (err) { showError(err); return; }
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      showControlsFor(file);
    }

    if (browseBtn) browseBtn.addEventListener("click", function (e) { e.stopPropagation(); input.click(); });
    wireDropzone(dropzone, input, function (files) { selectFile(files[0]); });
    if (clearBtn) clearBtn.addEventListener("click", function () {
      input.value = ""; controls.hidden = true; dropzone.hidden = false; clearError();
    });

    form.addEventListener("submit", function () {
      if (optimizeBtn) { optimizeBtn.disabled = true; optimizeBtn.textContent = "Optimizing…"; }
    });
  })();

  // --------------------------------------------------------------------- //
  // BATCH MODE
  // --------------------------------------------------------------------- //
  (function batch() {
    var form = $("#batch-form");
    var dropzone = $("#batch-dropzone");
    var input = $("#batch-input");
    if (!form || !dropzone || !input) return;

    var browseBtn = $("#batch-browse-btn");
    var errorEl = $("#batch-error");
    var controls = $("#batch-controls");
    var listEl = $("#batch-list");
    var countEl = $("#batch-count");
    var clearBtn = $("#batch-clear-btn");
    var optimizeBtn = $("#batch-optimize-btn");

    var progressSection = $("#batch-progress");
    var barFill = $("#batch-bar-fill");
    var progressText = $("#batch-progress-text");
    var resultsEl = $("#batch-results");
    var summaryEl = $("#batch-summary");
    var downloadEl = $("#batch-download");
    var resetBtn = $("#batch-reset-btn");

    var files = [];
    var es = null;

    setupOptions(form, null);

    function showError(m) { errorEl.textContent = m; errorEl.hidden = false; }
    function clearError() { errorEl.textContent = ""; errorEl.hidden = true; }

    function renderList() {
      countEl.textContent = files.length;
      listEl.innerHTML = "";
      files.forEach(function (f, idx) {
        var li = document.createElement("li");
        var name = document.createElement("span");
        name.className = "name"; name.textContent = f.name;
        var size = document.createElement("span");
        size.className = "meta-r"; size.textContent = humanSize(f.size);
        var rm = document.createElement("button");
        rm.type = "button"; rm.className = "link-btn remove"; rm.textContent = "remove";
        rm.addEventListener("click", function () { files.splice(idx, 1); syncUI(); });
        li.appendChild(name); li.appendChild(size); li.appendChild(rm);
        listEl.appendChild(li);
      });
    }

    function syncUI() {
      if (files.length) { dropzone.hidden = true; controls.hidden = false; }
      else { dropzone.hidden = false; controls.hidden = true; }
      renderList();
    }

    function addFiles(incoming) {
      clearError();
      for (var i = 0; i < incoming.length; i++) {
        if (files.length >= BATCH_MAX_FILES) { showError("Maximum " + BATCH_MAX_FILES + " files."); break; }
        var err = validateFile(incoming[i]);
        if (err) { showError(incoming[i].name + ": " + err); continue; }
        files.push(incoming[i]);
      }
      syncUI();
    }

    if (browseBtn) browseBtn.addEventListener("click", function (e) { e.stopPropagation(); input.click(); });
    wireDropzone(dropzone, input, addFiles);
    if (clearBtn) clearBtn.addEventListener("click", function () { files = []; clearError(); syncUI(); });

    function setBusy(busy) {
      optimizeBtn.disabled = busy;
      optimizeBtn.textContent = busy ? "Processing…" : "Optimize batch & download ZIP";
    }

    function startStream(jobId, total) {
      resultsEl.innerHTML = "";
      summaryEl.hidden = true;
      downloadEl.hidden = true;
      barFill.style.width = "0%";
      progressText.textContent = "Starting…";

      es = new EventSource("/batch/stream/" + jobId);

      es.addEventListener("progress", function (ev) {
        var d = JSON.parse(ev.data);
        barFill.style.width = Math.round((d.index / d.total) * 100) + "%";
        progressText.textContent = "Processing " + d.index + " / " + d.total + " — " + d.name;
        var li = document.createElement("li");
        var name = document.createElement("span");
        name.className = "name"; name.textContent = d.name;
        var res = document.createElement("span");
        if (d.ok) {
          res.className = "meta-r ok";
          res.textContent = (d.saved_pct > 0 ? "↓ " + d.saved_pct + "%" : "no gain") +
            " · " + d.orig_human + " → " + d.opt_human;
        } else {
          res.className = "meta-r err";
          res.textContent = "failed: " + (d.error || "error");
        }
        li.appendChild(name); li.appendChild(res);
        resultsEl.appendChild(li);
      });

      es.addEventListener("done", function (ev) {
        var d = JSON.parse(ev.data);
        es.close(); es = null;
        barFill.style.width = "100%";
        progressText.textContent = "Done — " + d.count + " image(s) processed.";
        summaryEl.textContent = "↓ " + d.saved_pct + "% smaller overall";
        var span = document.createElement("span");
        span.textContent = d.orig_human + " → " + d.opt_human + "  (ZIP " + d.zip_human + ")";
        summaryEl.appendChild(span);
        summaryEl.className = d.saved_pct > 0 ? "savings savings--good" : "savings savings--none";
        summaryEl.hidden = false;
        downloadEl.href = d.download;
        downloadEl.hidden = false;
        setBusy(false);
      });

      es.onerror = function () {
        if (es) { es.close(); es = null; }
        progressText.textContent = "Connection lost during processing.";
        setBusy(false);
      };
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!files.length) { showError("Add at least one image."); return; }
      clearError();
      setBusy(true);

      var fd = new FormData(form);
      // Replace the (empty) input field with our managed file list.
      fd.delete("images");
      files.forEach(function (f) { fd.append("images", f, f.name); });

      controls.hidden = true;
      progressSection.hidden = false;

      fetch("/batch", { method: "POST", body: fd, headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok || !res.j.ok) throw new Error(res.j.error || "Upload failed.");
          startStream(res.j.job_id, res.j.count);
        })
        .catch(function (err) {
          progressText.textContent = err.message;
          setBusy(false);
        });
    });

    if (resetBtn) resetBtn.addEventListener("click", function () {
      if (es) { es.close(); es = null; }
      files = [];
      progressSection.hidden = true;
      setBusy(false);
      clearError();
      syncUI();
    });
  })();

  // --------------------------------------------------------------------- //
  // Mode switcher
  // --------------------------------------------------------------------- //
  (function modeSwitch() {
    var tabs = document.querySelectorAll(".mode-tab");
    var panels = { single: $("#mode-single"), batch: $("#mode-batch") };
    if (!tabs.length) return;
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var mode = tab.getAttribute("data-mode");
        tabs.forEach(function (t) {
          var active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        Object.keys(panels).forEach(function (k) {
          if (panels[k]) panels[k].hidden = k !== mode;
        });
      });
    });
  })();

  // --------------------------------------------------------------------- //
  // Compare slider (single mode result)
  // --------------------------------------------------------------------- //
  (function compareSlider() {
    var wrapper = $("#compare-wrapper");
    var handle = $("#compare-handle");
    var after = $(".compare__layer--after");
    if (!wrapper || !handle || !after) return;

    var dragging = false, rect = null;
    function setPos(pct) {
      pct = Math.max(0, Math.min(100, pct));
      handle.style.left = pct + "%";
      after.style.clipPath = "inset(0 0 0 " + pct + "%)";
      handle.setAttribute("aria-valuenow", Math.round(pct));
    }
    function fromClientX(clientX) {
      if (!rect) return;
      setPos(((clientX - rect.left) / rect.width) * 100);
    }
    function down(e) {
      dragging = true; rect = wrapper.getBoundingClientRect();
      handle.style.transition = "none";
      fromClientX(e.clientX || (e.touches && e.touches[0].clientX));
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      var x = e.clientX || (e.touches && e.touches[0].clientX);
      if (x != null) fromClientX(x);
    }
    function up() { if (!dragging) return; dragging = false; handle.style.transition = "left 0.05s linear"; rect = null; }

    handle.addEventListener("mousedown", down);
    handle.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
    handle.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 10 : 1;
      var cur = parseInt(handle.style.left || "50", 10);
      if (e.key === "ArrowRight" || e.key === "ArrowUp") setPos(cur + step);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") setPos(cur - step);
      else if (e.key === "Home") setPos(0);
      else if (e.key === "End") setPos(100);
      else return;
      e.preventDefault();
    });
  })();

  // --------------------------------------------------------------------- //
  // Quality curve chart (single mode result, server-embedded JSON)
  // --------------------------------------------------------------------- //
  (function qualityCurve() {
    var canvas = $("#quality-curve-chart");
    var note = $("#quality-curve-note");
    var el = $("#curve-data");
    if (!canvas || !el) return;

    var data;
    try { data = JSON.parse(el.textContent); } catch (e) { return; }
    if (!data.curve || !data.curve.length) {
      if (note) note.textContent = "Could not generate chart.";
      return;
    }

    function render(curve, fmt) {
      var ctx = canvas.getContext("2d");
      if (!ctx) return;
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.clientWidth || 400, h = canvas.clientHeight || 200;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      var pad = { top: 20, right: 10, bottom: 30, left: 50 };
      var pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
      var sizes = curve.map(function (p) { return p.size_bytes; });
      var qs = curve.map(function (p) { return p.quality; });
      var minS = Math.min.apply(null, sizes), maxS = Math.max.apply(null, sizes);
      var minQ = Math.min.apply(null, qs), maxQ = Math.max.apply(null, qs);
      var sRange = (maxS - minS) || 1, qRange = (maxQ - minQ) || 1;

      ctx.strokeStyle = "#2e3946"; ctx.lineWidth = 1;
      ctx.font = "11px -apple-system, sans-serif"; ctx.fillStyle = "#8b97a6"; ctx.textAlign = "left";
      for (var i = 0; i <= 4; i++) {
        var y = pad.top + (ph / 4) * i;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
        ctx.fillText(humanSize(maxS - (sRange / 4) * i), 4, y + 3);
      }
      for (var j = 0; j <= 5; j++) {
        var x = pad.left + (pw / 5) * j;
        ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
        ctx.fillText(Math.round(minQ + (qRange / 5) * j), x - 8, h - 6);
      }
      ctx.strokeStyle = "#4a5565";
      ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph);
      ctx.lineTo(pad.left + pw, pad.top + ph); ctx.stroke();

      ctx.fillStyle = "#8b97a6"; ctx.font = "12px -apple-system, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("Quality", pad.left + pw / 2, h - 2);
      ctx.save(); ctx.translate(10, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText("File Size", 0, 0); ctx.restore();

      if (curve.length > 1) {
        ctx.strokeStyle = "#4f9cff"; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath();
        curve.forEach(function (p, idx) {
          var px = pad.left + ((p.quality - minQ) / qRange) * pw;
          var py = pad.top + ph - ((p.size_bytes - minS) / sRange) * ph;
          if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.fillStyle = "#4f9cff";
        curve.forEach(function (p) {
          var px = pad.left + ((p.quality - minQ) / qRange) * pw;
          var py = pad.top + ph - ((p.size_bytes - minS) / sRange) * ph;
          ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
        });
      } else {
        var cx = pad.left + pw / 2, cy = pad.top + ph / 2;
        ctx.fillStyle = "#4f9cff"; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#e6edf3"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("PNG (lossless)", cx, cy - 15);
        ctx.font = "11px sans-serif"; ctx.fillStyle = "#8b97a6";
        ctx.fillText(humanSize(curve[0].size_bytes), cx, cy + 5);
      }
      if (note) note.textContent = fmt === "PNG"
        ? "PNG is lossless — quality slider has no effect."
        : "File size at each quality level for this image.";
    }

    render(data.curve, data.format);
    var t = null;
    window.addEventListener("resize", function () {
      clearTimeout(t); t = setTimeout(function () { render(data.curve, data.format); }, 150);
    });
  })();
})();
