/* demo.js — gera um personagem de exemplo (atlas sintético + config/offsets do Leather) para testar o site sem arquivos. */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});

  const CONFIG = `{
  "defaultFlipX": true,
  "dancesLeftAndRight": false,
  "imagePath": "Boyfriend_Assets",
  "barColor": [81, 201, 219],
  "offsetsFlipWhenEnemy": true,
  "offsetsFlipWhenPlayer": false,
  "extraSheets": ["BFCheer"],
  "animations": [
    { "name": "idle", "animation_name": "BF idle dance", "fps": 24, "looped": false },
    { "name": "singLEFT", "animation_name": "BF NOTE LEFT0", "fps": 24, "looped": false },
    { "name": "singDOWN", "animation_name": "BF NOTE DOWN0", "fps": 24, "looped": false },
    { "name": "singUP", "animation_name": "BF NOTE UP0", "fps": 24, "looped": false },
    { "name": "singRIGHT", "animation_name": "BF NOTE RIGHT0", "fps": 24, "looped": false },
    { "name": "hey", "animation_name": "BF HEY", "fps": 24, "looped": false },
    { "name": "cheer", "animation_name": "Cheer", "fps": 24, "looped": false },
    { "name": "scared", "animation_name": "BF idle shaking", "fps": 24, "looped": true }
  ]
}
`;
  const OFFSETS = 'idle 5 0\nsingLEFT 12 -6\nsingDOWN -10 -50\nsingUP -37 27\nsingRIGHT -38 -7\nhey 7 6\ncheer -20 41\nscared 4 -2';

  const FW = 170, FH = 210, COLS = 12;

  function drawFrame(kind, i, hue) {
    const d = new Uint8Array(FW * FH * 4);
    const dir = { L: [-1, 0], D: [0, 1], U: [0, -1], R: [1, 0] }[kind] || [0, 0];
    const t = i / 4;
    const bob = Math.sin(t * Math.PI * 2) * 6;
    const cx = FW / 2 + dir[0] * 22 * Math.min(1, t + 0.3);
    const cy = FH * 0.62 + dir[1] * 20 * Math.min(1, t + 0.3) + bob;
    const body = (x, y) => {
      // corpo: elipse + cabeça: círculo + boné
      const dx = (x - cx) / 28, dy = (y - (cy + 18)) / 44;
      const head = Math.hypot(x - cx, y - (cy - 42)) - 22;
      const torso = Math.hypot(dx, dy) - 1;
      const cap = Math.hypot((x - cx - dir[0] * 6) / 30, (y - (cy - 56)) / 9) - 1;
      return { head, torso: torso * 28, cap: cap * 9 };
    };
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const s = body(x, y);
      const aH = Math.max(0, Math.min(1, 0.5 - s.head)), aT = Math.max(0, Math.min(1, 0.5 - s.torso)), aC = Math.max(0, Math.min(1, 0.5 - s.cap));
      const a = Math.max(aH, aT, aC);
      if (a <= 0) continue;
      let r, g, b;
      if (aC >= Math.max(aH, aT) && aC > 0) { r = 70; g = 110; b = 255; }
      else if (aH >= aT) { r = 255; g = 214 - (y - cy) * 0.3; b = 170; }
      else { const k = (hue + (y - cy) * 0.5) % 255; r = 40 + k * 0.3; g = 160 + (k % 60); b = 220; }
      const o = (y * FW + x) * 4;
      d[o] = Math.max(0, Math.min(255, r)); d[o + 1] = Math.max(0, Math.min(255, g)); d[o + 2] = Math.max(0, Math.min(255, b)); d[o + 3] = Math.round(a * 255);
    }
    return d;
  }

  async function sheet(name, anims) {
    const frames = [];
    anims.forEach((a, ai) => { for (let i = 0; i < a.count; i++) frames.push({ name: a.prefix + String(i).padStart(4, '0'), kind: a.kind, i: a.hold ? Math.floor(i / 2) : i, hue: ai * 31 }); });
    const rows = Math.ceil(frames.length / COLS);
    const W = COLS * FW, H = rows * FH;
    const atlas = new Uint8Array(W * H * 4);
    const xml = [];
    const cache = new Map();
    frames.forEach((f, n) => {
      const key = f.kind + f.i + f.hue;
      let bmp = cache.get(key);
      if (!bmp) { bmp = drawFrame(f.kind, f.i, f.hue); cache.set(key, bmp); }
      const ox = (n % COLS) * FW, oy = Math.floor(n / COLS) * FH;
      for (let y = 0; y < FH; y++) atlas.set(bmp.subarray(y * FW * 4, (y + 1) * FW * 4), ((oy + y) * W + ox) * 4);
      xml.push('\t<SubTexture name="' + f.name + '" x="' + ox + '" y="' + oy + '" width="' + FW + '" height="' + FH + '"/>');
    });
    const png = (await FNF.encodePNG(atlas, W, H, { mode: 'rgba' })).bytes;
    const xmlText = '<?xml version="1.0" encoding="utf-8"?>\n<TextureAtlas imagePath="' + name + '.png">\n' + xml.join('\n') + '\n</TextureAtlas>\n';
    return [
      { name: name + '.png', path: 'BF/' + name + '.png', bytes: png },
      { name: name + '.xml', path: 'BF/' + name + '.xml', bytes: FNF.textEncode(xmlText) },
    ];
  }

  /** Retorna a lista de arquivos [{name,path,bytes}] do personagem de exemplo. */
  async function makeDemo() {
    const main = await sheet('Boyfriend_Assets', [
      { prefix: 'BF idle dance', kind: 'idle', count: 10, hold: true },
      { prefix: 'BF NOTE LEFT0', kind: 'L', count: 8 },
      { prefix: 'BF NOTE DOWN0', kind: 'D', count: 8 },
      { prefix: 'BF NOTE UP0', kind: 'U', count: 8 },
      { prefix: 'BF NOTE RIGHT0', kind: 'R', count: 8 },
      { prefix: 'BF HEY', kind: 'U', count: 8, hold: true },
      { prefix: 'BF idle shaking', kind: 'idle', count: 6 },
    ]);
    const cheer = await sheet('BFCheer', [{ prefix: 'Cheer', kind: 'U', count: 10, hold: true }]);
    return [...main, ...cheer,
      { name: 'config.json', path: 'BF/config.json', bytes: FNF.textEncode(CONFIG) },
      { name: 'offsets.txt', path: 'BF/offsets.txt', bytes: FNF.textEncode(OFFSETS) }];
  }

  FNF.makeDemo = makeDemo;
})(typeof self !== 'undefined' ? self : globalThis);
