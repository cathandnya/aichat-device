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
#include <math.h>
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

/*
 * ★ **スペクトル抑圧。**
 *
 * 線形フィルタ（speexdsp の引き算）は、この端末では 3〜6dB しか
 * 消せなかった。スピーカーからマイクへの経路が**非線形に歪む**ため
 * （実測で波形の相関 0.25）、引き算では原理的に消えない。
 *
 * **が、鳴らす音のデータはこちらが持っている。** 帯域ごとに見ると、
 * 参照の大きさからマイクに乗る量が読める（実測で相関 0.82〜0.90）。
 * 歪んでいても「どの帯域がいまどれだけ鳴っているか」は正確に分かる。
 *
 * そこで引き算ではなく、**帯域ごとに「予想されるエコーのぶんだけ
 * 下げる」**。位相を使わないので歪みに強い。手元の録音で試算して
 * 14.9dB（線形の 3〜6dB に対して）。
 */
#define FFT_N 512
#define FFT_HALF (FFT_N / 2)

typedef struct {
    SpeexEchoState *echo;
    SpeexPreprocessState *preprocess;
    int frame_size;

    /* 帯域ごとの「参照 → エコー」の大きさの比。走らせながら憶える。 */
    float gain[FFT_HALF];
    /* 直前の窓（重ね合わせ用） */
    float overlap[FFT_N];
    float window[FFT_N];
    /* 作業用 */
    float mic_re[FFT_N], mic_im[FFT_N];
    float ref_re[FFT_N], ref_im[FFT_N];
    float pending_mic[FFT_N];
    float pending_ref[FFT_N];
    int   filled;
    int   ready;
} Aec;

/** 素朴な基数2 FFT。512 点なので速さは足りる。 */
static void fft(float *re, float *im, int n) {
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (int len = 2; len <= n; len <<= 1) {
        float ang = -2.0f * (float) M_PI / (float) len;
        float wr = cosf(ang), wi = sinf(ang);
        for (int i = 0; i < n; i += len) {
            float cr = 1.0f, ci = 0.0f;
            for (int k = 0; k < len / 2; k++) {
                int a = i + k, b = i + k + len / 2;
                float xr = re[b] * cr - im[b] * ci;
                float xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr;        im[a] += xi;
                float nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr; cr = nr;
            }
        }
    }
}

static void ifft(float *re, float *im, int n) {
    for (int i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im, n);
    for (int i = 0; i < n; i++) { re[i] /= (float) n; im[i] = -im[i] / (float) n; }
}

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

        /*
         * ★ **残差抑圧を強くする。**
         *
         * フィルタが収束するまでの 1〜2 秒は、引き算だけでは消えない。
         * 実測で erle 0.3dB → 3.2 → 6.1 と上がっていく間に、
         * 端末が自分のウェイクワードで**誤爆した**。危ないのは
         * まさにこの収束前の区間。
         *
         * 残差抑圧は**収束を待たずに効く**（消し残りの大きさを見て
         * 帯域ごとに下げる）ので、ここを強くするのが要。
         *
         * 既定は待機時 -40dB / near-end 検出時 -15dB。この機械は
         * **自分の声を浴びている間、near-end と誤って判定されやすい**
         * ので、そちらも深くする。人の声まで削るが、下流は STT で
         * あって人の耳ではない。
         */
        int suppress = -50;
        int suppress_active = -45;
        speex_preprocess_ctl(
            aec->preprocess, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS, &suppress);
        speex_preprocess_ctl(
            aec->preprocess, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS_ACTIVE,
            &suppress_active);

        /* 雑音抑圧も入れる。入力が小さいので底上げの助けになる。 */
        int denoise = 1;
        speex_preprocess_ctl(
            aec->preprocess, SPEEX_PREPROCESS_SET_DENOISE, &denoise);
        /* **AGC は入れない。** 無音を持ち上げると誤検出が増える。 */
        int agc = 0;
        speex_preprocess_ctl(aec->preprocess, SPEEX_PREPROCESS_SET_AGC, &agc);
    }

    for (int i = 0; i < FFT_HALF; i++) aec->gain[i] = 0.0f;
    for (int i = 0; i < FFT_N; i++) {
        aec->overlap[i] = 0.0f;
        /* ハン窓。50% 重ねで足すと 1 になる。 */
        aec->window[i] = 0.5f - 0.5f * cosf(2.0f * (float) M_PI * (float) i / (float) FFT_N);
    }
    aec->filled = 0;
    aec->ready = 0;

    return (jlong) (intptr_t) aec;
}

/**
 * 1 窓ぶん抑える。**引き算ではなく、帯域ごとに下げる。**
 *
 * `mic` と `ref` は FFT_N 点。結果を `out` に返す（同じ長さ）。
 */
static void suppress(Aec *aec, const float *mic, const float *ref, float *out) {
    for (int i = 0; i < FFT_N; i++) {
        aec->mic_re[i] = mic[i] * aec->window[i];
        aec->mic_im[i] = 0.0f;
        aec->ref_re[i] = ref[i] * aec->window[i];
        aec->ref_im[i] = 0.0f;
    }
    fft(aec->mic_re, aec->mic_im, FFT_N);
    fft(aec->ref_re, aec->ref_im, FFT_N);

    for (int k = 0; k < FFT_HALF; k++) {
        float mr = aec->mic_re[k], mi = aec->mic_im[k];
        float rr = aec->ref_re[k], ri = aec->ref_im[k];
        float mag = sqrtf(mr * mr + mi * mi);
        float rmag = sqrtf(rr * rr + ri * ri);

        /*
         * 比を憶える。**鳴っているときだけ。** 静かなときに更新すると
         * 部屋の雑音を「エコー」と憶えてしまう。
         * ゆっくり寄せる（急に動かすと人の声を削る）。
         */
        if (rmag > 50.0f) {
            float observed = mag / rmag;
            aec->gain[k] += (observed - aec->gain[k]) * 0.05f;
            if (aec->gain[k] > 4.0f) aec->gain[k] = 4.0f;
        }

        /* 予想されるエコーの大きさ。 */
        float est = aec->gain[k] * rmag;
        /*
         * どれだけ引くか。**この機械では強めに倒す。**
         *
         * 実測 1.6 倍・床 5% で 12dB まで来たが、それでも
         * 「ずんだもん」で誤爆した。下流は STT とウェイクワード判定で
         * あって人の耳ではないので、多少歪ませてでも消すほうを採る。
         * 人が割り込むときは**参照が鳴っていない帯域が残る**ので、
         * そこから拾える。
         */
        float keep = mag - 3.0f * est;
        float floor_ = 0.02f * mag;
        if (keep < floor_) keep = floor_;
        float g = (mag > 1e-6f) ? keep / mag : 1.0f;

        aec->mic_re[k] *= g; aec->mic_im[k] *= g;
        if (k > 0) {
            aec->mic_re[FFT_N - k] = aec->mic_re[k];
            aec->mic_im[FFT_N - k] = -aec->mic_im[k];
        }
    }
    ifft(aec->mic_re, aec->mic_im, FFT_N);
    for (int i = 0; i < FFT_N; i++) out[i] = aec->mic_re[i] * aec->window[i];
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
    /* まず線形で引ける分を引く（3〜6dB ぶん）。 */
    speex_echo_cancellation(aec->echo, mic_p, ref_p, out_p);
    if (aec->preprocess) speex_preprocess_run(aec->preprocess, out_p);

    /*
     * ★ **そのうえで、帯域ごとに抑える。**
     *
     * 線形で消しきれなかった歪みぶんは、ここで落とす。
     * 20ms(320) ずつ来るので、512 点の窓に溜めて 256 ずつ進める。
     */
    for (int i = 0; i < aec->frame_size; i++) {
        aec->pending_mic[aec->filled] = (float) out_p[i];
        aec->pending_ref[aec->filled] = (float) ref_p[i];
        aec->filled++;

        if (aec->filled == FFT_N) {
            float processed[FFT_N];
            suppress(aec, aec->pending_mic, aec->pending_ref, processed);
            /* 前の窓と重ねて足す。 */
            for (int j = 0; j < FFT_N; j++) aec->overlap[j] += processed[j];
            aec->ready = 1;
            /* 半分ぶん進める。 */
            memmove(aec->pending_mic, aec->pending_mic + FFT_N / 2,
                    (FFT_N / 2) * sizeof(float));
            memmove(aec->pending_ref, aec->pending_ref + FFT_N / 2,
                    (FFT_N / 2) * sizeof(float));
            aec->filled = FFT_N / 2;
        }
    }

    /*
     * 出来上がった分を返す。**まだ溜まっていない間は線形の結果を
     * そのまま返す**（無音を返すと語頭が欠ける）。
     */
    if (aec->ready) {
        for (int i = 0; i < aec->frame_size; i++) {
            float v = aec->overlap[i];
            if (v > 32767.0f) v = 32767.0f;
            if (v < -32768.0f) v = -32768.0f;
            out_p[i] = (jshort) v;
        }
        memmove(aec->overlap, aec->overlap + aec->frame_size,
                (FFT_N - aec->frame_size) * sizeof(float));
        for (int i = FFT_N - aec->frame_size; i < FFT_N; i++) aec->overlap[i] = 0.0f;
    }
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
