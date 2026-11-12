'use strict';
// Decoder PNG contra PNGs gerados pelo Pillow (paleta, cinza, 1 bit, 16 bits, Adam7) + roundtrip do encoder.
const fs = require('fs'), path = require('path');
const FNF = require('./load.js');
const assert = require('assert');

(async () => {
  const dir = path.join(__dirname, 'fixtures');
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.png'))) {
    const base = f.replace('.png', '');
    const exp = fs.readFileSync(path.join(dir, base + '.expected.rgba'));
    const img = await FNF.decodePNG(new Uint8Array(fs.readFileSync(path.join(dir, f))));
    assert.strictEqual(img.data.length, exp.length, base + ': tamanho');
    let bad = 0;
    for (let i = 0; i < exp.length; i += 4) {
      // quando alpha == 0 o RGB é irrelevante
      if (img.data[i + 3] !== exp[i + 3] || (exp[i + 3] !== 0 && (img.data[i] !== exp[i] || img.data[i + 1] !== exp[i + 1] || img.data[i + 2] !== exp[i + 2]))) bad++;
    }
    assert.strictEqual(bad, 0, base + ': ' + bad + ' pixels diferentes');
    console.log('  ok decode', base);
    n++;
  }
  // roundtrip do encoder: rgba / auto(paleta exata) / quantize
  const rgba = new Uint8Array(fs.readFileSync(path.join(dir, 'rgba8.expected.rgba')));
  const w = 37, h = 23;
  for (const mode of ['rgba', 'auto']) {
    const enc = await FNF.encodePNG(rgba, w, h, { mode });
    const dec = await FNF.decodePNG(enc.bytes);
    let bad = 0;
    for (let i = 0; i < rgba.length; i += 4) if (dec.data[i + 3] !== rgba[i + 3] || (rgba[i + 3] && (dec.data[i] !== rgba[i] || dec.data[i + 1] !== rgba[i + 1] || dec.data[i + 2] !== rgba[i + 2]))) bad++;
    assert.strictEqual(bad, 0, 'roundtrip ' + mode);
    console.log('  ok encode', mode, enc.kind, enc.bytes.length + ' bytes');
  }
  // paletas pequenas (1/2/4/8 bits)
  for (const k of [2, 3, 12, 200]) {
    const img = new Uint8Array(40 * 30 * 4);
    for (let i = 0; i < 40 * 30; i++) { const c = (i * 7) % k; img.set([c * 20 % 256, c * 9 % 256, c * 3 % 256, c === 1 ? 128 : 255], i * 4); }
    const enc = await FNF.encodePNG(img, 40, 30, { mode: 'auto' });
    const dec = await FNF.decodePNG(enc.bytes);
    assert.deepStrictEqual(Array.from(dec.data), Array.from(img), 'paleta ' + k);
    console.log('  ok palette', k, enc.kind);
  }
  // quantização
  const big = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) big.set([x * 4, y * 4, (x + y) * 2, x > 50 ? 0 : 255], (y * 64 + x) * 4);
  for (const dither of [false, true]) {
    const enc = await FNF.encodePNG(big, 64, 64, { mode: 'quantize', colors: 32, dither });
    const dec = await FNF.decodePNG(enc.bytes);
    let err = 0, c = 0;
    for (let i = 0; i < big.length; i += 4) { if (big[i + 3] !== dec.data[i + 3]) err += 1000; else if (big[i + 3]) { err += Math.abs(big[i] - dec.data[i]) + Math.abs(big[i + 1] - dec.data[i + 1]); c++; } }
    console.log('  ok quantize dither=' + dither, enc.kind, 'erro médio', (err / c).toFixed(1));
    assert.ok(err / c < 40); // soma de 2 canais, 32 cores num gradiente 3D
  }
  console.log('png.test: ' + n + ' arquivos decodificados OK');
})().catch((e) => { console.error(e); process.exit(1); });
