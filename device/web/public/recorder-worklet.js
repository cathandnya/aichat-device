/**
 * マイクの波形を 80ms（1280 サンプル）ずつメインスレッドへ渡すだけの worklet。
 *
 * **判断（無音かどうか・録るかどうか）はここに書かない。** ここは
 * オーディオスレッドで動くので、詰まると音が途切れる。渡すだけにする。
 *
 * 1280 サンプルにしているのは openWakeWord のフレーム長に合わせるため。
 * あとでウェイクワードを足すとき、この worklet をそのまま使い回せる。
 *
 * Vite のモジュール変換を通さずに済むよう、素の JS として public/ に置く。
 * `addModule()` は「そのファイルをそのまま読む」ので、変換されると壊れる。
 */

const FRAME = 1280;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // マイクが一時的に止まっても worklet は生かしておく（false を返すと
    // 二度と呼ばれなくなり、再開できない）。
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(FRAME - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === FRAME) {
        // コピーを渡して所有権ごと移す。コピーしないと、次のフレームで
        // 同じ領域を上書きしてしまう。
        const frame = this.buffer.slice();
        this.port.postMessage(frame, [frame.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
