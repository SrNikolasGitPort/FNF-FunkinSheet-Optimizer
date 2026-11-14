'use strict';
const FNF = require('./load.js');
const assert = require('assert');
let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (const pow2 of [false, true]) {
  const rects = []; let total = 0;
  for (let i = 0; i < 150; i++) { const w = 10 + Math.floor(rnd() * 200), h = 10 + Math.floor(rnd() * 200); rects.push({ id: i, w, h }); total += w * h; }
  const r = FNF.planAtlas(rects, { pow2, maxSize: 32768 });
  const P = rects.map((q) => Object.assign({ w: q.w, h: q.h }, r.placements.get(q.id)));
  for (const p of P) assert(p.x >= 0 && p.y >= 0 && p.x + p.w <= r.width && p.y + p.h <= r.height, 'fora do atlas');
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j];
    assert(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), 'sobreposição');
  }
  const fill = total / (r.width * r.height);
  console.log('  ok pack pow2=' + pow2 + ' ' + r.width + '×' + r.height + ' preenchimento ' + (fill * 100).toFixed(1) + '%');
  if (!pow2) assert(fill > 0.9, 'preenchimento baixo');
}
// rotação: sprites longos e finos encaixam melhor girados
{
  const rects = []; for (let i = 0; i < 40; i++) rects.push({ id: i, w: i % 2 ? 300 : 20, h: i % 2 ? 20 : 300 });
  const a = FNF.planAtlas(rects, { pow2: false, maxSize: 32768 }), b = FNF.planAtlas(rects, { pow2: false, maxSize: 32768, rotate: true });
  console.log('  ok rotação ' + a.width * a.height + ' → ' + b.width * b.height + ' px');
  assert(b.width * b.height <= a.width * a.height);
  assert([...b.placements.values()].some((p) => p.rot));
}
console.log('pack.test: TUDO OK');
