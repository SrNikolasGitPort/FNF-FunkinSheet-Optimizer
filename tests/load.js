'use strict';
// Carrega os módulos do site (scripts clássicos que se registram em globalThis.FNF) em Node.
const path = require('path');
for (const f of ['i18n', 'png', 'astc', 'compress', 'sparrow', 'resample', 'pack', 'config', 'pipeline', 'zipjob', 'vorbis_wasm', 'vorbis', 'audiojob']) require(path.join(__dirname, '..', 'js', f + '.js'));
module.exports = globalThis.FNF;
