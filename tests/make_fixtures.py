"""Gera PNGs de teste em formatos variados (paleta, cinza, 16 bits, entrelaçado) para validar o decoder."""
import numpy as np, sys, os
from PIL import Image
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(1)
w, h = 37, 23
rgba = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
rgba[..., 3] = np.where(rng.random((h, w)) < 0.3, 0, rgba[..., 3])
Image.fromarray(rgba, 'RGBA').save(f'{out}/rgba8.png')
Image.fromarray(rgba, 'RGBA').save(f'{out}/rgba8_interlaced.png', interlace=1) if 'interlace' in Image.registered_extensions() else None
rgb = rgba[..., :3].copy()
Image.fromarray(rgb, 'RGB').save(f'{out}/rgb8.png')
gray = rgba[..., 0].copy()
Image.fromarray(gray, 'L').save(f'{out}/gray8.png')
Image.fromarray(rgba[..., [0, 3]].copy(), 'LA').save(f'{out}/graya8.png')
pal = Image.fromarray(rgb, 'RGB').quantize(16)
pal.save(f'{out}/pal4.png', bits=4)
pal.save(f'{out}/pal8_trns.png', transparency=3)
Image.fromarray((gray > 128).astype(np.uint8) * 255, 'L').convert('1').save(f'{out}/bw1.png')
a16 = (rng.integers(0, 65536, (h, w, 4))).astype(np.uint16)
import struct, zlib
def png16(path, arr):
    hh, ww, _ = arr.shape
    raw = b''.join(b'\x00' + arr[y].astype('>u2').tobytes() for y in range(hh))
    def ch(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', ww, hh, 16, 6, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))
png16(f'{out}/rgba16.png', a16)
# interlaçado (Adam7) escrito manualmente via libpng do Pillow não é exposto; usa APNG-free caminho: salva com zlib filtro 0
def adam7(path, arr):
    hh, ww, _ = arr.shape
    passes = [(0,0,8,8),(4,0,8,8),(0,4,4,8),(2,0,4,4),(0,2,2,4),(1,0,2,2),(0,1,1,2)]
    raw = b''
    for x0, y0, dx, dy in passes:
        sub = arr[y0::dy, x0::dx]
        if sub.shape[0] == 0 or sub.shape[1] == 0: continue
        for y in range(sub.shape[0]): raw += b'\x00' + sub[y].tobytes()
    def ch(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', ww, hh, 8, 6, 0, 0, 1)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))
adam7(f'{out}/rgba8_adam7.png', rgba)
np.save(f'{out}/rgba8.npy', rgba)
np.save(f'{out}/rgb8.npy', rgb)
np.save(f'{out}/gray8.npy', gray)
np.save(f'{out}/rgba16.npy', a16)
np.save(f'{out}/pal4.npy', np.array(pal.convert('RGB')))
np.save(f'{out}/pal8_trns.npy', np.array(Image.open(f'{out}/pal8_trns.png').convert('RGBA')))
np.save(f'{out}/bw1.npy', np.array(Image.open(f'{out}/bw1.png').convert('L')))
np.save(f'{out}/graya8.npy', np.array(Image.open(f'{out}/graya8.png').convert('RGBA')))
print('ok')
