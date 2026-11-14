/* compress.js — compressão de imagens (PNG / WebP / JPEG / ASTC) priorizando leveza com qualidade medida (PSNR). */
(function (root) {
  'use strict';
  const FNF = (root.FNF = root.FNF || {});
  const TARGET = { high: 44, balanced: 38, small: 33 };

  function psnrPremult(A, B) {
    let se = 0;
    for (let i = 0; i < A.length; i += 4) {
      const a1 = A[i + 3], a2 = B[i + 3], da = a1 - a2;
      se += da * da;
      for (let c = 0; c < 3; c++) { const d = (A[i + c] * a1) / 255 - (B[i + c] * a2) / 255; se += d * d; }
    }
    const mse = se / A.length;
    return mse === 0 ? 99 : 10 * Math.log10(65025 / mse);
  }

  const isAstc = (b) => b.length > 16 && b[0] === 0x13 && b[1] === 0xab && b[2] === 0xa1 && b[3] === 0x5c;
  const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50;

  function canvasFor(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  async function decodeBrowser(bytes) {
    if (typeof createImageBitmap === 'undefined') throw new Error(FNF.t('cmp.err.nobrowser'));
    const bmp = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = canvasFor(bmp.width, bmp.height), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: bmp.width, height: bmp.height, data: new Uint8Array(d.data.buffer) };
  }
  async function decodeAny(bytes) {
    if (isAstc(bytes)) { const r = FNF.decodeASTC(bytes); return { width: r.width, height: r.height, data: r.data, kind: 'astc' }; }
    if (isPng(bytes)) { const r = await FNF.decodePNG(bytes); return { width: r.width, height: r.height, data: r.data, kind: 'png' }; }
    const r = await decodeBrowser(bytes); r.kind = 'browser'; return r;
  }
  async function browserEncode(rgba, w, h, mime, q) {
    const c = canvasFor(w, h), ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)), w, h), 0, 0);
    const blob = c.convertToBlob ? await c.convertToBlob({ type: mime, quality: q }) : await new Promise((res) => c.toBlob(res, mime, q));
    if (!blob || blob.type !== mime) throw new Error(FNF.t('cmp.err.format', { mime }));
    return new Uint8Array(await blob.arrayBuffer());
  }

  const hasAlpha = (d) => { for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true; return false; };

  async function pngSmart(img, level, onStep) {
    const { width: w, height: h, data } = img;
    const base = await FNF.encodePNG(data, w, h, { mode: 'auto' });
    let best = { bytes: base.bytes, kind: base.kind, psnr: 99 };
    if (level === 'lossless' || /PNG-8|palette|paleta/i.test(base.kind) && base.kind.indexOf('RGBA') < 0) return best;
    const target = TARGET[level] || 38, list = [16, 24, 32, 48, 64, 96, 128, 192, 256];
    const big = w * h > 4e6;
    for (const dither of big ? [false] : [false, true]) {
      let lo = 0, hi = list.length - 1, found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (onStep) await onStep();
        const enc = await FNF.encodePNG(data, w, h, { mode: 'quantize', colors: list[mid], dither });
        const dec = await FNF.decodePNG(enc.bytes);
        const p = psnrPremult(data, dec.data);
        if (p >= target) { found = { bytes: enc.bytes, kind: enc.kind, psnr: p }; hi = mid - 1; } else lo = mid + 1;
      }
      if (found && found.bytes.length < best.bytes.length) best = found;
    }
    return best;
  }

  async function astcSmart(img, level, block, onStep) {
    const { width: w, height: h, data } = img;
    const target = TARGET[level] || 38;
    const tries = block && block !== 'auto' ? [block] : level === 'small' ? ['10x10', '8x8', '6x6', '5x5', '4x4'] : ['8x8', '6x6', '5x5', '4x4'];
    let last = null;
    for (const b of tries) {
      if (onStep) await onStep();
      const [bw, bh] = b.split('x').map(Number);
      const bytes = FNF.encodeASTC(data, w, h, { bw, bh });
      const p = psnrPremult(data, FNF.decodeASTC(bytes).data);
      last = { bytes, kind: 'ASTC ' + bw + '×' + bh, psnr: p };
      if (p >= target || (block && block !== 'auto')) return last;
    }
    return last;
  }

  async function lossySmart(img, mime, level, onStep) {
    const { width: w, height: h, data } = img, target = TARGET[level] || 38;
    let lo = 0.3, hi = 0.99, best = null;
    for (let i = 0; i < 7; i++) {
      if (onStep) await onStep();
      const q = (lo + hi) / 2, bytes = await browserEncode(data, w, h, mime, q);
      const dec = await decodeBrowser(bytes);
      const p = psnrPremult(data, dec.data);
      if (p >= target) { best = { bytes, kind: mime.split('/')[1].toUpperCase() + ' q' + Math.round(q * 100), psnr: p }; hi = q; } else lo = q;
    }
    return best || { bytes: await browserEncode(data, w, h, mime, 0.99), kind: mime.split('/')[1].toUpperCase() + ' q99', psnr: null };
  }

  /** input: {name, bytes}. opts: {format:'auto'|'png'|'webp'|'jpeg'|'astc', quality:'lossless'|'high'|'balanced'|'small', astcBlock} */
  async function compressImage(input, opts, onStep) {
    const o = Object.assign({ format: 'auto', quality: 'balanced', astcBlock: 'auto' }, opts || {});
    const img = await decodeAny(input.bytes);
    // pixels 100% transparentes não precisam de cor
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 0) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; }
    const warnings = [];
    let fmt = o.format;
    if (fmt === 'auto') fmt = img.kind === 'astc' ? 'astc' : img.kind === 'png' ? 'png' : (/\.webp$/i.test(input.name) ? 'webp' : 'jpeg');
    if (fmt === 'jpeg' && hasAlpha(d)) { warnings.push(FNF.t('cmp.warn.jpegalpha')); fmt = 'png'; }
    let r;
    if (fmt === 'png') r = await pngSmart(img, o.quality, onStep);
    else if (fmt === 'astc') r = await astcSmart(img, o.quality === 'lossless' ? 'high' : o.quality, o.astcBlock, onStep);
    else r = await lossySmart(img, fmt === 'webp' ? 'image/webp' : 'image/jpeg', o.quality === 'lossless' ? 'high' : o.quality, onStep);
    const ext = { png: 'png', astc: 'astc', webp: 'webp', jpeg: 'jpg' }[fmt];
    const base = input.name.replace(/\.[^.]+$/, '');
    let out = { name: base + '.' + ext, bytes: r.bytes, kind: r.kind, psnr: r.psnr, width: img.width, height: img.height, before: input.bytes.length, warnings, kept: false };
    // se não ficou menor no mesmo formato, mantém o original
    const sameFmt = (fmt === 'png' && img.kind === 'png') || (fmt === 'astc' && img.kind === 'astc') || (o.format === 'auto' && fmt !== 'astc' && fmt !== 'png');
    if (sameFmt && out.bytes.length >= input.bytes.length) {
      out = Object.assign(out, { name: input.name, bytes: input.bytes, kind: FNF.t('cmp.kept'), psnr: 99, kept: true });
    }
    return out;
  }

  FNF.compressImage = compressImage; FNF.psnrPremult = psnrPremult;
  if (typeof module !== 'undefined' && module.exports) module.exports = FNF;
})(typeof globalThis !== 'undefined' ? globalThis : this);
