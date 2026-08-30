#ifndef SPEEXDSP_ANDROID_CONFIG_H
#define SPEEXDSP_ANDROID_CONFIG_H

/*
 * autotools の config.h の代わり。**AEC に要る最小限だけ**を立てる。
 *
 * `FLOATING_POINT` を選んでいる（`FIXED_POINT` ではなく）。MT8163 の
 * Cortex-A53 は VFP を持つので、浮動小数のほうが速く、かつ mdf.c の
 * 固定小数経路より枯れている。
 *
 * FFT は **kiss_fft** を使う。smallft も同梱されているが、kiss は
 * 実数 FFT（kiss_fftr）を持っていて mdf.c がそれを使う。
 */

#define FLOATING_POINT
#define USE_KISS_FFT
#define EXPORT

/* mdf.c / preprocess.c が使う標準関数の有無。Android には全部ある。 */
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1

#endif
