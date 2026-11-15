/* zipjob.js — otimiza um .zip inteiro: acha os atlas (PNG/ASTC + XML) e os configs (Psych JSON / Leather config.json + offsets.txt)
 * onde estiverem, otimiza cada grupo e devolve um .zip com a mesma estrutura (o que não é sprite volta intacto, sem recomprimir). */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});
  const lc = (s) => String(s).toLowerCase();
  const ext = (p) => { const m = /\.([^.\/]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
  const junk = (p) => /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/i.test(p);
  const MAX_JSON = 1024 * 1024;

  function rawRefs(cfg) {
    let j;
    try { j = JSON.parse(cfg.text.charCodeAt(0) === 0xfeff ? cfg.text.slice(1) : cfg.text); } catch (e) { return []; }
    const clean = (s) => String(s).trim().replace(/\\/g, '/').replace(/\.(png|astc|xml)$/i, '');
    if (cfg.kind === 'psych') return typeof j.image === 'string' ? j.image.split(',').map(clean) : [];
    const refs = [];
    if (typeof j.imagePath === 'string') refs.push(clean(j.imagePath));
    if (Array.isArray(j.extraSheets)) for (const s of j.extraSheets) if (typeof s === 'string') refs.push(clean(s));
    return refs;
  }
  const commonPrefix = (a, b) => { a = lc(a); b = lc(b); let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

  /** Quantos arquivos do .zip são candidatos (sem descompactar nada): para o resumo da interface. */
  function scanZip(bytes) {
    const entries = FNF.listZip(bytes).filter((e) => !e.dir && !junk(e.path));
    const count = (re) => entries.filter((e) => re.test(e.path)).length;
    const bases = (re) => new Set(entries.filter((e) => re.test(e.path)).map((e) => lc(FNF.baseOf(e.path))));
    const xmls = bases(/\.xml$/i);
    const atlases = entries.filter((e) => /\.(png|astc)$/i.test(e.path) && xmls.has(lc(FNF.baseOf(e.path)))).length;
    return { files: entries.length, atlases, images: count(/\.(png|astc)$/i), json: count(/\.json$/i) };
  }

  async function processZip(zipBytes, opts, onProgress) {
    const P = async (stage, pct) => { if (onProgress) await onProgress(stage, pct); };
    opts = Object.assign({}, FNF.DEFAULTS, opts || {}, { suffix: '' });
    await P(FNF.t('zj.reading'), 0);
    const entries = FNF.listZip(zipBytes);
    const usable = entries.filter((e) => !e.dir && !junk(e.path) && !e.encrypted);
    if (entries.some((e) => e.encrypted)) throw new Error(FNF.t('zip.err.encrypted'));
    const baseSet = (re) => new Set(usable.filter((e) => re.test(e.path)).map((e) => lc(FNF.baseOf(e.path))));
    const xmlBases = baseSet(/\.xml$/i), imgBases = baseSet(/\.(png|astc)$/i);
    const want = usable.filter((e) => {
      const x = ext(e.path), b = lc(FNF.baseOf(e.path));
      if (x === 'png' || x === 'astc') return xmlBases.has(b);
      if (x === 'xml') return imgBases.has(b);
      if (x === 'json') return e.usize <= MAX_JSON;
      return false;
    });
    const files = [];
    const problems = [];
    for (let i = 0; i < want.length; i++) {
      try {
        const bytes = await FNF.zipData(zipBytes, want[i]);
        // JSON que não é config de personagem (charts, etc.) é normal num mod: ignora em silêncio
        if (ext(want[i].path) === 'json' && !FNF.detectConfigKind(FNF.textDecode(bytes))) continue;
        files.push({ name: want[i].path.replace(/^.*\//, ''), path: want[i].path, bytes });
      }
      catch (e) { problems.push({ level: 'warn', msg: want[i].path + ': ' + e.message }); }
      if (i % 20 === 0) await P(FNF.t('zj.reading'), (i / Math.max(1, want.length)) * 4);
    }
    // offsets.txt só dos diretórios que têm config do Leather
    const leatherDirs = new Set();
    for (const f of files) if (ext(f.name) === 'json') {
      let k = null; try { k = FNF.detectConfigKind(FNF.textDecode(f.bytes)); } catch (e) { /* ignorado */ }
      if (k === 'leather') leatherDirs.add(FNF.dirOf(f.path));
    }
    for (const e of usable) if (ext(e.path) === 'txt' && leatherDirs.has(FNF.dirOf(e.path))) {
      try { files.push({ name: e.path.replace(/^.*\//, ''), path: e.path, bytes: await FNF.zipData(zipBytes, e) }); } catch (err) { /* ignorado */ }
    }
    const paired = FNF.pairFiles(files);
    for (const pr of paired.problems) if (pr.level === 'warn') problems.push(pr);
    const atlases = paired.atlases, configs = paired.configs;
    if (!atlases.length) throw new Error(FNF.t('zj.none'));

    // ---- agrupa: cada config com seus atlas (o mais próximo de pasta); atlas sem config ficam sozinhos
    const parent = atlases.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const cfgAtlas = new Map(); // config -> índice do primeiro atlas
    const hasCfg = new Set();
    const unmatched = [];
    for (const c of configs) {
      const found = [];
      for (const r of rawRefs(c)) {
        const base = lc(r.replace(/^.*\//, ''));
        let best = -1, bs = -1;
        atlases.forEach((a, i) => {
          if (lc(a.name) !== base) return;
          const sc = (lc(a.dir + a.name).endsWith(lc(r)) ? 100000 : 0) + commonPrefix(a.dir, c.dir);
          if (sc > bs) { bs = sc; best = i; }
        });
        if (best >= 0 && !found.includes(best)) found.push(best);
      }
      if (!found.length) { unmatched.push(c); continue; }
      cfgAtlas.set(c, found[0]);
      for (const x of found) { parent[find(x)] = find(found[0]); hasCfg.add(x); }
    }
    for (const c of unmatched) problems.push({ level: 'warn', msg: FNF.t('zj.cfgnoatlas', { name: c.dir + c.name }) });
    const groups = new Map();
    atlases.forEach((a, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, { atlases: [], configs: [], hasCfg: false }); groups.get(k).atlases.push(a); });
    for (const [c, i] of cfgAtlas) { const g = groups.get(find(i)); g.configs.push(c); g.hasCfg = true; }
    const list = [...groups.values()];

    const repl = new Map(); // caminho original -> arquivos que o substituem
    const rows = [], merged = { results: [], configs: [], problems: [], opts };
    let nAtl = 0, nKept = 0, nFail = 0, nCfg = 0, nNoCfg = 0;
    const toFile = (path, data, deflate) => ({ path, data, deflate });
    for (let gi = 0; gi < list.length; gi++) {
      const g = list[gi];
      const gopts = g.hasCfg || opts.resizeNoConfig ? opts : Object.assign({}, opts, { scale: 1 });
      if (!g.hasCfg && opts.scale < 1 && !opts.resizeNoConfig) nNoCfg += g.atlases.length;
      const label = g.atlases.map((a) => a.dir + a.pngName);
      let batch = null, err = null;
      try {
        batch = await FNF.runBatch({
          atlases: g.atlases.map((a) => ({ name: a.name, dir: a.dir, pngBytes: a.pngBytes, xmlText: a.xmlText })),
          configs: g.configs.map((c) => ({ kind: c.kind, name: c.name, dir: c.dir, text: c.text, bytes: c.bytes, offsets: c.offsets })),
          opts: gopts,
          onProgress: (stage, pct) => P(stage, 5 + ((gi * 100 + pct) / list.length) * 0.9),
        });
      } catch (e) { err = (e && e.message) || String(e); }
      const failRows = (status, note) => g.atlases.forEach((a, i) => {
        rows.push({ path: a.dir + a.pngName, status, note, before: a.pngBytes.length + a.xmlText.length, after: a.pngBytes.length + a.xmlText.length });
        if (status === 'error') nFail++; else nKept++;
      });
      if (err) { failRows('error', err); problems.push({ level: 'warn', msg: label.join(', ') + ': ' + err }); continue; }
      const bad = batch.results.find((r) => !r.validation.ok);
      if (bad) { const note = FNF.t('zj.revert.invalid', { name: bad.name }); failRows('error', note); problems.push({ level: 'warn', msg: note }); continue; }
      const unscaled = batch.results.every((r) => Math.abs(r.seff - 1) < 1e-9);
      const oldT = batch.results.reduce((n, r) => n + r.stats.pngBefore + r.stats.xmlBefore, 0);
      const newT = batch.results.reduce((n, r) => n + r.stats.pngAfter + r.stats.xmlAfter, 0);
      if (unscaled && newT >= oldT) { failRows('kept', FNF.t('zj.revert.bigger')); continue; }
      // aplica o grupo
      g.atlases.forEach((a, i) => {
        const r = batch.results[i];
        repl.set(a.dir + a.pngName, [toFile(r.dir + r.pngName, r.pngBytes, false)]);
        repl.set(a.dir + a.xmlName, [toFile(r.dir + r.xmlName, FNF.textEncode(r.xmlText), true)]);
        rows.push({ path: a.dir + a.pngName, status: 'ok', note: '', scale: r.scale, atlasBefore: r.stats.atlasBefore, atlasAfter: r.stats.atlasAfter, before: r.stats.pngBefore + r.stats.xmlBefore, after: r.stats.pngAfter + r.stats.xmlAfter });
        nAtl++;
      });
      g.configs.forEach((c, i) => {
        const o = batch.configs[i];
        repl.set(c.dir + c.name, [toFile(c.dir + o.name, o.bytes, true)]);
        if (c.offsets && o.offsets) repl.set(c.dir + c.offsets.name, [toFile(c.dir + o.offsets.name, o.offsets.bytes, true)]);
        if (o.changes.length || (o.offsets && o.offsets.changes.length)) nCfg++;
      });
      merged.results.push(...batch.results); merged.configs.push(...batch.configs); merged.problems.push(...batch.problems);
    }
    if (nNoCfg) problems.push({ level: 'info', msg: FNF.t('zj.noscale', { n: nNoCfg }) });
    merged.problems.push(...problems);

    await P(FNF.t('zj.building'), 96);
    const out = [];
    for (const e of entries) {
      const r = repl.get(e.path);
      if (r) { out.push(...r); continue; }
      out.push({ path: e.path, nameBytes: e.nameBytes, flags: e.flags, raw: { method: e.method, body: FNF.zipRaw(zipBytes, e), crc: e.crc, usize: e.usize } });
    }
    const report = FNF.buildReportText(merged);
    out.push({ path: 'optimizer-report.txt', data: FNF.textEncode(report), deflate: true });
    const zip = await FNF.makeZip(out);
    await P(FNF.t('pl.stage.done'), 100);
    const totals = { zipBefore: zipBytes.length, zipAfter: zip.length, atlases: nAtl, kept: nKept, failed: nFail, configs: nCfg, files: usable.length, resizedNoCfg: !!opts.resizeNoConfig };
    return { zip, report, rows, totals, problems: problems.filter((p) => p.level !== 'info' || true).map((p) => ({ level: p.level, msg: p.msg })) };
  }

  Object.assign(FNF, { processZip, scanZip });
})(typeof self !== 'undefined' ? self : globalThis);
