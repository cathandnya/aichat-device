cmake_minimum_required(VERSION 3.22.1)
project(aec C)

#
# speexdsp の音響エコー消去だけを組む。
#
# **ライブラリ全体は入れない。** resample / jitter / buffer / scal は
# 使わないので、ソースごと置いていない（vendoring したのは AEC と
# 残差抑圧に要る 7 本だけ）。
#
# autotools は通さず、configure が作るはずの config.h と
# speexdsp_config_types.h を手で置いてある。
#

add_library(aec SHARED
    aec_jni.c
    speexdsp/libspeexdsp/mdf.c          # エコー消去の本体
    speexdsp/libspeexdsp/preprocess.c   # 残差抑圧
    speexdsp/libspeexdsp/fftwrap.c
    speexdsp/libspeexdsp/filterbank.c
    speexdsp/libspeexdsp/kiss_fft.c
    speexdsp/libspeexdsp/kiss_fftr.c
    speexdsp/libspeexdsp/smallft.c
)

target_include_directories(aec PRIVATE
    speexdsp/include
    speexdsp/libspeexdsp
)

target_compile_definitions(aec PRIVATE HAVE_CONFIG_H)

# **-O2 で組む。** 常時走る信号処理なので、既定の -O0 だと
# デバッグビルドで実用にならない。
target_compile_options(aec PRIVATE
    -O2
    -ffast-math
    # vendoring したソースの警告は直さない（上流の都合）。自分の
    # aec_jni.c の警告だけ見たいので、ここでは黙らせる。
    -Wno-unused-function
    -Wno-unused-variable
)

target_link_libraries(aec log m)
