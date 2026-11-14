/* app.js — interface do FunkinSheet Optimizer. */
'use strict';
(function () {
  const FNF = window.FNF;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
  const LS_KEY = 'fnf-funkin-sheet-optimizer:opts:v2';
  const LS_LANG = 'fnf-funkin-sheet-optimizer:lang';
  const L = (en, pt, v) => { let t = FNF.lang === 'pt' ? pt : en; if (v) t = t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)); return t; };

  const state = { files: [], paired: null, snapshot: null, batch: null, preview: null, worker: null, running: false, cancel: false, urls: [] };

  // ------------------------------------------------------------------ opções
  const PRESETS = {
    quality: { autoPsnr: 38, trim: true, dedup: true, cleanInvisible: true, alphaThreshold: 0, aggressive: false, nearDedup: false, nearTolerance: 2, pngMode: 'auto', colors: 256, dither: false },
    balanced: { autoPsnr: 30, trim: true, dedup: true, cleanInvisible: true, alphaThreshold: 2, aggressive: false, nearDedup: true, nearTolerance: 1, pngMode: 'auto', colors: 256, dither: false },
    light: { autoPsnr: 26, trim: true, dedup: true, cleanInvisible: true, alphaThreshold: 8, aggressive: true, nearDedup: true, nearTolerance: 3, pngMode: 'quantize', colors: 128, dither: false },
  };

  function optInputs() { return $$('[data-opt]'); }
  function readOpts() {
    const o = {};
    for (const el of optInputs()) {
      const k = el.dataset.opt;
      if (el.type === 'checkbox') o[k] = el.checked;
      else if (el.type === 'number' || el.type === 'range' || el.dataset.num) o[k] = parseFloat(el.value);
      else o[k] = el.value;
    }
    o.suffix = (o.suffix || '').replace(/[^\w.\-]/g, '');
    if ($('#o-scalemode').value === 'auto') o.scale = 'auto';
    o.addScaleField = o.adjustOffsets;
    return o;
  }
  function applyOpts(o) {
    for (const el of optInputs()) {
      const k = el.dataset.opt;
      if (!(k in o)) continue;
      if (k === 'scale' && o[k] === 'auto') continue;
      if (el.type === 'checkbox') el.checked = !!o[k]; else el.value = o[k];
    }
    $('#o-scalemode').value = o.scale === 'auto' || o.scale === undefined ? 'auto' : 'manual';
    syncScale();
    syncPreset();
  }
  function saveOpts() { try { localStorage.setItem(LS_KEY, JSON.stringify(readOpts())); } catch (e) { /* armazenamento indisponível */ } }
  function loadOpts() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    applyOpts(Object.assign({}, FNF.DEFAULTS, PRESETS.balanced, saved));
  }
  function syncScale() {
    const v = parseFloat($('#o-scale').value) || 1;
    $('#scale-val').textContent = v.toFixed(2) + '×';
    $('#scale-box').hidden = $('#o-scalemode').value !== 'manual';
    $('#astc-box').hidden = $('#o-format').value !== 'astc';
    $$('#scale-presets button').forEach((b) => b.setAttribute('aria-pressed', String(Math.abs(parseFloat(b.dataset.s) - v) < 0.001)));
  }
  function syncPreset() {
    const o = readOpts();
    let match = 'custom';
    for (const [name, p] of Object.entries(PRESETS)) if (Object.keys(p).every((k) => o[k] === p[k])) { match = name; break; }
    $('#o-preset').value = match;
    $('#o-preset option[value=custom]').hidden = match !== 'custom';
  }

  // ------------------------------------------------------------------ arquivos
  async function addEntries(list) {
    for (const { file, path } of list) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const p = path.replace(/\\/g, '/');
      state.files = state.files.filter((f) => f.path !== p);
      state.files.push({ name: file.name || p.split('/').pop(), path: p, bytes });
    }
    refreshFiles();
  }

  async function collectDrop(dt) {
    const entries = Array.from(dt.items || []).map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return Array.from(dt.files).map((f) => ({ file: f, path: f.name }));
    const out = [];
    async function walk(e, prefix) {
      if (e.isFile) {
        const file = await new Promise((res, rej) => e.file(res, rej));
        out.push({ file, path: prefix + e.name });
      } else if (e.isDirectory) {
        const reader = e.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const c of batch) await walk(c, prefix + e.name + '/');
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e, '');
    return out;
  }

  function refreshFiles() {
    state.paired = FNF.pairFiles(state.files);
    const p = state.paired;
    const box = $('#file-summary');
    const parts = [];
    if (p.atlases.length) {
      parts.push('<div class="group"><span class="lbl">Atlas</span>' + p.atlases.map((a, i) =>
        '<span class="chip">' + esc(a.name) + ' <small>' + fmtBytes(a.pngBytes.length) + ' + XML</small><button type="button" data-rm-atlas="' + i + '" aria-label="' + L('Remove', 'Remover') + ' ' + esc(a.name) + '">×</button></span>').join('') + '</div>');
    }
    if (p.configs.length) {
      parts.push('<div class="group"><span class="lbl">Config</span>' + p.configs.map((c, i) =>
        '<span class="chip"><span class="tag ' + (c.kind === 'psych' ? 'psych' : '') + '">' + (c.kind === 'psych' ? 'Psych' : 'Leather') + '</span>' + esc(c.name) + (c.offsets ? ' <small>+ ' + esc(c.offsets.name) + '</small>' : '') +
        '<button type="button" data-rm-config="' + i + '" aria-label="' + L('Remove', 'Remover') + ' ' + esc(c.name) + '">×</button></span>').join('') + '</div>');
    }
    for (const pr of p.problems) if (pr.level !== 'info') parts.push('<div class="note ' + (pr.level === 'error' ? 'error' : 'warn') + '">' + esc(pr.msg) + '</div>');
    if (state.files.length) parts.push('<div class="group"><button type="button" class="btn small ghost" id="btn-clear">' + L('Clear all', 'Limpar tudo') + '</button></div>');
    box.innerHTML = parts.join('');
    $('#btn-run').disabled = state.running || !p.atlases.length;
  }

  function removePaths(paths) {
    state.files = state.files.filter((f) => !paths.includes(f.path));
    refreshFiles();
  }

  // ------------------------------------------------------------------ execução
  function setProgress(text, pct) {
    $('#progress').hidden = false;
    $('#progress-text').textContent = text;
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    $('#bar-fill').style.width = v + '%';
    $('.bar').setAttribute('aria-valuenow', String(v));
  }
  function showError(msg) { const e = $('#run-error'); e.hidden = !msg; e.textContent = msg || ''; }

  function runInWorker(payload) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker('js/worker.js'); } catch (e) { reject({ fallback: true }); return; }
      state.worker = w;
      let started = false;
      w.onmessage = (ev) => {
        started = true;
        const m = ev.data;
        if (m.type === 'progress') setProgress(m.stage, m.pct);
        else if (m.type === 'done') { w.terminate(); state.worker = null; resolve(m.batch); }
        else if (m.type === 'error') { w.terminate(); state.worker = null; reject({ message: m.message }); }
      };
      w.onerror = (ev) => {
        w.terminate(); state.worker = null;
        if (!started) reject({ fallback: true }); else reject({ message: ev.message || L('Processing error.', 'Erro no processamento.') });
      };
      w.postMessage(Object.assign({ type: 'run' }, payload));
    });
  }
  async function runOnMain(payload) {
    return FNF.runBatch({
      atlases: payload.atlases, configs: payload.configs, opts: payload.opts,
      onProgress: async (stage, pct) => {
        if (state.cancel) throw new Error(L('Cancelled.', 'Cancelado.'));
        setProgress(stage, pct);
        await new Promise((r) => setTimeout(r, 0));
      },
    });
  }

  async function run() {
    if (state.running || !state.paired || !state.paired.atlases.length) return;
    const opts = readOpts();
    saveOpts();
    const p = state.paired;
    state.snapshot = p;
    const payload = {
      lang: FNF.lang,
      atlases: p.atlases.map((a) => ({ name: a.name, dir: a.dir, pngBytes: a.pngBytes, xmlText: a.xmlText })),
      configs: p.configs.map((c) => ({ kind: c.kind, name: c.name, dir: c.dir, text: c.text, bytes: c.bytes, offsets: c.offsets })),
      opts,
    };
    state.running = true; state.cancel = false;
    $('#btn-run').disabled = true; $('#btn-cancel').hidden = false; showError('');
    $('#sec-results').hidden = true;
    setProgress(L('Starting…', 'Iniciando…'), 0);
    try {
      let batch;
      try { batch = await runInWorker(payload); }
      catch (e) { if (e && e.fallback) { setProgress(L('Processing on the main thread…', 'Processando na página principal…'), 0); batch = await runOnMain(payload); } else throw e; }
      state.batch = batch;
      await showResults(batch);
      $('#progress').hidden = true;
    } catch (e) {
      $('#progress').hidden = true;
      if (!state.cancel) showError((e && e.message) || String(e));
    } finally {
      state.running = false; state.worker = null;
      $('#btn-cancel').hidden = true; $('#btn-run').disabled = !(state.paired && state.paired.atlases.length);
    }
  }
  function cancel() {
    state.cancel = true;
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    state.running = false;
    $('#progress').hidden = true; $('#btn-cancel').hidden = true;
    $('#btn-run').disabled = !(state.paired && state.paired.atlases.length);
    showError(L('Optimization cancelled.', 'Otimização cancelada.'));
  }

  // ------------------------------------------------------------------ resultados
  function deltaHtml(a, b) {
    const d = FNF.delta(a, b);
    return '<span class="d ' + (b <= a ? 'good' : 'bad') + '">' + d + '</span>';
  }

  async function bitmapOf(bytes) {
    if (bytes.length > 4 && bytes[0] === 0x13 && bytes[1] === 0xab && bytes[2] === 0xa1 && bytes[3] === 0x5c) {
      const r = FNF.decodeASTC(bytes);
      const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data.buffer), r.width, r.height), 0, 0);
      return createImageBitmap(c);
    }
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }

  async function showResults(batch) {
    // prévias
    const snap = state.snapshot;
    state.preview = [];
    for (let i = 0; i < batch.results.length; i++) {
      const r = batch.results[i], a = snap.atlases[i];
      const origFrames = FNF.parseSparrow(a.xmlText).frames, optFrames = FNF.parseSparrow(r.xmlText).frames;
      const [ob, nb] = await Promise.all([bitmapOf(a.pngBytes), bitmapOf(r.pngBytes)]);
      state.preview.push({
        name: r.name,
        orig: { bmp: ob, w: ob.width, h: ob.height, frames: origFrames, regions: regionsOf(origFrames) },
        opt: { bmp: nb, w: nb.width, h: nb.height, frames: optFrames, regions: regionsOf(optFrames) },
        origFrames, optFrames,
      });
    }
    renderSummary(batch);
    renderConfigs(batch);
    renderDownloads(batch);
    fillAtlasSelect();
    fillGroupSelect();
    $('#sec-results').hidden = false;
    selectTab('summary');
    $('#sec-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function regionsOf(frames) {
    const m = new Map();
    for (const f of frames) {
      const k = f.x + ',' + f.y + ',' + f.w + ',' + f.h;
      if (!m.has(k)) m.set(k, { x: f.x, y: f.y, w: f.w, h: f.h, names: [] });
      m.get(k).names.push(f.name);
    }
    return Array.from(m.values());
  }

  function renderSummary(batch) {
    let pb = 0, pa = 0;
    const cards = batch.results.map((r) => {
      const s = r.stats;
      pb += s.pngBefore + s.xmlBefore; pa += s.pngAfter + s.xmlAfter;
      const v = r.validation;
      const psnr = v.psnrMin != null ? ' · ' + L('min PSNR', 'PSNR mín.') + ' ' + v.psnrMin.toFixed(1) + ' dB' : '';
      const pill = !v.ok ? '<span class="pill bad">' + L('validation failed', 'validação falhou') + '</span>'
        : v.exact === false ? '<span class="pill ok">' + L('reduced', 'reduzido') + psnr + '</span>'
        : v.lossy ? '<span class="pill warn">' + L('slightly lossy', 'com perdas leves') + psnr + '</span>'
        : '<span class="pill ok">' + L('identical to the original (validated)', 'idêntico ao original (validado)') + '</span>';
      const xmlNote = s.xmlAfter > s.xmlBefore ? '<div class="note">' + L('The XML grew because smart crop adds frameX/frameY to each frame. That is expected: the image saves far more.', 'O XML cresceu porque o corte inteligente adiciona frameX/frameY a cada frame. É esperado: a imagem economiza muito mais.') + '</div>' : '';
      const msgs = []
        .concat(xmlNote)
        .concat(v.errors.map((m) => '<div class="note error">' + esc(m) + '</div>'))
        .concat(r.warnings.concat(v.warnings).map((m) => '<div class="note warn">' + esc(m) + '</div>')).join('');
      const bar = (a, b) => '<div class="meter"><i style="width:' + Math.min(100, Math.round((b / a) * 100)) + '%"></i></div>';
      const sc = r.scale.toFixed(2) + (r.auto ? ' (auto)' : '');
      return '<div class="atlas-card"><h3>' + esc(r.name) + ' ' + pill + '<span class="muted">' + L('scale', 'escala') + ' ' + sc + ' (' + L('effective', 'efetiva') + ' ' + r.seff.toFixed(3) + ') · ' + r.ms + ' ms</span></h3>' +
        '<div class="metrics">' +
        '<div class="metric"><div class="k">' + L('Image', 'Imagem') + '</div><div class="v">' + fmtBytes(s.pngBefore) + ' → ' + fmtBytes(s.pngAfter) + '</div>' + deltaHtml(s.pngBefore, s.pngAfter) + ' <span class="muted">' + esc(s.pngKind) + '</span>' + bar(s.pngBefore, s.pngAfter) + '</div>' +
        '<div class="metric"><div class="k">XML</div><div class="v">' + fmtBytes(s.xmlBefore) + ' → ' + fmtBytes(s.xmlAfter) + '</div>' + deltaHtml(s.xmlBefore, s.xmlAfter) + bar(s.xmlBefore, s.xmlAfter) + '</div>' +
        '<div class="metric"><div class="k">' + L('Atlas size', 'Dimensão do atlas') + '</div><div class="v">' + s.atlasBefore.w + '×' + s.atlasBefore.h + ' → ' + s.atlasAfter.w + '×' + s.atlasAfter.h + '</div>' + deltaHtml(s.pixelsBefore, s.pixelsAfter) + ' <span class="muted">pixels</span></div>' +
        '<div class="metric"><div class="k">Frames</div><div class="v">' + s.framesTotal + ' → ' + s.framesUnique + ' ' + L('unique', 'únicos') + '</div><span class="d good">' + s.framesDuplicated + ' ' + L('duplicates', 'duplicados') + '</span></div>' +
        '</div><div class="msgs">' + msgs + '</div></div>';
    }).join('');
    const problems = batch.problems.map((p) => '<div class="note warn">' + esc(p.msg) + '</div>').join('');
    $('#pane-summary').innerHTML =
      '<div class="totals"><div><div class="muted">' + L('Total savings (image + XML)', 'Economia total (imagem + XML)') + '</div><b>' + FNF.delta(pb, pa) + '</b></div><div class="muted">' + fmtBytes(pb) + ' → ' + fmtBytes(pa) + '</div></div>' + cards + problems;
  }

  function diffTable(changes, title) {
    if (!changes.length) return '';
    return '<table class="diff"><thead><tr><th>' + esc(title) + '</th><th>' + L('Before', 'Antes') + '</th><th>' + L('After', 'Depois') + '</th></tr></thead><tbody>' +
      changes.slice(0, 60).map((c) => '<tr><td>' + esc(c.field) + '</td><td class="old">' + esc(c.before) + '</td><td class="new">' + esc(c.after) + '</td></tr>').join('') +
      (changes.length > 60 ? '<tr><td colspan="3">… ' + L('and', 'e mais') + ' ' + (changes.length - 60) + ' ' + L('more lines', 'linhas') + '</td></tr>' : '') + '</tbody></table>';
  }
  function renderConfigs(batch) {
    if (!batch.configs.length) {
      $('#pane-config').innerHTML = '<div class="note">' + L('No character config was added, so only the image and XML were optimized. For the character to look the same in game, set its sprite scale to <b>original_scale × {f}</b> and shift its offsets by the amounts shown in the report.', 'Nenhum config de personagem foi enviado, então só a imagem e o XML foram otimizados. Para o personagem ficar igual no jogo, defina a escala como <b>escala_original × {f}</b> e ajuste os offsets como mostra o relatório.', { f: (1 / (batch.results[0] ? batch.results[0].seff : 1)).toFixed(4) }) + '</div>';
      return;
    }
    $('#pane-config').innerHTML = batch.configs.map((c) => {
      const body = diffTable(c.changes, L('Field', 'Campo')) + (c.offsets ? diffTable(c.offsets.changes, 'Offset') : '') +
        (!c.changes.length && !(c.offsets && c.offsets.changes.length) ? '<p class="muted">' + L('No changes needed in this file.', 'Nenhuma alteração necessária neste arquivo.') + '</p>' : '') +
        c.warnings.map((w) => '<div class="note warn">' + esc(w) + '</div>').join('');
      return '<div class="cfg-card"><h3><span class="tag ' + (c.kind === 'psych' ? 'psych' : '') + '">' + (c.kind === 'psych' ? 'Psych' : 'Leather') + '</span>' + esc(c.name) +
        '<span class="muted">' + L('main atlas', 'atlas principal') + ': ' + esc(c.primary || '?') + ' · ' + L('factor', 'fator') + ' ' + c.invScale.toFixed(4) + (c.shift ? ' · ' + L('offset shift', 'deslocamento dos offsets') + ' ' + c.shift.dx.toFixed(1) + ', ' + c.shift.dy.toFixed(1) : '') + '</span></h3>' + body +
        '<details><summary class="muted">' + L('View the generated file', 'Ver o arquivo gerado') + '</summary><pre style="overflow:auto;font-size:.8rem;background:#0004;padding:10px;border-radius:8px">' + esc(c.text) + '</pre></details>' +
        (c.offsets ? '<details><summary class="muted">' + L('View generated', 'Ver') + ' ' + esc(c.offsets.name) + (FNF.lang === 'pt' ? ' gerado' : '') + '</summary><pre style="overflow:auto;font-size:.8rem;background:#0004;padding:10px;border-radius:8px">' + esc(c.offsets.text) + '</pre></details>' : '') + '</div>';
    }).join('');
  }

  function renderDownloads(batch) {
    state.urls.forEach((u) => URL.revokeObjectURL(u));
    state.urls = [];
    const files = FNF.collectOutputs(batch);
    $('#downloads').innerHTML = '';
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.data]));
      state.urls.push(url);
      const li = document.createElement('li');
      li.innerHTML = '<a download="' + esc(f.path.split('/').pop()) + '" href="' + url + '">' + esc(f.path) + '</a><span>' + fmtBytes(f.data.length) + '</span>';
      $('#downloads').appendChild(li);
    }
  }

  async function downloadZip() {
    if (!state.batch) return;
    if (state.batch.results.some((r) => !r.validation.ok) &&
        !window.confirm(L('Validation failed on at least one atlas: the result may differ from the original. Download anyway?', 'A validação falhou em pelo menos um atlas: o resultado pode estar diferente do original. Baixar mesmo assim?'))) return;
    const btn = $('#btn-zip');
    btn.disabled = true; btn.textContent = L('Building ZIP…', 'Gerando ZIP…');
    try {
      const zip = await FNF.makeZip(FNF.collectOutputs(state.batch));
      const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'optimized.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } finally { btn.disabled = false; btn.textContent = L('Download all (.zip)', 'Baixar tudo (.zip)'); }
  }

  // ------------------------------------------------------------------ abas
  function selectTab(name) {
    for (const t of ['summary', 'atlas', 'anim', 'config']) {
      $('#tab-' + t).setAttribute('aria-selected', String(t === name));
      $('#pane-' + t).hidden = t !== name;
    }
    if (name === 'atlas') { vResize(); vFit(); }
    if (name === 'anim') { aResize(); aStart(); } else aStop();
  }

  // ------------------------------------------------------------------ visualizador de atlas
  const V = { atlas: 0, which: 'opt', boxes: true, s: 1, ox: 0, oy: 0, hover: null, drag: null };
  const vSide = () => state.preview && state.preview[V.atlas] && state.preview[V.atlas][V.which];
  function fillAtlasSelect() {
    $('#v-atlas').innerHTML = state.preview.map((p, i) => '<option value="' + i + '">' + esc(p.name) + '</option>').join('');
    V.atlas = 0;
  }
  function vResize() {
    const c = $('#v-canvas'), dpr = window.devicePixelRatio || 1;
    const w = c.parentElement.clientWidth || 600;
    c.style.height = '480px';
    c.width = Math.round(w * dpr); c.height = Math.round(480 * dpr);
    vDraw();
  }
  function vFit() {
    const d = vSide(); if (!d) return;
    const c = $('#v-canvas'), dpr = window.devicePixelRatio || 1;
    const cw = c.width / dpr, ch = c.height / dpr;
    V.s = Math.min(cw / d.w, ch / d.h, 4);
    V.ox = (cw - d.w * V.s) / 2; V.oy = (ch - d.h * V.s) / 2;
    vDraw(); vInfo();
  }
  function vInfo() {
    const d = vSide(); if (!d) return;
    $('#v-info').textContent = d.w + '×' + d.h + ' px · ' + d.regions.length + ' ' + L('regions', 'regiões') + ' · ' + d.frames.length + ' frames · ' + Math.round(V.s * 100) + '%';
  }
  function vDraw() {
    const d = vSide(); const c = $('#v-canvas');
    if (!d || !c.width) return;
    const ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = V.s < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(d.bmp, V.ox, V.oy, d.w * V.s, d.h * V.s);
    if (V.boxes && d.regions.length * V.s < 40000) {
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(56,225,255,.55)';
      for (const r of d.regions) ctx.strokeRect(V.ox + r.x * V.s + 0.5, V.oy + r.y * V.s + 0.5, r.w * V.s, r.h * V.s);
    }
    if (V.hover) {
      const r = V.hover;
      ctx.fillStyle = 'rgba(255,79,163,.28)'; ctx.strokeStyle = '#ff4fa3'; ctx.lineWidth = 2;
      ctx.fillRect(V.ox + r.x * V.s, V.oy + r.y * V.s, r.w * V.s, r.h * V.s);
      ctx.strokeRect(V.ox + r.x * V.s, V.oy + r.y * V.s, r.w * V.s, r.h * V.s);
    }
  }
  function vPointer(ev) { const r = $('#v-canvas').getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width }; }
  function vBind() {
    const c = $('#v-canvas'), tip = $('#v-tip');
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = vPointer(ev), f = Math.exp(-ev.deltaY * 0.0015);
      const ns = Math.min(32, Math.max(0.02, V.s * f));
      V.ox = p.x - ((p.x - V.ox) / V.s) * ns; V.oy = p.y - ((p.y - V.oy) / V.s) * ns; V.s = ns;
      vDraw(); vInfo();
    }, { passive: false });
    c.addEventListener('pointerdown', (ev) => { c.setPointerCapture(ev.pointerId); const p = vPointer(ev); V.drag = { x: p.x, y: p.y, ox: V.ox, oy: V.oy }; });
    c.addEventListener('pointerup', () => { V.drag = null; });
    c.addEventListener('pointerleave', () => { V.hover = null; tip.hidden = true; vDraw(); });
    c.addEventListener('pointermove', (ev) => {
      const p = vPointer(ev), d = vSide(); if (!d) return;
      if (V.drag) { V.ox = V.drag.ox + p.x - V.drag.x; V.oy = V.drag.oy + p.y - V.drag.y; vDraw(); return; }
      const ix = (p.x - V.ox) / V.s, iy = (p.y - V.oy) / V.s;
      let hit = null;
      for (let i = d.regions.length - 1; i >= 0; i--) { const r = d.regions[i]; if (ix >= r.x && ix < r.x + r.w && iy >= r.y && iy < r.y + r.h) { hit = r; break; } }
      if (hit !== V.hover) { V.hover = hit; vDraw(); }
      if (hit) {
        tip.hidden = false;
        tip.textContent = hit.names.slice(0, 3).join(' · ') + (hit.names.length > 3 ? ' (+' + (hit.names.length - 3) + ')' : '') + '  ' + hit.w + '×' + hit.h;
        tip.style.left = Math.min(p.x + 14, p.w - 200) + 'px'; tip.style.top = p.y + 14 + 'px';
      } else tip.hidden = true;
    });
    $('#v-atlas').addEventListener('change', (e) => { V.atlas = +e.target.value; V.hover = null; vFit(); });
    const setWhich = (w) => { V.which = w; $('#v-orig').setAttribute('aria-pressed', String(w === 'orig')); $('#v-opt').setAttribute('aria-pressed', String(w === 'opt')); V.hover = null; vFit(); };
    $('#v-orig').addEventListener('click', () => setWhich('orig'));
    $('#v-opt').addEventListener('click', () => setWhich('opt'));
    $('#v-boxes').addEventListener('change', (e) => { V.boxes = e.target.checked; vDraw(); });
    $('#v-fit').addEventListener('click', vFit);
  }

  // ------------------------------------------------------------------ player de animações
  const A = { groups: [], g: null, i: 0, acc: 0, last: 0, playing: true, mode: 'side', fps: 24, raf: 0 };

  function parseOffsetsText(text) {
    const m = {};
    for (const line of text.split(/\r?\n/)) {
      const r = /^\s*(\S.*?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/.exec(line);
      if (r) m[r[1]] = [parseFloat(r[2]), parseFloat(r[3])];
    }
    return m;
  }
  function metaFor(atlasName, frameName) {
    const out = { label: null, fps: 24, offset: null, offsetNew: null, s0: 1, s1: null };
    const batch = state.batch;
    if (!batch) return out;
    for (const c of batch.configs) {
      let j, j2 = null;
      try { j = JSON.parse(c.before.replace(/^\uFEFF/, '')); } catch (e) { continue; }
      try { j2 = JSON.parse(c.text.replace(/^\uFEFF/, '')); } catch (e) { j2 = null; }
      const refs = FNF.configAtlasRefs({ kind: c.kind, text: c.before }).map((r) => r.toLowerCase());
      if (!refs.includes(atlasName.toLowerCase())) continue;
      const anims = Array.isArray(j.animations) ? j.animations : [];
      const pick = (jj) => {
        let best = null, bl = -1;
        for (const a of (jj && Array.isArray(jj.animations) ? jj.animations : [])) {
          const key = c.kind === 'psych' ? a.name : a.animation_name;
          if (typeof key === 'string' && key && frameName.startsWith(key) && key.length > bl) { best = a; bl = key.length; }
        }
        return best;
      };
      const best = pick(j), best2 = pick(j2);
      const sc = (o) => { for (const k of Object.keys(o || {})) if (/^(scale|char(acter)?[_-]?scale|sprite[_-]?scale)$/i.test(k) && typeof o[k] === 'number') return o[k]; return null; };
      out.s0 = sc(j) == null ? 1 : sc(j);
      out.s1 = sc(j2) == null ? out.s0 : sc(j2);
      if (best) {
        out.fps = best.fps || 24;
        if (c.kind === 'psych') {
          out.label = best.anim; out.offset = Array.isArray(best.offsets) ? best.offsets : null;
          out.offsetNew = best2 && Array.isArray(best2.offsets) ? best2.offsets : out.offset;
        } else {
          out.label = best.name;
          if (c.offsets) {
            const m = parseOffsetsText(c.offsets.before), m2 = parseOffsetsText(c.offsets.text);
            out.offset = m[best.name] || null; out.offsetNew = m2[best.name] || out.offset;
          }
        }
      }
      return out;
    }
    return out;
  }
  function fillGroupSelect() {
    A.groups = [];
    state.preview.forEach((p, ai) => {
      const map = new Map();
      p.origFrames.forEach((f, i) => {
        const key = f.name.replace(/\d+$/, '');
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(i);
      });
      for (const [prefix, idx] of map) {
        const num = (i) => { const m = /(\d+)$/.exec(p.origFrames[i].name); return m ? parseInt(m[1], 10) : 0; };
        idx.sort((a, b) => num(a) - num(b));
        const meta = metaFor(p.name, p.origFrames[idx[0]].name);
        A.groups.push({ atlas: ai, prefix, idx, meta, label: (meta.label ? meta.label + ' — ' : '') + prefix.trim() + ' (' + idx.length + ')' + (state.preview.length > 1 ? ' · ' + p.name : '') });
      }
    });
    $('#a-group').innerHTML = A.groups.map((g, i) => '<option value="' + i + '">' + esc(g.label) + '</option>').join('');
    setGroup(0);
  }
  function setGroup(i) {
    A.g = A.groups[i] || null; A.i = 0; A.acc = 0;
    if (A.g) { A.fps = A.g.meta.fps; $('#a-fps').value = A.fps; }
    updateAnimInfo();
  }
  function updateAnimInfo() {
    if (!A.g) { $('#a-info').textContent = ''; return; }
    const m = A.g.meta, r = state.batch.results[A.g.atlas];
    const noCfg = m.s1 == null;
    $('#a-info').textContent = (A.mode === 'side' ? L('Left: original · right: optimized. ', 'Esquerda: original · direita: otimizado. ') : L('Original overlaid on the optimized one (when aligned it looks like a single sprite). ', 'Original sobreposto ao otimizado (se estiverem alinhados, parece um sprite só). ')) +
      (noCfg ? L('No config: the optimized sprite is drawn ' + (1 / r.seff).toFixed(3) + '× larger without offset changes.', 'Sem config: o sprite otimizado é desenhado ' + (1 / r.seff).toFixed(3) + '× maior, sem ajuste de offsets.')
        : (m.offset ? L('Original offset ', 'Offset original ') + m.offset.join(', ') + (m.offsetNew ? ' → ' + L('new ', 'novo ') + m.offsetNew.join(', ') : '') + '. ' : L('No offset for this animation. ', 'Sem offset para esta animação. ')) + L('Scale ', 'Escala ') + m.s0 + ' → ' + (+m.s1.toFixed(4)) + '. ') +
      L('Approximate preview of how the game positions the sprite.', 'Prévia aproximada de como o jogo posiciona o sprite.');
  }
  function aResize() {
    const c = $('#a-canvas'), dpr = window.devicePixelRatio || 1;
    const w = c.parentElement.clientWidth || 600;
    c.style.height = '420px';
    c.width = Math.round(w * dpr); c.height = Math.round(420 * dpr);
  }
  function aStart() { aStop(); A.last = 0; A.raf = requestAnimationFrame(aTick); }
  function aStop() { if (A.raf) cancelAnimationFrame(A.raf); A.raf = 0; }
  function aTick(ts) {
    A.raf = requestAnimationFrame(aTick);
    if (!A.last) A.last = ts;
    const dt = Math.min(0.25, (ts - A.last) / 1000); A.last = ts;
    if (A.playing && A.g) {
      A.acc += dt * A.fps;
      while (A.acc >= 1) { A.acc -= 1; A.i = (A.i + 1) % A.g.idx.length; }
    }
    aDraw();
  }
  // (tlx,tly) = canto superior esquerdo da caixa virtual do frame, s = escala na tela
  function drawSprite(ctx, bmp, f, tlx, tly, s, alpha, label) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, f.x, f.y, f.w, f.h, tlx - f.fx * s, tly - f.fy * s, f.w * s, f.h * s);
    ctx.globalAlpha = 1;
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
    ctx.strokeRect(tlx + 0.5, tly + 0.5, f.fw * s, f.fh * s);
    ctx.restore();
    if (label) { ctx.fillStyle = 'rgba(240,236,255,.85)'; ctx.font = '12px ui-monospace, monospace'; ctx.fillText(label, tlx, tly - 6); }
  }
  function aDraw() {
    const c = $('#a-canvas');
    if (!c.width || !A.g) return;
    const ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = c.width / dpr, H = c.height / dpr;
    const p = state.preview[A.g.atlas], r = state.batch.results[A.g.atlas];
    const gi = A.g.idx[A.i], fo = p.origFrames[gi], fn = p.optFrames[gi];
    const m = A.g.meta, ref = r.ref;
    const s0 = m.s0, s1 = m.s1 == null ? m.s0 / r.seff : m.s1, side = A.mode === 'side';
    const zoom = parseFloat($('#a-zoom').value) || 1;
    const base = Math.min(((side ? W / 2 : W) - 40) / (ref.fw0 * s0), (H - 50) / (ref.fh0 * s0), 2.5) * zoom;
    const useOff = $('#a-offs').checked;
    const o0 = useOff && m.offset ? m.offset : [0, 0];
    const o1 = useOff ? (m.offsetNew || (m.s1 == null ? null : m.offset) || [0, 0]) : [0, 0];
    const cy = H / 2 + 8;
    // Flixel: ponto P do frame virtual -> pos - offset + C + s*(P - C), com C = centro do frame de referência.
    // Ancoramos pos para que o centro do frame de referência original fique em (cx, cy) com offset 0.
    const C0 = [ref.fw0 / 2, ref.fh0 / 2], C1 = [ref.fw1 / 2, ref.fh1 / 2];
    const tlOrig = (cx) => [cx - base * (o0[0] + s0 * C0[0]), cy - base * (o0[1] + s0 * C0[1])];
    const tlNew = (cx) => [cx - base * C0[0] - base * o1[0] + base * C1[0] - base * s1 * C1[0], cy - base * C0[1] - base * o1[1] + base * C1[1] - base * s1 * C1[1]];
    const cxO = side ? W * 0.25 : W / 2, cxN = side ? W * 0.75 : W / 2;
    const to = tlOrig(cxO), tn = tlNew(cxN);
    drawSprite(ctx, p.orig.bmp, fo, to[0], to[1], base * s0, 1, side ? L('original', 'original') : null);
    drawSprite(ctx, p.opt.bmp, fn, tn[0], tn[1], base * s1, side ? 1 : 0.55, side ? L('optimized', 'otimizado') : L('original + optimized (55%)', 'original + otimizado (55%)'));
    ctx.fillStyle = 'rgba(240,236,255,.7)'; ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('frame ' + (A.i + 1) + '/' + A.g.idx.length + ' · ' + fo.name, 10, 18);
  }
  function aBind() {
    $('#a-group').addEventListener('change', (e) => setGroup(+e.target.value));
    $('#a-play').addEventListener('click', () => { A.playing = !A.playing; $('#a-play').textContent = A.playing ? L('Pause', 'Pausar') : L('Play', 'Reproduzir'); });
    $('#a-fps').addEventListener('change', (e) => { A.fps = Math.max(1, Math.min(60, +e.target.value || 24)); });
    const setMode = (m) => { A.mode = m; updateAnimInfo(); $('#a-side').setAttribute('aria-pressed', String(m === 'side')); $('#a-over').setAttribute('aria-pressed', String(m === 'over')); };
    $('#a-side').addEventListener('click', () => setMode('side'));
    $('#a-over').addEventListener('click', () => setMode('over'));
  }

  // ------------------------------------------------------------------ idioma
  function translateStatic(lang) {
    $$('[data-pt]').forEach((el) => {
      if (el.dataset.en === undefined) el.dataset.en = el.innerHTML;
      el.innerHTML = lang === 'pt' ? el.dataset.pt : el.dataset.en;
    });
    $$('[data-pt-title]').forEach((el) => { if (el.dataset.enTitle === undefined) el.dataset.enTitle = el.getAttribute('title') || ''; el.setAttribute('title', lang === 'pt' ? el.dataset.ptTitle : el.dataset.enTitle); });
    $$('[data-pt-ph]').forEach((el) => { if (el.dataset.enPh === undefined) el.dataset.enPh = el.getAttribute('placeholder') || ''; el.setAttribute('placeholder', lang === 'pt' ? el.dataset.ptPh : el.dataset.enPh); });
  }
  function setLanguage(lang, persist) {
    FNF.setLang(lang);
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    translateStatic(lang);
    $$('#lang-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    if (persist) { try { localStorage.setItem(LS_LANG, lang); } catch (e) { /* ignorar */ } }
    refreshFiles();
    if (state.batch) { renderSummary(state.batch); renderConfigs(state.batch); updateAnimInfo(); }
    renderCompress();
    $('#a-play').textContent = A.playing ? L('Pause', 'Pausar') : L('Play', 'Reproduzir');
  }
  function selectMode(m) {
    $('#view-opt').hidden = m !== 'opt'; $('#view-cmp').hidden = m !== 'cmp';
    $('#mode-opt').setAttribute('aria-selected', String(m === 'opt')); $('#mode-cmp').setAttribute('aria-selected', String(m === 'cmp'));
    if (m !== 'opt') aStop();
  }

  // ------------------------------------------------------------------ comprimir imagens
  const C = { files: [], out: [], running: false, urls: [] };
  function renderCompress() {
    const box = $('#c-list'); if (!box) return;
    const rows = [];
    C.files.forEach((f, i) => {
      const o = C.out[i];
      if (!o) { rows.push('<div class="c-item"><span></span><div><div class="nm">' + esc(f.name) + '</div><div class="muted">' + fmtBytes(f.bytes.length) + '</div></div></div>'); return; }
      const warn = o.warnings.map((w) => '<div class="note warn">' + esc(w) + '</div>').join('');
      rows.push('<div class="c-item"><img alt="" src="' + o.preview + '"><div><div class="nm">' + esc(o.name) + '</div><div>' + fmtBytes(o.before) + ' → <b>' + fmtBytes(o.bytes.length) + '</b> ' + deltaHtml(o.before, o.bytes.length) +
        '</div><div class="muted">' + esc(o.kind) + (o.psnr != null && o.psnr < 99 ? ' · PSNR ' + o.psnr.toFixed(1) + ' dB' : '') + ' · ' + o.width + '×' + o.height + '</div>' + warn + '</div><a class="btn small" download="' + esc(o.name) + '" href="' + o.url + '">' + L('Download', 'Baixar') + '</a></div>');
    });
    box.innerHTML = rows.join('');
    $('#c-run').disabled = C.running || !C.files.length;
    $('#c-zip').hidden = !C.out.length || C.out.length < C.files.length || C.files.length < 2;
  }
  async function addImages(list) {
    for (const f of list) C.files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    C.out = []; renderCompress();
  }
  async function previewUrl(res) {
    try {
      const bytes = res.bytes;
      if (res.name.endsWith('.astc')) { const r = FNF.decodeASTC(bytes); const cv = document.createElement('canvas'); cv.width = r.width; cv.height = r.height; cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data.buffer), r.width, r.height), 0, 0); return cv.toDataURL('image/png'); }
    } catch (e) { /* sem prévia */ }
    return null;
  }
  async function runCompress() {
    if (C.running || !C.files.length) return;
    C.running = true; C.urls.forEach((u) => URL.revokeObjectURL(u)); C.urls = []; C.out = [];
    $('#c-run').disabled = true;
    const opts = { quality: $('#c-quality').value, format: $('#c-format').value, astcBlock: $('#c-astcblock').value };
    try {
      for (let i = 0; i < C.files.length; i++) {
        $('#c-progress').textContent = L('Compressing {n}/{t}: ', 'Comprimindo {n}/{t}: ', { n: i + 1, t: C.files.length }) + C.files[i].name;
        await new Promise((r) => setTimeout(r, 20));
        try {
          const r = await FNF.compressImage(C.files[i], opts, () => new Promise((res) => setTimeout(res, 0)));
          const mime = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', astc: 'application/octet-stream' }[r.name.split('.').pop()] || 'application/octet-stream';
          r.url = URL.createObjectURL(new Blob([r.bytes], { type: mime })); C.urls.push(r.url);
          r.preview = (await previewUrl(r)) || r.url;
          C.out[i] = r;
        } catch (e) {
          C.out[i] = { name: C.files[i].name, bytes: C.files[i].bytes, before: C.files[i].bytes.length, kind: L('failed: ', 'falhou: ') + (e.message || e), width: 0, height: 0, psnr: null, warnings: [], url: '#', preview: '' };
        }
        renderCompress();
      }
    } finally { C.running = false; $('#c-progress').textContent = ''; renderCompress(); }
  }
  async function zipCompressed() {
    const files = C.out.map((o) => ({ path: o.name, data: o.bytes, deflate: false }));
    const zip = await FNF.makeZip(files);
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const a = document.createElement('a'); a.href = url; a.download = 'compressed.zip'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ------------------------------------------------------------------ eventos
  function init() {
    const blocks = FNF.ASTC_BLOCKS.map(([x, y]) => '<option value="' + x + 'x' + y + '">' + x + '×' + y + '</option>').join('');
    $('#o-astcblock').innerHTML = '<option value="auto">Auto</option>' + blocks;
    $('#c-astcblock').innerHTML = '<option value="auto">Auto</option>' + blocks;
    loadOpts();
    let lang = 'en';
    try { lang = localStorage.getItem(LS_LANG) || ((navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en'); } catch (e) { /* ignorar */ }
    setLanguage(lang === 'pt' ? 'pt' : 'en', false);
    refreshFiles();
    $$('#lang-seg button').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang, true)));
    $('#mode-opt').addEventListener('click', () => selectMode('opt'));
    $('#mode-cmp').addEventListener('click', () => selectMode('cmp'));
    $('#c-pick').addEventListener('click', (e) => { e.stopPropagation(); $('#c-in').click(); });
    $('#c-drop').addEventListener('click', () => $('#c-in').click());
    $('#c-in').addEventListener('change', async (e) => { await addImages(Array.from(e.target.files)); e.target.value = ''; });
    $('#c-format').addEventListener('change', () => { $('#c-astc-box').hidden = $('#c-format').value !== 'astc'; });
    $('#c-run').addEventListener('click', runCompress);
    $('#c-zip').addEventListener('click', zipCompressed);
    $('#c-drop').addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    $('#c-drop').addEventListener('drop', async (e) => { e.preventDefault(); e.stopPropagation(); await addImages(Array.from(e.dataTransfer.files)); });

    const drop = $('#drop');
    $('#btn-pick').addEventListener('click', (e) => { e.stopPropagation(); $('#in-files').click(); });
    $('#btn-folder').addEventListener('click', (e) => { e.stopPropagation(); $('#in-folder').click(); });
    drop.addEventListener('click', () => $('#in-files').click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#in-files').click(); } });
    $('#in-files').addEventListener('change', async (e) => { await addEntries(Array.from(e.target.files).map((f) => ({ file: f, path: f.name }))); e.target.value = ''; });
    $('#in-folder').addEventListener('change', async (e) => { await addEntries(Array.from(e.target.files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { if (ev === 'drop' || e.target === document.documentElement || e.relatedTarget === null) drop.classList.remove('over'); }));
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!$('#view-cmp').hidden) return;
      try { await addEntries(await collectDrop(e.dataTransfer)); } catch (err) { showError(L('Could not read the dropped files: ', 'Não consegui ler os arquivos soltos: ') + err.message); }
    });
    $('#btn-demo').addEventListener('click', async (e) => {
      e.stopPropagation();
      setProgress(L('Building the example character…', 'Gerando personagem de exemplo…'), 20);
      await new Promise((r) => setTimeout(r, 30));
      try { state.files = await FNF.makeDemo(); refreshFiles(); } finally { $('#progress').hidden = true; }
    });
    $('#file-summary').addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      const p = state.paired;
      if (t.id === 'btn-clear') { state.files = []; refreshFiles(); }
      else if (t.dataset.rmAtlas !== undefined) { const a = p.atlases[+t.dataset.rmAtlas]; removePaths([a.dir + a.pngName, a.dir + a.xmlName]); }
      else if (t.dataset.rmConfig !== undefined) { const c = p.configs[+t.dataset.rmConfig]; removePaths([c.dir + c.name].concat(c.offsets ? [c.dir + c.offsets.name] : [])); }
    });

    // opções
    $('#sec-opts').addEventListener('input', (e) => { if (e.target.id === 'o-preset') return; syncScale(); syncPreset(); saveOpts(); });
    $('#scale-presets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $('#o-scale').value = b.dataset.s; syncScale(); saveOpts(); });
    $('#o-preset').addEventListener('change', (e) => { const p = PRESETS[e.target.value]; if (p) { applyOpts(Object.assign(readOpts(), p)); saveOpts(); } });

    $('#btn-run').addEventListener('click', run);
    $('#btn-cancel').addEventListener('click', cancel);
    $('#btn-zip').addEventListener('click', downloadZip);
    $$('.tabs [role=tab]').forEach((t) => t.addEventListener('click', () => selectTab(t.id.replace('tab-', ''))));
    vBind(); aBind();
    window.addEventListener('resize', () => { if (!$('#pane-atlas').hidden) { vResize(); } if (!$('#pane-anim').hidden) aResize(); });
  }

  document.addEventListener('DOMContentLoaded', init);
  window.__fnfApp = { state, run };
})();
