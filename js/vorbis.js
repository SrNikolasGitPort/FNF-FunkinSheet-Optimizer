/* vorbis.js — decodifica/codifica OGG Vorbis 100% no navegador (libogg + libvorbis da Xiph compilados para WebAssembly, ver vorbis_wasm.js).
 * API: FNF.vorbis.mix({ tracks:[Uint8Array…], quality, onProgress }) → { bytes, channels, rate, frames, seconds, peak }
 *      FNF.vorbis.info(bytes) → { channels, rate, frames? }  */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});
  let modP = null;
  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function getModule() {
    if (!modP) modP = (async () => {
      if (!FNF.VORBIS_WASM_B64) throw new Error('vorbis_wasm.js not loaded');
      return WebAssembly.compile(b64ToBytes(FNF.VORBIS_WASM_B64));
    })();
    return modP;
  }
  async function instance() {
    const mod = await getModule();
    const env = { sin: Math.sin, cos: Math.cos, atan: Math.atan, acos: Math.acos, exp: Math.exp, log: Math.log, pow: Math.pow, ldexp: (x, e) => x * Math.pow(2, e) };
    const { exports: x } = await WebAssembly.instantiate(mod, { env });
    return x;
  }
  const f32 = (x, ptr, n) => new Float32Array(x.memory.buffer, ptr, n);
  const ERR = { '-1': 'truncated', '-2': 'corrupt', '-3': 'not Vorbis', '-4': 'bad header' };

  /** Abre um decodificador sobre 'bytes' (copiados para a memória wasm). */
  function openDecoder(x, bytes, name) {
    const dp = x.malloc(bytes.length + 16);
    new Uint8Array(x.memory.buffer, dp, bytes.length).set(bytes);
    const ep = x.malloc(16);
    const h = x.dec_open(dp, bytes.length, ep);
    const err = new Int32Array(x.memory.buffer, ep, 1)[0];
    if (err) { try { x.dec_free(h); } catch (e) { /* ignorado */ } throw new Error(FNF.t('au.err.decode', { name: name || '?', why: ERR[err] || err })); }
    return { h, len: bytes.length, channels: x.dec_channels(h), rate: x.dec_rate(h), done: false };
  }

  /** Lê 'n' quadros (intercalados, canais = ch) já no formato de saída; completa com zeros no fim. Retorna quantos quadros reais vieram. */
  function makeReader(x, d, outCh, outRate, chunk) {
    const inCh = d.channels, rbuf = x.malloc(chunk * inCh * 4 + 64);
    const resample = d.rate !== outRate;
    let src = new Float32Array(0), srcPos = 0, eof = false; // só usado com reamostragem (interpolação linear)
    const ratio = d.rate / outRate;
    const pull = (n) => { // n quadros de origem -> Float32Array intercalado (inCh)
      const got = x.dec_read(d.h, rbuf, n);
      return new Float32Array(x.memory.buffer, rbuf, got * inCh).slice();
    };
    return {
      free() { x.free(rbuf); },
      pos() { return x.dec_pos(d.h) / d.len; },
      /** devolve { data: Float32Array(n*outCh), got } */
      read(n) {
        const out = new Float32Array(n * outCh);
        let got = 0;
        if (!resample) {
          if (!d.done) {
            got = x.dec_read(d.h, rbuf, n);
            if (got < n) d.done = true;
            const s = f32(x, rbuf, got * inCh);
            for (let i = 0; i < got; i++) for (let c = 0; c < outCh; c++) out[i * outCh + c] = s[i * inCh + (inCh === 1 ? 0 : c)];
          }
          return { data: out, got };
        }
        // reamostragem linear (raro: trilhas com taxas diferentes)
        for (let i = 0; i < n; i++) {
          const p = srcPos + i * ratio, i0 = Math.floor(p);
          while (!eof && (i0 + 2) * inCh > src.length + 0 && src.length / inCh < i0 + 2) {
            const more = pull(chunk);
            if (!more.length) { eof = true; break; }
            const merged = new Float32Array(src.length + more.length); merged.set(src); merged.set(more, src.length); src = merged;
          }
          if (i0 >= src.length / inCh) { d.done = true; break; }
          const fr = p - i0, i1 = Math.min(i0 + 1, src.length / inCh - 1);
          for (let c = 0; c < outCh; c++) {
            const ci = inCh === 1 ? 0 : c;
            out[i * outCh + c] = src[i0 * inCh + ci] * (1 - fr) + src[i1 * inCh + ci] * fr;
          }
          got++;
        }
        const consumed = Math.floor(srcPos + n * ratio); srcPos = srcPos + n * ratio - consumed;
        src = src.slice(Math.min(src.length, consumed * inCh));
        if (got < n) d.done = true;
        return { data: out, got };
      },
    };
  }

  /** Lê só os cabeçalhos Ogg: { channels, rate, frames, seconds } (sem decodificar). null se não for Vorbis. */
  function info(b) {
    b = b.bytes || b;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 58 || dv.getUint32(0, false) !== 0x4f676753) return null;
    const nseg = b[26]; const o = 27 + nseg;
    if (b[o] !== 1 || String.fromCharCode(b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6]) !== 'vorbis') return null;
    const channels = b[o + 11], rate = dv.getUint32(o + 12, true);
    let frames = 0;
    for (let i = b.length - 14; i >= 0; i--) {
      if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) {
        const lo = dv.getUint32(i + 6, true), hi = dv.getUint32(i + 10, true);
        if (hi !== 0xffffffff || lo !== 0xffffffff) { frames = hi * 4294967296 + lo; break; }
      }
    }
    return { channels, rate, frames, seconds: rate ? frames / rate : 0 };
  }

  /** Mistura várias trilhas OGG (soma amostra a amostra) e codifica um único OGG Vorbis (VBR). */
  async function mix(opts) {
    const tracks = opts.tracks, quality = opts.quality === undefined ? 0.5 : opts.quality, onProgress = opts.onProgress;
    if (!tracks.length) throw new Error('no tracks');
    const x = await instance();
    const decs = tracks.map((t, i) => openDecoder(x, t.bytes || t, t.name || 'track ' + (i + 1)));
    const outRate = decs[0].rate;
    const outCh = Math.max(...decs.map((d) => d.channels));
    if (decs.some((d) => d.channels !== 1 && d.channels !== outCh)) throw new Error(FNF.t('au.err.channels'));
    const CH = 4096;
    const readers = decs.map((d) => makeReader(x, d, outCh, outRate, CH));
    const enc = x.enc_new(outCh, outRate, quality, (Math.random() * 0x7fffffff) | 0);
    if (!x.enc_ok(enc)) throw new Error(FNF.t('au.err.encinit'));
    const chunks = [];
    const drain = () => { const n = x.enc_out_len(enc); if (n) { chunks.push(new Uint8Array(x.memory.buffer, x.enc_out(enc), n).slice()); x.enc_out_clear(enc); } };
    drain();
    let frames = 0, peak = 0, tick = 0;
    for (;;) {
      let n = 0; const parts = [];
      for (const r of readers) { const p = r.read(CH); parts.push(p.data); if (p.got > n) n = p.got; }
      if (n === 0) break;
      const pp = x.enc_buffer(enc, n);
      const ptrs = new Uint32Array(x.memory.buffer, pp, outCh);
      for (let c = 0; c < outCh; c++) {
        const dst = f32(x, ptrs[c], n);
        for (let i = 0; i < n; i++) {
          let s = 0; for (let k = 0; k < parts.length; k++) s += parts[k][i * outCh + c];
          dst[i] = s; const a = s < 0 ? -s : s; if (a > peak) peak = a;
        }
      }
      x.enc_wrote(enc, n); drain(); frames += n;
      if (onProgress && (++tick & 7) === 0) { await onProgress(Math.max(...readers.map((r) => r.pos()))); }
    }
    x.enc_wrote(enc, 0); drain();
    readers.forEach((r) => r.free());
    decs.forEach((d) => x.dec_free(d.h));
    x.enc_free(enc);
    let total = 0; for (const c of chunks) total += c.length;
    const bytes = new Uint8Array(total); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    return { bytes, channels: outCh, rate: outRate, frames, seconds: frames / outRate, peak };
  }

  /** Decodifica tudo para PCM float (planar). Usado em testes e verificações. */
  async function decode(bytes, name) {
    const x = await instance(), d = openDecoder(x, bytes, name), CH = 8192;
    const rbuf = x.malloc(CH * d.channels * 4 + 64), chans = Array.from({ length: d.channels }, () => []);
    for (;;) {
      const got = x.dec_read(d.h, rbuf, CH); if (!got) break;
      const s = f32(x, rbuf, got * d.channels);
      for (let c = 0; c < d.channels; c++) { const a = new Float32Array(got); for (let i = 0; i < got; i++) a[i] = s[i * d.channels + c]; chans[c].push(a); }
    }
    x.free(rbuf); x.dec_free(d.h);
    const flat = chans.map((list) => { const n = list.reduce((s, a) => s + a.length, 0), o = new Float32Array(n); let p = 0; for (const a of list) { o.set(a, p); p += a.length; } return o; });
    return { channels: d.channels, rate: d.rate, data: flat, frames: flat[0] ? flat[0].length : 0 };
  }

  /** Codifica PCM float planar (data: [Float32Array por canal]) em OGG Vorbis. */
  async function encodePCM(opts) {
    const x = await instance(), ch = opts.data.length, n = opts.data[0].length;
    const enc = x.enc_new(ch, opts.rate, opts.quality === undefined ? 0.5 : opts.quality, 1);
    if (!x.enc_ok(enc)) throw new Error(FNF.t('au.err.encinit'));
    const chunks = [], drain = () => { const k = x.enc_out_len(enc); if (k) { chunks.push(new Uint8Array(x.memory.buffer, x.enc_out(enc), k).slice()); x.enc_out_clear(enc); } };
    drain();
    for (let o = 0; o < n; o += 4096) {
      const m = Math.min(4096, n - o), ptrs = new Uint32Array(x.memory.buffer, x.enc_buffer(enc, m), ch);
      for (let c = 0; c < ch; c++) f32(x, ptrs[c], m).set(opts.data[c].subarray(o, o + m));
      x.enc_wrote(enc, m); drain();
    }
    x.enc_wrote(enc, 0); drain(); x.enc_free(enc);
    let total = 0; for (const c of chunks) total += c.length;
    const bytes = new Uint8Array(total); let p = 0; for (const c of chunks) { bytes.set(c, p); p += c.length; }
    return bytes;
  }

  FNF.vorbis = { info, mix, decode, encodePCM };
})(typeof self !== 'undefined' ? self : globalThis);
