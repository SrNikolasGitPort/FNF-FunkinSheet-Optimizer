#ifndef FNF_STDIO_H
#define FNF_STDIO_H
typedef struct _FILE FILE;
#define stderr ((FILE *)0)
#define stdout ((FILE *)0)
#define fprintf(...) 0
#define fputs(...) 0
#define printf(...) 0
#define sprintf(...) 0
#define snprintf(...) 0
#define fflush(...) 0
#endif
