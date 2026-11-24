/* audiojob.js — aba "Músicas": num ZIP, junta Inst + Voices (por pasta e por dificuldade) em um único Inst.ogg e recodifica leve.
 *   Inst.ogg + Voices.ogg                       -> Inst.ogg
 *   Inst.ogg + Voices-Hard.ogg                  -> Inst-Hard.ogg   (Inst-Hard.ogg, se existir, é usado no lugar)
 * Só OGG Vorbis. O resto do ZIP volta intacto (cópia sem recomprimir). */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});
  // kbps (estéreo 44,1 kHz) -> qualidade VBR do libvorbis. O alvo é a fidelidade do arquivo ORIGINAL:
  // nunca acima do necessário para igualá-lo, e com piso (0,3 ≈ 112 kbps) e teto (0,5 ≈ 160 kbps) estéreo.
  const KBPS_Q = [[45, -0.1], [64, 0], [80, 0.1], [96, 0.2], [112, 0.3], [128, 0.4], [160, 0.5]];
  const Q_MIN = 0.3, Q_MAX = 0.5, SRC_FACTOR = 1.0; // qualidade primeiro: acompanha o bitrate de origem, piso ≈ 112 kbps e teto ≈ 160 kbps estéreo
  function qualityFromKbps(k) {
    if (k <= KBPS_Q[0][0]) return Q_MIN;
    for (let i = 1; i < KBPS_Q.length; i++) {
      if (k <= KBPS_Q[i][0]) { const a = KBPS_Q[i - 1], b = KBPS_Q[i]; return Math.max(Q_MIN, a[1] + (b[1] - a[1]) * (k - a[0]) / (b[0] - a[0])); }
    }
    return Q_MAX;
  }
  /** Qualidade automática de uma música: acompanha a faixa de maior bitrate (normalizado p/ estéreo 44,1 kHz). */
  function autoQuality(tracks) {
    let k = 0;
    for (const t of tracks) {
      const i = FNF.vorbis.info(t.bytes || t); if (!i || !i.seconds) continue;
      const norm = (i.channels === 1 ? 1.8 : 1) * (i.rate / 44100);
      k = Math.max(k, (t.bytes || t).length * 8 / i.seconds / 1000 * norm * SRC_FACTOR);
    }
    return k ? Math.min(Q_MAX, Math.round(qualityFromKbps(k) * 100) / 100) : 0.4;
  }
  const ROLES = new Set(['player', 'opponent']); // sufixos de Voices que NÃO são dificuldade (Psych Engine)
  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };
  const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const junk = (p) => /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/i.test(p);

  /** Lê "Inst", "Voices-Hard", "Voices-Player-Hard"… -> { kind, diff, role } ou null */
  function parseName(file) {
    const m = /^(inst|voices)(?:-(.+))?\.ogg$/i.exec(file);
    if (!m) return null;
    const kind = m[1].toLowerCase(), toks = m[2] ? m[2].split('-') : [];
    const role = toks.filter((t) => ROLES.has(t.toLowerCase())).join('-');
    const diff = toks.filter((t) => !ROLES.has(t.toLowerCase())).join('-');
    return { kind, diff, role };
  }

  /** paths: caminhos .ogg do ZIP. Retorna { jobs:[{dir, key, diff, out, outExists, inst, voices:[path]}], warnings:[string], unused:[path] } */
  function planMusic(paths) {
    const byDir = new Map(), warnings = [], jobs = [];
    for (const p of paths) {
      const pn = parseName(nameOf(p)); if (!pn) continue;
      const d = dirOf(p); if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(Object.assign({ path: p }, pn));
    }
    for (const [dir, list] of byDir) {
      const inst = list.filter((f) => f.kind === 'inst'), voices = list.filter((f) => f.kind === 'voices');
      const instBy = new Map(), voicesBy = new Map(), names = new Map();
      for (const f of inst) { const k = f.diff.toLowerCase(); if (!instBy.has(k)) instBy.set(k, f); if (k && !names.has(k)) names.set(k, f.diff); }
      for (const f of voices) { const k = f.diff.toLowerCase(); if (!voicesBy.has(k)) voicesBy.set(k, []); voicesBy.get(k).push(f); if (k && !names.has(k)) names.set(k, f.diff); }
      const baseInst = instBy.get(''), baseVoices = voicesBy.get('') || [];
      const keys = [''].concat([...names.keys()].sort());
      for (const k of keys) {
        const iF = instBy.get(k) || baseInst;
        const vF = voicesBy.has(k) ? voicesBy.get(k) : baseVoices;
        if (!iF) { if (vF.length) warnings.push(FNF.t('au.warn.noinst', { dir: dir || '/', name: vF[0].path.replace(/^.*\//, '') })); continue; }
        const own = instBy.get(k);
        jobs.push({
          dir, key: k, diff: names.get(k) || '', inst: iF.path, voices: vF.map((f) => f.path),
          out: own ? own.path : dir + 'Inst' + (k ? '-' + names.get(k) : '') + '.ogg', outExists: !!own,
        });
      }
    }
    return { jobs, warnings };
  }

  /** Executa um trabalho (usado no worker e em testes): mistura as faixas e recodifica; reduz a qualidade se ficar maior que as originais. */
  async function runMusicJob(job, onProgress) {
    let q = job.quality === undefined ? autoQuality(job.tracks) : job.quality;
    const q0 = q;
    let r = await FNF.vorbis.mix({ tracks: job.tracks, quality: q, onProgress });
    let tries = 0;
    while (r.bytes.length > job.srcTotal && q > 0.25 && tries < 2) { q = Math.max(0.25, q - 0.05); tries++; r = await FNF.vorbis.mix({ tracks: job.tracks, quality: q }); }
    return { bytes: r.bytes, channels: r.channels, rate: r.rate, seconds: r.seconds, peak: r.peak, quality: q, auto: q0, retries: tries, kbps: r.seconds ? Math.round(r.bytes.length * 8 / r.seconds / 1000) : 0 };
  }

  /** io: { runJob(job, onProgress) -> Promise<resultado>, concurrency, onProgress(stage, pct) } */
  async function processMusicZip(zipBytes, opts, io) {
    opts = Object.assign({ patchCharts: true }, opts || {});
    const q = typeof opts.quality === 'number' ? opts.quality : undefined; // normalmente automático
    const P = async (stage, pct) => { if (io.onProgress) await io.onProgress(stage, pct); };
    await P(FNF.t('zj.reading'), 0);
    const entries = FNF.listZip(zipBytes);
    if (entries.some((e) => e.encrypted)) throw new Error(FNF.t('zip.err.encrypted'));
    const usable = entries.filter((e) => !e.dir && !junk(e.path));
    const byPath = new Map(usable.map((e) => [e.path, e]));
    const problems = [];
    const other = usable.filter((e) => /(^|\/)(inst|voices)(-[^/]*)?\.(mp3|wav|flac|m4a|aac|opus)$/i.test(e.path));
    if (other.length) problems.push({ level: 'warn', msg: FNF.t('au.warn.format', { n: other.length }) });
    const plan = planMusic(usable.filter((e) => /\.ogg$/i.test(e.path)).map((e) => e.path));
    for (const w of plan.warnings) problems.push({ level: 'warn', msg: w });
    if (!plan.jobs.length) throw new Error(FNF.t('au.none'));

    // ---- roda os trabalhos (com concorrência)
    const results = new Array(plan.jobs.length), prog = new Array(plan.jobs.length).fill(0);
    let next = 0, finished = 0;
    const tick = async () => { await P(FNF.t('au.stage', { n: finished, t: plan.jobs.length }), 3 + (prog.reduce((a, b) => a + b, 0) / plan.jobs.length) * 92); };
    const worker = async () => {
      for (;;) {
        const i = next++; if (i >= plan.jobs.length) return;
        const j = plan.jobs[i];
        try {
          const paths = [j.inst].concat(j.voices);
          const tracks = [];
          for (const p of paths) tracks.push({ name: p.replace(/^.*\//, ''), bytes: await FNF.zipData(zipBytes, byPath.get(p)) });
          const srcTotal = tracks.reduce((n, t) => n + t.bytes.length, 0);
          const r = await io.runJob({ id: i, tracks, quality: q, srcTotal }, (f) => { prog[i] = f; return tick(); });
          results[i] = Object.assign({ srcTotal, srcNames: tracks.map((t) => t.name) }, r);
        } catch (e) { results[i] = { error: (e && e.message) || String(e) }; }
        prog[i] = 1; finished++; await tick();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(io.concurrency || 1, plan.jobs.length)) }, worker));

    // ---- decide o que muda; uma pasta com falha fica toda como estava
    const failedDirs = new Set();
    plan.jobs.forEach((j, i) => { if (results[i].error) { failedDirs.add(j.dir); problems.push({ level: 'warn', msg: j.out + ': ' + results[i].error }); } });
    const rows = [], repl = new Map(), adds = [];
    const removedVoices = new Set(), mergedDirs = new Set();
    plan.jobs.forEach((j, i) => {
      const r = results[i], before = r.srcTotal || (byPath.get(j.inst).usize);
      if (r.error) { rows.push({ path: j.out, status: 'error', note: r.error, before, after: before, sources: [] }); return; }
      if (failedDirs.has(j.dir)) { rows.push({ path: j.out, status: 'kept', note: FNF.t('au.note.dirfail'), before, after: before, sources: r.srcNames }); return; }
      const merging = j.voices.length > 0;
      if (!merging && r.bytes.length >= r.srcTotal * 0.97) { rows.push({ path: j.out, status: 'kept', note: FNF.t('au.note.optimal'), before, after: before, sources: r.srcNames, seconds: r.seconds }); return; }
      if (j.outExists) repl.set(j.out, r.bytes); else adds.push({ path: j.out, data: r.bytes });
      if (merging) { j.voices.forEach((v) => removedVoices.add(v)); mergedDirs.add(j.dir); }
      rows.push({ path: j.out, status: merging ? 'merged' : 'recompressed', before, after: r.bytes.length, sources: r.srcNames, seconds: r.seconds, peak: r.peak, quality: r.quality, kbps: r.kbps, note: r.peak > 2 ? FNF.t('au.note.peak', { p: r.peak.toFixed(2) }) : '' });
    });
    // Voices só somem se todos os trabalhos que as usam foram aplicados
    const stillNeeded = new Set();
    plan.jobs.forEach((j, i) => { const applied = rows[i].status === 'merged'; if (!applied) j.voices.forEach((v) => stillNeeded.add(v)); });
    for (const v of stillNeeded) removedVoices.delete(v);

    // ---- needsVoices:true -> false nos charts das músicas que perderam o Voices
    let patched = [];
    if (opts.patchCharts && removedVoices.size) {
      const songDirs = new Set();
      for (const j of plan.jobs) if (mergedDirs.has(j.dir) && !failedDirs.has(j.dir)) songDirs.add(j.dir);
      const songNames = new Set([...songDirs].map((d) => d.replace(/\/$/, '').replace(/^.*\//, '').toLowerCase()));
      for (const e of usable) {
        if (!/\.json$/i.test(e.path) || e.usize > 8 * 1024 * 1024 || e.encrypted) continue;
        const d = dirOf(e.path), base = d.replace(/\/$/, '').replace(/^.*\//, '').toLowerCase();
        if (!songDirs.has(d) && !songNames.has(base)) continue;
        try {
          const text = FNF.textDecode(await FNF.zipData(zipBytes, e));
          if (!/"needsVoices"\s*:\s*true/.test(text)) continue;
          repl.set(e.path, FNF.textEncode(text.replace(/("needsVoices"\s*:\s*)true/g, '$1false')));
          patched.push(e.path);
        } catch (err) { /* json ilegível: ignora */ }
      }
    }

    // ---- monta o ZIP
    await P(FNF.t('zj.building'), 96);
    const out = [];
    for (const e of entries) {
      if (removedVoices.has(e.path)) continue;
      if (repl.has(e.path)) { out.push({ path: e.path, data: repl.get(e.path), deflate: /\.json$/i.test(e.path) }); continue; }
      out.push({ path: e.path, nameBytes: e.nameBytes, flags: e.flags, raw: { method: e.method, body: FNF.zipRaw(zipBytes, e), crc: e.crc, usize: e.usize } });
    }
    for (const a of adds) out.push({ path: a.path, data: a.data, deflate: false });
    const lines = [FNF.t('au.rep.title'), ''];
    for (const r of rows) lines.push('[' + r.status + '] ' + r.path + ' — ' + r.sources.join(' + ') + ' — ' + r.before + ' → ' + r.after + ' bytes' + (r.note ? ' — ' + r.note : ''));
    if (removedVoices.size) lines.push('', FNF.t('au.rep.removed'), ...[...removedVoices].map((v) => '  ' + v));
    if (patched.length) lines.push('', FNF.t('au.rep.charts'), ...patched.map((v) => '  ' + v));
    for (const p of problems) lines.push('', (p.level === 'warn' ? 'WARNING: ' : '') + p.msg);
    const report = lines.join('\n');
    out.push({ path: 'optimizer-music-report.txt', data: FNF.textEncode(report), deflate: true });
    const zip = await FNF.makeZip(out);
    await P(FNF.t('pl.stage.done'), 100);
    const ok = rows.filter((r) => r.status === 'merged' || r.status === 'recompressed');
    const totals = { zipBefore: zipBytes.length, zipAfter: zip.length, songs: ok.length, removed: removedVoices.size, charts: patched.length, failed: rows.filter((r) => r.status === 'error').length, kept: rows.filter((r) => r.status === 'kept').length };
    return { zip, report, rows, totals, problems };
  }

  FNF.audio = { planMusic, parseName, runMusicJob, processMusicZip, qualityFromKbps, autoQuality };
})(typeof self !== 'undefined' ? self : globalThis);
