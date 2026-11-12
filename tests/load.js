'use strict';
// Carrega os módulos do site (scripts clássicos que se registram em globalThis.FNF) em Node.
const path = require('path');
for (const f of ['png', 'sparrow', 'resample', 'pack', 'config', 'pipeline']) require(path.join(__dirname, '..', 'js', f + '.js'));
module.exports = globalThis.FNF;
