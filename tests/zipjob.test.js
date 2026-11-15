'use strict';
// ZIP completo: acha atlas/configs onde estiverem, otimiza no lugar e preserva o resto byte a byte.
const assert = require('assert');
const FNF = require('./load.js');

async function makeAtlas(seed, prefix) {
  const W = 900, H = 260, d = new Uint8Array(W * H * 4), xml = [];
  for (let i = 0; i < 8; i++) {
    const ox = i * 110, cx = 45 + (i % 4) * 4, cy = 50 + (i % 3) * 3, r = 36 + (i % 3);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 100; x++) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) d.set([(x * 5 + seed * 40) & 255, (y * 3 + i * 20) & 255, 160, Math.round(a * 255)], (y * W + ox + x) * 4);
    }
    xml.push('<SubTexture name="' + prefix + String(i).padStart(4, '0') + '" x="' + ox + '" y="0" width="100" height="120" frameX="-10" frameY="-8" frameWidth="120" frameHeight="140"/>');
  }
  return { png: (await FNF.encodePNG(d, W, H, { mode: 'rgba' })).bytes, xml: '<TextureAtlas imagePath="a.png">' + xml.join('') + '</TextureAtlas>' };
}
const T = (s) => FNF.textEncode(s);
const psychCfg = (img) => '{\n\t"animations": [\n\t\t{ "anim": "idle", "name": "idle", "fps": 24, "loop": false, "offsets": [10, 20] }\n\t],\n\t"image": "' + img + '",\n\t"position": [0, 0],\n\t"flip_x": false,\n\t"scale": 1\n}\n';

(async () => {
  const bf = await makeAtlas(1, 'idle'), dad = await makeAtlas(2, 'idle'), stage = await makeAtlas(3, 'bg');
  const ogg = new Uint8Array(5000).map((_, i) => (i * 31) & 255), icon = new Uint8Array(300).map((_, i) => i & 255);
  const leatherCfg = JSON.stringify({ imagePath: 'characters/lbf', animations: [{ name: 'idle', animation_name: 'idle' }], scale: 1 });
  const src = [
    { path: 'mods/', data: new Uint8Array(0) },
    { path: 'mods/images/characters/BF_ASSETS.png', data: bf.png }, { path: 'mods/images/characters/BF_ASSETS.xml', data: T(bf.xml), deflate: true },
    { path: 'mods/characters/bf.json', data: T(psychCfg('characters/BF_ASSETS')), deflate: true },
    // mesmo nome de atlas em outra pasta (outro mod) com config próprio
    { path: 'other/images/characters/BF_ASSETS.png', data: dad.png }, { path: 'other/images/characters/BF_ASSETS.xml', data: T(dad.xml), deflate: true },
    { path: 'other/characters/dad.json', data: T(psychCfg('characters/BF_ASSETS')), deflate: true },
    // atlas sem config (cenário) e um PNG sem XML
    { path: 'mods/images/stage/bg.png', data: stage.png }, { path: 'mods/images/stage/bg.xml', data: T(stage.xml), deflate: true },
    { path: 'mods/images/icons/icon-bf.png', data: icon },
    { path: 'mods/songs/test/Inst.ogg', data: ogg },
    { path: 'mods/data/chart.json', data: T('{"song":{"notes":[]}}'), deflate: true },
    // Leather: config.json + offsets.txt
    { path: 'lea/lbf/config.json', data: T(leatherCfg), deflate: true }, { path: 'lea/lbf/offsets.txt', data: T('idle 5 7\n'), deflate: true },
    { path: 'lea/lbf/lbf.png', data: bf.png }, { path: 'lea/lbf/lbf.xml', data: T(bf.xml), deflate: true },
  ];
  const zin = await FNF.makeZip(src);
  const scan = FNF.scanZip(zin);
  assert.strictEqual(scan.atlases, 4);
  const steps = [];
  const res = await FNF.processZip(zin, { scale: 0.5 }, (s, p) => steps.push(p));
  assert.ok(steps.length > 3 && steps[steps.length - 1] === 100);
  const out = FNF.listZip(res.zip), byPath = new Map(out.map((e) => [e.path, e]));
  for (const s of src) assert.ok(byPath.has(s.path), 'falta ' + s.path);
  assert.ok(byPath.has('optimizer-report.txt'));
  const rd = async (p) => FNF.zipData(res.zip, byPath.get(p));
  // não-sprites: idênticos
  assert.deepStrictEqual(Array.from(await rd('mods/songs/test/Inst.ogg')), Array.from(ogg));
  assert.deepStrictEqual(Array.from(await rd('mods/images/icons/icon-bf.png')), Array.from(icon));
  assert.strictEqual(FNF.textDecode(await rd('mods/data/chart.json')), '{"song":{"notes":[]}}');
  // personagens: escala dobrada, atlas reduzido, offsets ajustados
  const bfJ = JSON.parse(FNF.textDecode(await rd('mods/characters/bf.json'))), dadJ = JSON.parse(FNF.textDecode(await rd('other/characters/dad.json')));
  assert.ok(bfJ.scale > 1.9 && dadJ.scale > 1.9, 'scale deve compensar: ' + bfJ.scale);
  const bfPng = await FNF.decodePNG(await rd('mods/images/characters/BF_ASSETS.png'));
  assert.ok(bfPng.width < 900, 'atlas do personagem deve ter encolhido');
  // atlas repetido em outra pasta: cada config usa o atlas da própria pasta
  const dadXml = FNF.parseSparrow(FNF.textDecode(await rd('other/images/characters/BF_ASSETS.xml')));
  assert.ok(dadXml.frames.length === 8);
  const dadPng = await FNF.decodePNG(await rd('other/images/characters/BF_ASSETS.png'));
  assert.notDeepStrictEqual(Array.from(dadPng.data.slice(0, 2000)), Array.from(bfPng.data.slice(0, 2000)));
  // cenário sem config: continua na escala 1 (frames com o mesmo tamanho virtual)
  const bgXml = FNF.parseSparrow(FNF.textDecode(await rd('mods/images/stage/bg.xml')));
  assert.ok(bgXml.frames.every((f) => f.fw === 120 && f.fh === 140), 'cenário não pode mudar de escala');
  // Leather: offsets.txt ajustado junto
  const lcfg = JSON.parse(FNF.textDecode(await rd('lea/lbf/config.json')));
  assert.ok(lcfg.scale > 1.9);
  assert.notStrictEqual(FNF.textDecode(await rd('lea/lbf/offsets.txt')), 'idle 5 7\n');
  assert.ok(res.totals.atlases === 4 && res.totals.failed === 0, JSON.stringify(res.totals));
  // opção: redimensionar também atlas sem config
  const res2 = await FNF.processZip(zin, { scale: 0.5, resizeNoConfig: true });
  const o2 = new Map(FNF.listZip(res2.zip).map((e) => [e.path, e]));
  const bg2 = FNF.parseSparrow(FNF.textDecode(await FNF.zipData(res2.zip, o2.get('mods/images/stage/bg.xml'))));
  assert.ok(bg2.frames.every((f) => f.fw < 120), 'com resizeNoConfig o cenário deve reduzir');
  // erros claros
  await assert.rejects(() => FNF.processZip(new Uint8Array(100), {}), /ZIP/);
  const zEmpty = await FNF.makeZip([{ path: 'a.txt', data: T('x') }]);
  await assert.rejects(() => FNF.processZip(zEmpty, {}), /No atlas/);
  console.log('  ok ZIP:', res.totals.atlases + ' atlas, ' + res.totals.configs + ' configs, ' + zin.length + ' → ' + res.zip.length + ' bytes');
  console.log('zipjob.test: TUDO OK');
})().catch((e) => { console.error(e); process.exit(1); });
