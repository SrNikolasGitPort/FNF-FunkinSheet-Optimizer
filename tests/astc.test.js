// Testes do codec ASTC: ida e volta, blocos vazios/constantes e pipeline com entrada/saída .astc
const assert = require('assert');
const FNF = require('./load.js');
require('../js/demo.js');
(async () => {
  const w = 37, h = 29, px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, inside = (x - 18) ** 2 + (y - 14) ** 2 < 100;
    px.set(inside ? [200 - x * 3, 60 + y * 4, 120, 255 - (x + y) % 40] : [0, 0, 0, 0], i);
  }
  for (const [bw, bh] of [[4, 4], [5, 5], [6, 6], [8, 8], [10, 6], [12, 12]]) {
    const enc = FNF.encodeASTC(px, w, h, { bw, bh });
    assert.strictEqual(enc.length, 16 + Math.ceil(w / bw) * Math.ceil(h / bh) * 16);
    const dec = FNF.decodeASTC(enc);
    assert.deepStrictEqual([dec.width, dec.height, dec.badBlocks], [w, h, 0]);
    let se = 0, n = 0;
    for (let i = 0; i < w * h; i++) { const a = px[i * 4 + 3] / 255, b = dec.data[i * 4 + 3] / 255; for (let c = 0; c < 3; c++) { const e = px[i * 4 + c] * a - dec.data[i * 4 + c] * b; se += e * e; n++; } }
    const psnr = 10 * Math.log10(65025 / (se / n + 1e-9));
    assert.ok(psnr > (bw * bh > 64 ? 24 : 30), bw + 'x' + bh + ' PSNR ' + psnr);
    console.log('  ok ASTC ' + bw + 'x' + bh + ' PSNR ' + psnr.toFixed(1));
  }
  // bloco totalmente transparente e bloco de cor constante -> exatos
  const flat = new Uint8Array(16 * 4); for (let i = 0; i < 16; i++) flat.set([10, 20, 30, 255], i * 4);
  assert.deepStrictEqual(Array.from(FNF.decodeASTC(FNF.encodeASTC(flat, 4, 4, { bw: 4, bh: 4 })).data), Array.from(flat));
  assert.ok(FNF.decodeASTC(FNF.encodeASTC(new Uint8Array(64), 4, 4, { bw: 4, bh: 4 })).data.every((v) => v === 0));
  // cabeçalho inválido
  assert.throws(() => FNF.decodeASTC(new Uint8Array(32)), /astc/i);

  // pipeline: PNG -> ASTC e ASTC -> ASTC
  const demo = FNF.pairFiles(await FNF.makeDemo()), a = demo.atlases[0];
  const out = await FNF.optimizeAtlas(a, { scale: 0.5, format: 'astc', astcBlock: '6x6' });
  assert.ok(/\.astc$/.test(out.pngName) && out.xmlText.includes(out.pngName), out.pngName);
  assert.ok(out.validation.ok, out.validation.errors.join());
  const img = await FNF.decodePNG(a.pngBytes);
  const astcIn = { ...a, pngBytes: FNF.encodeASTC(img.data, img.width, img.height, { bw: 6, bh: 6 }) };
  const out2 = await FNF.optimizeAtlas(astcIn, { scale: 0.5 });
  assert.ok(/\.astc$/.test(out2.pngName) && out2.validation.ok, 'entrada ASTC mantém ASTC');
  assert.ok(out2.stats.pngAfter < out2.stats.pngBefore);
  const out3 = await FNF.optimizeAtlas(astcIn, { scale: 1, format: 'png' });
  assert.ok(/\.png$/.test(out3.pngName));
  console.log('  ok pipeline ASTC:', out.stats.pngAfter, 'bytes (PNG→ASTC),', out2.stats.pngBefore, '→', out2.stats.pngAfter, '(ASTC→ASTC)');
  console.log('astc.test: TUDO OK');
})().catch((e) => { console.error(e); process.exit(1); });
