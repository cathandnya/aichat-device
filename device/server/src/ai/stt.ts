/**
 * 音声認識。録った音声を文字にする。
 *
 * もとは Cloudflare Workers AI のバインディング（`env.AI.run`）を呼んでいた。
 * ローカルサーバーに移したので、上流を直接呼ぶ形に作り直してある。
 *
 * **既定は macOS の音声認識（SpeechAnalyzer）。** 実測で一番速くて正確で、
 * 音声が家の外に出ず、課金も無い（計測の内訳は types.ts の STT_MODELS）。
 * whisper とクラウドの経路も残してあるので、管理UIから切り替えられる。
 *
 * どのモデルを使うかは画面から受け取らない（chat.ts と同じ方針）。
 */

import {
  sttVendor,
  type Runtime,
  type SttModel,
} from "./types.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_TRANSCRIPTIONS = "https://api.openai.com/v1/audio/transcriptions";

/** 認識にかける時間の上限。30 秒の音声でもこの中に収まる。 */
const TIMEOUT_MS = 30_000;

/**
 * 書き起こしを頼む指示。
 *
 * Gemini は汎用モデルなので、そのまま音声を渡すと「この音声では〜と
 * 言っています」のような説明文を返すことがある。**書き起こしだけを
 * 返させる**必要がある。
 */
const GEMINI_PROMPT =
  "この音声を日本語で文字に起こしてください。" +
  "書き起こした文だけを返し、説明・前置き・引用符は付けないでください。" +
  "聞き取れない場合は空文字を返してください。";

export class SttError extends Error {}

/**
 * 音声を文字にする。無音や雑音だけなら空文字を返す（例外にしない）。
 *
 * 空文字をエラーにしないのは、画面が「聞き取れませんでした」を出して
 * 待機に戻れるようにするため。エラー画面にすると家族が身構える。
 */
export async function transcribe(
  audio: ArrayBuffer,
  model: SttModel,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<string> {
  const merged = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);

  const vendor = sttVendor(model);
  const text =
    vendor === "apple"
      ? await viaAppleSpeech(audio, runtime, merged)
      : vendor === "local"
        ? await viaLocalWhisper(audio, runtime, merged)
        : vendor === "gemini"
          ? await viaGemini(audio, model, runtime, merged)
          : await viaOpenAI(audio, model, runtime, merged);

  return text.trim();
}

/**
 * macOS の音声認識（SpeechAnalyzer）で書き起こす。
 *
 * 自前で Speech framework を呼ぶのは諦めた。TCC は「責任のあるプロセス」の
 * Info.plist を見るため、常駐サーバーから子プロセスとして呼ぶと必ず
 * 中断される（plist の埋め込み・ad-hoc 署名・.app 化・パスの変更、
 * いずれも SIGABRT）。
 *
 * 代わりに `ohr` を使う。OpenAI 互換の HTTP サーバーとして macOS の
 * 音声認識を包んでくれるので、こちらは HTTP を投げるだけで済む。
 * VOICEVOX や whisper-server と同じく別プロセスとして立てる。
 *
 * **既定のポート 11434 は Ollama と衝突する。** 8091 で立てること。
 */
async function viaAppleSpeech(
  audio: ArrayBuffer,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<string> {
  if (!runtime.appleSpeechUrl) {
    throw new SttError(
      "macOS の音声認識の接続先が設定されていません（APPLE_SPEECH_URL）。",
    );
  }

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
  form.append("model", "apple-speechanalyzer");
  form.append("language", "ja_JP");
  form.append("response_format", "json");

  let response: Response;
  try {
    response = await fetch(`${runtime.appleSpeechUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new SttError(
      "macOS の音声認識に接続できませんでした。ohr --serve は動いていますか。",
    );
  }

  if (!response.ok) throw await upstreamError(response, "ohr");

  const body = (await response.json()) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text : "";

  return isHallucination(text) ? "" : joinJapanese(text);
}

/**
 * 日本語の途中に入る余計な空白を詰める。
 *
 * SpeechAnalyzer は語の区切りごとに空白を入れてくる
 * （「明日の天気 を教 えて」）。日本語としては誤りだし、
 * そのまま画面に出すと読みにくい。
 *
 * **英数字どうしの空白は残す。** 「hello world」まで詰めると別の壊し方に
 * なるため、非 ASCII の隣にある空白だけを落とす。
 * 「AI の 話」→「AIの話」、「150 グラム」→「150グラム」は詰まり、
 * 「hello world」はそのまま。
 */
function joinJapanese(text: string): string {
  return text.replace(/[ \t]+(?=[^\x00-\x7F])|(?<=[^\x00-\x7F])[ \t]+/g, "");
}

/**
 * ローカルの whisper.cpp（whisper-server）で書き起こす。
 *
 * VOICEVOX と同じく別プロセスとして立てる。モデルの選択と速度の設定は
 * **whisper-server の起動引数**で決まるので、こちらからは渡さない
 * （device/README.md の起動例を参照）。
 *
 * whisper-server は OpenAI 互換の multipart を受ける。
 */
async function viaLocalWhisper(
  audio: ArrayBuffer,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<string> {
  if (!runtime.whisperUrl) {
    throw new SttError(
      "ローカルの音声認識の接続先が設定されていません（WHISPER_URL）。",
    );
  }

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
  form.append("language", "ja");
  form.append("response_format", "json");
  // 書き起こしに創造性は要らない。
  form.append("temperature", "0");

  let response: Response;
  try {
    response = await fetch(`${runtime.whisperUrl}/inference`, {
      method: "POST",
      body: form,
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new SttError(
      "ローカルの音声認識に接続できませんでした。whisper-server は動いていますか。",
    );
  }

  if (!response.ok) throw await upstreamError(response, "whisper-server");

  const body = (await response.json()) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text : "";

  // whisper は無音に対して「(音楽)」「ご視聴ありがとうございました」など、
  // 学習データ由来の定型句を返すことがある。そのまま AI に投げると
  // 見当違いの回答が返るので、無音として扱う。
  return isHallucination(text) ? "" : text;
}

/**
 * 無音や雑音に対する whisper の作り話か。
 *
 * 空文字を返させたいだけなので、判定は既知の定型句に絞る。
 * 広げすぎると本当の発話まで消してしまう。
 */
function isHallucination(text: string): boolean {
  const trimmed = text.trim().replace(/[。、！？!?\s]/g, "");
  if (!trimmed) return true;

  const KNOWN = [
    "ご視聴ありがとうございました",
    "ご覧いただきありがとうございます",
    "おやすみなさい",
    "チャンネル登録お願いします",
  ];
  if (KNOWN.includes(trimmed)) return true;

  // 「(音楽)」「[BLANK_AUDIO]」のような、括弧だけで構成されたもの。
  return /^[（(\[【].*[）)\]】]$/.test(trimmed);
}

/**
 * Gemini で書き起こす。
 *
 * 音声は `inline_data` に base64 で載せる。チャットで画像を送るときと
 * 同じ仕組みなので、上限（1MB）の範囲なら素直に通る。
 */
async function viaGemini(
  audio: ArrayBuffer,
  model: SttModel,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<string> {
  if (!runtime.geminiApiKey) {
    throw new SttError("GEMINI_API_KEY が設定されていません。");
  }

  const base = runtime.geminiBaseUrl ?? GEMINI_BASE;
  const response = await fetch(`${base}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // ?key= だと URL にキーが載る（chat.ts と同じ方針）。
      "x-goog-api-key": runtime.geminiApiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "audio/wav", data: base64(audio) } },
            { text: GEMINI_PROMPT },
          ],
        },
      ],
      generationConfig: {
        // 書き起こしに創造性は要らない。
        temperature: 0,
        // 思考させない。書き起こしは考える作業ではないうえ、
        // 思考トークンが上限を食って本文が出なくなる
        // （chat.ts の thinkingConfigFor と同じ理由）。
        thinkingConfig: { thinkingLevel: "minimal" },
        maxOutputTokens: 2048,
      },
    }),
    signal,
  });

  if (!response.ok) throw await upstreamError(response, "Gemini");

  const body = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };

  // 思考のパートは混ぜない（chat.ts の extractGemini と同じ）。
  return (body.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
}

/** OpenAI の書き起こし API を使う。 */
async function viaOpenAI(
  audio: ArrayBuffer,
  model: SttModel,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<string> {
  if (!runtime.openaiApiKey) {
    throw new SttError(
      "OPENAI_API_KEY が設定されていません。管理UIで音声認識を Gemini に戻すか、鍵を設定してください。",
    );
  }

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
  form.append("model", model);
  form.append("language", "ja");
  // 書き起こしだけが要る。単語ごとの時刻などは使わない。
  form.append("response_format", "text");

  const response = await fetch(OPENAI_TRANSCRIPTIONS, {
    method: "POST",
    headers: { Authorization: `Bearer ${runtime.openaiApiKey}` },
    body: form,
    signal,
  });

  if (!response.ok) throw await upstreamError(response, "OpenAI");

  return response.text();
}

/**
 * 上流のエラーを、こちらの言葉に直す。
 *
 * 上流の本文をそのまま投げない。鍵やモデル名が混ざりうるため、
 * 記録には状態コードだけを残す（chat.ts と同じ方針）。
 */
async function upstreamError(response: Response, vendor: string): Promise<SttError> {
  const detail = await response.text().catch(() => "");
  console.error(`[stt] ${vendor} ${response.status}`, detail.slice(0, 200));

  if (response.status === 401 || response.status === 403) {
    return new SttError("音声認識の鍵が正しくありません。");
  }
  if (response.status === 429) {
    return new SttError("混み合っています。しばらく待ってからお試しください。");
  }
  return new SttError("音声の認識に失敗しました。");
}

/**
 * バイト列を base64 にする。
 *
 * `btoa(String.fromCharCode(...bytes))` は引数が多すぎて 1MB では
 * RangeError になるので、Node の Buffer に任せる。
 */
function base64(audio: ArrayBuffer): string {
  return Buffer.from(audio).toString("base64");
}
