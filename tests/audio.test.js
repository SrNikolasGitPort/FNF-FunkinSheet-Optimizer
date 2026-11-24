'use strict';
// Aba Músicas: OGG Vorbis (libvorbis em wasm) — decodificar, misturar, recodificar e processar ZIP.
const assert = require('assert');
const FNF = require('./load.js');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const T = (s) => FNF.textEncode(s);

function synth(seed, secs, rate, ch) {
  const n = Math.floor(secs * rate), d = Array.from({ length: ch }, () => new Float32Array(n)); let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / rate, beat = (t * 2) % 1;
    let v = 0; for (const f of [220, 277.18, 329.63, 440]) v += Math.sin(2 * Math.PI * f * (1 + seed * 0.01) * t) * 0.12;
    v += Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-beat * 30)) * t) * Math.exp(-beat * 9) * 0.5 + rnd() * Math.exp(-((t * 4) % 1) * 25) * 0.25;
    for (let c = 0; c < ch; c++) d[c][i] = v + (c ? -1 : 1) * Math.sin(2 * Math.PI * 330 * t) * 0.05;
  }
  return d;
}
const ogg = (seed, secs, rate, ch, q) => FNF.vorbis.encodePCM({ data: synth(seed, secs, rate, ch), rate, quality: q === undefined ? 0.5 : q });

(async () => {
  // ---- 1) nomes: dificuldade x papel (Player/Opponent)
  const P = FNF.audio.parseName;
  assert.deepStrictEqual(P('Inst.ogg'), { kind: 'inst', diff: '', role: '' });
  assert.deepStrictEqual(P('Voices-HardeCore.ogg'), { kind: 'voices', diff: 'HardeCore', role: '' });
  assert.deepStrictEqual(P('Voices-Player.ogg'), { kind: 'voices', diff: '', role: 'Player' });
  assert.deepStrictEqual(P('voices-opponent-erect.OGG'), { kind: 'voices', diff: 'erect', role: 'opponent' });
  assert.strictEqual(P('song.ogg'), null);

  // ---- 2) planejamento (exemplo do pedido)
  const plan = FNF.audio.planMusic(['songs/a/Inst.ogg', 'songs/a/Voices.ogg', 'songs/a/Voices-HardeCore.ogg', 'songs/a/Inst-Erect.ogg', 'songs/b/Inst.ogg', 'songs/c/Voices.ogg', 'songs/d/Inst.ogg', 'songs/d/Voices-Player.ogg', 'songs/d/Voices-Opponent.ogg']);
  const key = (j) => j.out + ' <= ' + [j.inst].concat(j.voices).map((x) => x.replace('songs/', '')).join(' + ');
  const got = plan.jobs.map(key).sort();
  assert.deepStrictEqual(got, [
    'songs/a/Inst-Erect.ogg <= a/Inst-Erect.ogg + a/Voices.ogg',
    'songs/a/Inst-HardeCore.ogg <= a/Inst.ogg + a/Voices-HardeCore.ogg',
    'songs/a/Inst.ogg <= a/Inst.ogg + a/Voices.ogg',
    'songs/b/Inst.ogg <= b/Inst.ogg',
    'songs/d/Inst.ogg <= d/Inst.ogg + d/Voices-Player.ogg + d/Voices-Opponent.ogg',
  ]);
  assert.strictEqual(plan.warnings.length, 1); // songs/c só tem Voices
  console.log('  ok planejamento (Inst + Voices, dificuldades, Player/Opponent)');

  // ---- 3) decodificar / codificar
  const a = await ogg(1, 6, 44100, 2), b = await ogg(2, 5.5, 44100, 2, 0.4);
  const da = await FNF.vorbis.decode(a);
  assert.ok(da.channels === 2 && da.rate === 44100 && da.frames === Math.floor(6 * 44100), 'frames ' + da.frames);
  const m = await FNF.vorbis.mix({ tracks: [{ name: 'a', bytes: a }, { name: 'b', bytes: b }], quality: 0.5 });
  const dm = await FNF.vorbis.decode(m.bytes), db = await FNF.vorbis.decode(b);
  assert.strictEqual(dm.frames, da.frames, 'mistura tem o comprimento da mais longa');
  let se = 0, sp = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < dm.frames; i++) { const ref = da.data[c][i] + (i < db.frames ? db.data[c][i] : 0); se += (dm.data[c][i] - ref) ** 2; sp += ref * ref; }
  const snr = 10 * Math.log10(sp / se);
  assert.ok(snr > 18, 'SNR da mistura ' + snr.toFixed(1));
  console.log('  ok mistura: ' + (da.frames / 44100).toFixed(1) + ' s, SNR ' + snr.toFixed(1) + ' dB, ' + m.bytes.length + ' bytes (originais ' + (a.length + b.length) + ')');
  // canais/taxas diferentes
  const mono = await ogg(3, 6, 44100, 1), r48 = await ogg(4, 6, 48000, 2);
  const mm = await FNF.vorbis.mix({ tracks: [a, mono] }), m48 = await FNF.vorbis.mix({ tracks: [a, r48] });
  assert.ok(mm.channels === 2 && Math.abs(mm.seconds - 6) < 0.01 && m48.rate === 44100 && Math.abs(m48.seconds - 6) < 0.01);
  await assert.rejects(() => FNF.vorbis.mix({ tracks: [new Uint8Array(500)] }), /Only OGG Vorbis/);
  console.log('  ok mono + estéreo, 44.1k + 48k, arquivo inválido rejeitado');

  // validação externa (se houver ffprobe)
  try {
    const f = path.join(os.tmpdir(), 'fnf-au-' + process.pid + '.ogg'); fs.writeFileSync(f, m.bytes);
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration', '-of', 'json', f]).toString());
    fs.unlinkSync(f);
    assert.ok(j.streams[0].codec_name === 'vorbis' && j.streams[0].channels === 2 && Math.abs(j.format.duration - 6) < 0.05);
    console.log('  ok ffprobe confirma: vorbis, 2 canais, ' + (+j.format.duration).toFixed(2) + ' s');
  } catch (e) { if (e.code !== 'ENOENT') throw e; console.log('  (ffprobe não encontrado: verificação externa pulada)'); }

  // ---- 4) ZIP completo
  const inst = await ogg(5, 8, 44100, 2), v1 = await ogg(6, 8, 44100, 2, 0.4), vH = await ogg(7, 8, 44100, 2, 0.4), instE = await ogg(8, 8, 44100, 2);
  const song2 = await ogg(9, 5, 44100, 2, 0.5);
  const chart = '{"song":{"song":"Test","needsVoices":true,"notes":[]}}', other = new Uint8Array(3000).map((_, i) => (i * 7) & 255);
  const src = [
    { path: 'mod/songs/test/Inst.ogg', data: inst }, { path: 'mod/songs/test/Voices.ogg', data: v1 }, { path: 'mod/songs/test/Voices-HardeCore.ogg', data: vH },
    { path: 'mod/songs/test/Inst-Erect.ogg', data: instE },
    { path: 'mod/songs/solo/Inst.ogg', data: song2 },
    { path: 'mod/data/test/test-hard.json', data: T(chart), deflate: true }, { path: 'mod/data/test/other.json', data: T('{"x":1}'), deflate: true },
    { path: 'mod/images/bg.png', data: other }, { path: 'mod/songs/test/Inst.mp3', data: other },
  ];
  const zin = await FNF.makeZip(src);
  const steps = [];
  const res = await FNF.audio.processMusicZip(zin, {}, { concurrency: 2, runJob: (job, onP) => FNF.audio.runMusicJob(job, onP), onProgress: (s, p) => steps.push(p) });
  assert.ok(steps[steps.length - 1] === 100);
  const out = new Map(FNF.listZip(res.zip).map((e) => [e.path, e]));
  assert.ok(!out.has('mod/songs/test/Voices.ogg') && !out.has('mod/songs/test/Voices-HardeCore.ogg'), 'Voices devem sumir');
  for (const p of ['mod/songs/test/Inst.ogg', 'mod/songs/test/Inst-HardeCore.ogg', 'mod/songs/test/Inst-Erect.ogg', 'mod/songs/solo/Inst.ogg', 'mod/images/bg.png', 'optimizer-music-report.txt']) assert.ok(out.has(p), 'falta ' + p);
  assert.deepStrictEqual(Array.from(await FNF.zipData(res.zip, out.get('mod/images/bg.png'))), Array.from(other), 'outros arquivos intactos');
  const merged = await FNF.vorbis.decode(await FNF.zipData(res.zip, out.get('mod/songs/test/Inst.ogg')));
  assert.ok(Math.abs(merged.frames / 44100 - 8) < 0.01);
  assert.ok(/"needsVoices":false/.test(FNF.textDecode(await FNF.zipData(res.zip, out.get('mod/data/test/test-hard.json')))), 'chart atualizado');
  assert.strictEqual(FNF.textDecode(await FNF.zipData(res.zip, out.get('mod/data/test/other.json'))), '{"x":1}');
  const before = inst.length + v1.length + vH.length + instE.length;
  const outAudio = ['Inst.ogg', 'Inst-HardeCore.ogg', 'Inst-Erect.ogg'].reduce((n, f) => n + out.get('mod/songs/test/' + f).usize, 0);
  assert.ok(outAudio < before, 'áudio deve ficar menor: ' + outAudio + ' vs ' + before);
  assert.ok(res.problems.some((p) => /other formats/.test(p.msg)), 'aviso do mp3');
  assert.strictEqual(res.totals.charts, 1); assert.strictEqual(res.totals.removed, 2);
  console.log('  ok ZIP: ' + res.rows.map((r) => r.status).join(',') + ' | áudio ' + before + ' → ' + outAudio + ' bytes (' + Math.round(100 * outAudio / before) + '%)');
  // qualidade automática: arquivo de alto bitrate é recodificado (inclusive sozinho) e fica menor
  const hi = await ogg(9, 6, 44100, 2, 0.9);
  const aq = FNF.audio.autoQuality([{ bytes: hi }]), lq = FNF.audio.autoQuality([{ bytes: await ogg(9, 6, 44100, 2, 0.0) }]);
  assert.ok(aq <= 0.5 && lq <= aq, 'auto q: ' + lq + ' < ' + aq);
  const zhi = await FNF.makeZip([{ path: 'x/Inst.ogg', data: hi }]);
  const rhi = await FNF.audio.processMusicZip(zhi, {}, { runJob: (job) => FNF.audio.runMusicJob(job) });
  assert.strictEqual(rhi.rows[0].status, 'recompressed'); assert.ok(rhi.rows[0].after < hi.length * 0.8, 'Inst sozinho otimizado');
  console.log('  ok qualidade automática: ' + hi.length + ' → ' + rhi.rows[0].after + ' bytes (q ' + rhi.rows[0].quality + ')');
  // canais respeitados: estéreo (mesmo L==R) continua estéreo; mono continua mono
  const dmo = synth(5, 6, 44100, 1), dual = await FNF.vorbis.encodePCM({ data: [dmo[0], dmo[0]], rate: 44100, quality: 0.5 });
  const rd = await FNF.audio.runMusicJob({ tracks: [{ name: 'a', bytes: dual }], srcTotal: dual.length });
  assert.strictEqual(rd.channels, 2, 'estéreo deve continuar estéreo');
  const mono1 = await FNF.vorbis.encodePCM({ data: dmo, rate: 44100, quality: 0.5 });
  const rm = await FNF.audio.runMusicJob({ tracks: [{ name: 'a', bytes: mono1 }], srcTotal: mono1.length });
  assert.strictEqual(rm.channels, 1, 'mono deve continuar mono');
  console.log('  ok canais respeitados (estéreo → estéreo, mono → mono)');
  // sem charts
  const res2 = await FNF.audio.processMusicZip(zin, { patchCharts: false }, { runJob: (job) => FNF.audio.runMusicJob(job) });
  const o2 = new Map(FNF.listZip(res2.zip).map((e) => [e.path, e]));
  assert.ok(/needsVoices":true/.test(FNF.textDecode(await FNF.zipData(res2.zip, o2.get('mod/data/test/test-hard.json')))));
  // pasta com falha mantém tudo como estava
  const bad = await FNF.makeZip([{ path: 's/Inst.ogg', data: inst }, { path: 's/Voices.ogg', data: other }]);
  const res3 = await FNF.audio.processMusicZip(bad, {}, { runJob: (job) => FNF.audio.runMusicJob(job) });
  const o3 = new Map(FNF.listZip(res3.zip).map((e) => [e.path, e]));
  assert.ok(o3.has('s/Voices.ogg') && res3.totals.failed === 1 && res3.problems.length > 0);
  await assert.rejects(() => FNF.audio.processMusicZip(zin.slice(0, 10), {}, { runJob: () => null }), /ZIP/);
  console.log('  ok sem charts, arquivo corrompido mantém originais');
  console.log('audio.test: TUDO OK');
})().catch((e) => { console.error(e); process.exit(1); });
