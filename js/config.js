/* config.js — leitura/edição de JSON preservando a formatação original byte a byte (edição por trechos),
 * ajuste de config do Psych Engine e do Leather Engine, pareamento de arquivos e gerador de ZIP. */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});

  // ---------------------------------------------------------------- JSON com posições
  function parseJSONSpans(text) {
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const fail = (m) => { throw new Error(FNF.t('cfg.err.json',{m,i})); };
    const ws = () => { while (i < text.length) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
    function str() {
      const start = i;
      if (text[i] !== '"') fail(FNF.t('cfg.j.quote'));
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= text.length) fail(FNF.t('cfg.j.unterminated'));
      i++;
      return { kind: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) };
    }
    function value() {
      ws();
      const start = i, c = text[i];
      if (c === '{') {
        i++; const props = []; ws();
        if (text[i] === '}') { i++; return { kind: 'object', start, end: i, props }; }
        for (;;) {
          ws(); const k = str(); ws();
          if (text[i] !== ':') fail(FNF.t('cfg.j.colon'));
          i++;
          const v = value();
          props.push({ key: k.value, keyStart: k.start, keyEnd: k.end, value: v });
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; break; }
          fail(FNF.t('cfg.j.comma_brace'));
        }
        return { kind: 'object', start, end: i, props };
      }
      if (c === '[') {
        i++; const items = []; ws();
        if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items }; }
        for (;;) {
          items.push(value()); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; break; }
          fail(FNF.t('cfg.j.comma_bracket'));
        }
        return { kind: 'array', start, end: i, items };
      }
      if (c === '"') return str();
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
      if (m) { i += m[0].length; return { kind: 'number', start, end: i, value: parseFloat(m[0]), raw: m[0] }; }
      const lit = /^(true|false|null)/.exec(text.slice(i, i + 6));
      if (lit) { i += lit[0].length; return { kind: 'literal', start, end: i, value: lit[0] }; }
      fail(FNF.t('cfg.j.value'));
    }
    const rootNode = value();
    ws();
    if (i < text.length) fail(FNF.t('cfg.j.trailing'));
    return rootNode;
  }

  function applyEdits(text, edits) {
    return edits.slice().sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
  }
  const fmtNum = (x) => String(Number(x.toFixed(4)));
  const fmtOff = (x) => String(Number(x.toFixed(2)));
  const prop = (node, key) => (node.kind === 'object' ? node.props.find((p) => p.key === key) : undefined);

  // nome de saída: troca só o nome-base (mantém pastas e extensão)
  function renameRef(ref, rename) {
    if (!rename) return ref;
    const m = /^(.*?)([^\/\\]*?)(\.[A-Za-z0-9]+)?$/.exec(ref);
    return m[1] + rename(m[2]) + (m[3] || '');
  }

  // ---------------------------------------------------------------- Psych Engine
  /** opts: { invScale, rename:(base)=>base } */
  function adjustPsychConfig(text, opts) {
    const rootN = parseJSONSpans(text);
    if (rootN.kind !== 'object') throw new Error(FNF.t('cfg.err.psychobj'));
    const edits = [], changes = [], warnings = [];
    const sc = prop(rootN, 'scale');
    if (opts.skipScale) {
      // escala 1.0: nada a compensar
    } else if (sc && sc.value.kind === 'number') {
      const nv = sc.value.value * opts.invScale;
      edits.push({ start: sc.value.start, end: sc.value.end, text: fmtNum(nv) });
      changes.push({ field: 'scale', before: sc.value.raw, after: fmtNum(nv) });
    } else if (!sc) {
      if (!rootN.props.length) warnings.push(FNF.t('cfg.warn.emptyjson'));
      else {
        const k0 = rootN.props[0].keyStart;
        const gap = text.slice(rootN.start + 1, k0);
        edits.push({ start: k0, end: k0, text: '"scale": ' + fmtNum(opts.invScale) + ',' + gap });
        changes.push({ field: 'scale', before: FNF.t('cfg.change.absent'), after: fmtNum(opts.invScale) });
      }
    } else warnings.push(FNF.t('cfg.warn.scalenotnum'));
    if (opts.offsetShift && !opts.skipScale) {
      const an = prop(rootN, 'animations');
      if (an && an.value.kind === 'array') {
        an.value.items.forEach((it, idx) => {
          const nm = prop(it, 'anim');
          const label = 'animations[' + idx + ']' + (nm && nm.value.kind === 'string' ? ' (' + nm.value.value + ')' : '') + '.offsets';
          const off = prop(it, 'offsets');
          if (!off || off.value.kind !== 'array' || off.value.items.length < 2 || off.value.items.some((n) => n.kind !== 'number')) {
            if (opts.offsetShift.dx || opts.offsetShift.dy) warnings.push(FNF.t('cfg.warn.nooffsets', { label }));
            return;
          }
          const [a, b] = off.value.items;
          const na = fmtOff(a.value + opts.offsetShift.dx), nb = fmtOff(b.value + opts.offsetShift.dy);
          edits.push({ start: a.start, end: a.end, text: na }, { start: b.start, end: b.end, text: nb });
          changes.push({ field: label, before: a.raw + ', ' + b.raw, after: na + ', ' + nb });
        });
      }
    }
    const im = prop(rootN, 'image');
    if (im && im.value.kind === 'string' && opts.rename) {
      const nv = im.value.value.split(',').map((s) => renameRef(s.trim(), opts.rename)).join(',');
      if (nv !== im.value.value) {
        edits.push({ start: im.value.start, end: im.value.end, text: JSON.stringify(nv) });
        changes.push({ field: 'image', before: im.value.value, after: nv });
      }
    }
    return { text: applyEdits(text, edits), changes, warnings };
  }

  // ---------------------------------------------------------------- Leather Engine
  const LEATHER_SCALE_KEY = /^(scale|char(acter)?[_-]?scale|sprite[_-]?scale)$/i;

  /** opts: { invScale, rename, addScaleField } */
  function adjustLeatherConfig(text, opts) {
    const rootN = parseJSONSpans(text);
    if (rootN.kind !== 'object') throw new Error(FNF.t('cfg.err.leatherobj'));
    const edits = [], changes = [], warnings = [];
    const numericScale = rootN.props.filter((p) => /scale/i.test(p.key) && p.value.kind === 'number');
    const applicable = numericScale.filter((p) => LEATHER_SCALE_KEY.test(p.key));
    for (const p of opts.skipScale ? [] : applicable) {
      const nv = p.value.value * opts.invScale;
      edits.push({ start: p.value.start, end: p.value.end, text: fmtNum(nv) });
      changes.push({ field: p.key, before: p.value.raw, after: fmtNum(nv) });
    }
    for (const p of opts.skipScale ? [] : numericScale) if (!applicable.includes(p)) warnings.push(FNF.t('cfg.warn.scalelike',{key:p.key}));
    if (!applicable.length && !opts.skipScale) {
      if (opts.addScaleField && rootN.props.length) {
        const k0 = rootN.props[0].keyStart;
        const gap = text.slice(rootN.start + 1, k0);
        edits.push({ start: k0, end: k0, text: '"scale": ' + fmtNum(opts.invScale) + ',' + gap });
        changes.push({ field: 'scale', before: FNF.t('cfg.change.absent2'), after: FNF.t('cfg.change.added',{v:fmtNum(opts.invScale)}) });
        warnings.push(FNF.t('cfg.warn.added'));
      } else {
        warnings.push(FNF.t('cfg.warn.noscale',{factor:fmtNum(opts.invScale)}));
      }
    }
    if (opts.rename) {
      const ip = prop(rootN, 'imagePath');
      if (ip && ip.value.kind === 'string') {
        const nv = renameRef(ip.value.value, opts.rename);
        if (nv !== ip.value.value) {
          edits.push({ start: ip.value.start, end: ip.value.end, text: JSON.stringify(nv) });
          changes.push({ field: 'imagePath', before: ip.value.value, after: nv });
        }
      }
      const ex = prop(rootN, 'extraSheets');
      if (ex && ex.value.kind === 'array') {
        ex.value.items.forEach((it, idx) => {
          if (it.kind !== 'string') return;
          const nv = renameRef(it.value, opts.rename);
          if (nv !== it.value) {
            edits.push({ start: it.start, end: it.end, text: JSON.stringify(nv) });
            changes.push({ field: 'extraSheets[' + idx + ']', before: it.value, after: nv });
          }
        });
      }
    }
    const scaled = !opts.skipScale && (applicable.length > 0 || !!(opts.addScaleField && rootN.props.length));
    return { text: applyEdits(text, edits), changes, warnings, scaled };
  }

  /** Soma (dx,dy) aos offsets de "nome x y" (compensa a mudança de escala), preservando o formato do arquivo. */
  function shiftOffsetsText(text, dx, dy) {
    const parts = text.split(/(\r?\n)/);
    const changes = [];
    for (let i = 0; i < parts.length; i += 2) {
      const m = /^(\s*\S.*?)(\s+)(-?\d+(?:\.\d+)?)(\s+)(-?\d+(?:\.\d+)?)(\s*)$/.exec(parts[i]);
      if (!m) continue;
      const a = fmtOff(parseFloat(m[3]) + dx), b = fmtOff(parseFloat(m[5]) + dy);
      parts[i] = m[1] + m[2] + a + m[4] + b + m[6];
      changes.push({ field: m[1].trim(), before: m[3] + ' ' + m[5], after: a + ' ' + b });
    }
    return { text: parts.join(''), changes };
  }

  /** Multiplica os offsets de "nome x y" por factor, preservando ordem, separadores e fim de linha. */
  function scaleOffsetsText(text, factor) {
    const parts = text.split(/(\r?\n)/);
    const changes = [];
    for (let i = 0; i < parts.length; i += 2) {
      const m = /^(\s*\S.*?)(\s+)(-?\d+(?:\.\d+)?)(\s+)(-?\d+(?:\.\d+)?)(\s*)$/.exec(parts[i]);
      if (!m) continue;
      const a = Math.round(parseFloat(m[3]) * factor), b = Math.round(parseFloat(m[5]) * factor);
      parts[i] = m[1] + m[2] + a + m[4] + b + m[6];
      changes.push({ field: m[1].trim(), before: m[3] + ' ' + m[5], after: a + ' ' + b });
    }
    return { text: parts.join(''), changes };
  }

  // ---------------------------------------------------------------- pareamento de arquivos
  const extOf = (n) => { const m = /\.([^.\/\\]+)$/.exec(n); return m ? m[1].toLowerCase() : ''; };
  const baseOf = (n) => n.replace(/^.*[\/\\]/, '').replace(/\.[^.\/\\]+$/, '');
  const dirOf = (p) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : p.slice(0, i + 1).replace(/\\/g, '/'); };

  function detectConfigKind(text) {
    let j;
    try { j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) { return null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    if ('imagePath' in j) return 'leather';
    if ('image' in j) return 'psych';
    if (Array.isArray(j.animations)) {
      const a = j.animations[0] || {};
      if ('animation_name' in a) return 'leather';
      if ('anim' in a) return 'psych';
    }
    return null;
  }

  /** files: [{name, path, bytes}] */
  function pairFiles(files) {
    const pngs = [], xmls = [], jsons = [], txts = [], problems = [];
    for (const f of files) {
      const e = extOf(f.name);
      if (e === 'png' || e === 'astc') pngs.push(f);
      else if (e === 'xml') xmls.push(f);
      else if (e === 'json') jsons.push(f);
      else if (e === 'txt') txts.push(f);
      else problems.push({ level: 'info', msg: FNF.t('files.ignored',{name:f.name}) });
    }
    const key = (f) => (dirOf(f.path || f.name) + baseOf(f.name)).toLowerCase();
    const atlases = [], usedX = new Set();
    for (const p of pngs) {
      let x = xmls.find((q) => key(q) === key(p)) || xmls.find((q) => !usedX.has(q) && baseOf(q.name).toLowerCase() === baseOf(p.name).toLowerCase());
      if (!x) { problems.push({ level: 'error', msg: FNF.t('files.nopng',{name:p.name}) }); continue; }
      usedX.add(x);
      atlases.push({ name: baseOf(p.name), dir: dirOf(p.path || p.name), pngName: p.name, xmlName: x.name, pngBytes: p.bytes, xmlText: FNF.textDecode(x.bytes) });
    }
    for (const x of xmls) if (!usedX.has(x)) problems.push({ level: 'error', msg: FNF.t('files.noxml',{name:x.name}) });

    const configs = [];
    for (const j of jsons) {
      const text = FNF.textDecode(j.bytes);
      const kind = detectConfigKind(text);
      if (!kind) { problems.push({ level: 'warn', msg: FNF.t('files.notcfg',{name:j.name}) }); continue; }
      configs.push({ kind, name: j.name, dir: dirOf(j.path || j.name), text, bytes: j.bytes, offsets: null });
    }
    const leather = configs.filter((c) => c.kind === 'leather');
    const usedT = new Set();
    for (const c of leather) {
      let t = txts.find((q) => !usedT.has(q) && dirOf(q.path || q.name) === c.dir && /^offsets\.txt$/i.test(q.name)) ||
        txts.find((q) => !usedT.has(q) && dirOf(q.path || q.name) === c.dir);
      if (!t && leather.length === 1 && txts.length === 1) t = txts[0];
      if (t) { usedT.add(t); c.offsets = { name: t.name, bytes: t.bytes, text: FNF.textDecode(t.bytes) }; }
      else problems.push({ level: 'warn', msg: FNF.t('files.nooffsets',{name:c.name}) });
    }
    for (const t of txts) if (!usedT.has(t)) problems.push({ level: 'info', msg: FNF.t('files.txtignored',{name:t.name}) });
    return { atlases, configs, problems };
  }

  // ---------------------------------------------------------------- ZIP
  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  /** files: [{path, data:Uint8Array, deflate?:boolean}] → Uint8Array (.zip) */
  async function makeZip(files) {
    const { time, date } = dosDateTime(new Date());
    const locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const name = FNF.textEncode(f.path.replace(/^\/+/, ''));
      let method = 0, body = f.data;
      if (f.deflate) {
        const d = await FNF.deflateRaw(f.data);
        if (d.length < f.data.length) { method = 8; body = d; }
      }
      const crc = FNF.crc32(f.data);
      const lh = new Uint8Array(30 + name.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true);
      lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true); lv.setUint32(22, f.data.length, true); lv.setUint16(26, name.length, true);
      lh.set(name, 30);
      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, body.length, true); cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      locals.push(lh, body); centrals.push(ch);
      offset += lh.length + body.length;
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return FNF.concat([...locals, ...centrals, end]);
  }

  Object.assign(FNF, { parseJSONSpans, adjustPsychConfig, adjustLeatherConfig, scaleOffsetsText, shiftOffsetsText, pairFiles, detectConfigKind, makeZip, baseOf, dirOf });
})(typeof self !== 'undefined' ? self : globalThis);
