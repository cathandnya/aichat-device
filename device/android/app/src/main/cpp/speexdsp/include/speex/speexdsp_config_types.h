#ifndef __SPEEX_TYPES_H__
#define __SPEEX_TYPES_H__

/*
 * 本来 configure が speexdsp_config_types.h.in から作るもの。
 * autotools を通さず CMake だけで組むので、手で置いている。
 * Android の NDK は C99 の stdint.h を持つので、そのまま使えばよい。
 */
#include <stdint.h>

typedef int16_t spx_int16_t;
typedef uint16_t spx_uint16_t;
typedef int32_t spx_int32_t;
typedef uint32_t spx_uint32_t;

#endif
