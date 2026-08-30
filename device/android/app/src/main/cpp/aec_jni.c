/*
 * speexdsp の音響エコー消去を Kotlin から呼ぶための薄い層。
 *
 * **ここに判断を置かない。** 通す・通さないを決めるのは Kotlin 側
 * （Aec.kt）で、ここは「渡されたものを speexdsp に渡して返す」だけ。
 * C 側に条件分岐が増えると、実機でしか再現しない不具合の置き場所が
 * 増える。
 *
 * `PASS_THROUGH` を立てると**無加工で返す**。NDK のビルドと JNI の
 * 受け渡しだけを切り離して確かめるための口で、普段は 0。
 */

#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "speex/speex_echo.h"
#include "speex/speex_preprocess.h"

/**
 * 段階 1 の間だけ立てる。**消さずに素通しする。**
 *
 * ここが 1 の間は、AEC の中身が間違っていても本番の音は変わらない。
 * ビルドと受け渡しが通ったことを確かめてから 0 にする。
 */
#define PASS_THROUGH 0

typedef struct {
    SpeexEchoState *echo;
    SpeexPreprocessState *preprocess;
    int frame_size;
} Aec;

JNIEXPORT jlong JNICALL
Java_jp_local_aichat_device_Aec_nativeInit(
    JNIEnv *env, jclass clazz, jint frame_size, jint filter_length, jint sample_rate) {
    (void) env;
    (void) clazz;

    Aec *aec = calloc(1, sizeof(Aec));
    if (!aec) return 0;

    aec->frame_size = frame_size;
    aec->echo = speex_echo_state_init(frame_size, filter_length);
    if (!aec->echo) {
        free(aec);
        return 0;
    }
    speex_echo_ctl(aec->echo, SPEEX_ECHO_SET_SAMPLING_RATE, &sample_rate);

    /*
     * 残差抑圧。**AEC の後段に置くのが speexdsp の作法**で、
     * echo state を渡しておくと消し残りを見て抑えてくれる。
     */
    aec->preprocess = speex_preprocess_state_init(frame_size, sample_rate);
    if (aec->preprocess) {
        speex_preprocess_ctl(
            aec->preprocess, SPEEX_PREPROCESS_SET_ECHO_STATE, aec->echo);
    }

    return (jlong) (intptr_t) aec;
}

/**
 * 1 フレームぶん消す。
 *
 * `mic` と `ref` は同じ長さ（frame_size）で、結果は `out` に入れて返す。
 * **配列の確保は Kotlin 側**。ここで作ると毎フレーム GC を叩く。
 */
JNIEXPORT void JNICALL
Java_jp_local_aichat_device_Aec_nativeProcess(
    JNIEnv *env, jclass clazz, jlong handle,
    jshortArray mic, jshortArray ref, jshortArray out) {
    (void) clazz;

    Aec *aec = (Aec *) (intptr_t) handle;
    if (!aec) return;

    jshort *mic_p = (*env)->GetShortArrayElements(env, mic, NULL);
    jshort *ref_p = (*env)->GetShortArrayElements(env, ref, NULL);
    jshort *out_p = (*env)->GetShortArrayElements(env, out, NULL);
    if (!mic_p || !ref_p || !out_p) goto release;

#if PASS_THROUGH
    memcpy(out_p, mic_p, (size_t) aec->frame_size * sizeof(jshort));
#else
    speex_echo_cancellation(aec->echo, mic_p, ref_p, out_p);
    if (aec->preprocess) speex_preprocess_run(aec->preprocess, out_p);
#endif

release:
    /* mic と ref は読むだけなので書き戻さない（JNI_ABORT）。 */
    if (mic_p) (*env)->ReleaseShortArrayElements(env, mic, mic_p, JNI_ABORT);
    if (ref_p) (*env)->ReleaseShortArrayElements(env, ref, ref_p, JNI_ABORT);
    if (out_p) (*env)->ReleaseShortArrayElements(env, out, out_p, 0);
}

JNIEXPORT void JNICALL
Java_jp_local_aichat_device_Aec_nativeDestroy(JNIEnv *env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;

    Aec *aec = (Aec *) (intptr_t) handle;
    if (!aec) return;
    if (aec->preprocess) speex_preprocess_state_destroy(aec->preprocess);
    if (aec->echo) speex_echo_state_destroy(aec->echo);
    free(aec);
}
