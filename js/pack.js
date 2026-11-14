/* pack.js — empacotador MaxRects (BSSF) com busca do menor atlas possível. */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});

  class MaxRects {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.free = [{ x: 0, y: 0, w: W, h: H }];
    }
    // mode: 0 = BSSF (menor sobra curta), 1 = BAF (menor área livre), 2 = Bottom-Left
    find(w, h, mode) {
      let best = null, bs = Infinity, bl = Infinity;
      for (const f of this.free) {
        if (f.w >= w && f.h >= h) {
          let a, b;
          if (mode === 1) { a = f.w * f.h - w * h; b = Math.min(f.w - w, f.h - h); }
          else if (mode === 2) { a = f.y + h; b = f.x; }
          else { a = Math.min(f.w - w, f.h - h); b = Math.max(f.w - w, f.h - h); }
          if (a < bs || (a === bs && b < bl)) { bs = a; bl = b; best = f; }
        }
      }
      return best;
    }
    place(w, h, mode) {
      const f = this.find(w, h, mode || 0);
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
  function packInto(rects, W, H, mode) {
    const mr = new MaxRects(W, H);
    const pl = new Map();
    let usedW = 0, usedH = 0;
    for (const r of rects) {
      const p = mr.place(r.w, r.h, mode);
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
    const orders = [
      (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h,
      (a, b) => b.w * b.h - a.w * a.h,
      (a, b) => b.h - a.h || b.w - a.w,
      (a, b) => b.w - a.w || b.h - a.h,
      (a, b) => (b.w + b.h) - (a.w + a.h) || b.w * b.h - a.w * a.h,
    ].map((c) => rects.slice().sort(c));
    // orçamento de tempo: muitos retângulos => menos combinações
    const combos = [];
    const modes = rects.length > 3000 ? [0] : [0, 1, 2];
    const ords = rects.length > 3000 ? [0, 1] : orders.map((_, i) => i);
    for (const oi of ords) for (const m of modes) combos.push([oi, m]);
    const t0 = Date.now(), budget = opts.budgetMs || 2000;
    const over = () => Date.now() - t0 > budget;
    // melhor empacotamento em W×H (altura livre = H) -> menor área usada
    const tryWidth = (W, H, first) => {
      let res = null;
      for (const [oi, m] of combos) {
        if (res && over()) break;
        const r = packInto(orders[oi], W, H, m);
        if (!r) continue;
        const area = r.usedW * r.usedH;
        if (!res || area < res.area) res = { placements: r.placements, width: r.usedW, height: r.usedH, area };
        if (first) return res;
      }
      return res;
    };
    let best = null;
    if (opts.pow2) {
      const sizes = [];
      for (let w = nextPow2(Math.max(16, maxW)); w <= maxSize; w <<= 1) {
        for (let h = nextPow2(Math.max(16, maxH)); h <= maxSize; h <<= 1) if (w * h >= total) sizes.push([w, h]);
      }
      sizes.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
      for (const [w, h] of sizes) {
        const r = tryWidth(w, h, true);
        if (r) { best = { placements: r.placements, width: w, height: h }; break; }
      }
    } else {
      const base = Math.sqrt(total);
      const lo = Math.max(maxW, Math.floor(base));
      const hi = Math.min(maxSize, Math.max(lo + 1, Math.ceil(base * 1.9)));
      const consider = (w) => {
        if (w < maxW || w > maxSize) return;
        const r = tryWidth(w, maxSize, false);
        if (!r) return;
        const ratio = Math.max(r.width, r.height) / Math.min(r.width, r.height);
        if (!best || r.area < best.area || (r.area === best.area && ratio < best.ratio)) best = Object.assign(r, { ratio });
      };
      const seen = new Set();
      const tryW = (w) => { w = Math.round(w); if (!seen.has(w)) { seen.add(w); consider(w); } };
      // varredura grossa
      const steps = rects.length > 3000 ? 8 : 16;
      for (let i = 0; i <= steps; i++) tryW(lo + ((hi - lo) * i) / steps);
      tryW(Math.ceil(base * 1.05));
      // refinamento: busca local ao redor do melhor, com passos cada vez menores
      let span = (hi - lo) / steps;
      for (let round = 0; round < 5 && best && !over() && span >= 1; round++) {
        const c = best.width;
        for (let k = -3; k <= 3; k++) tryW(c + (k * span) / 3);
        span /= 3;
      }
    }
    if (!best) throw new Error('Os frames não cabem em um atlas de ' + maxSize + '×' + maxSize + ' px. Reduza a escala ou aumente o tamanho máximo.');
    return best;
  }

  Object.assign(FNF, { planAtlas });
})(typeof self !== 'undefined' ? self : globalThis);
