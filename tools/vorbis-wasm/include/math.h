/* math.h mínimo para compilar libvorbis em wasm32 sem libc. Funções transcendentais vêm do JS (import "env"). */
#ifndef FNF_MATH_H
#define FNF_MATH_H
#define IMP(n) __attribute__((import_module("env"), import_name(n)))
double sin(double) IMP("sin");
double cos(double) IMP("cos");
double atan(double) IMP("atan");
double atan2(double, double) IMP("atan2");
double exp(double) IMP("exp");
double log(double) IMP("log");
double pow(double, double) IMP("pow");
double log10(double) IMP("log10");
double ldexp(double, int) IMP("ldexp");
double acos(double) IMP("acos");
#define sqrt(x) __builtin_sqrt(x)
#define floor(x) __builtin_floor(x)
#define ceil(x) __builtin_ceil(x)
#define fabs(x) __builtin_fabs(x)
#define rint(x) __builtin_rint(x)
#define sqrtf(x) __builtin_sqrtf(x)
#define floorf(x) __builtin_floorf(x)
#define fabsf(x) __builtin_fabsf(x)
#define rintf(x) __builtin_rintf(x)
#define lrint(x) ((long)__builtin_rint(x))
#define lrintf(x) ((long)__builtin_rintf(x))
#endif
