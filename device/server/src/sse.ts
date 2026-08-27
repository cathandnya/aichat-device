/**
 * 上流（Claude / Gemini）の SSE を、画面向けの共通形式に正規化する。
 *
 * 画面に返す形式:
 *
 *     event: delta
 *     data: {"text":"こん"}
 *
 *     event: sources
 *     data: {"sources":[{"uri":"https://...","title":"tenki.jp"}]}
 *
 *     event: done
 *     data: {"stopReason":"end_turn"}
 *
 *     event: error
 *     data: {"message":"..."}
 *
 * 上流ごとの差をここで吸収するため、画面側の解析は1つで済む。
 * 将来別の AI を足しても、画面には手を入れずに済む。
 */

const encoder = new TextEncoder();

/** 正規化後のイベントを SSE の1メッセージに整形する。 */
export function sseMessage(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * SSE のバイト列を行単位に切り出し、`data:` 行の中身だけを取り出す。
 *
 * チャンク境界が行の途中に来ても壊れないよう、未完の行はバッファに残す。
 */
export class SSELineParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  /** チャンクを流し込み、その時点で確定した `data:` の中身を返す。 */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });

    const lines = this.buffer.split("\n");
    // 最後の要素は改行で終わっていない未完の行。次のチャンクに持ち越す。
    this.buffer = lines.pop() ?? "";

    const payloads: string[] = [];
    for (const raw of lines) {
      const line = raw.trimEnd(); // CRLF 対策
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      payloads.push(payload);
    }
    return payloads;
  }

  /** ストリーム終端で、バッファに残った最後の行を取り出す。 */
  flush(): string[] {
    if (!this.buffer.trim()) return [];
    const remaining = this.buffer;
    this.buffer = "";

    const line = remaining.trimEnd();
    if (!line.startsWith("data:")) return [];
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return [];
    return [payload];
  }
}

/** 上流の JSON を受け取り、テキスト差分を返す（無ければ null）。 */
export type DeltaExtractor = (payload: unknown) => ExtractResult;

export interface ExtractResult {
  /** 追加されたテキスト。無ければ undefined。 */
  text?: string;
  /** 生成終了の理由。受け取った時点で done を流す。 */
  stopReason?: string;
  /** 上流が返したエラー。 */
  error?: string;
  /**
   * この chunk で新たに見えた引用元。
   *
   * Gemini の groundingMetadata がどの chunk に乗るかは仕様上決まっておらず、
   * 最後の1つだけのことも、複数に分かれることもある。extractor は
   * 「見えた分をそのまま返す」だけにして、重複の排除と件数の制限は
   * normalizeStream 側に集約する（そちらは1リクエスト分の状態を持てる）。
   */
  sources?: Citation[];
}

/** アプリに出す引用元1件。 */
export interface Citation {
  /**
   * 開く先。
   *
   * Gemini が返すのは Google のリダイレクト URL であって、
   * 元サイトの URL ではない。展開するにはサブリクエストが要るうえ、
   * クリック計測という提供側の意図にも反するのでそのまま渡す。
   */
  uri: string;
  /** 表示名。Gemini はドメイン名（例 "tenki.jp"）を入れてくる。 */
  title: string;
}

/**
 * 1つの応答で流す引用元の上限。
 *
 * Gemini は同じ内容でも 20 件近く返すことがある。全部流しても
 * アプリ側は先頭数件しか出さないので、SSE と端末の保存領域を
 * 無駄に使わないようここで打ち切る。
 */
const MAX_SOURCES = 10;

/**
 * 上流の SSE を共通形式へ変換する `ReadableStream` を作る。
 *
 * @param upstream 上流のレスポンスボディ
 * @param extract  上流固有の JSON からテキスト差分を取り出す関数
 */
export function normalizeStream(
  upstream: ReadableStream<Uint8Array>,
  extract: DeltaExtractor,
): ReadableStream<Uint8Array> {
  const parser = new SSELineParser();
  const reader = upstream.getReader();

  let sawText = false;
  let stopReason: string | null = null;

  // 引用元の重複排除。上流は同じ引用元を毎 chunk 繰り返し送ってくるため、
  // 一度流したものは二度と流さない。
  //
  // title でも見るのは、URL が毎回違っても表示が同じになるから。
  // Gemini のリダイレクト URL は呼び出しごとにトークンが変わる一方、
  // 表示に使うのはドメイン名なので、URL だけで判定すると
  // 「出典 ①tenki.jp ②tenki.jp ③tenki.jp」のような並びになってしまう。
  const seenURIs = new Set<string>();
  const seenTitles = new Set<string>();
  let sourceCount = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // pull は enqueue されるまで再度呼ばれない。上流には message_start の
        // ようなテキストを含まないイベントが多数あるため、
        // 「何か enqueue するか、上流が終わるまで」ループで読み進める。
        // 1チャンク読んで即 return するとストリームがハングする。
        for (;;) {
          const { done, value } = await reader.read();
          const payloads = done ? parser.flush() : parser.push(value);

          let emitted = false;

          for (const payload of payloads) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue; // 解釈できない行は読み飛ばす
            }

            const result = extract(parsed);

            if (result.error) {
              controller.enqueue(sseMessage("error", { message: result.error }));
              controller.close();
              await reader.cancel().catch(() => {});
              return;
            }
            if (result.text) {
              sawText = true;
              emitted = true;
              controller.enqueue(sseMessage("delta", { text: result.text }));
            }
            if (result.sources?.length) {
              // 初出だけを集める。ここで流さなかった分は二度と出てこない
              // （上流が繰り返し送ってくる前提なので、取りこぼしにはならない）。
              const fresh: Citation[] = [];
              for (const source of result.sources) {
                if (sourceCount + fresh.length >= MAX_SOURCES) break;
                if (!source.uri) continue;
                if (seenURIs.has(source.uri) || seenTitles.has(source.title)) {
                  continue;
                }
                seenURIs.add(source.uri);
                seenTitles.add(source.title);
                fresh.push(source);
              }
              if (fresh.length) {
                sourceCount += fresh.length;
                // text と同様、ここでも emitted を立てる。引用元だけが
                // 入っていてテキストを含まない chunk は実際に来るため、
                // これを忘れると enqueue 済みなのに読み進め続けてしまう。
                emitted = true;
                controller.enqueue(sseMessage("sources", { sources: fresh }));
              }
            }
            if (result.stopReason) {
              stopReason = result.stopReason;
            }
          }

          if (done) {
            controller.enqueue(
              sseMessage("done", {
                // 1文字も来ないまま終わった場合はアプリ側で空応答として扱う。
                stopReason: !sawText && !stopReason ? "empty" : stopReason ?? "end_turn",
              }),
            );
            controller.close();
            return;
          }

          // 何も出せなかったら、次のチャンクを読みに戻る。
          if (emitted) return;
        }
      } catch (error) {
        // 上流の切断など。URL を含みうるので error 全体は流さない。
        console.error("stream normalize failed", errorLabel(error));
        controller.enqueue(
          sseMessage("error", { message: "応答の受信中にエラーが発生しました。" }),
        );
        controller.close();
        await reader.cancel().catch(() => {});
      }
    },

    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * ログに出して安全なエラー表現。
 *
 * 例外オブジェクトをそのまま出すと、メッセージに URL が含まれる場合がある。
 * Gemini はクエリにキーを載せる方式もあるため、名前と型だけに留める。
 */
export function errorLabel(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 120)}`;
  return typeof error;
}

/**
 * SSE として返すときのヘッダ。
 *
 * `Transfer-Encoding: chunked` を明示するのは、@hono/node-server が
 * 小さい応答をまとめて `Content-Length` を付けてしまうことがあるため。
 * そうなると生成し終わるまで画面に何も出ず、逐次表示にならない。
 *
 * `no-transform` と `X-Accel-Buffering` は、間に何かを挟んだときに
 * 途中でバッファされないようにする保険。
 */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Transfer-Encoding": "chunked",
  "X-Accel-Buffering": "no",
};
