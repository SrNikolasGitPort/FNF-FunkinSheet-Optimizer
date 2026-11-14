# FNF FunkinSheet Optimizer

A site that optimizes **Friday Night Funkin'** sprite atlases (Sparrow **PNG or ASTC + XML**) and keeps the character looking and aligned exactly like the original. It also has a general **image compressor**. Everything runs **100% in your browser** (nothing is uploaded) and works offline once loaded.

Live: https://srnikolasgitport.github.io/FNF-FunkinSheet-Optimizer/ — the interface is in **English by default**, with a PT button for Portuguese.

## Optimize atlases

1. Drop the PNG/ASTC + XML (and optionally the Psych Engine JSON, or Leather Engine `config.json` + `offsets.txt`), or the whole character folder.
2. Pick a profile (Best quality / Balanced / Smallest) and press **Optimize**. Size is **automatic by default**: the optimizer finds the smallest scale that still keeps measured quality (PSNR) — no target size to guess. You can still force a manual scale (0.1–1).
3. Check the summary, atlas viewer and animation preview, then **Download all (.zip)**.

What it does:

- **Smart crop** of transparent borders (adjusts `frameX/frameY`, keeping the virtual frame).
- **Automatic scale**, or manual 0.1–1, with sub-pixel resampling (Area / Bilinear / Lanczos3, premultiplied alpha) and rounding compensation.
- **`rotated="true"` support**: rotated frames are read correctly and written back upright.
- **Remove animations or frames** (optional, under Advanced): untick whole animations or single frames before optimizing; the site warns if the config still references an animation with no frames.
- **Deduplication** (identical, and optionally near-identical frames) and a **MaxRects packer**.
- **Smaller images**: adaptive PNG filters, exact palette PNG-8 when possible, optional quantized PNG-8.
- **ASTC**: reads `.astc` atlases (V-Slice style) and can write `.astc` (block sizes 4×4 … 12×12). The decoder was verified block-by-block against the browser's own GPU ASTC decoder. Limitation: blocks that use multiple partitions or HDR are not supported (reported as warnings).
- **Character config adjustment** that fixes **scale and offsets** so the character is aligned like the original. If the sprite is drawn at `1/S` size, the offsets of every animation are also shifted by half the change of the virtual frame size, `off' = off + (C' − C)`, where `C` is the centre of the reference frame (Flixel scales around it). The animation preview simulates the game's positioning using the original and the new config.
  - **Psych Engine** (any version): `scale` and each `animations[].offsets`.
  - **Leather Engine 0.5.0 – 1.1.9**: `config.json` (adds a `scale` field if missing, optional) and `offsets.txt`; `imagePath` / `extraSheets` use the same effective scale.
  - Original formatting is preserved (only the necessary values change).
- **Validation**: the result is decoded again and compared with the original (pixel-exact when lossless; PSNR otherwise).

## Compress images

A separate tab for any PNG / JPG / WebP / ASTC: choose **Lossless**, **High**, **Balanced** or **Smallest**. It searches for the smallest file whose measured quality (PSNR on premultiplied alpha) stays above the target — palette size for PNG, quality for WebP/JPEG, block size for ASTC. Invisible pixels are cleaned, and the original is kept if it can't be improved. Note: ASTC saves GPU memory (fixed size per block) but is often bigger on disk than a PNG with lots of transparency.

## Notes

- Offsets are computed from the *dominant* frame size, which is what the engine uses as the scaling origin in practice. Always eyeball the Animations tab for characters with very unusual frames.
- There is no artificial size limit (the atlas can grow up to 32768 px per side); there is no multi-page output.
- PNG uses the browser's native deflate (`CompressionStream`), which is not as strong as zopfli.
- When cropping, the XML usually **grows** (adds `frameX/frameY`); the image savings far outweigh it.

## Run / host

Static site (scripts are deferred and cached by a small service worker, so repeat visits open instantly): open `index.html`, or publish with GitHub Pages (a workflow is included). Processing runs in a Web Worker and falls back to the main thread when workers are blocked (e.g. `file://`).

## Tests

Node 18+:

```bash
node tests/png.test.js        # PNG decoder/encoder
node tests/pipeline.test.js   # pipeline, auto scale, rotated, offsets, configs, ZIP
node tests/astc.test.js       # ASTC encode/decode round trips and pipeline
node tests/compress.test.js   # image compressor
```

## Português (resumo)

Site que otimiza atlas de sprites do FNF (PNG ou ASTC + XML) e ajusta **scale e offsets** do personagem (Psych e Leather) para ficar alinhado como o original. Suporta `rotated="true"`, escala automática (sem alvo de tamanho), leitura/gravação de ASTC e uma aba **Compress images** para comprimir imagens mantendo a qualidade. Use o botão **PT** no topo para a interface em português.

## Structure

```
index.html, css/style.css
js/i18n.js       EN/PT strings
js/png.js        PNG decoder/encoder, quantization
js/astc.js       ASTC decoder/encoder
js/sparrow.js    Sparrow XML parser/writer
js/resample.js   sub-pixel resizing
js/pack.js       MaxRects
js/config.js     JSON edit-by-spans, Psych/Leather, file pairing, ZIP
js/pipeline.js   single-atlas pipeline and batch with configs
js/compress.js   image compressor
js/worker.js     off-main-thread execution
js/demo.js       example character
js/app.js        UI
tests/           automated tests
```
