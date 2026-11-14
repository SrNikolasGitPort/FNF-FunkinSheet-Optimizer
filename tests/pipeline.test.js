'use strict';
// Pipeline completo com um atlas sintético: S=1 deve ser idêntico ao original; S<1 deve manter alinhamento.
const fs = require('fs'), path = require('path');
const assert = require('assert');
const FNF = require('./load.js');

// ---- atlas sintético: 24 frames virtuais 220×260, bolinha antialiased que se move, com margens transparentes
const FW = 220, FH = 260;
function drawFrame(i, kind) {
  const d = new Uint8Array(FW * FH * 4);
  const cx = 70 + (kind === 'moving' ? (i % 7) * 12 : 0), cy = 120 + (kind === 'moving' ? Math.round(10 * Math.sin(i)) : 0), r = 38 + (kind === 'moving' ? i % 5 : 0);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const dist = Math.hypot(x - cx, y - cy);
    const a = Math.max(0, Math.min(1, r - dist + 0.5));
    if (a > 0) d.set([Math.round(255 * (x / FW)), Math.round(255 * (y / FH)), 180, Math.round(a * 255)], (y * FW + x) * 4);
  }
  return d;
}
async function buildAtlas(name) {
  const frames = [];
  const W = 1100, H = 1500, atlas = new Uint8Array(W * H * 4);
  let ox = 0, oy = 0;
  const xml = [];
  const bitmaps = [];
  for (let i = 0; i < 24; i++) {
    let bmp;
    if (i === 6 || i === 7) bmp = bitmaps[5];            // duplicatas exatas
    else if (i === 12) bmp = bitmaps[2];                 // outra duplicata
    else bmp = drawFrame(i, 'moving');
    bitmaps.push(bmp);
  }
  for (let i = 0; i < 24; i++) {
    if (ox + FW > W) { ox = 0; oy += FH; }
    for (let y = 0; y < FH; y++) atlas.set(bitmaps[i].subarray(y * FW * 4, (y + 1) * FW * 4), ((oy + y) * W + ox) * 4);
    const pre = 'idle' + (i < 12 ? '' : 'B');
    xml.push('<SubTexture name="' + pre + String(i + 1).padStart(4, '0') + '" x="' + ox + '" y="' + oy + '" width="' + FW + '" height="' + FH + '"/>');
    ox += FW;
  }
  // 2 frames já cortados na origem, com frameX/frameY negativos (formato típico do Animate)
  const crop = { x: 30, y: 60, w: 90, h: 100 };
  const tight = new Uint8Array(crop.w * crop.h * 4);
  for (let y = 0; y < crop.h; y++) tight.set(bitmaps[3].subarray(((crop.y + y) * FW + crop.x) * 4, ((crop.y + y) * FW + crop.x + crop.w) * 4), y * crop.w * 4);
  const px = 900, py = 1310;
  for (let y = 0; y < crop.h; y++) atlas.set(tight.subarray(y * crop.w * 4, (y + 1) * crop.w * 4), ((py + y) * W + px) * 4);
  xml.push('<SubTexture name="cut0001" x="' + px + '" y="' + py + '" width="' + crop.w + '" height="' + crop.h + '" frameX="-' + crop.x + '" frameY="-' + crop.y + '" frameWidth="' + FW + '" frameHeight="' + FH + '"/>');
  xml.push('<SubTexture name="cut0002" x="' + px + '" y="' + py + '" width="' + crop.w + '" height="' + crop.h + '" frameX="-' + crop.x + '" frameY="-' + crop.y + '" frameWidth="' + FW + '" frameHeight="' + FH + '"/>');
  // frame totalmente transparente
  xml.push('<SubTexture name="empty0001" x="1000" y="1400" width="30" height="30" frameX="-5" frameY="-5" frameWidth="40" frameHeight="40"/>');
  const png = (await FNF.encodePNG(atlas, W, H, { mode: 'rgba' })).bytes;
  const xmlText = '<?xml version="1.0" encoding="utf-8"?>\n<TextureAtlas imagePath="' + name + '.png">\n\t' + xml.join('\n\t') + '\n</TextureAtlas>\n';
  return { name, dir: '', pngBytes: png, xmlText };
}

const kb = (n) => (n / 1024).toFixed(1) + 'KB';
(async () => {
  const atlas = await buildAtlas('Boyfriend_Assets');
  console.log('atlas sintético: PNG ' + kb(atlas.pngBytes.length) + ', XML ' + kb(atlas.xmlText.length));

  // ---- 1) S = 1: sem perdas
  let r = await FNF.optimizeAtlas(atlas, { scale: 1 });
  console.log('S=1:', 'PNG', kb(r.stats.pngBefore), '→', kb(r.stats.pngAfter), r.stats.pngKind, '| atlas', r.atlas.w + '×' + r.atlas.h, '| únicos', r.stats.framesUnique + '/' + r.stats.framesTotal, '| validação', r.validation.ok ? 'OK' : r.validation.errors);
  assert.ok(r.validation.ok, 'validação S=1: ' + r.validation.errors.join('; '));
  assert.ok(r.stats.pngAfter < r.stats.pngBefore);
  assert.strictEqual(r.stats.framesUnique, 23, 'dedup'); // 27 entradas: 3 duplicatas de bitmap + cut0002 = cut0001
  // verificação independente: recompor cada frame e comparar com o original
  const o = await FNF.decodePNG(atlas.pngBytes), oSp = FNF.parseSparrow(atlas.xmlText);
  const n = await FNF.decodePNG(r.pngBytes), nSp = FNF.parseSparrow(r.xmlText);
  assert.deepStrictEqual(nSp.frames.map((f) => f.name), oSp.frames.map((f) => f.name));
  for (let i = 0; i < oSp.frames.length; i++) {
    const A = FNF.composeFrame(o, oSp.frames[i]), B = FNF.composeFrame(n, nSp.frames[i]);
    assert.strictEqual(nSp.frames[i].fw, oSp.frames[i].fw);
    for (let k = 0; k < A.length; k += 4) {
      assert.ok(A[k + 3] === B[k + 3] && (A[k + 3] === 0 || (A[k] === B[k] && A[k + 1] === B[k + 1] && A[k + 2] === B[k + 2])), 'frame ' + oSp.frames[i].name + ' difere');
    }
  }
  console.log('  ok S=1 pixel-perfect em', oSp.frames.length, 'frames');
  const emptyF = nSp.frames.find((f) => f.name === 'empty0001');
  assert.strictEqual(emptyF.w * emptyF.h, 1);

  // ---- 2) escalas
  for (const S of [0.75, 0.5, 0.25, 0.1]) {
    const rs = await FNF.optimizeAtlas(atlas, { scale: S });
    console.log('S=' + S + ':', 'PNG', kb(rs.stats.pngAfter), '| atlas', rs.atlas.w + '×' + rs.atlas.h, '| seff', rs.seff.toFixed(4), '| PSNR mín', rs.validation.psnrMin && rs.validation.psnrMin.toFixed(1), '| ok', rs.validation.ok);
    assert.ok(rs.validation.ok, JSON.stringify(rs.validation.errors));
    const sp = FNF.parseSparrow(rs.xmlText);
    assert.strictEqual(sp.frames[0].fw, Math.max(1, Math.round(220 * rs.Sx)));
    if (S >= 0.25) assert.ok(rs.validation.psnrMin > 25, 'PSNR baixo');
  }
  for (const filter of ['bilinear', 'lanczos']) {
    const rs = await FNF.optimizeAtlas(atlas, { scale: 0.5, filter });
    assert.ok(rs.validation.ok); console.log('  ok filtro', filter, 'PSNR', rs.validation.psnrMin.toFixed(1));
  }
  // opções: pow2, quantize, near dedup, agressivo
  const p2 = await FNF.optimizeAtlas(atlas, { scale: 0.5, pow2: true });
  assert.ok((p2.atlas.w & (p2.atlas.w - 1)) === 0 && (p2.atlas.h & (p2.atlas.h - 1)) === 0); console.log('  ok pow2', p2.atlas.w + '×' + p2.atlas.h);
  const q = await FNF.optimizeAtlas(atlas, { scale: 0.5, pngMode: 'quantize', colors: 64 });
  console.log('  ok quantize 64:', kb(q.stats.pngAfter), q.stats.pngKind, 'PSNR', q.validation.psnrMin.toFixed(1)); assert.ok(q.validation.ok);
  const ag = await FNF.optimizeAtlas(atlas, { scale: 1, alphaThreshold: 8, aggressive: true });
  console.log('  ok agressivo:', kb(ag.stats.pngAfter), 'PSNR', ag.validation.psnrMin.toFixed(1));
  const nd = await FNF.optimizeAtlas(atlas, { scale: 1, nearDedup: true, nearTolerance: 3 });
  console.log('  ok near-dedup únicos', nd.stats.framesUnique);
  const nodedup = await FNF.optimizeAtlas(atlas, { scale: 1, dedup: false });
  assert.ok(nodedup.stats.framesUnique >= r.stats.framesUnique); console.log('  ok sem dedup únicos', nodedup.stats.framesUnique);
  const notrim = await FNF.optimizeAtlas(atlas, { scale: 1, trim: false, dedup: false });
  assert.ok(notrim.validation.ok); console.log('  ok sem trim/dedup PNG', kb(notrim.stats.pngAfter));

  // ---- 3) rotated e fora dos limites
  {
    // rotated="true": região guardada girada 90° horário; o resultado deve ser idêntico ao do atlas sem rotação
    const src = await FNF.decodePNG(atlas.pngBytes);
    const f0 = FNF.parseSparrow(atlas.xmlText).frames[0];
    const upright = new Uint8Array(f0.w * f0.h * 4), rot = new Uint8Array(f0.h * f0.w * 4);
    for (let y = 0; y < f0.h; y++) for (let x = 0; x < f0.w; x++) {
      const s0 = ((f0.y + y) * src.width + f0.x + x) * 4;
      upright.set(src.data.subarray(s0, s0 + 4), (y * f0.w + x) * 4);
      // CW: (x,y) -> (H-1-y, x) numa imagem de largura H
      rot.set(src.data.subarray(s0, s0 + 4), (x * f0.h + (f0.h - 1 - y)) * 4);
    }
    const mk = async (data, w, h, rotated) => ({
      name: 'rot', pngBytes: (await FNF.encodePNG(data, w, h, { mode: 'rgba' })).bytes,
      xmlText: '<TextureAtlas imagePath="rot.png"><SubTexture name="a0001" x="0" y="0" width="' + w + '" height="' + h + '"' + (rotated ? ' rotated="true"' : '') + '/></TextureAtlas>',
    });
    const A = await FNF.optimizeAtlas(await mk(upright, f0.w, f0.h, false), { scale: 1 });
    const B = await FNF.optimizeAtlas(await mk(rot, f0.h, f0.w, true), { scale: 1 });
    assert.ok(B.validation.ok, B.validation.errors.join());
    assert.deepStrictEqual(Array.from(B.pngBytes), Array.from(A.pngBytes), 'rotated deve gerar o mesmo PNG do atlas sem rotação');
    assert.strictEqual(B.xmlText, A.xmlText); assert.ok(!/rotated/.test(B.xmlText));
    const B2 = await FNF.optimizeAtlas(await mk(rot, f0.h, f0.w, true), { scale: 0.5 });
    assert.ok(B2.validation.ok && B2.validation.psnrMin > 30);
    console.log('  ok rotated="true" idêntico ao atlas sem rotação (S=1) e ok com S=0.5');
  }
  {
    // frame apontando além do PNG: tolerado (área faltante vira transparente) com aviso
    const big = await FNF.optimizeAtlas({ ...atlas, xmlText: atlas.xmlText.replace('x="0" y="0"', 'x="' + (FNF.parseSparrow(atlas.xmlText).frames[0].x + 5000) + '" y="0"') }, { scale: 1 });
    assert.ok(big.warnings.some((w) => /outside the image/.test(w)) && big.validation.ok, 'deve tolerar frame fora do PNG');
  }
  await assert.rejects(() => FNF.optimizeAtlas({ ...atlas, xmlText: '<foo/>' }, {}), /TextureAtlas/);
  console.log('  ok erros de entrada');

  // ---- 4) lote com configs do Leather (exemplo real do usuário) + 2 atlas (extraSheets)
  const ex = path.join(__dirname, '..', 'examples', 'BF');
  const cfgBytes = new Uint8Array(fs.readFileSync(path.join(ex, 'config.json')));
  const offBytes = new Uint8Array(fs.readFileSync(path.join(ex, 'offsets.txt')));
  const cheer = Object.assign({}, atlas, { name: 'BFCheer' });
  const paired = FNF.pairFiles([
    { name: 'Boyfriend_Assets.png', path: 'BF/Boyfriend_Assets.png', bytes: atlas.pngBytes }, { name: 'Boyfriend_Assets.xml', path: 'BF/Boyfriend_Assets.xml', bytes: FNF.textEncode(atlas.xmlText) },
    { name: 'BFCheer.png', path: 'BF/BFCheer.png', bytes: cheer.pngBytes }, { name: 'BFCheer.xml', path: 'BF/BFCheer.xml', bytes: FNF.textEncode(cheer.xmlText) },
    { name: 'config.json', path: 'BF/config.json', bytes: cfgBytes }, { name: 'offsets.txt', path: 'BF/offsets.txt', bytes: offBytes },
  ]);
  assert.strictEqual(paired.atlases.length, 2); assert.strictEqual(paired.configs.length, 1); assert.strictEqual(paired.configs[0].kind, 'leather'); assert.ok(paired.configs[0].offsets);
  let b = await FNF.runBatch({ atlases: paired.atlases, configs: paired.configs, opts: { scale: 1 } });
  assert.ok(b.results.every((x) => x.validation.ok));
  assert.deepStrictEqual(Array.from(b.configs[0].bytes), Array.from(cfgBytes), 'config.json deve ficar idêntico com S=1');
  assert.deepStrictEqual(Array.from(b.configs[0].offsets.bytes), Array.from(offBytes), 'offsets.txt deve ficar byte a byte idêntico com S=1');
  console.log('  ok Leather S=1: config.json e offsets.txt idênticos byte a byte');
  b = await FNF.runBatch({ atlases: paired.atlases, configs: paired.configs, opts: { scale: 0.5, suffix: '_opt', addScaleField: false, adjustOffsets: false } });
  assert.ok(b.results.every((x) => x.validation.ok));
  assert.strictEqual(b.results[0].Sx, b.results[1].Sx, 'extraSheets devem usar a mesma escala efetiva');
  const c = b.configs[0];
  assert.ok(c.warnings.some((w) => /no scale field/.test(w)), 'deve avisar que não há campo de escala');
  assert.strictEqual(JSON.parse(c.text).imagePath, 'Boyfriend_Assets_opt'); assert.deepStrictEqual(JSON.parse(c.text).extraSheets, ['BFCheer_opt']);
  assert.strictEqual(c.offsets.text, FNF.textDecode(offBytes), 'offsets inalterados por padrão');
  // só 2 trechos mudaram: nada mais
  assert.strictEqual(c.text.replace('"Boyfriend_Assets_opt"', '"Boyfriend_Assets"').replace('"BFCheer_opt"', '"BFCheer"'), c.before);
  console.log('  ok Leather S=0.5: aviso de escala ausente, nomes _opt, resto do JSON intacto');
  b = await FNF.runBatch({ atlases: paired.atlases, configs: paired.configs, opts: { scale: 0.5, addScaleField: true, adjustOffsets: false, scaleOffsets: true } });
  const c2 = b.configs[0];
  assert.ok(JSON.parse(c2.text).scale > 1.9 && JSON.parse(c2.text).scale < 2.1);
  assert.ok(/^scared 2 -1\r?$/m.test(c2.offsets.text.split('\n')[0]) || /^scared /m.test(c2.offsets.text));
  assert.ok(!c2.offsets.text.endsWith('\n'), 'sem newline final preservado');
  console.log('  ok Leather scale adicionado =', JSON.parse(c2.text).scale, '| primeira linha offsets:', c2.offsets.text.split('\n')[0]);

  // ---- 5) Psych
  const psych = '{\n\t"animations": [\n\t\t{ "anim": "idle", "name": "BF idle dance", "fps": 24, "loop": false, "offsets": [0, 0] }\n\t],\n\t"vocals_file": "",\n\t"no_antialiasing": false,\n\t"image": "characters/Boyfriend_Assets",\n\t"position": [0, 350],\n\t"healthicon": "bf",\n\t"flip_x": true,\n\t"healthbar_colors": [49, 176, 209],\n\t"camera_position": [0, 0],\n\t"sing_duration": 4,\n\t"scale": 1.2\n}\n';
  const pp = FNF.pairFiles([{ name: 'Boyfriend_Assets.png', path: 'Boyfriend_Assets.png', bytes: atlas.pngBytes }, { name: 'Boyfriend_Assets.xml', path: 'Boyfriend_Assets.xml', bytes: FNF.textEncode(atlas.xmlText) }, { name: 'bf.json', path: 'bf.json', bytes: FNF.textEncode(psych) }]);
  assert.strictEqual(pp.configs[0].kind, 'psych');
  b = await FNF.runBatch({ atlases: pp.atlases, configs: pp.configs, opts: { scale: 0.5, adjustOffsets: false } });
  const pj = b.configs[0];
  const newScale = JSON.parse(pj.text).scale;
  console.log('  ok Psych scale 1.2 →', newScale, '(fator', pj.invScale.toFixed(4) + ')');
  assert.ok(Math.abs(newScale - 1.2 * pj.invScale) < 1e-3);
  assert.strictEqual(pj.text.replace(/"scale": [\d.]+/, '"scale": 1.2'), psych, 'só o scale muda');
  // sem campo scale: é adicionado
  const noScale = psych.replace(',\n\t"scale": 1.2', '');
  const pp2 = FNF.pairFiles([{ name: 'Boyfriend_Assets.png', path: 'a.png', bytes: atlas.pngBytes }, { name: 'Boyfriend_Assets.xml', path: 'a.xml', bytes: FNF.textEncode(atlas.xmlText) }, { name: 'bf.json', path: 'bf.json', bytes: FNF.textEncode(noScale) }]);
  b = await FNF.runBatch({ atlases: pp2.atlases, configs: pp2.configs, opts: { scale: 0.25 } });
  assert.ok(JSON.parse(b.configs[0].text).scale > 3.5); assert.strictEqual(JSON.parse(b.configs[0].text).image, 'characters/Boyfriend_Assets');
  console.log('  ok Psych sem scale: adicionado', JSON.parse(b.configs[0].text).scale);

  // ---- 5b) offsets + escala automática
  {
    const psychO = psych.replace('"offsets": [0, 0]', '"offsets": [10, -20.5]');
    const po = FNF.pairFiles([{ name: 'Boyfriend_Assets.png', path: 'a.png', bytes: atlas.pngBytes }, { name: 'Boyfriend_Assets.xml', path: 'a.xml', bytes: FNF.textEncode(atlas.xmlText) }, { name: 'bf.json', path: 'bf.json', bytes: FNF.textEncode(psychO) }]);
    const bo = await FNF.runBatch({ atlases: po.atlases, configs: po.configs, opts: { scale: 0.5 } });
    const j0 = JSON.parse(psychO), j1 = JSON.parse(bo.configs[0].text), r0 = bo.results[0];
    const C = [r0.ref.fw0 / 2, r0.ref.fh0 / 2], C1 = [r0.ref.fw1 / 2, r0.ref.fh1 / 2];
    const s0 = j0.scale, s1 = j1.scale, o0 = j0.animations[0].offsets, o1 = j1.animations[0].offsets;
    // posição na tela (Flixel): -offset + C + s*(P-C), antes e depois, para um ponto do frame virtual
    for (const P of [[0, 0], [100, 130], [220, 260]]) {
      const a = [-o0[0] + C[0] + s0 * (P[0] - C[0]), -o0[1] + C[1] + s0 * (P[1] - C[1])];
      const P1 = [P[0] * r0.Sx, P[1] * r0.Sy];
      const b = [-o1[0] + C1[0] + s1 * (P1[0] - C1[0]), -o1[1] + C1[1] + s1 * (P1[1] - C1[1])];
      assert.ok(Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01, 'alinhamento: ' + a + ' vs ' + b);
    }
    assert.deepStrictEqual(o1, [-45, -85.5]);
    console.log('  ok Psych offsets ajustados', o0, '→', o1, '(alinhamento na tela conferido)');
    // Leather: offsets.txt recebe o mesmo deslocamento
    const bl = await FNF.runBatch({ atlases: paired.atlases, configs: paired.configs, opts: { scale: 0.5 } });
    assert.ok(JSON.parse(bl.configs[0].text).scale > 1.9);
    const l0 = FNF.textDecode(offBytes).split('\n')[0], l1 = bl.configs[0].offsets.text.split('\n')[0];
    assert.notStrictEqual(l0, l1); console.log('  ok Leather offsets:', l0.trim(), '→', l1.trim());
    // escala automática
    const au = await FNF.optimizeAtlas(atlas, {});
    assert.ok(au.auto && au.scale < 1 && au.validation.ok, 'auto deve reduzir: ' + au.scale);
    const au2 = await FNF.optimizeAtlas(atlas, { autoPsnr: 45 });
    assert.ok(au2.scale >= au.scale);
    console.log('  ok escala automática', au.scale, '(PSNR 30) e', au2.scale, '(PSNR 45)');
  }

  // ---- 5c) remover animações / frames
  {
    const names = FNF.parseSparrow(atlas.xmlText).frames.map((f) => f.name);
    const key = names[0].replace(/\d+$/, ''), idle = names.filter((n) => n.startsWith(key)), psychK = psych.replace('BF idle dance', key);
    assert.ok(idle.length > 3);
    const pr = FNF.pairFiles([{ name: 'Boyfriend_Assets.png', path: 'a.png', bytes: atlas.pngBytes }, { name: 'Boyfriend_Assets.xml', path: 'a.xml', bytes: FNF.textEncode(atlas.xmlText) }, { name: 'bf.json', path: 'bf.json', bytes: FNF.textEncode(psychK) }]);
    pr.atlases[0].removeNames = idle;
    const b = await FNF.runBatch({ atlases: pr.atlases, configs: pr.configs, opts: { scale: 1 } });
    const left = FNF.parseSparrow(b.results[0].xmlText).frames.map((f) => f.name);
    assert.strictEqual(left.length, names.length - idle.length);
    assert.ok(!left.some((n) => n.startsWith(key)) && b.results[0].validation.ok);
    assert.ok(b.configs[0].warnings.some((w) => /no frames left/.test(w)), 'deve avisar sobre a animação sem frames');
    pr.atlases[0].removeNames = names;
    await assert.rejects(() => FNF.optimizeAtlas(pr.atlases[0], { scale: 1 }), /All frames/);
    console.log('  ok remoção de frames:', idle.length, 'removidos, aviso no config');
  }

  // ---- 6) ZIP
  const files = FNF.collectOutputs(b);
  const zip = await FNF.makeZip(files);
  fs.writeFileSync(path.join(require('os').tmpdir(), 'fnf-test-out.zip'), zip);
  console.log('  ok zip', files.map((f) => f.path).join(', '), zip.length + ' bytes');
  console.log('pipeline.test: TUDO OK');
})().catch((e) => { console.error(e); process.exit(1); });
