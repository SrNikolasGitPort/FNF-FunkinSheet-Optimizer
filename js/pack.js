/* pack.js — empacotador MaxRects (BSSF) com busca do menor atlas possível. */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});

  class MaxRects {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.free = [{ x: 0, y: 0, w: W, h: H }];
    }
    find(w, h) {
      let best = null, bs = Infinity, bl = Infinity;
      for (const f of this.free) {
        if (f.w >= w && f.h >= h) {
          const lw = f.w - w, lh = f.h - h;
          const ss = Math.min(lw, lh), ls = Math.max(lw, lh);
          if (ss < bs || (ss === bs && ls < bl)) { bs = ss; bl = ls; best = f; }
        }
      }
      return best;
    }
    place(w, h) {
      const f = this.find(w, h);
      if (!f) return null;
      const p = { x: f.x, y: f.y, w, h };
      const kept = [], fresh = [];
      for (const r of this.free) {
        if (p.x >= r.x + r.w || p.x + p.w <= r.x || p.y >= r.y + r.h || p.y + p.h <= r.y) { kept.push(r); continue; }
        if (p.x > r.x) fresh.push({ x: r.x, y: r.y, w: p.x - r.x, h: r.h });
        if (p.x + p.w < r.x + r.w) fresh.push({ x: p.x + p.w, y: r.y, w: r.x + r.w - (p.x + p.w), h: r.h });
        if (p.y > r.y) fresh.push({ x: r.x, y: r.y, w: r.w, h: p.y - r.y });
        if (p.y + p.h < r.y + r.h) fresh.push({ x: r.x, y: p.y + p.h, w: r.w, h: r.y + r.h - (p.y + p.h) });
      }
      const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
      for (let i = 0; i < fresh.length; i++) {
        const a = fresh[i];
        if (a.w <= 0 || a.h <= 0) continue;
        let dead = false;
        for (const k of kept) if (inside(a, k)) { dead = true; break; }
        if (!dead) for (let j = 0; j < fresh.length && !dead; j++) {
          if (j !== i && fresh[j].w > 0 && inside(a, fresh[j]) && (!inside(fresh[j], a) || j < i)) dead = true;
        }
        if (!dead) kept.push(a);
      }
      this.free = kept;
      return p;
    }
  }

  // rects: [{id,w,h}] -> { placements:Map(id->{x,y}), usedW, usedH } ou null se não couber em W×H
  function packInto(rects, W, H) {
    const mr = new MaxRects(W, H);
    const pl = new Map();
    let usedW = 0, usedH = 0;
    for (const r of rects) {
      const p = mr.place(r.w, r.h);
      if (!p) return null;
      pl.set(r.id, { x: p.x, y: p.y });
      usedW = Math.max(usedW, p.x + r.w); usedH = Math.max(usedH, p.y + r.h);
    }
    return { placements: pl, usedW, usedH };
  }

  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  /** Procura o menor atlas. rects incluem o padding. opts: {pow2, maxSize}. Retorna {placements, width, height} */
  function planAtlas(rects, opts) {
    const maxSize = opts.maxSize || 32768;
    let total = 0, maxW = 0, maxH = 0;
    for (const r of rects) {
      total += r.w * r.h;
      maxW = Math.max(maxW, r.w); maxH = Math.max(maxH, r.h);
    }
    if (maxW > maxSize || maxH > maxSize) {
      throw new Error('Um frame (' + maxW + '×' + maxH + ') é maior que o tamanho máximo do atlas (' + maxSize + ' px).');
    }
    const sorted = rects.slice().sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
    let best = null;
    if (opts.pow2) {
      const sizes = [];
      for (let w = nextPow2(Math.max(16, maxW)); w <= maxSize; w <<= 1) {
        for (let h = nextPow2(Math.max(16, maxH)); h <= maxSize; h <<= 1) if (w * h >= total) sizes.push([w, h]);
      }
      sizes.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
      for (const [w, h] of sizes) {
        const r = packInto(sorted, w, h);
        if (r) { best = { placements: r.placements, width: w, height: h }; break; }
      }
    } else {
      const base = Math.sqrt(total);
      const lo = Math.max(maxW, Math.floor(base));
      const hi = Math.min(maxSize, Math.max(lo + 1, Math.ceil(base * 1.9)));
      const cands = new Set();
      const steps = 14;
      for (let i = 0; i <= steps; i++) cands.add(Math.round(lo + ((hi - lo) * i) / steps));
      cands.add(Math.min(maxSize, Math.max(maxW, Math.ceil(base * 1.05))));
      for (const w of cands) {
        const r = packInto(sorted, w, maxSize);
        if (!r) continue;
        const area = r.usedW * r.usedH;
        const ratio = Math.max(r.usedW, r.usedH) / Math.min(r.usedW, r.usedH);
        if (!best || area < best.area || (area === best.area && ratio < best.ratio)) {
          best = { placements: r.placements, width: r.usedW, height: r.usedH, area, ratio };
        }
      }
    }
    if (!best) throw new Error('Os frames não cabem em um atlas de ' + maxSize + '×' + maxSize + ' px. Reduza a escala ou aumente o tamanho máximo.');
    return best;
  }

  Object.assign(FNF, { planAtlas });
})(typeof self !== 'undefined' ? self : globalThis);
