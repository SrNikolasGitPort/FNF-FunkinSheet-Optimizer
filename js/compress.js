/* compress.js — compressão de imagens (PNG / ASTC) priorizando leveza com qualidade medida (PSNR). */
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

  async function decodeAny(bytes) {
    if (isAstc(bytes)) { const r = FNF.decodeASTC(bytes); return { width: r.width, height: r.height, data: r.data, kind: 'astc' }; }
    if (isPng(bytes)) { const r = await FNF.decodePNG(bytes); return { width: r.width, height: r.height, data: r.data, kind: 'png' }; }
    throw new Error(FNF.t('cmp.err.format'));
  }

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

  /** input: {name, bytes}. opts: {format:'auto'|'png'|'astc', quality:'lossless'|'high'|'balanced'|'small', astcBlock} */
  async function compressImage(input, opts, onStep) {
    const o = Object.assign({ format: 'auto', quality: 'balanced', astcBlock: 'auto' }, opts || {});
    const img = await decodeAny(input.bytes);
    // pixels 100% transparentes não precisam de cor
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 0) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; }
    const warnings = [];
    const fmt = o.format === 'astc' || o.format === 'png' ? o.format : img.kind;
    let r;
    if (fmt === 'png') r = await pngSmart(img, o.quality, onStep);
    else r = await astcSmart(img, o.quality === 'lossless' ? 'high' : o.quality, o.astcBlock, onStep);
    const ext = fmt;
    const base = input.name.replace(/\.[^.]+$/, '');
    let out = { name: base + '.' + ext, bytes: r.bytes, kind: r.kind, psnr: r.psnr, width: img.width, height: img.height, before: input.bytes.length, warnings, kept: false };
    // se não ficou menor no mesmo formato, mantém o original
    const sameFmt = (fmt === 'png' && img.kind === 'png') || (fmt === 'astc' && img.kind === 'astc');
    if (sameFmt && out.bytes.length >= input.bytes.length) {
      out = Object.assign(out, { name: input.name, bytes: input.bytes, kind: FNF.t('cmp.kept'), psnr: 99, kept: true });
    }
    return out;
  }

  FNF.compressImage = compressImage; FNF.psnrPremult = psnrPremult;
  if (typeof module !== 'undefined' && module.exports) module.exports = FNF;
})(typeof globalThis !== 'undefined' ? globalThis : this);
