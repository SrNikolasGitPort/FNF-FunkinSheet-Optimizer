/* worker.js — executa o lote de otimização fora da thread da interface. */
'use strict';
importScripts('i18n.js', 'png.js', 'astc.js', 'compress.js', 'sparrow.js', 'resample.js', 'pack.js', 'config.js', 'pipeline.js', 'zipjob.js');

self.onmessage = async (ev) => {
  const m = ev.data;
  if (!m || (m.type !== 'run' && m.type !== 'zip')) return;
  try {
    if (m.lang) self.FNF.setLang(m.lang);
    if (m.type === 'zip') {
      const res = await self.FNF.processZip(m.zipBytes, m.opts, (stage, pct) => self.postMessage({ type: 'progress', stage, pct }));
      self.postMessage({ type: 'done', zipResult: res }, [res.zip.buffer]);
      return;
    }
    const batch = await self.FNF.runBatch({
      atlases: m.atlases,
      configs: m.configs,
      opts: m.opts,
      onProgress: (stage, pct) => self.postMessage({ type: 'progress', stage, pct }),
    });
    self.postMessage({ type: 'done', batch });
  } catch (e) {
    self.postMessage({ type: 'error', message: (e && e.message) || String(e) });
  }
};
