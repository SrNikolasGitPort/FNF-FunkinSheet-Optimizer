/* vorbis_wrap.c — libc mínima + API simples (decodificar / codificar OGG Vorbis) para o FunkinSheet Optimizer.
 * Compilado junto com libogg 1.3.5 e libvorbis 1.3.7 (Xiph.Org, licença BSD). */
#include <stddef.h>
#include <stdint.h>
#include <ogg/ogg.h>
#include <vorbis/codec.h>
#include <vorbis/vorbisenc.h>

#define EXPORT(n) __attribute__((export_name(n)))

/* ---------------------------------------------------------------- mini libc */
void *memcpy(void *d, const void *s, size_t n) { return __builtin_memcpy(d, s, n); }
void *memmove(void *d, const void *s, size_t n) { return __builtin_memmove(d, s, n); }
void *memset(void *d, int c, size_t n) { return __builtin_memset(d, c, n); }
int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (size_t i = 0; i < n; i++) if (x[i] != y[i]) return x[i] - y[i];
  return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return (unsigned char)*a - (unsigned char)*b; }
int strncmp(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) { if (a[i] != b[i]) return (unsigned char)a[i] - (unsigned char)b[i]; if (!a[i]) return 0; }
  return 0;
}
char *strcat(char *d, const char *s) { char *r = d; while (*d) d++; while ((*d++ = *s++)) {} return r; }
void *memchr(const void *p, int c, size_t n) { const unsigned char *x = p; for (size_t i = 0; i < n; i++) if (x[i] == (unsigned char)c) return (void *)(x + i); return 0; }
void exit(int c) { (void)c; __builtin_trap(); }
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)) {} return r; }

/* alocador por classes de tamanho (potências de 2) com listas livres */
extern unsigned char __heap_base;
static size_t heap_ptr = 0, heap_end = 0;
static void *freelist[48];
static void *bump(size_t n) {
  if (!heap_ptr) { heap_ptr = ((size_t)&__heap_base + 15) & ~(size_t)15; heap_end = (size_t)__builtin_wasm_memory_size(0) * 65536; }
  if (heap_ptr + n > heap_end) {
    size_t pages = (heap_ptr + n - heap_end + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
    heap_end += pages * 65536;
  }
  void *p = (void *)heap_ptr; heap_ptr += n; return p;
}
EXPORT("malloc") void *malloc(size_t n) {
  if (!n) n = 1;
  size_t total = n + 16; int cls = 5;
  while (((size_t)1 << cls) < total) cls++;
  char *p;
  if (freelist[cls]) { p = freelist[cls]; freelist[cls] = *(void **)(p + 16); }
  else { p = bump((size_t)1 << cls); if (!p) return 0; }
  *(size_t *)p = (size_t)cls;
  return p + 16;
}
EXPORT("free") void free(void *q) {
  if (!q) return;
  char *p = (char *)q - 16; size_t cls = *(size_t *)p;
  *(void **)q = freelist[cls]; freelist[cls] = p;
}
void *calloc(size_t a, size_t b) { size_t n = a * b; void *p = malloc(n); if (p) memset(p, 0, n); return p; }
void *realloc(void *q, size_t n) {
  if (!q) return malloc(n);
  size_t cap = ((size_t)1 << *(size_t *)((char *)q - 16)) - 16;
  if (n <= cap) return q;
  void *r = malloc(n); if (!r) return 0;
  memcpy(r, q, cap); free(q); return r;
}
void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *)) { /* shell sort */
  char *a = base, tmp[64];
  for (size_t gap = n / 2; gap > 0; gap /= 2)
    for (size_t i = gap; i < n; i++) {
      memcpy(tmp, a + i * sz, sz); size_t j = i;
      for (; j >= gap && cmp(a + (j - gap) * sz, tmp) > 0; j -= gap) memcpy(a + j * sz, a + (j - gap) * sz, sz);
      memcpy(a + j * sz, tmp, sz);
    }
}

/* ---------------------------------------------------------------- decodificador */
typedef struct {
  ogg_sync_state oy; ogg_stream_state os; vorbis_info vi; vorbis_comment vc; vorbis_dsp_state vd; vorbis_block vb;
  const unsigned char *data; long len, pos;
  int channels; long rate;
  int eos_seen, ready; ogg_int64_t final_gp, total_out;
} Dec;

static int dec_feed(Dec *d) {
  if (d->pos >= d->len) return 0;
  long n = d->len - d->pos; if (n > 8192) n = 8192;
  char *b = ogg_sync_buffer(&d->oy, n); if (!b) return 0;
  memcpy(b, d->data + d->pos, n); d->pos += n; ogg_sync_wrote(&d->oy, n);
  return 1;
}
/* data precisa continuar válido (na memória wasm) até dec_free. Retorna 0 = ok; <0 = erro */
EXPORT("dec_open") Dec *dec_open(const unsigned char *data, long len, int *err) {
  Dec *d = calloc(1, sizeof(Dec)); *err = 0;
  d->data = data; d->len = len; d->final_gp = -1;
  ogg_sync_init(&d->oy); vorbis_info_init(&d->vi); vorbis_comment_init(&d->vc);
  ogg_page og; ogg_packet op; int got = 0, stream = 0;
  while (got < 3) {
    int r = ogg_sync_pageout(&d->oy, &og);
    if (r == 0) { if (!dec_feed(d)) { *err = -1; return d; } continue; }
    if (r < 0) continue;
    if (!stream) { ogg_stream_init(&d->os, ogg_page_serialno(&og)); stream = 1; }
    if (ogg_stream_pagein(&d->os, &og) < 0) { *err = -2; return d; }
    while (got < 3) {
      int p = ogg_stream_packetout(&d->os, &op);
      if (p == 0) break;
      if (p < 0) { *err = -2; return d; }
      if (vorbis_synthesis_headerin(&d->vi, &d->vc, &op) < 0) { *err = -3; return d; } /* não é Vorbis */
      got++;
    }
  }
  if (vorbis_synthesis_init(&d->vd, &d->vi) != 0) { *err = -4; return d; }
  vorbis_block_init(&d->vd, &d->vb);
  d->channels = d->vi.channels; d->rate = d->vi.rate; d->ready = 1;
  return d;
}
EXPORT("dec_channels") int dec_channels(Dec *d) { return d->channels; }
EXPORT("dec_rate") long dec_rate(Dec *d) { return d->rate; }
/* escreve até maxFrames quadros intercalados (float). Retorna quadros escritos; 0 = fim. */
EXPORT("dec_read") int dec_read(Dec *d, float *out, int maxFrames) {
  int written = 0, ch = d->channels;
  for (;;) {
    float **pcm; int n = vorbis_synthesis_pcmout(&d->vd, &pcm);
    if (n > 0) {
      int take = n; if (take > maxFrames - written) take = maxFrames - written;
      if (d->eos_seen && d->final_gp >= 0) {
        ogg_int64_t rem = d->final_gp - d->total_out;
        if (rem <= 0) { vorbis_synthesis_read(&d->vd, n); continue; }
        if (take > rem) take = (int)rem;
      }
      for (int c = 0; c < ch; c++) { const float *s = pcm[c]; float *o = out + (size_t)written * ch + c; for (int i = 0; i < take; i++) o[(size_t)i * ch] = s[i]; }
      vorbis_synthesis_read(&d->vd, take); written += take; d->total_out += take;
      if (written >= maxFrames) return written;
      continue;
    }
    ogg_packet op; int r = ogg_stream_packetout(&d->os, &op);
    if (r > 0) { if (vorbis_synthesis(&d->vb, &op) == 0) vorbis_synthesis_blockin(&d->vd, &d->vb); continue; }
    if (r < 0) continue;
    if (d->eos_seen) return written;
    ogg_page og; int pr = ogg_sync_pageout(&d->oy, &og);
    if (pr > 0) {
      ogg_stream_pagein(&d->os, &og);
      if (ogg_page_eos(&og)) { d->eos_seen = 1; d->final_gp = ogg_page_granulepos(&og); }
      continue;
    }
    if (pr < 0) continue;
    if (!dec_feed(d)) { d->eos_seen = 1; d->final_gp = -1; continue; } /* arquivo truncado: devolve o que deu */
  }
}
EXPORT("dec_pos") long dec_pos(Dec *d) { return d->pos; }
EXPORT("dec_free") void dec_free(Dec *d) {
  if (d->ready) { vorbis_block_clear(&d->vb); vorbis_dsp_clear(&d->vd); }
  ogg_stream_clear(&d->os); vorbis_comment_clear(&d->vc); vorbis_info_clear(&d->vi); ogg_sync_clear(&d->oy); free(d);
}

/* ---------------------------------------------------------------- codificador (VBR) */
typedef struct {
  vorbis_info vi; vorbis_comment vc; vorbis_dsp_state vd; vorbis_block vb; ogg_stream_state os;
  unsigned char *buf; size_t cap, len; int ok;
} Enc;
static void enc_append(Enc *e, const unsigned char *p, long n) {
  if (e->len + n > e->cap) { size_t nc = e->cap ? e->cap * 2 : 65536; while (nc < e->len + n) nc *= 2; e->buf = realloc(e->buf, nc); e->cap = nc; }
  memcpy(e->buf + e->len, p, n); e->len += n;
}
static void enc_pages(Enc *e, int flush) {
  ogg_page og;
  for (;;) {
    int r = flush ? ogg_stream_flush(&e->os, &og) : ogg_stream_pageout(&e->os, &og);
    if (!r) break;
    enc_append(e, og.header, og.header_len); enc_append(e, og.body, og.body_len);
  }
}
EXPORT("enc_new") Enc *enc_new(int channels, long rate, float quality, int serial) {
  Enc *e = calloc(1, sizeof(Enc));
  vorbis_info_init(&e->vi);
  if (vorbis_encode_init_vbr(&e->vi, channels, rate, quality) != 0) { e->ok = 0; return e; }
  vorbis_comment_init(&e->vc); vorbis_comment_add_tag(&e->vc, "ENCODER", "FunkinSheet Optimizer (libvorbis 1.3.7)");
  vorbis_analysis_init(&e->vd, &e->vi); vorbis_block_init(&e->vd, &e->vb); ogg_stream_init(&e->os, serial);
  ogg_packet h1, h2, h3;
  vorbis_analysis_headerout(&e->vd, &e->vc, &h1, &h2, &h3);
  ogg_stream_packetin(&e->os, &h1); ogg_stream_packetin(&e->os, &h2); ogg_stream_packetin(&e->os, &h3);
  enc_pages(e, 1);
  e->ok = 1; return e;
}
EXPORT("enc_ok") int enc_ok(Enc *e) { return e->ok; }
/* devolve vetor de ponteiros (um por canal) onde o JS escreve 'frames' amostras planares */
EXPORT("enc_buffer") float **enc_buffer(Enc *e, int frames) { return vorbis_analysis_buffer(&e->vd, frames); }
/* confirma 'frames' amostras escritas (0 = fim do áudio) e codifica o que for possível */
EXPORT("enc_wrote") void enc_wrote(Enc *e, int frames) {
  vorbis_analysis_wrote(&e->vd, frames);
  ogg_packet op;
  while (vorbis_analysis_blockout(&e->vd, &e->vb) == 1) {
    vorbis_analysis(&e->vb, NULL); vorbis_bitrate_addblock(&e->vb);
    while (vorbis_bitrate_flushpacket(&e->vd, &op)) { ogg_stream_packetin(&e->os, &op); enc_pages(e, 0); }
  }
  if (frames == 0) enc_pages(e, 1);
}
EXPORT("enc_out") unsigned char *enc_out(Enc *e) { return e->buf; }
EXPORT("enc_out_len") int enc_out_len(Enc *e) { return (int)e->len; }
EXPORT("enc_out_clear") void enc_out_clear(Enc *e) { e->len = 0; }
EXPORT("enc_free") void enc_free(Enc *e) {
  if (e->ok) { ogg_stream_clear(&e->os); vorbis_block_clear(&e->vb); vorbis_dsp_clear(&e->vd); vorbis_comment_clear(&e->vc); }
  vorbis_info_clear(&e->vi); free(e->buf); free(e);
}
