/**
 * ローカルサーバー（/api/*）の呼び出し。
 *
 * AI を直接叩かないのは、鍵をブラウザに置かないためと、`getUserMedia` が
 * localhost でしか動かないため。画面もローカルサーバーが配っているので、
 * すべて同一オリジンで済む。
 */

/** 回答の裏付けに使われたページ。 */
export interface Source {
  uri: string;
  title: string;
}

/** 生成中に届くもの。 */
export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };

export interface DeviceConfig {
  provider?: string;
  claudeModel?: string;
  geminiModel?: string;
  answerLength?: string;
}

/**
 * SSE のバイト列から `data:` の中身だけを取り出す。
 *
 * チャンクの境目が行の途中に来ても壊れないよう、未完の行は持ち越す。
 * 実装はサーバー側（device/server/src/sse.ts の SSELineParser）と揃えてある。
 *
 * `event:` 行は読まない。中身のキーで種類が分かるので、
 * 行の順序に頼らないほうが壊れにくい。
 */
class LineParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    const payloads: string[] = [];
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload) payloads.push(payload);
    }
    return payloads;
  }
}

/**
 * 回答を流し込む。
 *
 * `signal` を渡すと途中でやめられる。**やめたときはサーバーが上流も切る**
 * ので、見ない回答に課金され続けることはない（device/server 側の仕掛け）。
 */
export async function* streamChat(
  messages: { role: string; content: string }[],
  options: { signal?: AbortSignal; scenario?: string } = {},
): AsyncGenerator<ChatEvent> {
  const query = options.scenario ? `?scenario=${options.scenario}` : "";

  const response = await fetch(`/api/chat${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal: options.signal,
  });

  // サーバーはエラーも 200 + SSE で返すので、ここは本来通らない。
  // 通るのはローカルサーバー自体が落ちているときくらい。
  if (!response.ok || !response.body) {
    yield { type: "error", message: "サーバーに接続できませんでした。" };
    return;
  }

  const reader = response.body.getReader();
  const parser = new LineParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const payload of parser.push(value)) {
        const event = toEvent(payload);
        if (event) yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** `data:` の中身を、種類の分かる形にする。読めなければ null。 */
function toEvent(payload: string): ChatEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null; // 知らない形は読み飛ばす
  }

  if (typeof parsed.message === "string") {
    return { type: "error", message: parsed.message };
  }
  if (typeof parsed.text === "string") {
    return { type: "delta", text: parsed.text };
  }
  if (Array.isArray(parsed.sources)) {
    return { type: "sources", sources: sanitizeSources(parsed.sources) };
  }
  if (typeof parsed.stopReason === "string") {
    return { type: "done", stopReason: parsed.stopReason };
  }
  return null;
}

/**
 * 出典を、開いても安全なものだけにする。
 *
 * サーバーは自分たちのものだが、中身は上流（Gemini）から来た文字列で、
 * それを画面のリンクにする経路になる。http / https 以外は捨てる。
 */
function sanitizeSources(raw: unknown[]): Source[] {
  const sources: Source[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { uri, title } = item as { uri?: unknown; title?: unknown };
    if (typeof uri !== "string") continue;

    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

    sources.push({
      uri,
      title: typeof title === "string" && title ? title : parsed.hostname,
    });
  }
  return sources;
}

/** 音声を文字にする。無音なら空文字が返る。 */
export async function transcribe(wav: ArrayBuffer): Promise<string> {
  const response = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? "音声を認識できませんでした。");
  }

  const result = (await response.json()) as { text?: unknown };
  return typeof result.text === "string" ? result.text : "";
}

/** いま使われている設定。取れなければ null（画面の表示にしか使わない）。 */
export async function fetchConfig(): Promise<DeviceConfig | null> {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return null;
    return (await response.json()) as DeviceConfig;
  } catch {
    return null;
  }
}

/** 動作モード。画面の隅に出して、本番と取り違えないようにする。 */
export async function fetchHealth(): Promise<{ mode: string; tts: string } | null> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return null;
    return (await response.json()) as { mode: string; tts: string };
  } catch {
    return null;
  }
}
