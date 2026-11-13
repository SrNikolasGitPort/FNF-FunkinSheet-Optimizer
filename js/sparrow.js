/* sparrow.js — parser/escritor do XML de atlas Sparrow (TextureAtlas/SubTexture) sem DOMParser,
 * para funcionar em Web Worker e Node. */
'use strict';
(function (root) {
  const FNF = (root.FNF = root.FNF || {});

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    });
  }
  function encodeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function parseAttrs(str) {
    const out = {};
    const re = /([^\s=\/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(str))) out[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    return out;
  }

  const num = (v) => {
    const n = Math.round(parseFloat(v));
    return Number.isFinite(n) ? n : NaN;
  };

  /** Lê um XML Sparrow. Retorna { imagePath, frames:[{name,x,y,w,h,fx,fy,fw,fh,rotated,hasFrame}], warnings } */
  function parseSparrow(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rootM = /<TextureAtlas\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(text);
    if (!rootM) throw new Error(FNF.t('sp.err.root'));
    const atlasAttrs = parseAttrs(rootM[1]);
    const re = /<SubTexture\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/gi;
    const frames = [];
    const warnings = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(text))) {
      const a = parseAttrs(m[1]);
      const name = a.name;
      if (name === undefined) throw new Error(FNF.t('sp.err.noname'));
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
      if (![x, y, w, h].every(Number.isFinite)) throw new Error(FNF.t('sp.err.rect',{name}));
      const hasFrame = a.frameX !== undefined || a.frameY !== undefined || a.frameWidth !== undefined || a.frameHeight !== undefined;
      const fx = a.frameX !== undefined ? num(a.frameX) : 0;
      const fy = a.frameY !== undefined ? num(a.frameY) : 0;
      const rotated = a.rotated === 'true';
      const fw = a.frameWidth !== undefined ? num(a.frameWidth) : (rotated ? h : w);
      const fh = a.frameHeight !== undefined ? num(a.frameHeight) : (rotated ? w : h);
      if (![fx, fy, fw, fh].every(Number.isFinite)) throw new Error(FNF.t('sp.err.frame',{name}));
      if (seen.has(name)) warnings.push(FNF.t('sp.warn.dup',{name}));
      seen.add(name);
      frames.push({ name, x, y, w, h, fx, fy, fw, fh, hasFrame, rotated });
    }
    if (!frames.length) throw new Error(FNF.t('sp.err.none'));
    return { imagePath: atlasAttrs.imagePath || '', frames, warnings };
  }

  /** frames: [{name,x,y,w,h,fx,fy,fw,fh}] — frameX/Y/W/H só são escritos quando necessários. */
  function writeSparrow(imagePath, frames) {
    const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<TextureAtlas imagePath="' + encodeAttr(imagePath) + '">'];
    for (const f of frames) {
      let s = '<SubTexture name="' + encodeAttr(f.name) + '" x="' + f.x + '" y="' + f.y + '" width="' + f.w + '" height="' + f.h + '"';
      if (f.fx !== 0 || f.fy !== 0 || f.fw !== f.w || f.fh !== f.h) {
        s += ' frameX="' + f.fx + '" frameY="' + f.fy + '" frameWidth="' + f.fw + '" frameHeight="' + f.fh + '"';
      }
      lines.push(s + '/>');
    }
    lines.push('</TextureAtlas>');
    return lines.join('\n');
  }

  Object.assign(FNF, { parseSparrow, writeSparrow });
})(typeof self !== 'undefined' ? self : globalThis);
