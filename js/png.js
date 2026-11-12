/* png.js — decoder/encoder PNG próprio (sem dependências), quantizador e utilitários de bytes.
 * Usa DecompressionStream/CompressionStream nativos (navegadores modernos e Node 18+). */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});

  // ---------------------------------------------------------------- bytes
  const te = new TextEncoder();
  const tdKeepBOM = new TextDecoder('utf-8', { ignoreBOM: true });

  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  async function pipe(bytes, stream) {
    const s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const inflate = (b) => pipe(b, new DecompressionStream('deflate'));
  const deflate = (b) => pipe(b, new CompressionStream('deflate'));
  const deflateRaw = (b) => pipe(b, new CompressionStream('deflate-raw'));

  let CRC_TABLE = null;
  function crc32(bytes, start, end) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = start || 0, e = end === undefined ? bytes.length : end; i < e; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------------------------------------------------------------- decode
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function unfilter(raw, off, w, h, bits) {
    const bpp = Math.max(1, bits >> 3);
    const stride = Math.ceil((w * bits) / 8);
    const out = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      const ft = raw[off++];
      const r = y * stride;
      const p = r - stride;
      switch (ft) {
        case 0:
          for (let i = 0; i < stride; i++) out[r + i] = raw[off + i];
          break;
        case 1:
          for (let i = 0; i < stride; i++) out[r + i] = (raw[off + i] + (i >= bpp ? out[r + i - bpp] : 0)) & 255;
          break;
        case 2:
          for (let i = 0; i < stride; i++) out[r + i] = (raw[off + i] + (y ? out[p + i] : 0)) & 255;
          break;
        case 3:
          for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[r + i - bpp] : 0;
            const b = y ? out[p + i] : 0;
            out[r + i] = (raw[off + i] + ((a + b) >> 1)) & 255;
          }
          break;
        case 4:
          for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[r + i - bpp] : 0;
            const b = y ? out[p + i] : 0;
            const c = y && i >= bpp ? out[p + i - bpp] : 0;
            const pp = a + b - c;
            const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
            const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            out[r + i] = (raw[off + i] + pr) & 255;
          }
          break;
        default:
          throw new Error('PNG corrompido (filtro de linha inválido: ' + ft + ').');
      }
      off += stride;
    }
    return { rows: out, stride, off };
  }

  function readSample(rows, rowOff, idx, depth) {
    if (depth === 8) return rows[rowOff + idx];
    if (depth === 16) return (rows[rowOff + idx * 2] << 8) | rows[rowOff + idx * 2 + 1];
    const perByte = 8 / depth;
    const byte = rows[rowOff + ((idx / perByte) | 0)];
    const shift = 8 - depth * ((idx % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  }

  function fillRGBA(out, W, x0, y0, dx, dy, pw, ph, rows, stride, ctx) {
    const { depth, ct, plte, trns } = ctx;
    const max = (1 << depth) - 1;
    const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
    for (let py = 0; py < ph; py++) {
      const ro = py * stride;
      let o = ((y0 + py * dy) * W + x0) * 4;
      const ostep = dx * 4;
      for (let px = 0; px < pw; px++, o += ostep) {
        let r, g, b, a = 255;
        if (ct === 6) {
          r = to8(readSample(rows, ro, px * 4, depth)); g = to8(readSample(rows, ro, px * 4 + 1, depth));
          b = to8(readSample(rows, ro, px * 4 + 2, depth)); a = to8(readSample(rows, ro, px * 4 + 3, depth));
        } else if (ct === 2) {
          const rr = readSample(rows, ro, px * 3, depth), gg = readSample(rows, ro, px * 3 + 1, depth), bb = readSample(rows, ro, px * 3 + 2, depth);
          if (trns && rr === trns[0] && gg === trns[1] && bb === trns[2]) a = 0;
          r = to8(rr); g = to8(gg); b = to8(bb);
        } else if (ct === 0) {
          const v = readSample(rows, ro, px, depth);
          if (trns && v === trns[0]) a = 0;
          r = g = b = to8(v);
        } else if (ct === 4) {
          r = g = b = to8(readSample(rows, ro, px * 2, depth));
          a = to8(readSample(rows, ro, px * 2 + 1, depth));
        } else {
          const i = readSample(rows, ro, px, depth);
          r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2];
          a = trns && i < trns.length ? trns[i] : 255;
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
      }
    }
  }

  async function decodePNG(bytes) {
    if (!bytes || bytes.length < 8 || !PNG_SIG.every((v, i) => bytes[i] === v)) {
      throw new Error('O arquivo não é um PNG válido.');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8, ihdr = null, plte = null, trnsRaw = null;
    const idat = [];
    while (pos + 8 <= bytes.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const body = bytes.subarray(pos + 8, pos + 8 + len);
      pos += 12 + len;
      if (type === 'IHDR') {
        const bd = new DataView(body.buffer, body.byteOffset, body.byteLength);
        ihdr = { w: bd.getUint32(0), h: bd.getUint32(4), depth: body[8], ct: body[9], interlace: body[12] };
      } else if (type === 'PLTE') plte = body;
      else if (type === 'tRNS') trnsRaw = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
    }
    if (!ihdr) throw new Error('PNG sem cabeçalho IHDR.');
    const { w, h, depth, ct, interlace } = ihdr;
    const chMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const ch = chMap[ct];
    if (!ch) throw new Error('Tipo de cor PNG não suportado: ' + ct);
    if (ct === 3 && !plte) throw new Error('PNG indexado sem paleta.');
    if (w * h > 400e6) throw new Error('Imagem grande demais.');
    const warnings = [];
    if (depth === 16) warnings.push('PNG de 16 bits por canal: convertido para 8 bits.');
    let trns = null;
    if (trnsRaw) {
      if (ct === 3) trns = trnsRaw;
      else if (ct === 0) trns = [(trnsRaw[0] << 8) | trnsRaw[1]];
      else if (ct === 2) trns = [(trnsRaw[0] << 8) | trnsRaw[1], (trnsRaw[2] << 8) | trnsRaw[3], (trnsRaw[4] << 8) | trnsRaw[5]];
    }
    const bits = ch * depth;
    const raw = await inflate(concat(idat));
    const out = new Uint8Array(w * h * 4);
    const ctx = { depth, ct, plte, trns };
    if (!interlace) {
      const { rows, stride } = unfilter(raw, 0, w, h, bits);
      if (ct === 6 && depth === 8) out.set(rows.subarray(0, w * h * 4));
      else fillRGBA(out, w, 0, 0, 1, 1, w, h, rows, stride, ctx);
    } else {
      const sx = [0, 4, 0, 2, 0, 1, 0], sy = [0, 0, 4, 0, 2, 0, 1];
      const dx = [8, 8, 4, 4, 2, 2, 1], dy = [8, 8, 8, 4, 4, 2, 2];
      let off = 0;
      for (let p = 0; p < 7; p++) {
        const pw = Math.ceil((w - sx[p]) / dx[p]), ph = Math.ceil((h - sy[p]) / dy[p]);
        if (pw <= 0 || ph <= 0) continue;
        const r = unfilter(raw, off, pw, ph, bits);
        off = r.off;
        fillRGBA(out, w, sx[p], sy[p], dx[p], dy[p], pw, ph, r.rows, r.stride, ctx);
      }
    }
    return { width: w, height: h, data: out, warnings };
  }

  // ---------------------------------------------------------------- encode
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  }

  // Escolhe, por linha, o filtro de menor soma de |valor assinado| e devolve linhas filtradas.
  function filterRows(data, stride, h, bpp) {
    const out = new Uint8Array(h * (stride + 1));
    const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
    for (let y = 0; y < h; y++) {
      const r = y * stride, p = r - stride;
      let best = -1, bestScore = Infinity;
      for (let t = 0; t < 5; t++) {
        const c = cand[t];
        let s = 0;
        for (let i = 0; i < stride; i++) {
          const x = data[r + i];
          const a = i >= bpp ? data[r + i - bpp] : 0;
          const b = y ? data[p + i] : 0;
          const cc = y && i >= bpp ? data[p + i - bpp] : 0;
          let v;
          if (t === 0) v = x;
          else if (t === 1) v = x - a;
          else if (t === 2) v = x - b;
          else if (t === 3) v = x - ((a + b) >> 1);
          else {
            const pp = a + b - cc;
            const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc);
            v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc);
          }
          v &= 255;
          c[i] = v;
          s += v < 128 ? v : 256 - v;
        }
        if (s < bestScore) { bestScore = s; best = t; }
        if (bestScore === 0) break;
      }
      const o = y * (stride + 1);
      out[o] = best;
      out.set(cand[best], o + 1);
    }
    return out;
  }

  // Paleta exata (sem perdas) se houver <= limit cores RGBA distintas.
  function exactPalette(rgba, n, limit) {
    const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
    const map = new Map();
    const colors = [];
    for (let i = 0; i < n; i++) {
      const c = u32[i];
      if (!map.has(c)) {
        if (colors.length >= limit) return null;
        map.set(c, colors.length);
        colors.push(c);
      }
    }
    // ordena por alpha crescente (entradas translúcidas primeiro → tRNS curto)
    const order = colors.map((c, i) => i).sort((a, b) => ((colors[a] >>> 24) & 255) - ((colors[b] >>> 24) & 255) || a - b);
    const remap = new Int32Array(colors.length);
    const palette = new Uint8Array(colors.length * 4);
    order.forEach((oldIdx, newIdx) => {
      remap[oldIdx] = newIdx;
      const c = colors[oldIdx];
      palette[newIdx * 4] = c & 255; palette[newIdx * 4 + 1] = (c >>> 8) & 255;
      palette[newIdx * 4 + 2] = (c >>> 16) & 255; palette[newIdx * 4 + 3] = (c >>> 24) & 255;
    });
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) indices[i] = remap[map.get(u32[i])];
    return { palette, indices };
  }

  // Quantização por median-cut (histograma 5-5-5-5 bits) com dithering Floyd-Steinberg opcional.
  function quantize(rgba, w, h, maxColors, dither) {
    const n = w * h;
    const K = 1 << 20;
    const cnt = new Uint32Array(K);
    const sR = new Float64Array(K), sG = new Float64Array(K), sB = new Float64Array(K), sA = new Float64Array(K);
    let hasT = false;
    for (let i = 0; i < n; i++) {
      const o = i * 4, a = rgba[o + 3];
      if (a === 0) { hasT = true; continue; }
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const k = ((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3);
      cnt[k]++; sR[k] += r; sG[k] += g; sB[k] += b; sA[k] += a;
    }
    const keyList = [];
    for (let k = 0; k < K; k++) if (cnt[k]) keyList.push(k);
    const ids = Int32Array.from(keyList);
    const avg = [new Float32Array(K), new Float32Array(K), new Float32Array(K), new Float32Array(K)];
    for (const k of keyList) {
      const c = cnt[k];
      avg[0][k] = sR[k] / c; avg[1][k] = sG[k] / c; avg[2][k] = sB[k] / c; avg[3][k] = sA[k] / c;
    }
    const target = Math.max(1, maxColors - (hasT ? 1 : 0));
    const W4 = [1, 1, 1, 1.3];
    function info(lo, hi) {
      let total = 0;
      const mn = [255, 255, 255, 255], mx = [0, 0, 0, 0];
      for (let i = lo; i < hi; i++) {
        const k = ids[i];
        total += cnt[k];
        for (let c = 0; c < 4; c++) { const v = avg[c][k]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
      }
      let ch = 0, rng = -1;
      for (let c = 0; c < 4; c++) { const r = (mx[c] - mn[c]) * W4[c]; if (r > rng) { rng = r; ch = c; } }
      return { lo, hi, total, ch, rng, score: rng * Math.sqrt(total) };
    }
    const boxes = [info(0, ids.length)];
    while (boxes.length < target) {
      let bi = -1, bs = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.hi - b.lo > 1 && b.score > bs) { bs = b.score; bi = i; }
      }
      if (bi < 0) break;
      const b = boxes[bi];
      const arr = ids.subarray(b.lo, b.hi);
      const av = avg[b.ch];
      arr.sort((p, q) => av[p] - av[q]);
      let acc = 0, mid = b.lo + 1;
      for (let i = b.lo; i < b.hi - 1; i++) {
        acc += cnt[ids[i]];
        mid = i + 1;
        if (acc >= b.total / 2) break;
      }
      boxes.splice(bi, 1, info(b.lo, mid), info(mid, b.hi));
    }
    const pal = [];
    if (hasT) pal.push([0, 0, 0, 0]);
    for (const b of boxes) {
      let t = 0, r = 0, g = 0, bl = 0, a = 0;
      for (let i = b.lo; i < b.hi; i++) {
        const k = ids[i];
        t += cnt[k]; r += sR[k]; g += sG[k]; bl += sB[k]; a += sA[k];
      }
      pal.push([Math.round(r / t), Math.round(g / t), Math.round(bl / t), Math.max(1, Math.round(a / t))]);
    }
    const np = pal.length;
    const pm = new Float32Array(np * 4);
    for (let i = 0; i < np; i++) {
      const a = pal[i][3];
      pm[i * 4] = (pal[i][0] * a) / 255; pm[i * 4 + 1] = (pal[i][1] * a) / 255; pm[i * 4 + 2] = (pal[i][2] * a) / 255; pm[i * 4 + 3] = a;
    }
    function nearest(r, g, b, a, from) {
      const pr = (r * a) / 255, pg = (g * a) / 255, pb = (b * a) / 255;
      let best = from, bd = Infinity;
      for (let i = from; i < np; i++) {
        const dr = pr - pm[i * 4], dg = pg - pm[i * 4 + 1], db = pb - pm[i * 4 + 2], da = a - pm[i * 4 + 3];
        const d = dr * dr + dg * dg + db * db + da * da;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    const first = hasT ? 1 : 0;
    const indices = new Uint8Array(n);
    if (!dither) {
      const cache = new Int16Array(K).fill(-1);
      for (let i = 0; i < n; i++) {
        const o = i * 4, a = rgba[o + 3];
        if (a === 0) { indices[i] = 0; continue; }
        const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        const k = ((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3);
        let v = cache[k];
        if (v < 0) { v = nearest(avg[0][k], avg[1][k], avg[2][k], avg[3][k], first); cache[k] = v; }
        indices[i] = v;
      }
    } else {
      let cur = new Float32Array((w + 2) * 4), nxt = new Float32Array((w + 2) * 4);
      for (let y = 0; y < h; y++) {
        nxt.fill(0);
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4, e = (x + 1) * 4;
          const a0 = rgba[o + 3];
          if (a0 === 0) { indices[y * w + x] = 0; continue; }
          const v = [0, 1, 2, 3].map((c) => Math.max(0, Math.min(255, rgba[o + c] + cur[e + c])));
          const idx = nearest(v[0], v[1], v[2], Math.max(1, v[3]), first);
          indices[y * w + x] = idx;
          for (let c = 0; c < 4; c++) {
            const er = v[c] - pal[idx][c];
            cur[e + 4 + c] += (er * 7) / 16;
            nxt[e - 4 + c] += (er * 3) / 16;
            nxt[e + c] += (er * 5) / 16;
            nxt[e + 4 + c] += er / 16;
          }
        }
        const t = cur; cur = nxt; nxt = t;
      }
    }
    const palette = new Uint8Array(np * 4);
    pal.forEach((c, i) => palette.set(c, i * 4));
    return { palette, indices };
  }

  function packIndices(indices, w, h, depth) {
    if (depth === 8) return indices;
    const stride = Math.ceil((w * depth) / 8);
    const out = new Uint8Array(stride * h);
    const per = 8 / depth;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const shift = 8 - depth * ((x % per) + 1);
        out[y * stride + ((x / per) | 0)] |= indices[y * w + x] << shift;
      }
    }
    return out;
  }

  /** opts: { mode:'auto'|'rgba'|'quantize', colors:256, dither:false }. Retorna { bytes, kind } */
  async function encodePNG(rgba, w, h, opts) {
    const o = opts || {};
    const mode = o.mode || 'auto';
    let pal = null;
    if (mode !== 'rgba') {
      const limit = mode === 'quantize' ? Math.max(2, Math.min(256, o.colors || 256)) : 256;
      pal = exactPalette(rgba, w * h, limit);
      if (!pal && mode === 'quantize') pal = quantize(rgba, w, h, limit, !!o.dither);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h);
    const parts = [new Uint8Array(PNG_SIG)];
    let filtered, kind;
    if (pal) {
      const n = pal.palette.length / 4;
      const depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
      ihdr[8] = depth; ihdr[9] = 3;
      const plte = new Uint8Array(n * 3);
      let lastT = -1;
      for (let i = 0; i < n; i++) {
        plte[i * 3] = pal.palette[i * 4]; plte[i * 3 + 1] = pal.palette[i * 4 + 1]; plte[i * 3 + 2] = pal.palette[i * 4 + 2];
        if (pal.palette[i * 4 + 3] !== 255) lastT = i;
      }
      parts.push(chunk('IHDR', ihdr), chunk('PLTE', plte));
      if (lastT >= 0) {
        const t = new Uint8Array(lastT + 1);
        for (let i = 0; i <= lastT; i++) t[i] = pal.palette[i * 4 + 3];
        parts.push(chunk('tRNS', t));
      }
      const packed = packIndices(pal.indices, w, h, depth);
      filtered = filterRows(packed, Math.ceil((w * depth) / 8), h, 1);
      kind = 'PNG-8 (' + n + ' cores)';
    } else {
      ihdr[8] = 8; ihdr[9] = 6;
      parts.push(chunk('IHDR', ihdr));
      filtered = filterRows(rgba, w * 4, h, 4);
      kind = 'RGBA 32 bits';
    }
    parts.push(chunk('IDAT', await deflate(filtered)), chunk('IEND', new Uint8Array(0)));
    return { bytes: concat(parts), kind };
  }

  Object.assign(FNF, {
    concat, inflate, deflate, deflateRaw, crc32, decodePNG, encodePNG, quantize, exactPalette,
    textEncode: (s) => te.encode(s),
    textDecode: (b) => tdKeepBOM.decode(b),
  });
})(typeof self !== 'undefined' ? self : globalThis);
