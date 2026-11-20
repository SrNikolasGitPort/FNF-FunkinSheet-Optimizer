const assert = require('assert');
const FNF = require('./load.js');
require('../js/demo.js');
(async () => {
  const d = FNF.pairFiles(await FNF.makeDemo()), a = d.atlases[0];
  const input = { name: 'atlas.png', bytes: a.pngBytes };
  const dec = await FNF.decodePNG(a.pngBytes);
  const lossless = await FNF.compressImage(input, { quality: 'lossless' });
  const dl = await FNF.decodePNG(lossless.bytes);
  const keep = (x) => { const o = new Uint8Array(x); for (let i = 0; i < o.length; i += 4) if (!o[i + 3]) o[i] = o[i + 1] = o[i + 2] = 0; return o; };
  assert.deepStrictEqual(Array.from(dl.data), Array.from(keep(dec.data)), 'lossless deve manter todos os pixels visíveis');
  const bal = await FNF.compressImage(input, { quality: 'balanced' });
  const small = await FNF.compressImage(input, { quality: 'small' });
  assert.ok(bal.bytes.length <= lossless.bytes.length && small.bytes.length <= bal.bytes.length);
  assert.ok(bal.psnr >= 38 || bal.kept || bal.psnr === 99, 'psnr ' + bal.psnr);
  const as = await FNF.compressImage(input, { format: 'astc', quality: 'balanced' });
  assert.ok(/\.astc$/.test(as.name) && as.psnr >= 38, as.kind + ' ' + as.psnr);
  const back = await FNF.compressImage({ name: as.name, bytes: as.bytes }, { format: 'png', quality: 'lossless' });
  assert.ok(/\.png$/.test(back.name));
  console.log('  ok compress: original', input.bytes.length, '→ sem perdas', lossless.bytes.length, '| equilibrado', bal.bytes.length, '(' + bal.kind + ',', (bal.psnr || 0).toFixed(1), 'dB) | pequeno', small.bytes.length, '| ASTC', as.bytes.length, as.kind);
  // escala: reduz a imagem em pixels antes de comprimir (PNG e ASTC)
  for (const fmt of ['png', 'astc']) {
    const sc = await FNF.compressImage(input, { format: fmt, quality: 'balanced', scale: 0.5 });
    const w = Math.round(dec.width * 0.5), h = Math.round(dec.height * 0.5);
    assert.ok(sc.width === w && sc.height === h && sc.origW === dec.width && sc.scale === 0.5, fmt + ' dimensões');
    assert.ok(!sc.kept, 'com escala não pode manter o original');
    const back2 = fmt === 'png' ? await FNF.decodePNG(sc.bytes) : FNF.decodeASTC(sc.bytes);
    assert.ok(back2.width === w && back2.height === h, fmt + ' arquivo com as dimensões novas');
    assert.ok(sc.bytes.length < bal.bytes.length || fmt === 'astc', fmt + ' menor');
  }
  console.log('  ok compress com escala 0.5 (PNG e ASTC)');
  console.log('compress.test: TUDO OK');
})().catch((e) => { console.error(e); process.exit(1); });
