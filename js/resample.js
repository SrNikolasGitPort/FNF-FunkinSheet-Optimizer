/* resample.js — redimensionamento de alta qualidade em alpha pré-multiplicado (área / bilinear / Lanczos3),
 * com "janela": cada pixel de destino cobre um intervalo exato do frame virtual, então o resultado fica
 * alinhado em subpixel (sem esticar o conteúdo para caber em um retângulo arredondado). */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});

  function lanczos(x) {
    if (x === 0) return 1;
    if (x <= -3 || x >= 3) return 0;
    const px = Math.PI * x;
    return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
  }

  /* Pixel de destino i corresponde ao índice absoluto X = dst0 + i, que cobre o intervalo
   * [X/S − p, (X+1)/S − p) em coordenadas do bitmap de origem (p = posição do bitmap no frame virtual).
   * O que cai fora do bitmap conta como transparente (peso entra na soma, sem contribuição de cor). */
  function makeWeights(srcLen, dst0, dstLen, S, p, kind) {
    const inv = 1 / S, fscale = Math.max(inv, 1);
    const starts = new Int32Array(dstLen), counts = new Int32Array(dstLen), offs = new Int32Array(dstLen);
    const list = [];
    for (let i = 0; i < dstLen; i++) {
      const X = dst0 + i;
      const a = X * inv - p, b = a + inv;
      const js = [], ws = [];
      let total = 0;
      if (kind === 'area') {
        for (let j = Math.floor(a); j < Math.ceil(b); j++) {
          const w = Math.max(0, Math.min(b, j + 1) - Math.max(a, j));
          total += w;
          if (j >= 0 && j < srcLen && w > 0) { js.push(j); ws.push(w); }
        }
      } else {
        const c = (a + b) / 2, radius = (kind === 'lanczos' ? 3 : 1) * fscale;
        for (let j = Math.floor(c - radius); j < Math.ceil(c + radius); j++) {
          const d = (j + 0.5 - c) / fscale;
          const w = kind === 'lanczos' ? lanczos(d) : Math.max(0, 1 - Math.abs(d));
          total += w;
          if (j >= 0 && j < srcLen && w !== 0) { js.push(j); ws.push(w); }
        }
      }
      if (!(total > 0)) total = 1;
      starts[i] = js.length ? js[0] : 0;
      counts[i] = js.length;
      offs[i] = list.length;
      // índices contíguos: preenche lacunas (não ocorrem na prática) com peso 0
      for (let k = 0; k < js.length; k++) list.push(ws[k] / total);
    }
    return { starts, counts, offs, w: Float32Array.from(list) };
  }

  /** Redimensiona uma janela. src: RGBA não pré-multiplicado (sw×sh); destino: dw×dh a partir do pixel (x0,y0)
   *  da grade escalada (Sx,Sy); (px,py) = posição do bitmap no frame virtual de origem. */
  function resizeWindow(src, sw, sh, x0, y0, dw, dh, Sx, Sy, px, py, kind) {
    kind = kind || 'area';
    const wx = makeWeights(sw, x0, dw, Sx, px, kind), wy = makeWeights(sh, y0, dh, Sy, py, kind);
    const tmp = new Float32Array(dw * sh * 4);
    for (let y = 0; y < sh; y++) {
      const row = y * sw * 4, trow = y * dw * 4;
      for (let x = 0; x < dw; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        const s = wx.starts[x], n = wx.counts[x], o = wx.offs[x];
        for (let k = 0; k < n; k++) {
          const p = row + (s + k) * 4;
          const al = src[p + 3];
          const w = wx.w[o + k];
          const wa = (w * al) / 255;
          r += src[p] * wa; g += src[p + 1] * wa; b += src[p + 2] * wa; a += w * al;
        }
        const t = trow + x * 4;
        tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b; tmp[t + 3] = a;
      }
    }
    const out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const s = wy.starts[y], n = wy.counts[y], o = wy.offs[y];
      for (let x = 0; x < dw; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < n; k++) {
          const p = ((s + k) * dw + x) * 4;
          const w = wy.w[o + k];
          r += tmp[p] * w; g += tmp[p + 1] * w; b += tmp[p + 2] * w; a += tmp[p + 3] * w;
        }
        const q = (y * dw + x) * 4;
        const al = a < 0 ? 0 : a > 255 ? 255 : a;
        const ai = Math.round(al);
        if (ai > 0) {
          const k = 255 / al;
          const cl = (v) => { v = Math.round(v * k); return v < 0 ? 0 : v > 255 ? 255 : v; };
          out[q] = cl(r); out[q + 1] = cl(g); out[q + 2] = cl(b); out[q + 3] = ai;
        }
      }
    }
    return out;
  }

  /** Redimensiona a imagem inteira de sw×sh para dw×dh. */
  function resizeRGBA(src, sw, sh, dw, dh, kind) {
    if (sw === dw && sh === dh) return src.slice();
    return resizeWindow(src, sw, sh, 0, 0, dw, dh, dw / sw, dh / sh, 0, 0, kind);
  }

  Object.assign(FNF, { resizeRGBA, resizeWindow });
})(typeof self !== 'undefined' ? self : globalThis);
