/* audioworker.js — mistura/codifica uma música (OGG Vorbis via WebAssembly) fora da thread da interface. */
'use strict';
importScripts('i18n.js', 'vorbis_wasm.js', 'vorbis.js', 'audiojob.js');
self.onmessage = async (ev) => {
  const m = ev.data;
  if (!m || m.type !== 'job') return;
  try {
    if (m.lang) self.FNF.setLang(m.lang);
    const job = Object.assign({}, m.job, { tracks: m.job.tracks.map((t) => ({ name: t.name, bytes: new Uint8Array(t.buffer) })) });
    const r = await self.FNF.audio.runMusicJob(job, (f) => self.postMessage({ type: 'progress', id: m.id, f }));
    self.postMessage({ type: 'done', id: m.id, result: r }, [r.bytes.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: (e && e.message) || String(e) });
  }
};
