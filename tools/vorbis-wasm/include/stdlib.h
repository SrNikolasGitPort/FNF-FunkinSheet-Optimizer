#ifndef FNF_STDLIB_H
#define FNF_STDLIB_H
#include <stddef.h>
void *malloc(size_t);
void *calloc(size_t, size_t);
void *realloc(void *, size_t);
void free(void *);
void exit(int);
void qsort(void *, size_t, size_t, int (*)(const void *, const void *));
#define alloca __builtin_alloca
#define abs(x) __builtin_abs(x)
#define labs(x) __builtin_labs(x)
#endif
