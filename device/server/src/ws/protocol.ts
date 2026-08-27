/**
 * デバイスとサーバーの取り決め。
 *
 * デバイス → サーバー: **バイナリのフレーム**（16kHz mono 16bit LE、80ms）
 * サーバー → デバイス: **JSON**（状態・文字）と**バイナリ**（鳴らす WAV）
 *
 * デバイス側に判断をさせないので、送るのは「いまどう見せるか」だけ。
 */

/** 画面の状態。ブラウザ版の 5 状態をそのまま移した。 */
export type DeviceState =
  | "idle" // 待機。時計を出す
  | "listening" // 聞き取り中
  | "thinking" // 考え中
  | "speaking" // 回答中
  /**
   * 追い質問の窓が開いている。ウェイクワード無しで続けられる。
   *
   * **黙って聞いている状態を作らない。** 画面に「続けてどうぞ」と出す。
   * 常時マイクが開いている機械なので、聞いていることは見えていないといけない。
   */
  | "following"
  | "error";

export interface Source {
  uri: string;
  title: string;
}

/** サーバーからデバイスへ送る JSON。 */
export type ServerMessage =
  | { type: "state"; state: DeviceState; status: string }
  /** 聞き取った内容。画面の上に出す。 */
  | { type: "question"; text: string }
  /** 回答の**累積全文**。差分ではないので、そのまま置き換えればよい。 */
  | { type: "answer"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "error"; message: string }
  /** 次に届くバイナリが読み上げの音声であることの予告。 */
  | { type: "audio"; bytes: number }
  /** 設定の表示用（画面下の「いま Haiku 4.5」）。 */
  | { type: "config"; provider: string; model: string; wakeWords: string[] }
  /** どのチャットに入ったか。Web UI が履歴を追えるように。 */
  | { type: "chat"; chatId: string; title: string }
  /**
   * 試験用（`?mode=wake`）。窓を1つ判定した結果。
   *
   * 誤起動を測るために**当たらなかった窓も送る**。何と聞こえたかが
   * 見えないと、語を選び直す材料にならない。
   */
  | {
      type: "heard";
      /** 書き起こし。無音なら空。 */
      text: string;
      /** 判定語に当たったか。 */
      fired: boolean;
      /** ISO8601 */
      at: string;
      /** 書き起こしにかかった時間（ミリ秒）。 */
      ms: number;
    };

/** デバイスからサーバーへ送る JSON（音声はバイナリで別に送る）。 */
export type DeviceMessage =
  /** 画面を触った / 物理ボタン。ウェイクワード無しで起こす。 */
  | { type: "wake" }
  /** やめる。 */
  | { type: "cancel" }
  /**
   * 試験用（`?mode=wake`）。判定に使う語を差し替える。
   *
   * **設定（/admin）は書き換えない。** この接続の中だけで効く。
   * 同じ部屋の音に対して候補を比べられるようにするため。
   * 送らなければ設定の語を使う。
   */
  | { type: "wake-words"; words: string[] };
