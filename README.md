# FNF FunkinSheet Optimizer

A site that optimizes **Friday Night Funkin'** sprite atlases (Sparrow **PNG or ASTC + XML**) and keeps the character looking and aligned exactly like the original. It also has a general **image compressor**. Everything runs **100% in your browser** (nothing is uploaded) and works offline once loaded.

Live: https://srnikolasgitport.github.io/FNF-FunkinSheet-Optimizer/ — the interface is in **English by default**, with a PT button for Portuguese.

## Optimize atlases

1. Drop the PNG/ASTC + XML (and optionally the Psych Engine JSON, or Leather Engine `config.json` + `offsets.txt`), or the whole character folder.
2. Pick a profile (Best quality / Balanced / Smallest) and press **Optimize**. The sprite scale is **fixed and chosen by you** (0.1–1, default 1.0 = original size); nothing is shrunk automatically.
3. Check the summary, atlas viewer and animation preview, then **Download all (.zip)**.

What it does:

- **Smart crop** of transparent borders (adjusts `frameX/frameY`, keeping the virtual frame).
- **Fixed scale** 0.1–1 (you choose), with sub-pixel resampling (Area / Bilinear / Lanczos3, premultiplied alpha) and rounding compensation.
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

A separate tab for any PNG / ASTC (other formats are not supported): choose **Lossless**, **High**, **Balanced** or **Smallest**. It searches for the smallest file whose measured quality (PSNR on premultiplied alpha) stays above the target — palette size for PNG, block size for ASTC. Invisible pixels are cleaned, and the original is kept if it can't be improved. Note: ASTC saves GPU memory (fixed size per block) but is often bigger on disk than a PNG with lots of transparency.

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
node tests/audio.test.js      # music tab (OGG)
node tests/zipjob.test.js     # ZIP mode
node tests/pipeline.test.js   # pipeline, rotated, offsets, configs, ZIP
node tests/astc.test.js       # ASTC encode/decode round trips and pipeline
node tests/compress.test.js   # image compressor
```

## Português (resumo)

Site que otimiza atlas de sprites do FNF (PNG ou ASTC + XML) e ajusta **scale e offsets** do personagem (Psych e Leather) para ficar alinhado como o original. Suporta `rotated="true"`, escala fixa escolhida por você, leitura/gravação de ASTC e uma aba **Compress images** para comprimir imagens mantendo a qualidade. Use o botão **PT** no topo para a interface em português.

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

## Music tab (OGG)

**Optimize music** takes the ZIP of your songs folder and, for each song folder, merges `Inst` + `Voices` into a single light OGG:

- `Inst.ogg` + `Voices.ogg` → `Inst.ogg`
- `Inst.ogg` + `Voices-HardeCore.ogg` → `Inst-HardeCore.ogg` (an existing `Inst-HardeCore.ogg` is used instead of `Inst.ogg`)
- Psych Engine `Voices-Player` / `Voices-Opponent` are merged into the Inst; any other suffix is treated as a difficulty.
- The merged `Voices*.ogg` files are removed from the ZIP, and the charts of those songs get `needsVoices: false` (optional checkbox) so the engine doesn't look for a missing file.
- Mixing is sample-exact (different channel counts / sample rates are handled), then re-encoded with libvorbis VBR: **High** (default, same level as typical FNF OGGs), **Balanced** or **Smallest**. The result is never larger than the original files combined (quality steps down automatically if needed), and a lone `Inst.ogg` is only replaced when the saving is meaningful.
- OGG Vorbis only; other audio formats are reported and left untouched. Everything else in the ZIP is copied back untouched.

Decoding and encoding run entirely in your browser (several workers in parallel) using the official **libogg/libvorbis compiled to WebAssembly** (`tools/vorbis-wasm/`, rebuild with `build.sh`). The decoder matches ffmpeg's to ~1e-7 and the encoder produces the same size/SNR as ffmpeg's libvorbis (see `tests/audio.test.js`). Licenses: `THIRD_PARTY_NOTICES.md`.

## ZIP mode

Drop (or **Choose ZIP**) a whole mod / characters folder as a `.zip`. The site finds every atlas (PNG or ASTC + XML) and every character config (Psych JSON, Leather `config.json` + `offsets.txt`) wherever they are, optimizes them in place and hands back a ZIP with the **same structure**. Details:

- Each config is paired with the atlas that matches its `image` / `imagePath` (preferring the same folder, so two mods with the same atlas name don't get mixed). Scale, offsets and atlas always stay in sync.
- Atlases without a character config (stages, UI…) are kept at 1.0× by default so in-game size doesn't change; **Advanced → Resize atlases without a config** overrides that.
- Everything else (audio, scripts, charts, icons, PNGs without XML) is copied back untouched, without recompressing.
- If an atlas fails validation or errors, its original files are kept; if the result isn't smaller at 1.0×, the original is kept too. An `optimizer-report.txt` is added to the ZIP.
- Limits: no password-protected or ZIP64 (>4 GB) archives.

## Turbo

Optimization is faster (≈5.4 s → ≈3 s on a 4000×3800 atlas): validation reuses the in-memory atlas for lossless PNG, and a fast path for empty PNG rows. The worker is pre-warmed at page load, and the progress bar shows live elapsed time.

## Tighter packing

The packer now tries 5 sort orders × 3 MaxRects heuristics (BSSF, best-area-fit, bottom-left) and refines the atlas width with a local search (2 s time budget). On random sprite sets this raises fill from ~89–92 % to ~94–97 % (smaller PNG dimensions, no overlap, verified by `tests/pack.test.js`). Power-of-two atlases also try every combination per size.

## Optional rotation

Advanced → **Allow rotation** (off by default) lets the packer turn sprites 90° to fit tighter. Rotated frames are written with `rotated="true"` (stored region rotated 90° clockwise, with explicit `frameWidth/frameHeight`), and validation checks the result pixel by pixel. Only enable it if your engine reads `rotated="true"` (HaxeFlixel's Sparrow loader does; some older engine builds may not).
