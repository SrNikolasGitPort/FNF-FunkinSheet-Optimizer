/* pipeline.js — pipeline de otimização de um atlas Sparrow e processamento em lote com configs de personagem.
 * Ordem: limpar → trim → dedup → resize → re-trim → re-dedup → empacotar → PNG/XML → validar. */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const DEFAULTS = {
    format: 'auto',         // 'auto' (mesmo do original) | 'png' | 'astc'
    astcBlock: 'auto',      // 'auto' ou '4x4' … '12x12'
    astcQuality: 'normal',
    scale: 'auto',          // 'auto' (menor escala com boa qualidade) ou número 0.1 … 1
    autoPsnr: 30,           // qualidade mínima (dB) usada pela escala automática
    filter: 'area',         // area | bilinear | lanczos
    compensateRounding: true,
    trim: true,
    alphaThreshold: 0,      // 0 = só corta alpha == 0 (sem perdas)
    aggressive: false,      // zera pixels com alpha <= threshold
    cleanInvisible: true,   // zera RGB de pixels totalmente transparentes (melhor compressão, visualmente idêntico)
    dedup: true,
    nearDedup: false,
    nearTolerance: 2,
    padding: 1,
    extrude: 1,
    pow2: false,
    maxSize: 32768,
    pngMode: 'auto',        // auto (paleta exata se couber) | rgba | quantize
    colors: 256,
    dither: false,
    suffix: '',
    validate: true,
    scaleOffsets: false,    // Leather: multiplica offsets.txt por S (avançado)
    addScaleField: true,    // Leather: adiciona "scale" se o config não tiver
    adjustOffsets: true,    // soma o deslocamento de centro aos offsets (mantém o alinhamento original)
  };

  // ---------------------------------------------------------------- helpers de bitmap
  function extract(img, f) {
    const out = new Uint8Array(f.w * f.h * 4);
    for (let y = 0; y < f.h; y++) {
      const s = ((f.y + y) * img.width + f.x) * 4;
      out.set(img.data.subarray(s, s + f.w * 4), y * f.w * 4);
    }
    return out;
  }

  /** Decodifica PNG ou ASTC (.astc) pelo cabeçalho. */
  async function decodeAny(bytes) {
    if (bytes.length > 4 && bytes[0] === 0x13 && bytes[1] === 0xab && bytes[2] === 0xa1 && bytes[3] === 0x5c) {
      const r = FNF.decodeASTC(bytes);
      return { width: r.width, height: r.height, data: r.data, warnings: r.badBlocks ? [FNF.t('astc.warn.bad', { n: r.badBlocks })] : [], astc: true, bw: r.bw, bh: r.bh };
    }
    const r = await FNF.decodePNG(bytes);
    r.warnings = r.warnings || [];
    return r;
  }

  /** Bitmap lógico (upright) de um frame; frames rotacionados (rotated="true") são girados 90° anti-horário. */
  function extractLogical(img, f) {
    const raw = extract(img, f);
    if (!f.rotated) return { w: f.w, h: f.h, data: raw };
    const W = f.w, lw = f.h, lh = f.w;
    const out = new Uint8Array(lw * lh * 4);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const s = (x * W + (W - 1 - y)) * 4, d = (y * lw + x) * 4;
        out[d] = raw[s]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s + 2]; out[d + 3] = raw[s + 3];
      }
    }
    return { w: lw, h: lh, data: out };
  }

  /** Escolhe a menor escala (0.1–1) em que reduzir e ampliar de volta ainda mantém o PSNR mínimo. */
  function autoScale(entries, target) {
    const uniq = [...new Set(entries.map((e) => e.bmp))].filter((b) => b.w * b.h >= 64);
    if (!uniq.length) return 1;
    uniq.sort((a, b) => b.w * b.h - a.w * a.h);
    const pick = [];
    const n = Math.min(14, uniq.length);
    for (let i = 0; i < n; i++) pick.push(uniq[Math.floor((i * (uniq.length - 1)) / Math.max(1, n - 1))]);
    const score = (S) => {
      let sum = 0;
      for (const b of pick) {
        const nw = Math.max(1, Math.round(b.w * S)), nh = Math.max(1, Math.round(b.h * S));
        const small = FNF.resizeRGBA(b.data, b.w, b.h, nw, nh, 'area');
        const back = FNF.resizeRGBA(small, nw, nh, b.w, b.h, 'bilinear');
        sum += Math.min(60, psnrAndDiff(b.data, back).psnr);
      }
      return sum / pick.length;
    };
    if (score(0.1) >= target) return 0.1;
    if (score(1) < target) return 1;
    let lo = 10, hi = 100; // inteiros em centésimos: lo falha, hi passa
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (score(mid / 100) >= target) hi = mid; else lo = mid;
    }
    return hi / 100;
  }

  function bboxAlpha(d, w, h, thr) {
    let l = w, t = h, r = -1, b = -1;
    for (let y = 0; y < h; y++) {
      let o = y * w * 4 + 3;
      for (let x = 0; x < w; x++, o += 4) {
        if (d[o] > thr) {
          if (x < l) l = x;
          if (x > r) r = x;
          if (y < t) t = y;
          b = y;
        }
      }
    }
    return r < 0 ? null : { l, t, w: r - l + 1, h: b - t + 1 };
  }

  function crop(d, w, l, t, cw, ch) {
    const out = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const s = ((t + y) * w + l) * 4;
      out.set(d.subarray(s, s + cw * 4), y * cw * 4);
    }
    return out;
  }

  function hashBmp(b) {
    const u = new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.length >> 2);
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (let i = 0; i < u.length; i++) {
      const v = u[i];
      h1 = Math.imul(h1 ^ v, 16777619);
      h2 = (Math.imul(h2 + v, 0x85ebca6b) ^ (h2 >>> 13)) | 0;
    }
    return b.w + 'x' + b.h + ':' + (h1 >>> 0) + ':' + (h2 >>> 0);
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2), y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  function withinTol(a, b, tol) {
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] === 0 && b[i + 3] === 0) continue;
      if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol || Math.abs(a[i + 3] - b[i + 3]) > tol) return false;
    }
    return true;
  }

  function dedupe(entries, nearTol) {
    const exact = new Map(), near = new Map();
    for (const e of entries) {
      const b = e.bmp;
      if (!b._h) b._h = hashBmp(b);
      const list = exact.get(b._h);
      let found = null;
      if (list) for (const c of list) if (c === b || sameBytes(c.data, b.data)) { found = c; break; }
      if (!found && nearTol > 0) {
        const nl = near.get(b.w + 'x' + b.h);
        if (nl) for (const c of nl) if (withinTol(c.data, b.data, nearTol)) { found = c; break; }
      }
      if (found) e.bmp = found;
      else {
        if (list) list.push(b); else exact.set(b._h, [b]);
        const k = b.w + 'x' + b.h;
        if (near.has(k)) near.get(k).push(b); else near.set(k, [b]);
      }
    }
    return new Set(entries.map((e) => e.bmp)).size;
  }

  function trimEntries(entries, thr) {
    const cache = new Map();
    for (const e of entries) {
      let r = cache.get(e.bmp);
      if (!r) {
        const b = e.bmp;
        const bb = bboxAlpha(b.data, b.w, b.h, thr);
        if (!bb) r = { l: 0, t: 0, bmp: { w: 1, h: 1, data: new Uint8Array(4) } };
        else if (bb.w === b.w && bb.h === b.h) r = { l: 0, t: 0, bmp: b };
        else r = { l: bb.l, t: bb.t, bmp: { w: bb.w, h: bb.h, data: crop(b.data, b.w, bb.l, bb.t, bb.w, bb.h) } };
        cache.set(b, r);
      }
      e.bmp = r.bmp; e.px += r.l; e.py += r.t;
    }
  }

  /** Compõe o frame virtual (fw×fh) a partir do atlas, aplicando frameX/frameY. */
  function composeFrame(img, f, fw, fh) {
    fw = fw === undefined ? f.fw : fw; fh = fh === undefined ? f.fh : fh;
    const out = new Uint8Array(fw * fh * 4);
    const ox = 0 - f.fx, oy = 0 - f.fy;
    const lw = f.rotated ? f.h : f.w, lh = f.rotated ? f.w : f.h;
    const lg = f.rotated ? extractLogical(img, f).data : null;
    const x0 = Math.max(0, -ox), x1 = Math.min(lw, fw - ox);
    if (x1 <= x0) return out;
    for (let yy = 0; yy < lh; yy++) {
      const dy = oy + yy;
      if (dy < 0 || dy >= fh) continue;
      const s = lg ? (yy * lw + x0) * 4 : ((f.y + yy) * img.width + f.x + x0) * 4;
      out.set((lg || img.data).subarray(s, s + (x1 - x0) * 4), (dy * fw + ox + x0) * 4);
    }
    return out;
  }

  function psnrAndDiff(A, B) {
    let se = 0, maxd = 0;
    for (let i = 0; i < A.length; i += 4) {
      const a1 = A[i + 3], a2 = B[i + 3];
      const d3 = Math.abs(a1 - a2);
      se += d3 * d3; if (d3 > maxd) maxd = d3;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs((A[i + c] * a1) / 255 - (B[i + c] * a2) / 255);
        se += d * d; if (d > maxd) maxd = d;
      }
    }
    const mse = se / A.length;
    return { psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse), maxd };
  }

  // ---------------------------------------------------------------- pipeline de um atlas
  async function optimizeAtlas(input, userOpts, progress) {
    const t0 = now();
    const o = Object.assign({}, DEFAULTS, userOpts || {});
    const autoMode = o.scale === 'auto';
    o.scale = autoMode ? 1 : Math.min(1, Math.max(0.1, Number(o.scale) || 1));
    const P = async (stage, pct) => { if (progress) await progress(stage, pct); };
    const warnings = [];

    await P(FNF.t('pl.stage.read'), 0);
    const img = await decodeAny(input.pngBytes);
    const sp = FNF.parseSparrow(input.xmlText);
    warnings.push(...img.warnings, ...sp.warnings);
    if (input.removeNames && input.removeNames.length) {
      const rm = new Set(input.removeNames), before = sp.frames.length;
      sp.frames = sp.frames.filter((f) => !rm.has(f.name));
      if (!sp.frames.length) throw new Error(FNF.t('pl.err.allremoved'));
      warnings.push(FNF.t('pl.warn.removed', { n: before - sp.frames.length }));
    }
    for (const f of sp.frames) {
      if (f.w <= 0 || f.h <= 0) throw new Error(FNF.t('pl.err.zero', { name: f.name }));
      if (f.x < 0 || f.y < 0 || f.x + f.w > img.width || f.y + f.h > img.height) {
        throw new Error(FNF.t('pl.err.bounds', { name: f.name, x: f.x, y: f.y, w: f.w, h: f.h, iw: img.width, ih: img.height }));
      }
    }

    // entradas: cada frame com seu bitmap e a posição do bitmap dentro do frame virtual
    const regionCache = new Map();
    let pixelsBefore = 0;
    const entries = sp.frames.map((f) => {
      const k = f.x + ',' + f.y + ',' + f.w + ',' + f.h + (f.rotated ? 'r' : '');
      let bmp = regionCache.get(k);
      if (!bmp) {
        bmp = extractLogical(img, f);
        regionCache.set(k, bmp);
        pixelsBefore += f.w * f.h;
      }
      return { name: f.name, bmp, px: 0 - f.fx, py: 0 - f.fy, fw: f.fw, fh: f.fh };
    });
    const total = entries.length;
    const thr = Math.max(0, Math.min(254, o.alphaThreshold | 0));
    const lossy = (thr > 0 && (o.trim || o.aggressive)) || o.nearDedup || o.pngMode === 'quantize' || ((o.format === 'astc' || ((!o.format || o.format === 'auto') && img.astc)));

    await P(FNF.t('pl.stage.clean'), 8);
    if (o.cleanInvisible || (o.aggressive && thr > 0)) {
      const seen = new Set();
      for (const e of entries) {
        if (seen.has(e.bmp)) continue;
        seen.add(e.bmp);
        const d = e.bmp.data;
        const cut = o.aggressive ? thr : 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] <= cut) { d[i - 3] = 0; d[i - 2] = 0; d[i - 1] = 0; d[i] = 0; }
      }
    }

    await P(FNF.t('pl.stage.trim'), 15);
    if (o.trim) trimEntries(entries, thr);

    await P(FNF.t('pl.stage.dedup'), 25);
    let uniqueAfterTrim = new Set(entries.map((e) => e.bmp)).size;
    if (o.dedup) uniqueAfterTrim = dedupe(entries, o.nearDedup ? o.nearTolerance : 0);

    // escala efetiva (compensa o arredondamento do tamanho do frame virtual)
    let Sx = 1, Sy = 1;
    let refDims = null;
    if (!o.forceScale && autoMode) o.scale = autoScale(entries, Number(o.autoPsnr) || 30);
    {
      const count = new Map();
      for (const e of entries) { const k = e.fw + 'x' + e.fh; count.set(k, (count.get(k) || 0) + 1); }
      let bk = null, bc = 0;
      for (const [k, c] of count) if (c > bc) { bc = c; bk = k; }
      refDims = bk.split('x').map(Number);
    }
    if (o.forceScale) { Sx = o.forceScale.Sx; Sy = o.forceScale.Sy; }
    else if (o.scale < 1) {
      const count = new Map();
      for (const e of entries) { const k = e.fw + 'x' + e.fh; count.set(k, (count.get(k) || 0) + 1); }
      let bestK = null, bestC = 0;
      for (const [k, c] of count) if (c > bestC) { bestC = c; bestK = k; }
      const [fwD, fhD] = bestK.split('x').map(Number);
      if (o.compensateRounding) { Sx = Math.max(1, Math.round(fwD * o.scale)) / fwD; Sy = Math.max(1, Math.round(fhD * o.scale)) / fhD; }
      else { Sx = Sy = o.scale; }
    }

    if (Sx !== 1 || Sy !== 1) {
      const rc = new Map();
      let idc = 0, done = 0;
      for (const e of entries) {
        const b = e.bmp;
        if (!b.id) b.id = ++idc;
        // janela de destino que cobre exatamente o bitmap na grade escalada (amostragem em subpixel)
        const fx0 = e.px * Sx, fy0 = e.py * Sy;
        const x0 = Math.floor(fx0 + 1e-9), x1 = Math.ceil((e.px + b.w) * Sx - 1e-9);
        const y0 = Math.floor(fy0 + 1e-9), y1 = Math.ceil((e.py + b.h) * Sy - 1e-9);
        const nw = Math.max(1, x1 - x0), nh = Math.max(1, y1 - y0);
        const key = b.id + ':' + nw + 'x' + nh + ':' + (fx0 - x0).toFixed(4) + ':' + (fy0 - y0).toFixed(4);
        let nb = rc.get(key);
        if (!nb) {
          nb = { w: nw, h: nh, data: FNF.resizeWindow(b.data, b.w, b.h, x0, y0, nw, nh, Sx, Sy, e.px, e.py, o.filter) };
          rc.set(key, nb);
        }
        e.bmp = nb; e.px = x0; e.py = y0;
        e.fw = Math.max(1, Math.round(e.fw * Sx)); e.fh = Math.max(1, Math.round(e.fh * Sy));
        if (++done % 25 === 0) await P(FNF.t('pl.stage.resize', { pct: Math.round(o.scale * 100) }), 30 + (30 * done) / total);
      }
      await P(FNF.t('pl.stage.retrim'), 62);
      if (o.trim) trimEntries(entries, thr);
      if (o.dedup) dedupe(entries, 0);
    }
    const uniq = [...new Set(entries.map((e) => e.bmp))];

    await P(FNF.t('pl.stage.pack'), 68);
    const ex = Math.max(0, o.extrude | 0), pad = Math.max(0, o.padding | 0);
    const rects = uniq.map((b, i) => { b.pid = i; return { id: i, w: b.w + 2 * ex + pad, h: b.h + 2 * ex + pad }; });
    const plan = FNF.planAtlas(rects, { pow2: o.pow2, maxSize: o.maxSize });
    const W = o.pow2 ? plan.width : Math.max(1, plan.width - pad);
    const H = o.pow2 ? plan.height : Math.max(1, plan.height - pad);
    const atlas = new Uint8Array(W * H * 4);
    for (const b of uniq) {
      const p = plan.placements.get(b.pid);
      b.ax = p.x + ex; b.ay = p.y + ex;
      for (let y = 0; y < b.h; y++) atlas.set(b.data.subarray(y * b.w * 4, (y + 1) * b.w * 4), ((b.ay + y) * W + b.ax) * 4);
      if (ex > 0) {
        for (let oy = -ex; oy < b.h + ex; oy++) {
          const inY = oy >= 0 && oy < b.h;
          for (let ox = -ex; ox < b.w + ex; ox++) {
            if (inY && ox >= 0 && ox < b.w) { ox = b.w - 1; continue; }
            const sx = Math.min(b.w - 1, Math.max(0, ox)), sy = Math.min(b.h - 1, Math.max(0, oy));
            const s = (sy * b.w + sx) * 4, d = ((b.ay + oy) * W + b.ax + ox) * 4;
            atlas[d] = b.data[s]; atlas[d + 1] = b.data[s + 1]; atlas[d + 2] = b.data[s + 2]; atlas[d + 3] = b.data[s + 3];
          }
        }
      }
    }

    await P(FNF.t('pl.stage.png'), 78);
    const wantAstc = o.format === 'astc' || ((!o.format || o.format === 'auto') && img.astc);
    let enc;
    if (wantAstc) {
      let [abw, abh] = (o.astcBlock && o.astcBlock !== 'auto' ? o.astcBlock : (img.astc ? img.bw + 'x' + img.bh : '6x6')).split('x').map(Number);
      const bytes = FNF.encodeASTC(atlas, W, H, { bw: abw, bh: abh, quality: o.astcQuality || 'normal' });
      enc = { bytes, kind: 'ASTC ' + abw + '×' + abh };
    } else enc = await FNF.encodePNG(atlas, W, H, { mode: o.pngMode, colors: o.colors, dither: o.dither });
    const outBase = input.name + (o.suffix || '');
    const pngName = outBase + (wantAstc ? '.astc' : '.png'), xmlName = outBase + '.xml';
    const outFrames = entries.map((e) => ({
      name: e.name, x: e.bmp.ax, y: e.bmp.ay, w: e.bmp.w, h: e.bmp.h, fx: 0 - e.px, fy: 0 - e.py, fw: e.fw, fh: e.fh,
    }));
    const xmlText = FNF.writeSparrow(pngName, outFrames);

    const stats = {
      framesTotal: total,
      framesUnique: uniq.length,
      framesDuplicated: total - uniq.length,
      pngBefore: input.pngBytes.length,
      pngAfter: enc.bytes.length,
      xmlBefore: FNF.textEncode(input.xmlText).length,
      xmlAfter: FNF.textEncode(xmlText).length,
      atlasBefore: { w: img.width, h: img.height },
      atlasAfter: { w: W, h: H },
      pixelsBefore, pixelsAfter: W * H,
      uniqueAfterTrim,
      pngKind: enc.kind,
    };
    if (stats.pngAfter > stats.pngBefore) warnings.push(FNF.t('pl.warn.pngbigger', { after: stats.pngAfter, before: stats.pngBefore }));

    // ------------------------------------------------------------ validação
    const validation = { ok: true, errors: [], warnings: [], psnrMin: null, psnrAvg: null, frames: 0, exact: null, lossy };
    if (o.validate) {
      await P(FNF.t('pl.stage.validate'), 86);
      const newImg = await decodeAny(enc.bytes);
      const newSp = FNF.parseSparrow(xmlText);
      if (newSp.frames.length !== sp.frames.length) validation.errors.push(FNF.t('pl.val.count'));
      for (let i = 0; i < Math.min(newSp.frames.length, sp.frames.length); i++) {
        if (newSp.frames[i].name !== sp.frames[i].name) { validation.errors.push(FNF.t('pl.val.order', { name: sp.frames[i].name })); break; }
      }
      const regs = new Map();
      for (const f of newSp.frames) {
        if (f.x < 0 || f.y < 0 || f.x + f.w > newImg.width || f.y + f.h > newImg.height) { validation.errors.push(FNF.t('pl.val.bounds', { name: f.name })); break; }
        regs.set(f.x + ',' + f.y + ',' + f.w + ',' + f.h, f);
      }
      const rl = [...regs.values()];
      if (rl.length <= 3000) {
        outer: for (let i = 0; i < rl.length; i++) {
          for (let j = i + 1; j < rl.length; j++) {
            const a = rl[i], b = rl[j];
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
              validation.errors.push(FNF.t('pl.val.overlap', { a: a.name, b: b.name }));
              break outer;
            }
          }
        }
      }
      const exact = Sx === 1 && Sy === 1;
      validation.exact = exact;
      const step = exact ? 1 : Math.max(1, Math.ceil(sp.frames.length / 150));
      let mism = 0, psSum = 0, psMin = 99, cnt = 0, worst = '';
      for (let i = 0; i < sp.frames.length && validation.errors.length < 5; i += step) {
        const f = sp.frames[i], nf = newSp.frames[i];
        let A = composeFrame(img, f, f.fw, f.fh);
        const B = composeFrame(newImg, nf, nf.fw, nf.fh);
        if (exact) {
          if (nf.fw !== f.fw || nf.fh !== f.fh) { validation.errors.push(FNF.t('pl.val.virtual', { name: f.name })); continue; }
          let bad = 0;
          for (let k = 0; k < A.length; k += 4) {
            const a1 = A[k + 3], a2 = B[k + 3];
            if (a1 !== a2 || (a1 !== 0 && (A[k] !== B[k] || A[k + 1] !== B[k + 1] || A[k + 2] !== B[k + 2]))) bad++;
          }
          if (bad) { mism += bad; if (!worst) worst = f.name; }
          if (lossy) { const m = psnrAndDiff(A, B); psSum += m.psnr; psMin = Math.min(psMin, m.psnr); }
        } else {
          A = FNF.resizeRGBA(A, f.fw, f.fh, nf.fw, nf.fh, 'area');
          const m = psnrAndDiff(A, B);
          psSum += m.psnr; if (m.psnr < psMin) { psMin = m.psnr; worst = f.name; }
        }
        cnt++;
      }
      validation.frames = cnt;
      if (exact && !lossy) {
        if (mism > 0) validation.errors.push(FNF.t('pl.val.diff', { n: mism, name: worst }));
      } else {
        validation.psnrMin = psMin; validation.psnrAvg = cnt ? psSum / cnt : 99;
        if (psMin < 28) validation.warnings.push(FNF.t('pl.val.psnr', { psnr: psMin.toFixed(1), frame: worst ? FNF.t('pl.val.psnrframe', { frame: worst }) : '' }));
      }
      validation.ok = validation.errors.length === 0;
    }

    await P(FNF.t('pl.stage.done'), 100);
    return {
      name: input.name, dir: input.dir || '', outName: outBase, pngName, xmlName,
      pngBytes: enc.bytes, xmlText, atlas: { w: W, h: H },
      Sx, Sy, seff: Math.sqrt(Sx * Sy), scale: o.scale, auto: autoMode && !o.forceScale,
      ref: { fw0: refDims[0], fh0: refDims[1], fw1: Math.max(1, Math.round(refDims[0] * Sx)), fh1: Math.max(1, Math.round(refDims[1] * Sy)) },
      stats, validation, warnings, ms: Math.round(now() - t0),
    };
  }

  // ---------------------------------------------------------------- lote (atlas + configs)
  function configAtlasRefs(cfg) {
    let j;
    try { j = JSON.parse(cfg.text.charCodeAt(0) === 0xfeff ? cfg.text.slice(1) : cfg.text); } catch (e) { return []; }
    const base = (s) => FNF.baseOf(String(s).trim());
    if (cfg.kind === 'psych') return typeof j.image === 'string' ? j.image.split(',').map(base) : [];
    const refs = [];
    if (typeof j.imagePath === 'string') refs.push(base(j.imagePath));
    if (Array.isArray(j.extraSheets)) for (const s of j.extraSheets) if (typeof s === 'string') refs.push(base(s));
    return refs;
  }

  const fmtNum = (x) => String(Number(x.toFixed(4)));

  async function runBatch(args) {
    const opts = Object.assign({}, DEFAULTS, args.opts || {});
    const atlases = args.atlases || [], configs = args.configs || [];
    const onProgress = args.onProgress;
    const byName = new Map(atlases.map((a) => [a.name.toLowerCase(), a]));
    const problems = [];
    const primaryOf = new Map(); // atlas -> atlas primário (mesma escala efetiva)
    const cfgPrimary = new Map();
    for (const c of configs) {
      const refs = configAtlasRefs(c).map((r) => r.toLowerCase());
      const found = refs.map((r) => byName.get(r)).filter(Boolean);
      for (const r of refs) if (!byName.has(r)) problems.push({ level: 'warn', msg: FNF.t('pl.prob.cfgmissing', { cfg: c.name, atlas: r }) });
      if (found.length) {
        cfgPrimary.set(c, found[0]);
        for (const x of found.slice(1)) if (x !== found[0] && !primaryOf.has(x)) primaryOf.set(x, found[0]);
      } else {
        cfgPrimary.set(c, atlases[0] || null);
        if (atlases.length) problems.push({ level: 'warn', msg: FNF.t('pl.prob.noprimary', { cfg: c.name, used: atlases[0].name }) });
      }
    }
    // primários/independentes primeiro, dependentes depois
    const order = atlases.filter((a) => !primaryOf.has(a)).concat(atlases.filter((a) => primaryOf.has(a)));
    const results = new Map();
    let i = 0;
    for (const a of order) {
      const idx = i++;
      const prim = primaryOf.get(a);
      const forceScale = prim && results.get(prim) ? { Sx: results.get(prim).Sx, Sy: results.get(prim).Sy } : undefined;
      const res = await optimizeAtlas(a, Object.assign({}, opts, { forceScale }), async (stage, pct) => {
        if (onProgress) await onProgress(a.name + ' — ' + stage, (idx * 100 + pct) / order.length);
      });
      results.set(a, res);
    }

    const processed = new Set(atlases.map((a) => a.name.toLowerCase()));
    const rename = opts.suffix ? (b) => (processed.has(b.toLowerCase()) ? b + opts.suffix : b) : null;
    const cfgOut = [];
    for (const c of configs) {
      const prim = cfgPrimary.get(c);
      const pr = prim && results.get(prim);
      const seff = pr ? pr.seff : 1;
      const invScale = 1 / seff;
      const noScale = Math.abs(invScale - 1) < 1e-9;
      const shift = opts.adjustOffsets && pr && pr.ref && !noScale ? { dx: (pr.ref.fw1 - pr.ref.fw0) / 2, dy: (pr.ref.fh1 - pr.ref.fh0) / 2 } : null;
      const copts = { invScale: noScale ? 1 : invScale, rename, addScaleField: opts.addScaleField, skipScale: noScale, offsetShift: shift };
      const r = c.kind === 'psych' ? FNF.adjustPsychConfig(c.text, copts) : FNF.adjustLeatherConfig(c.text, copts);
      {
        // avisa sobre animações do config cujos frames foram todos removidos
        let j = null; try { j = JSON.parse(c.text.replace(/^\uFEFF/, '')); } catch (e) { /* ignorado */ }
        const anims = j && Array.isArray(j.animations) ? j.animations : [];
        for (const at of atlases) {
          if (!at.removeNames || !at.removeNames.length) continue;
          const rm = new Set(at.removeNames), all = FNF.parseSparrow(at.xmlText).frames.map((f) => f.name);
          for (const a of anims) {
            const key = c.kind === 'psych' ? a.name : a.animation_name;
            if (typeof key !== 'string' || !key) continue;
            const mine = all.filter((n) => n.startsWith(key));
            if (mine.length && mine.every((n) => rm.has(n))) r.warnings.push(FNF.t('pl.warn.animgone', { name: c.kind === 'psych' ? (a.anim || key) : (a.name || key) }));
          }
        }
      }
      const out = {
        name: c.name, dir: c.dir, kind: c.kind, primary: prim ? prim.name : null, invScale,
        shift: shift && (shift.dx || shift.dy) ? shift : null,
        changes: r.changes, warnings: r.warnings,
        before: c.text, text: r.text,
        bytes: r.text === c.text ? c.bytes : FNF.textEncode(r.text),
        offsets: null,
      };
      if (c.offsets) {
        let t = c.offsets.text, ch = [];
        if (shift && c.kind === 'leather' && r.scaled) { const so = FNF.shiftOffsetsText(t, shift.dx, shift.dy); t = so.text; ch = so.changes; }
        else if (opts.scaleOffsets && !noScale) { const so = FNF.scaleOffsetsText(t, seff); t = so.text; ch = so.changes; }
        out.offsets = { name: c.offsets.name, before: c.offsets.text, text: t, changes: ch, bytes: t === c.offsets.text ? c.offsets.bytes : FNF.textEncode(t) };
      }
      cfgOut.push(out);
    }
    return { results: atlases.map((a) => results.get(a)), configs: cfgOut, problems, opts, scaleNote: fmtNum(1) };
  }

  // ---------------------------------------------------------------- saída
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  const delta = (a, b) => { const d = a ? Math.round((b / a - 1) * 100) : 0; return (d > 0 ? '+' : '') + d + '%'; };

  function buildReportText(batch) {
    const L = [FNF.t('rep.title'), ''];
    for (const r of batch.results) {
      const s = r.stats;
      L.push(FNF.t('rep.atlas', { name: r.name, scale: r.scale + (r.auto ? ' (auto)' : ''), eff: r.seff.toFixed(4) }));
      L.push('  PNG: ' + kb(s.pngBefore) + ' → ' + kb(s.pngAfter) + ' (' + delta(s.pngBefore, s.pngAfter) + ')  [' + s.pngKind + ']');
      L.push('  XML: ' + kb(s.xmlBefore) + ' → ' + kb(s.xmlAfter) + ' (' + delta(s.xmlBefore, s.xmlAfter) + ')');
      L.push(FNF.t('rep.atlasdim', { a: s.atlasBefore.w + '×' + s.atlasBefore.h, b: s.atlasAfter.w + '×' + s.atlasAfter.h }));
      L.push(FNF.t('rep.frames', { total: s.framesTotal, unique: s.framesUnique, dup: s.framesDuplicated }));
      L.push(FNF.t('rep.valid', { state: FNF.t(r.validation.ok ? 'rep.ok' : 'rep.failed'), psnr: r.validation.psnrMin != null ? FNF.t('rep.psnr', { v: r.validation.psnrMin.toFixed(1) }) : '', ms: r.ms }));
      for (const w of r.warnings.concat(r.validation.warnings)) L.push('  ' + FNF.t('rep.warn') + w);
      for (const e of r.validation.errors) L.push('  ' + FNF.t('rep.error') + e);
      L.push('');
    }
    for (const c of batch.configs) {
      L.push(FNF.t('rep.config', { kind: c.kind, name: c.name, atlas: c.primary || '?', factor: c.invScale.toFixed(4) }));
      for (const ch of c.changes) L.push('  ' + ch.field + ': ' + ch.before + ' → ' + ch.after);
      if (c.offsets) for (const ch of c.offsets.changes) L.push('  ' + c.offsets.name + ' · ' + ch.field + ': ' + ch.before + ' → ' + ch.after);
      for (const w of c.warnings) L.push('  ' + FNF.t('rep.warn') + w);
      L.push('');
    }
    for (const p of batch.problems) L.push((p.level === 'warn' ? FNF.t('rep.warn') : '') + p.msg);
    return L.join('\n');
  }

  /** Lista de arquivos para o ZIP. */
  function collectOutputs(batch) {
    const files = [];
    for (const r of batch.results) {
      files.push({ path: r.dir + r.pngName, data: r.pngBytes, deflate: false });
      files.push({ path: r.dir + r.xmlName, data: FNF.textEncode(r.xmlText), deflate: true });
    }
    for (const c of batch.configs) {
      files.push({ path: c.dir + c.name, data: c.bytes, deflate: true });
      if (c.offsets) files.push({ path: c.dir + c.offsets.name, data: c.offsets.bytes, deflate: true });
    }
    files.push({ path: 'report.txt', data: FNF.textEncode(buildReportText(batch)), deflate: true });
    return files;
  }

  Object.assign(FNF, { DEFAULTS, delta, configAtlasRefs, optimizeAtlas, runBatch, buildReportText, collectOutputs, composeFrame });
})(typeof self !== 'undefined' ? self : globalThis);
