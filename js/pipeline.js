/* pipeline.js — pipeline de otimização de um atlas Sparrow e processamento em lote com configs de personagem.
 * Ordem: limpar → trim → dedup → resize → re-trim → re-dedup → empacotar → PNG/XML → validar. */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const DEFAULTS = {
    scale: 1,               // 0.1 … 1
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
    maxSize: 8192,
    pngMode: 'auto',        // auto (paleta exata se couber) | rgba | quantize
    colors: 256,
    dither: false,
    suffix: '',
    validate: true,
    scaleOffsets: false,    // Leather: multiplica offsets.txt por S (avançado)
    addScaleField: false,   // Leather: adiciona "scale" se o config não tiver
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
    const x0 = Math.max(0, -ox), x1 = Math.min(f.w, fw - ox);
    if (x1 <= x0) return out;
    for (let yy = 0; yy < f.h; yy++) {
      const dy = oy + yy;
      if (dy < 0 || dy >= fh) continue;
      const s = ((f.y + yy) * img.width + f.x + x0) * 4;
      out.set(img.data.subarray(s, s + (x1 - x0) * 4), (dy * fw + ox + x0) * 4);
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
    o.scale = Math.min(1, Math.max(0.1, Number(o.scale) || 1));
    const P = async (stage, pct) => { if (progress) await progress(stage, pct); };
    const warnings = [];

    await P('Lendo PNG e XML', 0);
    const img = await FNF.decodePNG(input.pngBytes);
    const sp = FNF.parseSparrow(input.xmlText);
    warnings.push(...img.warnings, ...sp.warnings);
    for (const f of sp.frames) {
      if (f.rotated) throw new Error('O frame "' + f.name + '" é rotacionado (rotated="true"). Atlas com frames rotacionados ainda não são suportados: reexporte sem rotação.');
      if (f.w <= 0 || f.h <= 0) throw new Error('O frame "' + f.name + '" tem largura/altura zero.');
      if (f.x < 0 || f.y < 0 || f.x + f.w > img.width || f.y + f.h > img.height) {
        throw new Error('O frame "' + f.name + '" (' + f.x + ',' + f.y + ' ' + f.w + '×' + f.h + ') está fora dos limites do PNG (' + img.width + '×' + img.height + ').');
      }
    }

    // entradas: cada frame com seu bitmap e a posição do bitmap dentro do frame virtual
    const regionCache = new Map();
    let pixelsBefore = 0;
    const entries = sp.frames.map((f) => {
      const k = f.x + ',' + f.y + ',' + f.w + ',' + f.h;
      let bmp = regionCache.get(k);
      if (!bmp) {
        bmp = { w: f.w, h: f.h, data: extract(img, f) };
        regionCache.set(k, bmp);
        pixelsBefore += f.w * f.h;
      }
      return { name: f.name, bmp, px: 0 - f.fx, py: 0 - f.fy, fw: f.fw, fh: f.fh };
    });
    const total = entries.length;
    const thr = Math.max(0, Math.min(254, o.alphaThreshold | 0));
    const lossy = (thr > 0 && (o.trim || o.aggressive)) || o.nearDedup || o.pngMode === 'quantize';

    await P('Limpando pixels invisíveis', 8);
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

    await P('Corte inteligente', 15);
    if (o.trim) trimEntries(entries, thr);

    await P('Deduplicando frames', 25);
    let uniqueAfterTrim = new Set(entries.map((e) => e.bmp)).size;
    if (o.dedup) uniqueAfterTrim = dedupe(entries, o.nearDedup ? o.nearTolerance : 0);

    // escala efetiva (compensa o arredondamento do tamanho do frame virtual)
    let Sx = 1, Sy = 1;
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
        if (++done % 25 === 0) await P('Redimensionando (' + Math.round(o.scale * 100) + '%)', 30 + (30 * done) / total);
      }
      await P('Cortando e deduplicando novamente', 62);
      if (o.trim) trimEntries(entries, thr);
      if (o.dedup) dedupe(entries, 0);
    }
    const uniq = [...new Set(entries.map((e) => e.bmp))];

    await P('Empacotando atlas', 68);
    const ex = Math.max(0, o.extrude | 0), pad = Math.max(0, o.padding | 0);
    const rects = uniq.map((b, i) => { b.pid = i; return { id: i, w: b.w + 2 * ex + pad, h: b.h + 2 * ex + pad }; });
    const plan = FNF.planAtlas(rects, { pow2: o.pow2, maxSize: o.maxSize });
    const W = o.pow2 ? plan.width : Math.max(1, plan.width - pad);
    const H = o.pow2 ? plan.height : Math.max(1, plan.height - pad);
    if (Math.max(W, H) > 4096) warnings.push('O atlas ficou com ' + W + '×' + H + ' px: acima de 4096 px, GPUs de celulares fracos podem falhar. Considere reduzir a escala.');
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

    await P('Gerando PNG', 78);
    const enc = await FNF.encodePNG(atlas, W, H, { mode: o.pngMode, colors: o.colors, dither: o.dither });
    const outBase = input.name + (o.suffix || '');
    const pngName = outBase + '.png', xmlName = outBase + '.xml';
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
    if (stats.pngAfter > stats.pngBefore) warnings.push('O PNG de saída ficou maior que o original (' + stats.pngAfter + ' > ' + stats.pngBefore + ' bytes). Tente "PNG-8 quantizado" ou reduzir a escala.');

    // ------------------------------------------------------------ validação
    const validation = { ok: true, errors: [], warnings: [], psnrMin: null, psnrAvg: null, frames: 0, exact: null, lossy };
    if (o.validate) {
      await P('Validando resultado', 86);
      const newImg = await FNF.decodePNG(enc.bytes);
      const newSp = FNF.parseSparrow(xmlText);
      if (newSp.frames.length !== sp.frames.length) validation.errors.push('Quantidade de frames diferente do original.');
      for (let i = 0; i < Math.min(newSp.frames.length, sp.frames.length); i++) {
        if (newSp.frames[i].name !== sp.frames[i].name) { validation.errors.push('Nome/ordem de frame divergente: "' + sp.frames[i].name + '".'); break; }
      }
      const regs = new Map();
      for (const f of newSp.frames) {
        if (f.x < 0 || f.y < 0 || f.x + f.w > newImg.width || f.y + f.h > newImg.height) { validation.errors.push('SubTexture "' + f.name + '" fora do PNG final.'); break; }
        regs.set(f.x + ',' + f.y + ',' + f.w + ',' + f.h, f);
      }
      const rl = [...regs.values()];
      if (rl.length <= 3000) {
        outer: for (let i = 0; i < rl.length; i++) {
          for (let j = i + 1; j < rl.length; j++) {
            const a = rl[i], b = rl[j];
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
              validation.errors.push('Regiões sobrepostas no atlas: "' + a.name + '" e "' + b.name + '".');
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
          if (nf.fw !== f.fw || nf.fh !== f.fh) { validation.errors.push('Tamanho do frame virtual mudou em "' + f.name + '".'); continue; }
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
        if (mism > 0) validation.errors.push('Diferença de pixels em relação ao original (' + mism + ' pixels, primeiro frame: "' + worst + '"). Resultado deveria ser idêntico.');
      } else {
        validation.psnrMin = psMin; validation.psnrAvg = cnt ? psSum / cnt : 99;
        if (psMin < 28) validation.warnings.push('PSNR mínimo de ' + psMin.toFixed(1) + ' dB' + (worst ? ' (frame "' + worst + '")' : '') + ': há perda visível nesse frame.');
      }
      validation.ok = validation.errors.length === 0;
    }

    await P('Concluído', 100);
    return {
      name: input.name, dir: input.dir || '', outName: outBase, pngName, xmlName,
      pngBytes: enc.bytes, xmlText, atlas: { w: W, h: H },
      Sx, Sy, seff: Math.sqrt(Sx * Sy), scale: o.scale,
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
      for (const r of refs) if (!byName.has(r)) problems.push({ level: 'warn', msg: 'O config "' + c.name + '" cita o atlas "' + r + '", que não foi enviado.' });
      if (found.length) {
        cfgPrimary.set(c, found[0]);
        for (const x of found.slice(1)) if (x !== found[0] && !primaryOf.has(x)) primaryOf.set(x, found[0]);
      } else {
        cfgPrimary.set(c, atlases[0] || null);
        if (atlases.length) problems.push({ level: 'warn', msg: 'Não achei o atlas principal do config "' + c.name + '"; usei "' + atlases[0].name + '" para calcular a escala.' });
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
      const copts = { invScale: noScale ? 1 : invScale, rename, addScaleField: opts.addScaleField, skipScale: noScale };
      const r = c.kind === 'psych' ? FNF.adjustPsychConfig(c.text, copts) : FNF.adjustLeatherConfig(c.text, copts);
      const out = {
        name: c.name, dir: c.dir, kind: c.kind, primary: prim ? prim.name : null, invScale,
        changes: r.changes, warnings: r.warnings,
        before: c.text, text: r.text,
        bytes: r.text === c.text ? c.bytes : FNF.textEncode(r.text),
        offsets: null,
      };
      if (c.offsets) {
        let t = c.offsets.text, ch = [];
        if (opts.scaleOffsets && !noScale) { const so = FNF.scaleOffsetsText(t, seff); t = so.text; ch = so.changes; }
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
    const L = ['RELATÓRIO — FNF FunkinSheet Optimizer', ''];
    for (const r of batch.results) {
      const s = r.stats;
      L.push('Atlas: ' + r.name + '  (escala ' + r.scale + ', escala efetiva ' + r.seff.toFixed(4) + ')');
      L.push('  PNG: ' + kb(s.pngBefore) + ' → ' + kb(s.pngAfter) + ' (' + delta(s.pngBefore, s.pngAfter) + ')  [' + s.pngKind + ']');
      L.push('  XML: ' + kb(s.xmlBefore) + ' → ' + kb(s.xmlAfter) + ' (' + delta(s.xmlBefore, s.xmlAfter) + ')');
      L.push('  Atlas: ' + s.atlasBefore.w + '×' + s.atlasBefore.h + ' → ' + s.atlasAfter.w + '×' + s.atlasAfter.h);
      L.push('  Frames: ' + s.framesTotal + ' total, ' + s.framesUnique + ' únicos, ' + s.framesDuplicated + ' duplicados');
      L.push('  Validação: ' + (r.validation.ok ? 'OK' : 'FALHOU') + (r.validation.psnrMin != null ? ' (PSNR mín. ' + r.validation.psnrMin.toFixed(1) + ' dB)' : '') + ', ' + r.ms + ' ms');
      for (const w of r.warnings.concat(r.validation.warnings)) L.push('  Aviso: ' + w);
      for (const e of r.validation.errors) L.push('  ERRO: ' + e);
      L.push('');
    }
    for (const c of batch.configs) {
      L.push('Config (' + c.kind + '): ' + c.name + '  → primário: ' + (c.primary || '?') + ', fator ' + c.invScale.toFixed(4));
      for (const ch of c.changes) L.push('  ' + ch.field + ': ' + ch.before + ' → ' + ch.after);
      for (const w of c.warnings) L.push('  Aviso: ' + w);
      L.push('');
    }
    for (const p of batch.problems) L.push((p.level === 'warn' ? 'Aviso: ' : '') + p.msg);
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
    files.push({ path: 'relatorio.txt', data: FNF.textEncode(buildReportText(batch)), deflate: true });
    return files;
  }

  Object.assign(FNF, { DEFAULTS, delta, configAtlasRefs, optimizeAtlas, runBatch, buildReportText, collectOutputs, composeFrame });
})(typeof self !== 'undefined' ? self : globalThis);
