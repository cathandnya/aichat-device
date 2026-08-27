/**
 * 偽の上流（Anthropic / Gemini）。**本物の AI を一度も呼ばずに**
 * 回答の経路を確かめるためのもの。
 *
 * `../aichat/CLAUDE.md` の「経路や送信内容の確認 → モックの上流サーバーを
 * 立てる」に沿っている。書き方は worker にあった models-stub と同じく
 * `node:http` だけ。
 *
 * Anthropic SDK は `baseURL` を差し替えられるので、そこをここに向ける。
 * Gemini は fetch を直接呼んでいるので、グローバルの fetch を差し替える。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface UpstreamMock {
  url: string;
  received: ReceivedRequest[];
  /** 上流が閉じられた（＝こちらが切った）回数。 */
  readonly aborted: number;
  close(): Promise<void>;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface MockOptions {
  /** 応答のしかた。 */
  behavior?: "stream" | "slow" | "error-401" | "error-429";
  /** ローカル whisper が返す書き起こし。無音の作り話の検証にも使う。 */
  whisperText?: string;
  /** macOS の音声認識（ohr）が返す書き起こし。 */
  appleText?: string;
}

export async function startUpstreamMock(
  options: MockOptions = {},
): Promise<UpstreamMock> {
  const received: ReceivedRequest[] = [];
  const state = { aborted: 0 };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      received.push({
        method: req.method ?? "",
        path,
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      if (path.includes("/messages")) return claude(req, res, options, state);
      if (path.includes(":streamGenerateContent")) return gemini(req, res, options, state);
      if (path.includes(":generateContent")) return geminiStt(res);
      if (path.includes("/inference")) return whisperStt(res, options);
      if (path.includes("/v1/audio/transcriptions")) return appleStt(res, options);

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");

  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    get aborted() {
      return state.aborted;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Anthropic Messages API の SSE を真似る。 */
function claude(
  req: IncomingMessage,
  res: ServerResponse,
  options: MockOptions,
  state: { aborted: number },
): void {
  if (options.behavior === "error-401") return fail(res, 401, "authentication_error");
  if (options.behavior === "error-429") return fail(res, 429, "rate_limit_error");

  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  watchAbort(req, res, state);

  const parts = ["こん", "にちは", "。今日は", "晴れ", "です。"];
  let i = 0;

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    if (i < parts.length) {
      send(res, "content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: parts[i] },
      });
      i += 1;
      return;
    }
    clearInterval(timer);
    send(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
    res.end();
  }, options.behavior === "slow" ? 400 : 10);
}

/** Gemini の streamGenerateContent?alt=sse を真似る。 */
function gemini(
  req: IncomingMessage,
  res: ServerResponse,
  options: MockOptions,
  state: { aborted: number },
): void {
  if (options.behavior === "error-401") return fail(res, 401, "invalid api key");

  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  watchAbort(req, res, state);

  const chunks = [
    { candidates: [{ content: { parts: [{ text: "こん" }] } }] },
    // 思考のパートは本文に混ざってはいけない。
    { candidates: [{ content: { parts: [{ text: "（内心）", thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: "にちは。" }] } }] },
    {
      candidates: [
        {
          content: { parts: [{ text: "" }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://example.com/a", title: "tenki.jp" } }],
          },
          finishReason: "STOP",
        },
      ],
    },
  ];

  let i = 0;
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
      i += 1;
      return;
    }
    clearInterval(timer);
    res.end();
  }, options.behavior === "slow" ? 400 : 10);
}

/** Gemini の generateContent（音声認識に使う）を真似る。 */
function geminiStt(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: "（考え中）", thought: true },
              { text: "明日の天気は" },
            ],
          },
        },
      ],
    }),
  );
}

/** whisper-server の /inference を真似る。 */
function whisperStt(res: ServerResponse, options: MockOptions): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ text: options.whisperText ?? "明日の天気は" }));
}

/** ohr（OpenAI 互換）の /v1/audio/transcriptions を真似る。 */
function appleStt(res: ServerResponse, options: MockOptions): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ text: options.appleText ?? "明日の天気は" }));
}

function send(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function fail(res: ServerResponse, status: number, type: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message: type } }));
}

/**
 * こちらが接続を切ったことを数える。
 *
 * ここが増えないなら、画面で「やめる」を押しても上流の生成が続いている
 * ＝課金が続いている、ということ。
 */
function watchAbort(
  req: IncomingMessage,
  res: ServerResponse,
  state: { aborted: number },
): void {
  req.on("aborted", () => {
    state.aborted += 1;
  });
  res.on("close", () => {
    if (!res.writableEnded) state.aborted += 1;
  });
}
