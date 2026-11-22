#!/bin/sh
# Compila libogg 1.3.5 + libvorbis 1.3.7 (Xiph.Org) para WebAssembly e gera js/vorbis_wasm.js (wasm em base64).
# Requer: clang (com alvo wasm32), wasm-ld, git, python3.  Uso: tools/vorbis-wasm/build.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd); OUT="$HERE/../../js/vorbis_wasm.js"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
git clone -q --depth 1 --branch v1.3.5 https://github.com/xiph/ogg.git "$W/ogg"
git clone -q --depth 1 --branch v1.3.7 https://github.com/xiph/vorbis.git "$W/vorbis"
V="$W/vorbis/lib"
SRC="$W/ogg/src/bitwise.c $W/ogg/src/framing.c $V/mdct.c $V/smallft.c $V/block.c $V/envelope.c $V/window.c $V/lsp.c $V/lpc.c $V/analysis.c $V/synthesis.c $V/psy.c $V/info.c $V/floor1.c $V/floor0.c $V/res0.c $V/mapping0.c $V/registry.c $V/codebook.c $V/sharedbook.c $V/lookup.c $V/bitrate.c $V/vorbisenc.c $HERE/vorbis_wrap.c"
clang --target=wasm32 -O2 -ffreestanding -nostdlib -fno-builtin -fno-math-errno -mbulk-memory -w \
  -I"$HERE/include" -I"$W/ogg/include" -I"$W/vorbis/include" -I"$V" -D_REENTRANT \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--strip-all -Wl,-z,stack-size=2097152 -Wl,--initial-memory=8388608 -Wl,--max-memory=2147483648 -Wl,--export-memory \
  $SRC -o "$W/vorbis.wasm"
python3 - "$W/vorbis.wasm" "$OUT" <<'PY'
import base64, sys
b = open(sys.argv[1], 'rb').read()
open(sys.argv[2], 'w').write("/* GERADO por tools/vorbis-wasm/build.sh — libogg 1.3.5 + libvorbis 1.3.7 (Xiph.Org, BSD-3-Clause) compilados para WebAssembly. Não edite. */\n"
  "'use strict';\n(function (root) { (root.FNF = root.FNF || {}).VORBIS_WASM_B64 = '" + base64.b64encode(b).decode() + "'; })(typeof self !== 'undefined' ? self : globalThis);\n")
print('wasm', len(b), 'bytes')
PY
