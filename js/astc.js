/* ASTC (LDR, 2D) — leitor/gravador de arquivos .astc, sem dependências.
 * Decoder: blocos void-extent, 1 partição, plano simples/duplo, CEM LDR 0–13 (exceto HDR).
 * Encoder: 1 partição, CEM 8/12 (RGB/RGBA direto), busca de grade/quantização por bloco. */
(function (root) {
  'use strict';
  const FNF = (root.FNF = root.FNF || {});
  const LEVELS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192, 256];
  const QSTR = '000100200300400040440444010110210310410140441444020120220320420240442444030130230330430340443444001101201301401041404044011111211311411141414144021121221321421241424244031131231331431341434344002102202302402042204304012112212312412142214314022122222322422242224324032132232332432342234334003103203303403043004104013113213313413143014114023123223323423243024124033133233333433343034134';
  const QUINTS = []; for (let i = 0; i < 128; i++) QUINTS.push([+QSTR[i * 3], +QSTR[i * 3 + 1], +QSTR[i * 3 + 2]]);
  // trits: T (8 bits) -> t0..t4 (algoritmo da especificação)
  function tritsOf(T) {
    const b = (i) => (T >> i) & 1, f = (hi, lo) => (T >> lo) & ((1 << (hi - lo + 1)) - 1);
    let C, t4, t3;
    if (f(4, 2) === 7) { C = (f(7, 5) << 2) | f(1, 0); t4 = 2; t3 = 2; }
    else {
      C = f(4, 0);
      if (f(6, 5) === 3) { t4 = 2; t3 = b(7); } else { t4 = b(7); t3 = f(6, 5); }
    }
    let t2, t1, t0;
    const c = (hi, lo) => (C >> lo) & ((1 << (hi - lo + 1)) - 1);
    if (c(1, 0) === 3) { t2 = 2; t1 = c(4, 4); t0 = (c(3, 3) << 1) | (c(2, 2) & (c(3, 3) ^ 1)); }
    else if (c(3, 2) === 3) { t2 = 2; t1 = 2; t0 = c(1, 0); }
    else { t2 = c(4, 4); t1 = c(3, 2); t0 = (c(1, 1) << 1) | (c(0, 0) & (c(1, 1) ^ 1)); }
    return [t0, t1, t2, t3, t4];
  }
  const TRITS = []; const TRIT_INV = new Map();
  for (let T = 0; T < 256; T++) { const t = tritsOf(T); TRITS.push(t); const k = t.join(''); if (!TRIT_INV.has(k)) TRIT_INV.set(k, T); }
  const QUINT_INV = new Map(); QUINTS.forEach((q, i) => { const k = q.join(''); if (!QUINT_INV.has(k)) QUINT_INV.set(k, i); });

  function qkind(qi) { // {type:0 bits|1 trit|2 quint, k}
    const n = LEVELS[qi]; let k = 0, m = n;
    while (m % 2 === 0) { m >>= 1; k++; }
    return m === 1 ? { type: 0, k } : m === 3 ? { type: 1, k } : { type: 2, k };
  }
  const QK = LEVELS.map((_, i) => qkind(i));
  function iseBits(count, qi) {
    const q = QK[qi];
    if (q.type === 0) return count * q.k;
    if (q.type === 1) return Math.ceil((8 * count) / 5) + count * q.k;
    return Math.ceil((7 * count) / 3) + count * q.k;
  }
  const TCH = [2, 2, 1, 2, 1], QCH = [3, 2, 2];

  function getBits(buf, pos, n) {
    let v = 0;
    for (let i = 0; i < n; i++) { const p = pos + i; if (p < 128 && (buf[p >> 3] >> (p & 7)) & 1) v |= 1 << i; }
    return v;
  }
  function putBits(buf, pos, n, v) {
    for (let i = 0; i < n; i++) { const p = pos + i; if (p >= 128) return; if ((v >> i) & 1) buf[p >> 3] |= 1 << (p & 7); else buf[p >> 3] &= ~(1 << (p & 7)); }
  }
  function decodeISE(buf, pos, count, qi) {
    const q = QK[qi], out = [];
    if (q.type === 0) { for (let i = 0; i < count; i++) { out.push(getBits(buf, pos, q.k)); pos += q.k; } return out; }
    const per = q.type === 1 ? 5 : 3, ch = q.type === 1 ? TCH : QCH;
    for (let g = 0; g * per < count; g++) {
      const m = [], big = [];
      let T = 0, shift = 0;
      for (let j = 0; j < per; j++) {
        const idx = g * per + j;
        if (idx >= count) break;
        m.push(getBits(buf, pos, q.k)); pos += q.k;
        const n = ch[j]; T |= getBits(buf, pos, n) << shift; shift += n; pos += n;
      }
      const tv = q.type === 1 ? TRITS[T] : QUINTS[T];
      for (let j = 0; j < m.length; j++) out.push((tv[j] << q.k) | m[j]);
    }
    return out;
  }
  function encodeISE(vals, qi, buf, pos) {
    const q = QK[qi];
    if (q.type === 0) { for (const v of vals) { putBits(buf, pos, q.k, v); pos += q.k; } return; }
    const per = q.type === 1 ? 5 : 3, ch = q.type === 1 ? TCH : QCH, mask = (1 << q.k) - 1;
    for (let g = 0; g * per < vals.length; g++) {
      const tv = [], ms = [];
      for (let j = 0; j < per; j++) { const v = vals[g * per + j]; tv.push(v === undefined ? 0 : v >> q.k); ms.push(v === undefined ? 0 : v & mask); }
      const T = (q.type === 1 ? TRIT_INV : QUINT_INV).get(tv.join(''));
      let shift = 0;
      for (let j = 0; j < per; j++) {
        if (g * per + j >= vals.length) break;
        putBits(buf, pos, q.k, ms[j]); pos += q.k;
        putBits(buf, pos, ch[j], T >> shift); shift += ch[j]; pos += ch[j];
      }
    }
  }
  function unqEndpoint(qi, v) {
    const q = QK[qi];
    if (q.type === 0) { let out = v, got = q.k; while (got < 8) { const s = Math.min(q.k, 8 - got); out = (out << s) | (v >> (q.k - s)); got += s; } return out; }
    const bits = v & ((1 << q.k) - 1), d = v >> q.k, a = bits & 1 ? 0x1ff : 0;
    const x = bits >> 1; let B = 0, C = 0;
    if (q.type === 1) {
      switch (q.k) {
        case 0: return [0, 128, 255][d];
        case 1: B = 0; C = 204; break;
        case 2: { const y = x & 1; B = (y << 1) | (y << 2) | (y << 4) | (y << 8); C = 93; break; }
        case 3: { const y = x & 3; B = y | (y << 2) | (y << 7); C = 44; break; }
        case 4: { const y = x & 7; B = y | (y << 6); C = 22; break; }
        case 5: { const y = x & 15; B = (y >> 2) | (y << 5); C = 11; break; }
        default: { const y = x & 31; B = (y >> 4) | (y << 4); C = 5; }
      }
    } else {
      switch (q.k) {
        case 0: return [0, 64, 128, 192, 255][d];
        case 1: B = 0; C = 113; break;
        case 2: { const y = x & 1; B = (y << 2) | (y << 3) | (y << 8); C = 54; break; }
        case 3: { const y = x & 3; B = (y >> 1) | (y << 1) | (y << 7); C = 26; break; }
        case 4: { const y = x & 7; B = (y >> 1) | (y << 6); C = 13; break; }
        default: { const y = x & 15; B = (y >> 3) | (y << 5); C = 6; }
      }
    }
    let t = d * C + B; t ^= a; t = (a & 0x80) | (t >> 2); return t & 255;
  }
  function unqWeight(qi, v) {
    const q = QK[qi]; let dq;
    if (q.type === 0) { let out = v, got = q.k; while (got < 6) { const s = Math.min(q.k, 6 - got); out = (out << s) | (v >> (q.k - s)); got += s; } dq = out; }
    else {
      const bits = v & ((1 << q.k) - 1), d = v >> q.k, a = bits & 1 ? 0x7f : 0, x = bits >> 1; let B = 0, C;
      if (q.type === 1) {
        if (q.k === 0) dq = [0, 32, 63][d];
        else { if (q.k === 1) { B = 0; C = 50; } else if (q.k === 2) { const y = x & 1; B = y | (y << 2) | (y << 6); C = 23; } else { const y = x & 3; B = y | (y << 5); C = 11; } }
      } else {
        if (q.k === 0) dq = [0, 16, 32, 47, 63][d];
        else if (q.k === 1) { B = 0; C = 28; } else { const y = x & 1; B = (y << 1) | (y << 6); C = 13; }
      }
      if (dq === undefined) { let t = d * C + B; t ^= a; dq = (a & 0x20) | (t >> 2); dq &= 63; }
    }
    return dq > 32 ? dq + 1 : dq;
  }
  const EPT = LEVELS.map((n, i) => { const a = []; for (let v = 0; v < n; v++) a.push(unqEndpoint(i, v)); return a; });
  const WGT = LEVELS.slice(0, 12).map((n, i) => { const a = []; for (let v = 0; v < n; v++) a.push(unqWeight(i, v)); return a; });

  // modos de bloco 2D
  function decodeBlockMode(bm) {
    let base = (bm >> 4) & 1; const H = (bm >> 9) & 1, A = (bm >> 5) & 3; let D = (bm >> 10) & 1, hh = H, x, y;
    if ((bm & 3) !== 0) {
      base |= (bm & 3) << 1; let B = (bm >> 7) & 3;
      switch ((bm >> 2) & 3) {
        case 0: x = B + 4; y = A + 2; break;
        case 1: x = B + 8; y = A + 2; break;
        case 2: x = A + 2; y = B + 8; break;
        default: B &= 1; if (bm & 0x100) { x = B + 2; y = A + 2; } else { x = A + 2; y = B + 6; }
      }
    } else {
      base |= ((bm >> 2) & 3) << 1; if (((bm >> 2) & 3) === 0) return null;
      const B = (bm >> 9) & 3;
      switch ((bm >> 7) & 3) {
        case 0: x = 12; y = A + 2; break;
        case 1: x = A + 2; y = 12; break;
        case 2: x = A + 6; y = B + 6; D = 0; hh = 0; break;
        default: if (A === 0) { x = 6; y = 10; } else if (A === 1) { x = 10; y = 6; } else return null;
      }
    }
    const qm = base - 2 + 6 * hh, cnt = x * y * (D + 1);
    if (qm < 0 || qm > 11 || cnt > 64) return null;
    const wb = iseBits(cnt, qm);
    if (wb < 24 || wb > 96) return null;
    return { x, y, dual: !!D, qm, wb, cnt };
  }
  const MODES = new Array(2048);
  for (let i = 0; i < 2048; i++) MODES[i] = (i & 0x1ff) === 0x1fc ? null : decodeBlockMode(i);

  const bt = (a, b) => { b = (b >> 1) | (a & 0x80); a = (a >> 1) & 0x3f; if (a & 0x20) a -= 0x40; return [a, b]; };
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const bc = (r, g, b) => [(r + b) >> 1, (g + b) >> 1, b];
  function endpointsFor(cem, v) {
    switch (cem) {
      case 0: return [[v[0], v[0], v[0], 255], [v[1], v[1], v[1], 255]];
      case 1: { const l0 = (v[0] >> 2) | (v[1] & 0xc0), l1 = clamp(l0 + (v[1] & 0x3f)); return [[l0, l0, l0, 255], [l1, l1, l1, 255]]; }
      case 4: return [[v[0], v[0], v[0], v[2]], [v[1], v[1], v[1], v[3]]];
      case 5: { const [o0, b0] = bt(v[1], v[0]), [o1, b1] = bt(v[3], v[2]); return [[b0, b0, b0, b1], [clamp(b0 + o0), clamp(b0 + o0), clamp(b0 + o0), clamp(b1 + o1)]]; }
      case 6: return [[(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, 255], [v[0], v[1], v[2], 255]];
      case 8: {
        const s0 = v[0] + v[2] + v[4], s1 = v[1] + v[3] + v[5];
        if (s1 >= s0) return [[v[0], v[2], v[4], 255], [v[1], v[3], v[5], 255]];
        return [[...bc(v[1], v[3], v[5]), 255], [...bc(v[0], v[2], v[4]), 255]];
      }
      case 9: {
        const [o0, b0] = bt(v[1], v[0]), [o1, b1] = bt(v[3], v[2]), [o2, b2] = bt(v[5], v[4]);
        if (o0 + o1 + o2 >= 0) return [[b0, b1, b2, 255], [clamp(b0 + o0), clamp(b1 + o1), clamp(b2 + o2), 255]];
        return [[...bc(b0 + o0, b1 + o1, b2 + o2).map(clamp), 255], [...bc(b0, b1, b2), 255]];
      }
      case 10: return [[(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, v[4]], [v[0], v[1], v[2], v[5]]];
      case 12: {
        const s0 = v[0] + v[2] + v[4], s1 = v[1] + v[3] + v[5];
        if (s1 >= s0) return [[v[0], v[2], v[4], v[6]], [v[1], v[3], v[5], v[7]]];
        return [[...bc(v[1], v[3], v[5]), v[7]], [...bc(v[0], v[2], v[4]), v[6]]];
      }
      case 13: {
        const [o0, b0] = bt(v[1], v[0]), [o1, b1] = bt(v[3], v[2]), [o2, b2] = bt(v[5], v[4]), [o3, b3] = bt(v[7], v[6]);
        if (o0 + o1 + o2 >= 0) return [[b0, b1, b2, b3], [clamp(b0 + o0), clamp(b1 + o1), clamp(b2 + o2), clamp(b3 + o3)]];
        return [[...bc(b0 + o0, b1 + o1, b2 + o2).map(clamp), clamp(b3 + o3)], [...bc(b0, b1, b2), b3]];
      }
      default: return null; // HDR / reservado
    }
  }

  /** Pesos por texel (0..64) a partir da grade. */
  function infill(g, wx, wy, bw, bh) {
    const out = new Uint8Array(bw * bh);
    const Ds = Math.floor((1024 + (bw >> 1)) / (bw - 1)), Dt = Math.floor((1024 + (bh >> 1)) / (bh - 1));
    for (let t = 0; t < bh; t++) for (let s = 0; s < bw; s++) {
      const gs = (Ds * s * (wx - 1) + 32) >> 6, gt = (Dt * t * (wy - 1) + 32) >> 6;
      const js = gs >> 4, fs = gs & 15, jt = gt >> 4, ft = gt & 15;
      const v0 = js + wx * jt;
      const w11 = (fs * ft + 8) >> 4, w10 = ft - w11, w01 = fs - w11, w00 = 16 - fs - ft + w11;
      const G = (i) => g[Math.min(i, g.length - 1)];
      out[t * bw + s] = (G(v0) * w00 + G(v0 + 1) * w01 + G(v0 + wx) * w10 + G(v0 + wx + 1) * w11 + 8) >> 4;
    }
    return out;
  }

  function rev(buf) { const r = new Uint8Array(16); for (let i = 0; i < 128; i++) if ((buf[i >> 3] >> (i & 7)) & 1) { const j = 127 - i; r[j >> 3] |= 1 << (j & 7); } return r; }

  /** Decodifica um bloco em out (bw*bh*4 RGBA). Retorna false se inválido/não suportado. */
  function decodeBlock(buf, bw, bh, out) {
    const bm = getBits(buf, 0, 11);
    if ((bm & 0x1ff) === 0x1fc) {
      if ((bm >> 9) & 1) return false; // HDR
      const c = [0, 1, 2, 3].map((i) => (buf[8 + i * 2] | (buf[9 + i * 2] << 8)));
      const px = c.map((v) => Math.round(v / 257));
      for (let i = 0; i < bw * bh; i++) { out[i * 4] = px[0]; out[i * 4 + 1] = px[1]; out[i * 4 + 2] = px[2]; out[i * 4 + 3] = px[3]; }
      return true;
    }
    const m = MODES[bm]; if (!m) return false;
    if (m.x > bw || m.y > bh) return false;
    if (getBits(buf, 11, 2) !== 0) return false; // multipartição: não suportado
    const cem = getBits(buf, 13, 4);
    const nv = ((cem >> 2) + 1) * 2;
    const avail = 128 - 17 - m.wb - (m.dual ? 2 : 0);
    let eq = -1;
    for (let q = 20; q >= 0; q--) if (iseBits(nv, q) <= avail) { eq = q; break; }
    if (eq < 4) return false;
    const ev = decodeISE(buf, 17, nv, eq).map((v) => EPT[eq][v]);
    const ep = endpointsFor(cem, ev); if (!ep) return false;
    const rb = rev(buf);
    const wv = decodeISE(rb, 0, m.cnt, m.qm).map((v) => WGT[m.qm][v]);
    let w1, w2 = null, ccs = 0;
    if (m.dual) {
      ccs = getBits(buf, 128 - m.wb - 2, 2);
      const a = [], b = []; for (let i = 0; i < wv.length; i += 2) { a.push(wv[i]); b.push(wv[i + 1]); }
      w1 = infill(a, m.x, m.y, bw, bh); w2 = infill(b, m.x, m.y, bw, bh);
    } else w1 = infill(wv, m.x, m.y, bw, bh);
    for (let i = 0; i < bw * bh; i++) for (let c = 0; c < 4; c++) {
      const w = w2 && c === ccs ? w2[i] : w1[i];
      const c0 = (ep[0][c] << 8) | ep[0][c], c1 = (ep[1][c] << 8) | ep[1][c];
      out[i * 4 + c] = Math.round((((c0 * (64 - w) + c1 * w + 32) >> 6)) / 257);
    }
    return true;
  }

  function parseHeader(b) {
    if (b.length < 16 || b[0] !== 0x13 || b[1] !== 0xab || b[2] !== 0xa1 || b[3] !== 0x5c) throw new Error(FNF.t('astc.err.magic'));
    const bw = b[4], bh = b[5], bz = b[6];
    const dim = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    const width = dim(7), height = dim(10), depth = dim(13);
    if (bz !== 1 || depth !== 1) throw new Error(FNF.t('astc.err.3d'));
    if (!FNF.ASTC_BLOCKS.some(([x, y]) => x === bw && y === bh)) throw new Error(FNF.t('astc.err.block', { b: bw + 'x' + bh }));
    return { bw, bh, width, height };
  }
  FNF.ASTC_BLOCKS = [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]];

  function decodeASTC(bytes) {
    const { bw, bh, width, height } = parseHeader(bytes);
    const nbx = Math.ceil(width / bw), nby = Math.ceil(height / bh);
    if (bytes.length < 16 + nbx * nby * 16) throw new Error(FNF.t('astc.err.short'));
    const data = new Uint8Array(width * height * 4), blk = new Uint8Array(bw * bh * 4);
    let bad = 0;
    for (let by = 0; by < nby; by++) for (let bx = 0; bx < nbx; bx++) {
      const o = 16 + (by * nbx + bx) * 16;
      const ok = decodeBlock(bytes.subarray(o, o + 16), bw, bh, blk);
      if (!ok) { bad++; for (let i = 0; i < bw * bh; i++) { blk[i * 4] = 255; blk[i * 4 + 1] = 0; blk[i * 4 + 2] = 255; blk[i * 4 + 3] = 255; } }
      for (let y = 0; y < bh && by * bh + y < height; y++) for (let x = 0; x < bw && bx * bw + x < width; x++) {
        const d = ((by * bh + y) * width + bx * bw + x) * 4, s = (y * bw + x) * 4;
        data[d] = blk[s]; data[d + 1] = blk[s + 1]; data[d + 2] = blk[s + 2]; data[d + 3] = blk[s + 3];
      }
    }
    return { width, height, data, bw, bh, badBlocks: bad };
  }

  // ---------------- encoder ----------------
  const NEAR = EPT.map((tab) => { const idx = tab.map((u, i) => [u, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]); return idx; });
  function nearestEp(qi, v) { // índice ISE cujo valor desquantizado é mais próximo
    const a = NEAR[qi]; let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid][0] <= v) lo = mid; else hi = mid; }
    return Math.abs(a[lo][0] - v) <= Math.abs(a[hi][0] - v) ? a[lo][1] : a[hi][1];
  }
  const NEARW = WGT.map((tab) => tab.map((u, i) => [u, i]).sort((a, b) => a[0] - b[0]));
  function nearestW(qi, t64) {
    const a = NEARW[qi]; let best = a[0], bd = 1e9;
    for (const e of a) { const d = Math.abs(e[0] - t64); if (d < bd) { bd = d; best = e; } }
    return best[1];
  }
  const modeCache = new Map();
  function candidateModes(bw, bh, minEp, full) {
    const key = bw + 'x' + bh + ':' + minEp + ':' + full;
    if (modeCache.has(key)) return modeCache.get(key);
    const byGrid = new Map();
    for (let bm = 0; bm < 2048; bm++) {
      const m = MODES[bm]; if (!m || m.dual || m.x > bw || m.y > bh) continue;
      const avail = 128 - 17 - m.wb; let eq = -1;
      for (let q = 20; q >= 0; q--) if (iseBits(8, q) <= avail) { eq = q; break; }
      if (eq < 0 || LEVELS[eq] < minEp) continue;
      const k = m.x + ',' + m.y, prev = byGrid.get(k);
      if (!prev || m.qm > prev.m.qm) byGrid.set(k, { bm, m, eq, avail });
    }
    let list = [...byGrid.values()];
    if (!full) { // só grades próximas do bloco completo
      list = list.filter((c) => c.m.x * c.m.y >= bw * bh * 0.45 || (c.m.x === bw && c.m.y === bh));
    }
    modeCache.set(key, list);
    return list;
  }
  function eqFor(nv, wb) { for (let q = 20; q >= 0; q--) if (iseBits(nv, q) <= 128 - 17 - wb) return q; return -1; }

  function encodeBlock(px, bw, bh, opts) {
    const n = bw * bh, buf = new Uint8Array(16);
    let allA0 = true, same = true, opaque = true;
    for (let i = 0; i < n; i++) {
      if (px[i * 4 + 3] !== 0) allA0 = false;
      if (px[i * 4 + 3] !== 255) opaque = false;
      for (let c = 0; c < 4; c++) if (px[i * 4 + c] !== px[c]) same = false;
    }
    const void_ = (r, g, b, a) => { putBits(buf, 0, 11, 0x1fc); buf.fill(0xff, 2, 8); [r, g, b, a].forEach((v, i) => { buf[8 + i * 2] = v; buf[9 + i * 2] = v; }); buf[0] = 0xfc; buf[1] = 0xfd; return buf; };
    if (allA0) { const b = void_(0, 0, 0, 0); return b; }
    if (same) return void_(px[0], px[1], px[2], px[3]);
    // cor média dos pixels visíveis para substituir RGB de pixels transparentes
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let i = 0; i < n; i++) { const a = px[i * 4 + 3]; if (a) { sr += px[i * 4] * a; sg += px[i * 4 + 1] * a; sb += px[i * 4 + 2] * a; sw += a; } }
    const mr = sr / sw, mg = sg / sw, mb = sb / sw;
    const P = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3];
      if (a === 0) { P[i * 4] = mr; P[i * 4 + 1] = mg; P[i * 4 + 2] = mb; } else { P[i * 4] = px[i * 4]; P[i * 4 + 1] = px[i * 4 + 1]; P[i * 4 + 2] = px[i * 4 + 2]; }
      P[i * 4 + 3] = a;
    }
    const nc = opaque ? 3 : 4, cem = opaque ? 8 : 12, nv = nc * 2;
    // eixo principal (iteração de potência) com média
    const mean = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) mean[c] += P[i * 4 + c] / n;
    const cov = [];
    for (let a = 0; a < nc; a++) { cov.push([]); for (let b = 0; b < nc; b++) { let s = 0; for (let i = 0; i < n; i++) s += (P[i * 4 + a] - mean[a]) * (P[i * 4 + b] - mean[b]); cov[a].push(s); } }
    let ax = new Array(nc).fill(1);
    for (let it = 0; it < 8; it++) { const nx = ax.map((_, a) => cov[a].reduce((s, v, b) => s + v * ax[b], 0)); const len = Math.hypot(...nx) || 1; ax = nx.map((v) => v / len); }
    let tmin = 1e9, tmax = -1e9;
    for (let i = 0; i < n; i++) { let t = 0; for (let c = 0; c < nc; c++) t += (P[i * 4 + c] - mean[c]) * ax[c]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
    const E0 = [], E1 = [];
    for (let c = 0; c < nc; c++) { E0.push(clamp(mean[c] + ax[c] * tmin)); E1.push(clamp(mean[c] + ax[c] * tmax)); }
    const cands = candidateModes(bw, bh, opts.minEp, opts.full);
    let best = null;
    const rec = new Uint8Array(n * 4);
    for (const cd of cands) {
      const { m, eq, bm } = cd;
      const neq = eqFor(nv, m.wb); if (neq < 0 || LEVELS[neq] < opts.minEp) continue;
      // endpoints quantizados (ordem v0..: r0 r1 g0 g1 b0 b1 a0 a1)
      let lo = E0, hi = E1;
      const qv = (e0, e1) => { const out = []; for (let c = 0; c < nc; c++) { out.push(nearestEp(neq, e0[c]), nearestEp(neq, e1[c])); } return out; };
      let iv = qv(lo, hi), un = iv.map((v) => EPT[neq][v]);
      let sum0 = un[0] + un[2] + un[4], sum1 = un[1] + un[3] + un[5];
      let swapped = false;
      if (sum1 < sum0) { iv = qv(hi, lo); un = iv.map((v) => EPT[neq][v]); sum0 = un[0] + un[2] + un[4]; sum1 = un[1] + un[3] + un[5]; swapped = true; if (sum1 < sum0) continue; }
      if (opaque) { /* cem 8 */ }
      const e0 = [], e1 = [];
      for (let c = 0; c < nc; c++) { e0.push(un[c * 2]); e1.push(un[c * 2 + 1]); }
      if (opaque) { e0.push(255); e1.push(255); }
      // pesos ideais por texel
      const d = e1.map((v, c) => v - e0[c]); const dd = d.reduce((s, v) => s + v * v, 0) || 1;
      const ideal = new Float32Array(n);
      for (let i = 0; i < n; i++) { let t = 0; for (let c = 0; c < nc; c++) t += (P[i * 4 + c] - e0[c]) * d[c]; ideal[i] = Math.min(1, Math.max(0, t / dd)); }
      // grade
      const wx = m.x, wy = m.y, gcount = wx * wy, g = new Float32Array(gcount);
      if (wx === bw && wy === bh) g.set(ideal);
      else {
        const num = new Float32Array(gcount), den = new Float32Array(gcount);
        const Ds = Math.floor((1024 + (bw >> 1)) / (bw - 1)), Dt = Math.floor((1024 + (bh >> 1)) / (bh - 1));
        for (let t = 0; t < bh; t++) for (let s = 0; s < bw; s++) {
          const gs = (Ds * s * (wx - 1) + 32) >> 6, gt = (Dt * t * (wy - 1) + 32) >> 6;
          const js = gs >> 4, fs = gs & 15, jt = gt >> 4, ft = gt & 15, v0 = js + wx * jt;
          const w11 = (fs * ft + 8) >> 4, w10 = ft - w11, w01 = fs - w11, w00 = 16 - fs - ft + w11;
          const val = ideal[t * bw + s];
          const add = (i, w) => { if (w > 0 && i < gcount) { num[i] += val * w; den[i] += w; } };
          add(v0, w00); add(v0 + 1, w01); add(v0 + wx, w10); add(v0 + wx + 1, w11);
        }
        for (let i = 0; i < gcount; i++) g[i] = den[i] ? num[i] / den[i] : 0.5;
      }
      const wi = [], wu = [];
      for (let i = 0; i < gcount; i++) { const v = nearestW(m.qm, g[i] * 64); wi.push(v); wu.push(WGT[m.qm][v]); }
      const tw = infill(wu, wx, wy, bw, bh);
      // erro (pré-multiplicado)
      let err = 0;
      for (let i = 0; i < n; i++) {
        const w = tw[i], a0 = px[i * 4 + 3];
        const ra = e0[3] + ((e1[3] - e0[3]) * w + 32) / 64;
        const ar = ra / 255, ao = a0 / 255;
        for (let c = 0; c < 3; c++) {
          const rc = e0[c] + ((e1[c] - e0[c]) * w) / 64;
          const dv = rc * ar - px[i * 4 + c] * ao; err += dv * dv;
        }
        const da = ra - a0; err += da * da;
      }
      if (!best || err < best.err) best = { err, bm, m, neq, iv, wi, swapped };
      if (err === 0) break;
    }
    if (!best) return void_(Math.round(mr), Math.round(mg), Math.round(mb), 255);
    // gravar
    putBits(buf, 0, 11, best.bm); putBits(buf, 11, 2, 0); putBits(buf, 13, 4, cem);
    encodeISE(best.iv, best.neq, buf, 17);
    const wb = new Uint8Array(16); encodeISE(best.wi, best.m.qm, wb, 0);
    for (let i = 0; i < best.m.wb; i++) if ((wb[i >> 3] >> (i & 7)) & 1) { const j = 127 - i; buf[j >> 3] |= 1 << (j & 7); }
    return buf;
  }

  /** rgba: Uint8Array w*h*4. opts: {bw,bh,quality:'fast'|'normal'|'best'} */
  function encodeASTC(rgba, w, h, opts) {
    opts = opts || {}; const bw = opts.bw || 6, bh = opts.bh || 6;
    const q = opts.quality || 'normal';
    const eo = { minEp: q === 'best' ? 16 : 32, full: q !== 'fast' || bw * bh > 64 };
    const nbx = Math.ceil(w / bw), nby = Math.ceil(h / bh);
    const out = new Uint8Array(16 + nbx * nby * 16);
    out.set([0x13, 0xab, 0xa1, 0x5c, bw, bh, 1, w & 255, (w >> 8) & 255, w >> 16, h & 255, (h >> 8) & 255, h >> 16, 1, 0, 0]);
    const px = new Uint8Array(bw * bh * 4);
    for (let by = 0; by < nby; by++) for (let bx = 0; bx < nbx; bx++) {
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const sx = Math.min(w - 1, bx * bw + x), sy = Math.min(h - 1, by * bh + y), s = (sy * w + sx) * 4, d = (y * bw + x) * 4;
        px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
      }
      out.set(encodeBlock(px, bw, bh, eo), 16 + (by * nbx + bx) * 16);
    }
    return out;
  }
  FNF.decodeASTC = decodeASTC; FNF.encodeASTC = encodeASTC; FNF.astc = { decodeBlock, decodeISE, encodeISE, iseBits, TRITS, QUINTS, MODES, EPT, WGT, unqEndpoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = FNF;
})(typeof globalThis !== 'undefined' ? globalThis : this);
