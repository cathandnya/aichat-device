/**
 * 上流の AI（Claude / Gemini）の呼び出し。
 *
 * 重要な設計判断が2つある。
 *
 * 1. モデル・システムプロンプト・max_tokens は画面から受け取らない。
 *    受け取ってしまうと、画面を改変すれば管理UIの制御を回避して
 *    高価なモデルを呼べてしまい、設定を持つ意味が無くなる。
 *    リクエストに紛れ込んでいても無視し、常に保存された設定を使う。
 *
 * 2. 上流の SSE をそのまま流さず、共通形式に正規化して返す（sse.ts）。
 *    Claude と Gemini は SSE の形が全く違うため、その差をここで吸収する。
 *    画面側の解析は1つで済み、将来 AI を足しても画面を触らずに済む。
 *
 * 鍵は Runtime（.env か OS の鍵束）から来る。Web 標準の
 * fetch / Response / ReadableStream しか使っていない。
 */

import Anthropic from "@anthropic-ai/sdk";

import { EMOTION_PROMPT } from "../speech/emotion.ts";

/**
 * いまの日時。**日本時間で、読み上げに向く形で書く。**
 *
 * 曜日まで入れるのは「今日は何曜日」に答えられるようにするため。
 * 秒は要らない（読み上げる前に過ぎている）。
 */
function nowPrompt(): string {
  const now = new Date();
  const date = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  return `いまは ${date} です。日付・時刻・曜日を聞かれたらこれを使ってください。`;
}

/**
 * 音声で入って音声で出ることを伝える指示。**サーバーが必ず足す。**
 *
 * `/admin` の systemPrompt には置かない（利用者が書き換えると消えて、
 * 原因の分からない不調になる。EMOTION_PROMPT・TOOL_PROMPT と同じ扱い）。
 *
 * ### 前半 — 入り口の誤変換
 *
 * 問いかけは音声認識を通ってから来る。**音は合っているのに漢字が違う**
 * ことがある（実測で「行き方」→「生き方」、「オンス」→「温度」。
 * docs/03 の比較表）。モデルは書き起こしを人が打った文だと思って読むので、
 * 誤変換をそのまま前提にして見当違いに答える。**同音の誤りがありうると
 * 伝えておくだけで、文脈から読み替えてくれる。**
 *
 * 直すのは読みではなく解釈なので、**聞き返しを増やさない**ように書く。
 * 「怪しければ確認してください」と書くと、少し珍しい語のたびに
 * 聞き返すようになって会話にならない。
 *
 * ### 後半 — 出口の読み間違い
 *
 * 回答は VOICEVOX が読む。**同じ表記で読みが変わる語**（「一日」
 * 「方」「今日」）は、辞書に登録しても文脈までは見てくれないので直せない。
 * 書く側でひらがなにしてもらうのが唯一の手。
 *
 * **全部をひらがなにさせない。** 画面にも同じ本文が出る（`/chats` の
 * 履歴に残る）ので、ひらがなだらけだと読めなくなる。**迷う語だけ**に絞る。
 */
const SPEECH_PROMPT = [
  "あなたへの問いかけは音声認識を通っているので、同じ音の別の語に",
  "書き間違えられていることがあります（「行き方」が「生き方」など）。",
  "話の流れに合わない語が混ざっていたら、言い間違いではなく",
  "書き起こしの誤りとみなして読み替えてください。",
  "いちいち聞き返す必要はありません。",
  "また、あなたの回答は音声で読み上げられます。",
  "読みが二通りある語（「一日」「方」「今日」など）は、",
  "意図した読みのひらがなで書いてください。",
  "それ以外は普通に漢字で書いてください。",
].join("");
import { readConfig } from "../store.ts";
import { errorResponse } from "../http.ts";
import {
  errorLabel,
  normalizeStream,
  SSELineParser,
  type DeltaExtractor,
  type ExtractResult,
} from "../sse.ts";
import {
  claudeOutputBudget,
  geminiOutputBudget,
  IMAGE_MEDIA_TYPES,
  isImageMediaType,
  modelFor,
  THINKING_BUDGETS,
  type ChatMessage,
  type CloudProvider,
  type ContentBlock,
  type Runtime,
  type ThinkingLevel,
} from "./types.ts";

const MAX_MESSAGES = 200;
const MAX_CONTENT_LENGTH = 100_000;

/** 1メッセージに付けられる画像。アプリ側の上限と揃える。 */
const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * 1リクエスト全体の画像。
 *
 * 会話を続けると過去の添付も毎回送られてくるので、1メッセージ分より
 * 余裕を持たせつつ、際限なく積み上がらないところで止める。
 */
const MAX_IMAGES_PER_REQUEST = 8;

/**
 * 画像1枚の base64 の長さ。
 *
 * アプリは長辺1536pxのJPEGに落としてから送るので実際は数百KBに収まる。
 * これはその上限ではなく、桁違いのものを弾くための歯止め。
 * base64 は元の約1.33倍なので、およそ3.7MBの画像に相当する。
 */
const MAX_IMAGE_BASE64_LENGTH = 5_000_000;

/** base64 として妥当な文字だけか（改行や空白も混じらせない）。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

interface ParsedBody {
  messages: ChatMessage[];
}

/**
 * リクエストボディを検証する。
 *
 * 通った要素は必ず組み立て直す。そうすることで、知らないフィールドが
 * 紛れ込んでいても上流には渡らない。
 *
 * export しているのはテスト（e2e/images.test.mjs）から使うため。
 */
export function parseBody(raw: unknown): ParsedBody | string {
  if (!raw || typeof raw !== "object") return "リクエストボディが不正です。";

  const { messages } = raw as Record<string, unknown>;
  if (!Array.isArray(messages)) return "messages は配列である必要があります。";
  if (messages.length === 0) return "messages が空です。";
  if (messages.length > MAX_MESSAGES) {
    return `messages が多すぎます（最大 ${MAX_MESSAGES} 件）。`;
  }

  const parsed: ChatMessage[] = [];
  let totalImages = 0;

  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      return "messages の要素が不正です。";
    }
    const { role, content } = entry as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") {
      return "role は user または assistant である必要があります。";
    }

    // 画像を含まない従来の形。
    if (typeof content === "string") {
      if (content.length > MAX_CONTENT_LENGTH) {
        return `content が長すぎます（最大 ${MAX_CONTENT_LENGTH} 文字）。`;
      }
      parsed.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      return "content は文字列または配列である必要があります。";
    }
    if (content.length === 0) return "content が空です。";

    const blocks = parseBlocks(content, role);
    if (typeof blocks === "string") return blocks;

    totalImages += blocks.filter((b) => b.type === "image").length;
    if (totalImages > MAX_IMAGES_PER_REQUEST) {
      return `画像が多すぎます（1回のやり取りで最大 ${MAX_IMAGES_PER_REQUEST} 枚）。`;
    }

    parsed.push({ role, content: blocks });
  }

  // Claude / Gemini とも先頭が user であることを要求する。
  if (parsed[0]?.role !== "user") {
    return "最初のメッセージは user である必要があります。";
  }

  return { messages: parsed };
}

/** content が配列だったときの中身を検証する。文字列を返したらエラー。 */
function parseBlocks(
  content: unknown[],
  role: "user" | "assistant",
): ContentBlock[] | string {
  const blocks: ContentBlock[] = [];
  let textLength = 0;
  let imageCount = 0;

  for (const raw of content) {
    if (!raw || typeof raw !== "object") return "content の要素が不正です。";
    const block = raw as Record<string, unknown>;

    if (block.type === "text") {
      if (typeof block.text !== "string") {
        return "text ブロックの text は文字列である必要があります。";
      }
      textLength += block.text.length;
      if (textLength > MAX_CONTENT_LENGTH) {
        return `content が長すぎます（最大 ${MAX_CONTENT_LENGTH} 文字）。`;
      }
      blocks.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image") {
      // 上流は assistant の発言に画像を認めない。
      if (role !== "user") {
        return "画像を含められるのは user のメッセージだけです。";
      }

      const source = block.source;
      if (!source || typeof source !== "object") {
        return "image ブロックの source が不正です。";
      }
      const { type, media_type: mediaType, data } = source as Record<
        string,
        unknown
      >;

      if (type !== "base64") {
        return "画像は base64 で送る必要があります。";
      }
      if (!isImageMediaType(mediaType)) {
        return `対応していない画像形式です（${IMAGE_MEDIA_TYPES.join(" / ")}）。`;
      }
      if (typeof data !== "string" || data.length === 0) {
        return "画像のデータが空です。";
      }
      if (data.length > MAX_IMAGE_BASE64_LENGTH) {
        return "画像が大きすぎます。";
      }
      if (!BASE64_PATTERN.test(data)) {
        return "画像のデータが base64 として不正です。";
      }

      imageCount += 1;
      if (imageCount > MAX_IMAGES_PER_MESSAGE) {
        return `1つのメッセージに付けられる画像は ${MAX_IMAGES_PER_MESSAGE} 枚までです。`;
      }

      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      });
      continue;
    }

    return "content に未知の種類が含まれています。";
  }

  return blocks;
}

/**
 * 回答を作る。正規化した SSE の Response を返す。
 *
 * `raw` は画面から届いた本文、`signal` は画面が切ったことを伝えるもの。
 * **signal を上流まで通すのが肝心。** 通し忘れると、画面で「やめる」を
 * 押しても生成が続き、誰も見ない回答に課金され続ける。
 */
/**
 * サーバーが持たせる道具（function calling）。
 *
 * **画面（`/api/chat`）には渡さない。** タイマーは端末の会話でだけ
 * 意味があり、誰が呼んだか分からない HTTP からは掛けさせない。
 */
export interface ServerTools {
  /** Gemini の `functionDeclarations` にそのまま入る形。 */
  declarations: unknown[];
  /** 呼ばれたら実行して、返す値（JSON になるもの）を返す。 */
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * 道具の呼び合いを何周まで許すか。
 *
 * **暴走よけ。** 道具を呼んでは結果を見てまた呼ぶ、が止まらなくなると
 * 課金が延々と続く。タイマーは 1 周で済むので 3 で足りる。
 */
const MAX_TOOL_ROUNDS = 3;

export async function handleChat(
  raw: unknown,
  signal: AbortSignal,
  runtime: Runtime,
  tools?: ServerTools,
): Promise<Response> {
  const parsed = parseBody(raw);
  if (typeof parsed === "string") return errorResponse(400, parsed);

  const config = readConfig();
  // 端末内モデルという選択肢が無いので、設定された経路をそのまま使う
  // （経路の食い違いを 409 で返すような分岐は要らない）。
  const cloud = config.provider;
  const model = modelFor(config, cloud);

  // **タグの指示はサーバーが足す。** `/admin` の systemPrompt は利用者が
  // 書き換えるので、そちらに混ぜると書き換えで消えて原因の分からない
  // 不調になる（docs/08）。
  // **いまの日時を渡す。**
  //
  // モデルは学習した時点までしか知らないので、日付や時刻を聞かれると
  // 推測で答える（実際に「今日は何日」で適当な日を返した）。設定の
  // プロンプトには「タイムゾーンは日本」とあるが、**肝心の日時が
  // どこからも渡っていなかった**。
  //
  // 毎回変わる値なので `/admin` の systemPrompt には置けない。
  // サーバーが足す側に入れる。
  const systemPrompt = [config.systemPrompt, nowPrompt(), SPEECH_PROMPT]
    .concat(config.emotionTags ? [EMOTION_PROMPT] : [])
    .concat(tools ? [TOOL_PROMPT] : [])
    .filter(Boolean)
    .join("\n\n");

  try {
    // **道具つきは Gemini だけ。** Claude は tool_use の解析が別途要る
    // （`extractClaude` は text_delta しか見ていない）。
    if (tools && cloud === "gemini") {
      return await geminiWithTools(
        signal,
        runtime,
        systemPrompt,
        geminiOutputBudget(config.answerLength, config.thinkingLevel),
        model,
        config.thinkingLevel,
        parsed.messages,
        tools,
        config.version,
      );
    }

    const upstream =
      cloud === "claude"
        ? await callClaude(
            signal,
            runtime,
            systemPrompt,
            claudeOutputBudget(config.answerLength),
            model,
            parsed.messages,
          )
        : await callGemini(
            signal,
            runtime,
            systemPrompt,
            // 思考の分を上乗せした値。本文の分だけ渡すと思考で使い切る。
            geminiOutputBudget(config.answerLength, config.thinkingLevel),
            model,
            config.thinkingLevel,
            parsed.messages,
          );

    if (!upstream.ok || !upstream.body) {
      return await upstreamError(upstream, cloud);
    }

    const extract = cloud === "claude" ? extractClaude : extractGemini;

    return new Response(normalizeStream(upstream.body, extract), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // どの経路・モデルで応答したかを画面の表示に使う。
        "X-AIChatDevice-Provider": cloud,
        "X-AIChatDevice-Model": model,
        "X-AIChatDevice-Config-Version": String(config.version),
      },
    });
  } catch (error) {
    // クライアント切断は異常ではないので静かに閉じる。
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }

    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status: unknown }).status) || 502
        : 502;

    // 例外オブジェクトを丸ごと出さない。メッセージに URL が含まれると
    // 認証情報が漏れる経路になりうるため、名前と要約だけに留める。
    console.error("chat handler failed", cloud, errorLabel(error));
    return errorResponse(status, "AI の呼び出しに失敗しました。");
  }
}

/** 非 2xx のときに、上流の詳細を隠しつつ適切なステータスで返す。 */
async function upstreamError(
  upstream: Response,
  cloud: CloudProvider,
): Promise<Response> {
  const detail = await upstream.text().catch(() => "");
  console.error("upstream error", cloud, upstream.status, detail.slice(0, 200));

  const retryAfter = upstream.headers.get("retry-after");
  return errorResponse(
    upstream.status,
    upstreamMessage(upstream.status),
    retryAfter ? { "retry-after": retryAfter } : undefined,
  );
}

/**
 * 上流のエラー本文はそのまま返さない。
 *
 * プロバイダ固有の内部情報やキーの断片が含まれうるため、
 * 状況に応じた一般的な文言に置き換える。
 */
function upstreamMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "AI サービスの認証に失敗しました。管理者にお問い合わせください。";
  }
  if (status === 429) {
    return "混み合っています。しばらく待ってからお試しください。";
  }
  if (status >= 500) {
    return "AI サービスが一時的に応答できません。";
  }
  if (status === 400) {
    // 400 は設定の食い違いで、待っても直らない。
    // 「エラーが返りました」だけだと、管理者がどこを見ればよいか分からない
    // （実際にモデルと思考レベルの組み合わせで詰まった）。
    // 詳しい理由は上流の本文にあり、ログには出している。
    return "AI の設定が受け付けられませんでした。管理設定を確認してください。";
  }
  return "AI サービスがエラーを返しました。";
}

// MARK: - Claude

async function callClaude(
  signal: AbortSignal,
  runtime: Runtime,
  systemPrompt: string,
  maxTokens: number,
  model: string,
  messages: ChatMessage[],
): Promise<Response> {
  const client = new Anthropic({
    apiKey: runtime.anthropicApiKey,
    // 未設定なら SDK の既定（本物の API）。
    ...(runtime.anthropicBaseUrl ? { baseURL: runtime.anthropicBaseUrl } : {}),
  });

  // asResponse() で生レスポンスを受け取り、正規化ストリームに渡す。
  return client.messages
    .create(
      {
        model,
        max_tokens: maxTokens,
        stream: true,
        // 空のシステムプロンプトは送らない（余計なトークンを使わないため）。
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages,
      },
      { signal },
    )
    .asResponse();
}

/** Anthropic の SSE イベントからテキスト差分を取り出す。 */
const extractClaude: DeltaExtractor = (payload) => {
  const event = payload as {
    type?: string;
    delta?: { type?: string; text?: string; stop_reason?: string };
  };

  const result: ExtractResult = {};

  switch (event.type) {
    case "content_block_delta":
      if (event.delta?.type === "text_delta" && event.delta.text) {
        result.text = event.delta.text;
      }
      break;
    case "message_delta":
      if (event.delta?.stop_reason) {
        result.stopReason = event.delta.stop_reason;
      }
      break;
    case "error":
      result.error = "AI サービスがエラーを返しました。";
      break;
  }
  return result;
};

// MARK: - Gemini

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * 管理UIで選んだ思考レベルを、モデルの世代に合う形へ変換する。
 *
 * Gemini の `maxOutputTokens` は **思考トークンも含めた合算の上限** として働く。
 * 既定のまま投げると思考が上限のほとんどを食い潰し、本文が生成されないまま
 * `finishReason: MAX_TOKENS` で打ち切られる。実際にそれが起きて、
 * 途中で切れた英語の思考内容が回答として表示された。既定を "minimal" に
 * しているのはこのため。
 *
 * 世代でフィールド名が違う。
 * - Gemini 3.x  … `thinkingLevel`（minimal / low / medium / high）。
 *                 完全な無効化はできず "minimal" が最小
 * - Gemini 2.5  … `thinkingBudget`（トークン数）。0 で無効化でき、
 *                 -1 は動的思考（モデルが複雑さに応じて自分で決める）
 *
 * 「自動」は 2.5 の -1 に対応する。3.x には相当する値が無いので、
 * モデルの既定である "medium" に倒す。
 *
 * モデル一覧が動的になったので、ここには未知の ID も来うる。
 * models.list は thinkingLevel / thinkingBudget のどちらを取るかを
 * 示す情報を返さないため、判定は ID の世代に頼るしかない
 * （英語の description を grep するよりはましな選択）。
 * **1.x / 2.x 以外はすべて thinkingLevel を取ると仮定する。**
 * 外れた場合は上流が 400 を返すので、黙って間違うことはない。
 */
function thinkingConfigFor(model: string, level: ThinkingLevel) {
  // "gemini-2.9-..." のような将来の ID を legacy と誤判定しないよう、
  // 世代を明示的に列挙する。
  const legacy = /^gemini-(1|2)\./.test(model);
  if (legacy) {
    return { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[level] } };
  }
  return {
    thinkingConfig: { thinkingLevel: level === "auto" ? "medium" : level },
  };
}

/**
 * 共通形式のメッセージを Gemini の `contents` の1件に変換する。
 *
 * Claude 形式を正規形にしているので、変換が要るのはこちらだけ。
 * `parts` が元から配列なので、画像は素直に足せる。
 *
 * export しているのはテスト（e2e/images.test.mjs）から使うため。
 */
/**
 * 道具の使い方の指示。**宣言だけだと使ってくれないことがある。**
 *
 * `/admin` の systemPrompt には置かない（利用者が書き換えると消えて、
 * 原因の分からない不調になる）。サーバーが足す側に入れる。
 */
const TOOL_PROMPT = [
  "タイマーを頼まれたら set_timer を使ってください。",
  "すでに動いているときは新しくかけられません。",
  "その場合は残り時間を伝えてください。",
  "残り時間を聞かれたら get_timer、やめてと言われたら cancel_timer を使ってください。",
  "音量を変えてと言われたら set_volume を使ってください。",
  "「大きく」「小さく」のような言い方なら change に増減を渡します。",
  "いまの消費電力を聞かれたら get_house_power を使ってください。",
  "ワット数は「およそ600ワット」のように丸めて答えてください。",
  "製氷機の水を聞かれたら get_ice_maker_water を使ってください。",
  "分かるのは有無だけです。残りの量は答えられません。",
  "PC の電源は get_pc_power で調べ、set_pc_power で入り切りします。",
  "pressed が false なら、もうその状態だったので何もしていません。",
  "強制的に電源を落とすことはできません。頼まれたらできないと伝えてください。",
  "「ありがとう」「またね」「おわり」など、相手が話を切り上げようとしていたら",
  "end_chat を使ってください。",
  "**黙って終わらず、短い別れの挨拶を必ず言ってください。**",
  "まだ話が続きそうなときや、ついでに何かを頼まれているときは使いません。",
].join("");

/**
 * 道具を持たせて Gemini と話す。**呼び合いが終わってから流し始める。**
 *
 * 途中で `functionCall` が返ると本文はまだ無い。**先に道具を実行して
 * から本文を流す**ので、利用者に届くのは最後の1周ぶんだけになる。
 * ストリームを途中まで流してから道具を呼ぶと、言いかけの文が出て
 * 消えることになるため、この形を採る。
 */
async function geminiWithTools(
  signal: AbortSignal,
  runtime: Runtime,
  systemPrompt: string,
  maxTokens: number,
  model: string,
  thinkingLevel: ThinkingLevel,
  messages: ChatMessage[],
  tools: ServerTools,
  configVersion: number,
): Promise<Response> {
  const contents: unknown[] = messages.map(toGeminiContent);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const upstream = await callGemini(
      signal,
      runtime,
      systemPrompt,
      maxTokens,
      model,
      thinkingLevel,
      messages,
      tools,
      contents,
    );
    if (!upstream.ok || !upstream.body) return await upstreamError(upstream, "gemini");

    // 一度ぜんぶ読む。道具を呼ぶかどうかは最後まで見ないと分からない。
    const { calls, raw } = await readGeminiStream(upstream.body);

    // 道具を呼ばなかった＝これが答え。溜めたぶんをそのまま流す。
    if (calls.length === 0) {
      return new Response(normalizeStream(replay(raw), extractGemini), {
        status: 200,
        headers: toolHeaders(model, configVersion),
      });
    }

    // 呼ばれたぶんを実行して、結果を会話に足してもう一周。
    contents.push({
      role: "model",
      // **署名も一緒に返す。** 落とすと次の往復が 400 になる。
      parts: calls.map((c) => ({
        functionCall: { name: c.name, args: c.args },
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      })),
    });

    const responses = [];
    for (const call of calls) {
      let result: unknown;
      try {
        result = await tools.execute(call.name, call.args);
      } catch (error) {
        // **道具が転んでも会話は続ける。** AI に伝えて言葉にしてもらう。
        result = { error: error instanceof Error ? error.message : "失敗しました" };
      }
      console.log(`[tool] ${call.name} ${JSON.stringify(call.args)} → ${JSON.stringify(result)}`);
      responses.push({
        functionResponse: { name: call.name, response: { result } },
      });
    }
    contents.push({ role: "user", parts: responses });
  }

  // 打ち切り。ここに来るのは道具を呼び続けたとき。
  return errorResponse(500, "道具の呼び出しが終わりませんでした。");
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /**
   * 思考の署名。**そのまま返さないと 400 になる。**
   *
   * Gemini 3 系は道具を呼ぶとき `functionCall` にこれを付けてくる。
   * 次の往復でそのまま送り返す決まりで、落とすと
   * 「Function call is missing a thought_signature」で拒まれる
   * （実機で実際に出た）。**中身は読まない。預かって返すだけ。**
   */
  thoughtSignature?: string;
}

/**
 * Gemini の SSE を最後まで読み、**道具の呼び出しと生の行**を返す。
 *
 * 生の行を取っておくのは、道具を呼ばなかったときに
 * `normalizeStream` へそのまま流し直すため（もう一度 API を叩かない）。
 */
async function readGeminiStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ calls: ToolCall[]; raw: string[] }> {
  const parser = new SSELineParser();
  const reader = body.getReader();
  const calls: ToolCall[] = [];
  const raw: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    const payloads = done ? parser.flush() : parser.push(value);

    for (const payload of payloads) {
      raw.push(payload);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const chunk = parsed as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              functionCall?: { name?: string; args?: Record<string, unknown> };
              thoughtSignature?: string;
            }>;
          };
        }>;
      };
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        const call = part.functionCall;
        if (call?.name) {
          calls.push({
            name: call.name,
            args: call.args ?? {},
            ...(part.thoughtSignature
              ? { thoughtSignature: part.thoughtSignature }
              : {}),
          });
        }
      }
    }
    if (done) break;
  }

  return { calls, raw };
}

/** 溜めた SSE の行を、もう一度ストリームとして流す。 */
function replay(payloads: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
}

function toolHeaders(model: string, version: number): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-AIChatDevice-Provider": "gemini",
    "X-AIChatDevice-Model": model,
    "X-AIChatDevice-Config-Version": String(version),
  };
}

export function toGeminiContent(message: ChatMessage) {
  return {
    // Gemini のロール名は user / model（assistant ではない）。
    role: message.role === "assistant" ? "model" : "user",
    parts:
      typeof message.content === "string"
        ? [{ text: message.content }]
        : message.content.map(toGeminiPart),
  };
}

function toGeminiPart(block: ContentBlock) {
  if (block.type === "text") return { text: block.text };
  // Gemini は snake_case（inline_data / mime_type）。Claude 側と綴りが違う。
  return {
    inline_data: {
      mime_type: block.source.media_type,
      data: block.source.data,
    },
  };
}

async function callGemini(
  signal: AbortSignal,
  runtime: Runtime,
  systemPrompt: string,
  maxTokens: number,
  model: string,
  thinkingLevel: ThinkingLevel,
  messages: ChatMessage[],
  /**
   * 道具を持たせるとき。**渡されたときだけ** functionDeclarations を足す。
   *
   * 生の contents を渡せるのは、道具の往復で
   * 「model の functionCall」「function の functionResponse」という
   * `ChatMessage` で表せない役が要るため。
   */
  tools?: ServerTools,
  contents?: unknown[],
): Promise<Response> {
  // API キーは x-goog-api-key ヘッダで渡す。
  // ?key= クエリ方式だと URL にキーが載り、Cloudflare Traces の url.full や
  // fetch の例外メッセージ経由で漏れる経路ができるため使わない。
  const url = `${runtime.geminiBaseUrl ?? GEMINI_BASE}/${model}:streamGenerateContent?alt=sse`;

  const body = {
    contents: contents ?? messages.map(toGeminiContent),
    ...(systemPrompt
      ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
      : {}),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...thinkingConfigFor(model, thinkingLevel),
    },
    // Google 検索での裏付けを常に有効にする。
    //
    // これを渡さない限り Gemini は検索を一切せず、学習済みの知識だけで
    // 答える。それらしい回答が返るぶん、検索していないことに気づきにくい。
    //
    // 実際に検索するかはモデルが質問ごとに判断するので、不要な場面で
    // 課金されるわけではない。検索した場合は groundingMetadata が付き、
    // extractGemini が引用元として取り出す。
    //
    // ツール名は googleSearch。google_search_retrieval は 1.5 世代のもので、
    // 3.x に投げると 400 になる。
    //
    // urlContext は「貼られた URL を実際に開いて読む」ツール。検索とは別物で、
    // これが無いと URL を貼られても本文を取りに行かず、URL の文字列だけから
    // それらしく答えてしまう（検索が偶然そのページに当たれば読めるが、
    // 当たらなければ黙って想像で答える）。同じ配列に並べて併用できる。
    //
    // URL を含まない会話では何も起きないので、常時渡して構わない。
    //
    // **道具を渡しても検索は外さない。** 両方入る。
    //
    // 素直に並べると 400 で
    // 「Please enable tool_config.include_server_side_tool_invocations to
    //  use Built-in tools with Function calling」と返る。下の toolConfig が
    // それで、**これを立てれば同居できる**（実機で確認：タイマーの依頼で
    // functionCall が返り、天気の質問では groundingMetadata が付いた）。
    //
    // 検索のほうが使う場面が多いので、**タイマーのために外すのは割に合わない**。
    tools: tools
      ? [
          { googleSearch: {} },
          { urlContext: {} },
          { functionDeclarations: tools.declarations },
        ]
      : [{ googleSearch: {} }, { urlContext: {} }],
    // 組み込みの道具（検索）と自前の道具を混ぜるときに要る。
    ...(tools
      ? { toolConfig: { includeServerSideToolInvocations: true } }
      : {}),
  };

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": runtime.geminiApiKey,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Gemini の SSE チャンクからテキスト差分と引用元を取り出す。
 *
 * export しているのはテスト（e2e/grounding.test.mjs）から使うため。
 */
export const extractGemini: DeltaExtractor = (payload) => {
  const chunk = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
      urlContextMetadata?: {
        urlMetadata?: Array<{
          retrievedUrl?: string;
          urlRetrievalStatus?: string;
        }>;
      };
    }>;
    promptFeedback?: { blockReason?: string };
    error?: { message?: string };
  };

  const result: ExtractResult = {};

  if (chunk.error) {
    result.error = "AI サービスがエラーを返しました。";
    return result;
  }

  // 安全フィルタで入力ごと拒否された場合。
  if (chunk.promptFeedback?.blockReason) {
    result.stopReason = "refusal";
    return result;
  }

  const candidate = chunk.candidates?.[0];
  if (candidate) {
    // parts は複数に分かれることがあるので連結する。
    // thought: true のパートは思考内容なので本文に混ぜない。
    // thinkingLevel を絞っていても思考自体は無くならないため、
    // 表示側に漏らさない防御をここにも置く。
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    if (text) result.text = text;

    // 検索で裏付けに使われたページ。
    //
    // groundingMetadata には他に groundingSupports（本文のどの範囲を
    // どの出典が裏付けたか）と searchEntryPoint（検索候補チップの HTML）も
    // 入っているが、どちらも使っていない。本文には脚注番号を入れず
    // 一覧だけを出す方針のため。
    //
    // なお searchEntryPoint は、Google の利用規約では本来この検索候補も
    // 併せて表示することが求められている。私的利用の範囲として今は
    // 出していないので、配布先を広げるときは再検討すること。
    const searchSources = (candidate.groundingMetadata?.groundingChunks ?? [])
      .map((entry) => entry.web)
      .filter((web): web is { uri: string; title?: string } => !!web?.uri)
      .map((web) => ({
        uri: web.uri,
        // title が空なら URL をそのまま見せる。リダイレクト URL なので
        // ホスト名を出しても意味が無く、かえって出所を誤らせる。
        title: web.title?.trim() || web.uri,
      }));

    // urlContext が実際に読み込めたページ。検索の出典と同じ列に並べる。
    //
    // 取得に失敗した URL は落とす。読めなかったページを出典として出すと
    // 「これを参照して答えた」という嘘になるため（モデルの側は
    // 「アクセスできませんでした」と本文で述べる）。
    // ステータスが付いてこない場合は成功として扱い、値が増えたときに
    // 全部落ちてしまうのを避ける。
    const fetchedSources = (candidate.urlContextMetadata?.urlMetadata ?? [])
      .filter(
        (entry): entry is { retrievedUrl: string; urlRetrievalStatus?: string } =>
          !!entry.retrievedUrl &&
          (!entry.urlRetrievalStatus ||
            entry.urlRetrievalStatus === "URL_RETRIEVAL_STATUS_SUCCESS"),
      )
      // 表示名も URL のまま出す。こちらは検索と違って実 URL なので
      // ホスト名を出しても誤らせはしないが、normalizeStream が
      // 表示名でも重複を見るため、同じサイトの別記事を2つ貼られたときに
      // 片方が黙って消える。URL のままなら取りこぼさない。
      .map((entry) => ({ uri: entry.retrievedUrl, title: entry.retrievedUrl }));

    const sources = [...searchSources, ...fetchedSources];
    if (sources.length) result.sources = sources;

    if (candidate.finishReason) {
      // SAFETY / RECITATION は拒否として扱い、アプリ側で区別できるようにする。
      // MAX_TOKENS はそのまま渡し、途中で切れたことをアプリ側で示せるようにする。
      result.stopReason =
        candidate.finishReason === "SAFETY" ||
        candidate.finishReason === "RECITATION"
          ? "refusal"
          : candidate.finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : "end_turn";
    }
  }
  return result;
};
