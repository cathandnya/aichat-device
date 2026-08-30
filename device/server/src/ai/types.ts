/**
 * Worker 全体で共有する型定義。
 */

/**
 * AI を呼ぶのに要るもの。
 *
 * もとは Cloudflare の Env（KV と Workers AI のバインディング）だった。
 * ローカルサーバーに移したので、鍵は .env か OS の鍵束（secrets.ts）から、
 * 設定はローカルのファイル（store.ts）から来る。
 */
export interface Runtime {
  anthropicApiKey: string;
  geminiApiKey: string;
  /** 音声認識に OpenAI を選んだときだけ要る。 */
  openaiApiKey: string;
  /** ローカルの whisper-server の URL。空なら whisper は使えない。 */
  whisperUrl: string;
  /** macOS の音声認識を包む ohr サーバーの URL。空なら使えない。 */
  appleSpeechUrl: string;
  /**
   * 上流の差し替え。**テストでスタブを指すためだけのもの。**
   * 未設定なら必ず本物の API を使う（設定漏れで本番がスタブを
   * 向くことがないよう、既定を本物にしてある）。
   */
  geminiModelsEndpoint?: string;
  anthropicBaseUrl?: string;
  geminiBaseUrl?: string;
}

/**
 * 使う AI。管理UIからのみ変更できる。
 *
 * 本家 AIChat には `automatic` / `onDevice`（端末内の Apple Foundation Models）
 * があるが、こちらでは削ってある。**AI を呼ぶのはサーバーだけ**で、話しかける
 * 端末には何も載らないため、「端末内モデル」という概念が成立しない。選択肢を
 * 残すと「端末内のみ」に設定した瞬間にデバイスが黙って答えなくなる。
 *
 * サーバーが Mac に据え置かれた以上、Foundation Models 自体は呼べる位置にある。
 * 足すとしたら provider ではなく**補助的な用途**（感情の判定など）で、
 * 回答そのものをこれに任せる話ではない。
 */
export const CLOUD_PROVIDERS = ["claude", "gemini"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

/**
 * 許可する Claude モデルの許可リスト。
 * ここに無いモデルは管理UIからもAPIからも指定できない（想定外の課金を防ぐ）。
 */
export const CLAUDE_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/**
 * 音声認識に使うモデル。
 *
 * 既定は **macOS の音声認識（SpeechAnalyzer）**。実測で一番速くて正確で、
 * 音声が家の外に出ず、課金も無い。`ohr` が OpenAI 互換のサーバーとして
 * 包んでくれるので、こちらは HTTP を投げるだけで済む。
 *
 * ### 実測（Apple Silicon / VOICEVOX の合成音声 6 文・常駐サーバー）
 *
 * | | 1文あたり | 意味が変わる誤り |
 * |---|---|---|
 * | **Apple SpeechAnalyzer（ohr）** | **0.14秒** | **0件** |
 * | whisper large-v3-turbo + `-ac 512` | 0.74秒 | 6件中1件（行き方→生き方） |
 * | whisper large-v3-turbo（既定設定） | 2.42秒 | 0件 |
 * | whisper small | 0.86秒 | 6件中1件（オンス→温度） |
 *
 * whisper も残してある。**Apple の音声認識は macOS でしか動かない**ので、
 * サーバーを Mac 以外へ動かすならそちらになる。ただし**いまはサーバーを Mac に
 * 据え置くと決めている**（docs/04 の「変更の記録」）ので、これは逃げ道であって
 * 予定ではない。クラウドの経路は、どちらのサーバーも立てられないときの最後の手段。
 *
 * whisper の `-ac 512` は音声文脈を縮める指定。whisper は入力を 30 秒窓に
 * 詰めて処理するので、短い問いかけでも固定費がかかる。窓を縮めると
 * 3 倍速くなり、数秒しか話さないこの用途では精度もほぼ落ちない。
 */
export const STT_MODELS = [
  "apple-speech",
  "local-whisper",
  "gemini-flash-latest",
  "gpt-4o-transcribe",
  "whisper-1",
] as const;
export type SttModel = (typeof STT_MODELS)[number];

export const STT_MODEL_LABELS: Record<SttModel, string> = {
  "apple-speech":
    "macOS の音声認識 — 既定。最速（0.14秒）で音声も外に出ない。ohr が要る。Mac のみ",
  "local-whisper":
    "ローカル（whisper.cpp）— 音声が外に出ず課金も無い。Mac 以外でも動く。whisper-server が要る",
  "gemini-flash-latest":
    "Gemini Flash — チャットと同じ鍵で使えるので鍵が増えない",
  "gpt-4o-transcribe": "OpenAI gpt-4o-transcribe — 書き起こし専用。OPENAI_API_KEY が要る",
  "whisper-1": "OpenAI whisper-1 — 安価な旧世代。OPENAI_API_KEY が要る",
};

/** そのモデルをどこで動かすか。 */
export function sttVendor(
  model: SttModel,
): "apple" | "local" | "gemini" | "openai" {
  if (model === "apple-speech") return "apple";
  if (model === "local-whisper") return "local";
  return model.startsWith("gemini-") ? "gemini" : "openai";
}

export function isSttModel(value: unknown): value is SttModel {
  return (
    typeof value === "string" && (STT_MODELS as readonly string[]).includes(value)
  );
}

export const MAX_AUDIO_BYTES = 1_000_000;

/**
 * Gemini のモデル一覧は静的に持たず、models.list から取得して KV に置く
 * （gemini-models.ts）。Google が短い間隔で新モデルを出すため、
 * コードを直して deploy しないと選べない状態を避ける。
 *
 * 妥当性の検証は **書き込み時のみ**（validatePatch で取得済み一覧と突き合わせる）。
 * 読み出し時は形だけ見る（isModelId）。取得した一覧が一時的に短かっただけで、
 * 動いている設定が黙って別のモデルに置き換わるのを防ぐため。
 */

/** models.list から取り込んだ1件。表示に要る分だけを持つ。 */
export interface GeminiModelInfo {
  /** "gemini-3.6-flash"。API の "models/" 接頭辞は剥がして保存する。 */
  id: string;
  /** API の displayName（英語）。無ければ id。 */
  displayName: string;
  /** 入力トークン上限。取得できなければ 0。表示の補助にのみ使う。 */
  inputTokenLimit: number;
  /** 出力トークン上限。取得できなければ 0。 */
  outputTokenLimit: number;
}

/** KV `gemini-models` の中身。 */
export interface GeminiModelCatalog {
  models: GeminiModelInfo[];
  /** ISO8601。管理UIに「いつ取得したか」を出す。 */
  fetchedAt: string;
}

/**
 * Gemini の思考（thinking）の深さ。
 *
 * Gemini 3.x は `thinkingLevel`、2.5 は `thinkingBudget` と
 * フィールド名が異なる。ここでは共通の段階として持ち、
 * 送信時にモデルの世代に応じて変換する（chat.ts の thinkingConfigFor）。
 */
export const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "auto",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  minimal: "最小 — 速い・安い（日常会話向け・既定）",
  low: "低 — 少し考える",
  medium: "中 — 込み入った質問向け",
  high: "高 — じっくり考える（遅い・高コスト）",
  auto: "自動 — 質問の難しさに応じてモデルが決める",
};

/**
 * Gemini 2.5 系に渡す思考予算（トークン数）。
 *
 * 2.5 の `thinkingBudget` は 0〜24,576 の範囲。3.x の `thinkingLevel` に
 * 相当する段階をこの範囲に割り当てている。
 * `-1` は動的思考（モデルが複雑さに応じて自分で決める）を意味する特別値。
 */
export const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 0,
  low: 2048,
  medium: 8192,
  high: 24576,
  auto: -1,
};

/**
 * 出力予算を見積もるときに「自動」をどれとみなすか。
 *
 * 動的思考は実際の消費量が事前にわからないため、上限に届いて回答が
 * 途切れないよう最大（high）と同じだけ確保しておく。実際に使われ
 * なければ課金もされない。
 */
const THINKING_ESTIMATE: Record<ThinkingLevel, number> = {
  ...THINKING_BUDGETS,
  auto: THINKING_BUDGETS.high,
};

/**
 * 回答の長さ。管理者はトークン数ではなくこちらを選ぶ。
 *
 * トークン数を人が管理すると、思考の分を足し忘れて回答が出なくなる。
 * 実際にそれが起きたため、長さだけを選ばせて必要なトークン数は
 * `outputBudget()` が計算する。
 */
export const ANSWER_LENGTHS = ["short", "standard", "long"] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];

export const ANSWER_LENGTH_LABELS: Record<AnswerLength, string> = {
  short: "短め — 要点だけ（目安 1,000 文字）",
  standard: "標準 — 通常の会話に十分（目安 3,000 文字・既定）",
  long: "長め — 詳しい説明や長文向け（目安 8,000 文字）",
};

/** 本文に使うトークン数。日本語はおよそ 1 文字 = 1 トークン。 */
const ANSWER_TOKENS: Record<AnswerLength, number> = {
  short: 1024,
  standard: 3072,
  long: 8192,
};

/**
 * モデルが受け付ける出力トークンの上限。
 * 対象モデル（Gemini Flash 系 / Claude）はいずれもこれ以上を許容する。
 */
const OUTPUT_TOKENS_CEILING = 32768;

/**
 * Gemini に渡す `maxOutputTokens` を求める。
 *
 * Gemini の `maxOutputTokens` は **思考トークンも含めた合算の上限** として
 * 働くため、本文の分だけを渡すと思考で使い切って回答が出ない。
 * 思考予算を上乗せして確保する。
 *
 * 3.x の `thinkingLevel` は「相対的な許容量」で実トークン数は公表されて
 * いないため、2.5 用の予算表を見積もりとして流用する。多めに確保する分には
 * 実際に使われなければ課金されない（課金は実消費トークンに対して行われる）。
 */
export function geminiOutputBudget(
  length: AnswerLength,
  thinking: ThinkingLevel,
): number {
  const total = ANSWER_TOKENS[length] + THINKING_ESTIMATE[thinking];
  return Math.min(total, OUTPUT_TOKENS_CEILING);
}

/** Claude に渡す `max_tokens`。Claude は思考を使っていないので本文の分だけ。 */
export function claudeOutputBudget(length: AnswerLength): number {
  return ANSWER_TOKENS[length];
}

export function isAnswerLength(value: unknown): value is AnswerLength {
  return (
    typeof value === "string" &&
    (ANSWER_LENGTHS as readonly string[]).includes(value)
  );
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/** 管理UIでの表示用ラベル（価格や位置づけを併記して誤選択を防ぐ）。 */
export const CLAUDE_MODEL_LABELS: Record<ClaudeModel, string> = {
  "claude-haiku-4-5": "Haiku 4.5 — $1 / $5 per MTok（最安・日常会話向け）",
  "claude-sonnet-5": "Sonnet 5 — $3 / $15 per MTok（バランス型・既定）",
  "claude-opus-5": "Opus 5 — $5 / $25 per MTok（最高品質・高コスト）",
};

/**
 * 表示用の短いモデル名。Claude だけ手書きの表を持つ。
 * Gemini は一覧が動的なので shortModelName が ID から導出する。
 */
export const CLAUDE_SHORT_NAMES: Record<ClaudeModel, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-opus-5": "Opus 5",
};

export interface AppConfig {
  /** 設定の版。更新のたびに +1 される。アプリ側のキャッシュ判定に使う。 */
  version: number;
  /** 使う AI。端末内モデルは無いので claude / gemini の二択。 */
  provider: CloudProvider;
  /**
   * Claude / Gemini それぞれのモデルを別フィールドで保持する。
   * プロバイダを切り替えても、各々で選んだモデルが保たれる。
   */
  claudeModel: ClaudeModel;
  /**
   * Gemini のモデル ID。許可リストが API 由来の動的な集合になったため、
   * 型としてはただの文字列。妥当性は書き込み時（validatePatch）に
   * 取得済み一覧と突き合わせて確かめる。
   */
  geminiModel: string;
  /** Gemini の思考の深さ。Claude 側には影響しない。 */
  thinkingLevel: ThinkingLevel;
  /** 音声認識に使うモデル。 */
  sttModel: SttModel;
  /** 読み上げの速さ。1.0 が VOICEVOX の既定。 */
  speechSpeed: SpeechSpeed;
  /**
   * ウェイクワード。書き起こしにこのどれかが出たら起動する。
   *
   * **複数持てるのが肝心。** 認識器には癖があり、同じ発話でも
   * 濁点が落ちたりする（「ずんだもん」→「すんだもん」）。
   * 実測では両方を登録して検出 10/10・誤起動 0/15 になった。
   * 詳しくは docs/06。
   */
  wakeWords: string[];
  /** 追い質問を受け付ける秒数。0 なら毎回ウェイクワードが要る。 */
  followUpSec: number;
  /** これが聞こえたら会話を終える。空でもよい。 */
  endPhrases: string[];
  /**
   * 名前を呼ばれただけのときの返事。**既定は空で、効果音だけ。**
   *
   * アレクサに倣った。呼ばれるたびに声で返されると、続けて話す気を
   * そがれる（言いかけているところに被る）。**音が鳴れば起きたことは
   * 分かる**ので、それで足りる。
   *
   * 何か言わせたいときはここに文を入れる。
   */
  wakeReply: string;
  /** これ以上あいたら別の会話とみなす（分）。 */
  conversationGapMin: number;
  /** AI に送る直近の往復数。保存は全部。 */
  contextTurns: number;
  systemPrompt: string;
  /**
   * 感情タグを付けさせるか。
   *
   * **切っても本文は変わらない。** 表情は辞書での推定に落ちるだけ
   * （docs/08）。タグが効かないと分かったときに戻せるようにしておく。
   */
  emotionTags: boolean;
  /**
   * 回答の長さ。必要なトークン数は思考レベルと併せて自動で決まる
   * （`geminiOutputBudget` / `claudeOutputBudget`）。
   */
  answerLength: AnswerLength;
  /** ISO8601 */
  updatedAt: string;
}

/** 選ばれている経路に対応するモデル ID。 */
export function modelFor(config: AppConfig, cloud: CloudProvider): string {
  return cloud === "claude" ? config.claudeModel : config.geminiModel;
}

/**
 * 読み上げの速さ。1.0 が VOICEVOX の既定。
 *
 * ブラウザ側で再生速度を上げる（`playbackRate`）方法もあるが、
 * そちらは声の高さまで上がって不自然になる。VOICEVOX に
 * `speedScale` として渡すと、高さを保ったまま速く話す。
 *
 * 値を並べて持つのは、自由入力にすると 0 や 100 を保存できてしまい、
 * 読み上げが壊れるため。他の設定（モデル・回答の長さ）と同じ考え方。
 */
export const SPEECH_SPEEDS = [
  0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0,
] as const;
export type SpeechSpeed = (typeof SPEECH_SPEEDS)[number];

export function isSpeechSpeed(value: unknown): value is SpeechSpeed {
  return (
    typeof value === "number" && (SPEECH_SPEEDS as readonly number[]).includes(value)
  );
}

/**
 * ウェイクワードの上限。数も長さも絞る。
 *
 * 判定は「窓を書き起こして文字列を探す」ので、増やしても CPU は増えない。
 * それでも絞るのは、短すぎる語（1〜2文字）を入れると誤起動が跳ねるため。
 */
export const MAX_WAKE_WORDS = 8;
export const WAKE_WORD_MIN_LENGTH = 3;
export const WAKE_WORD_MAX_LENGTH = 24;

export function isWakeWords(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.length > MAX_WAKE_WORDS) return false;
  return value.every(
    (v) =>
      typeof v === "string" &&
      v.trim().length >= WAKE_WORD_MIN_LENGTH &&
      v.trim().length <= WAKE_WORD_MAX_LENGTH,
  );
}

/**
 * 追い質問の窓の長さ（秒）。**0 なら毎回ウェイクワードが要る。**
 *
 * 窓が開いている間は部屋の話し声を拾って AI に投げてしまう。これは課金に
 * 直結するので、0 にして止められる逃げ道を残してある。
 * 8 秒は Alexa（約5秒）と Google（約8秒）の相場から。
 */
export const MAX_FOLLOW_UP_SEC = 30;

export function isFollowUpSec(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_FOLLOW_UP_SEC
  );
}

/**
 * 会話を終える語。ウェイクワードと同じ仕組み（文字列一致）で判定する。
 *
 * 空にもできる。「ありがとう」は会話の途中にも出るので、
 * 誤って終わるのが気になるなら消せるようにしてある。
 */
export const MAX_END_PHRASES = 8;

export function isEndPhrases(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length > MAX_END_PHRASES) return false;
  return value.every((v) => typeof v === "string" && v.trim().length >= 2);
}

/**
 * 名前を呼ばれただけのときの返事。
 *
 * 「ずんだもん」とだけ言われて質問が続かなかったとき、
 * **エラーにせず短く返事をして待つ。** 呼びかけに無反応だと
 * 壊れているように見えるし、「聞き取れませんでした」と言われるのは
 * こちらが悪いことにされているようで感じが悪い。
 *
 * **AI は呼ばない**（読み上げるだけ）ので費用はかからない。
 * 空にすると、返事をせずに黙って待つ。
 */
export const MAX_WAKE_REPLY_LENGTH = 40;

export function isWakeReply(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_WAKE_REPLY_LENGTH;
}

/**
 * これ以上あいたら「別の会話」とみなす分数。
 *
 * **ウェイクワードでは文脈を捨てない。** 以前は「呼ばれたら新しいチャット」に
 * していたが、少し考えて言い直すだけで文脈が飛んだ。実際の記録でも
 * 「今日これから雨降る」の 2.7 分後に「東京なんだけど」と言っているのに
 * 別のチャットになっており、AI には前の話が渡っていなかった。
 *
 * 家族が別の話題を始める心配は、時間で十分に防げる。
 */
export const MAX_CONVERSATION_GAP_MIN = 120;

export function isConversationGapMin(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CONVERSATION_GAP_MIN
  );
}

/**
 * AI に送る直近の往復数。**保存は全部で、送る分だけを絞る。**
 *
 * 長い文脈は課金が増え、回答の精度も落ちる。会話が続いても
 * 送る量が一定になるので、途中で強制的に打ち切る必要がなくなる。
 */
export const MAX_CONTEXT_TURNS = 30;

export function isContextTurns(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CONTEXT_TURNS
  );
}

export const SYSTEM_PROMPT_MAX_LENGTH = 8000;

/** KV に値が無い初回に使う既定値。 */
export const DEFAULT_CONFIG: AppConfig = {
  version: 0,
  // 据え置きデバイスは「話しかけたらすぐ答える」が第一なので、
  // 既定は Claude の中でも速い Haiku にしておく。
  provider: "claude",
  claudeModel: "claude-haiku-4-5",
  geminiModel: "gemini-3.6-flash",
  thinkingLevel: "minimal",
  sttModel: "apple-speech",
  // 据え置きデバイスは「聞いてすぐ次に進みたい」ので、既定から速める。
  speechSpeed: 1.5,
  // 実測で一番成績が良かった組み合わせ（docs/06）。
  // 「すんだもん」は濁点が落ちた聞こえ方。足しても誤起動は増えなかった。
  wakeWords: ["ずんだもん", "すんだもん"],
  followUpSec: 8,
  endPhrases: ["ありがとう", "おわり", "もういい", "またね"],
  // **既定は空。** 効果音だけで返事はしない（アレクサに合わせた）。
  wakeReply: "",
  conversationGapMin: 10,
  contextTurns: 5,
  systemPrompt: "",
  emotionTags: true,
  answerLength: "standard",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

/**
 * 内容の断片。
 *
 * Claude の形をそのまま正規形にしている。`callClaude` は messages を
 * SDK へそのまま渡しており、その素直さを保ちたいため。Gemini 側は
 * parts が元から配列なので、変換は素直に書ける。
 */
export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * 受け付ける画像形式。
 *
 * 上流がどちらも扱えるものに限る。Anthropic SDK の型もこの4つを
 * リテラルで要求するので、許可リストをそのまま型として使う。
 */
export const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return (
    typeof value === "string" &&
    (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
  );
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ImageMediaType; data: string };
}

export type ContentBlock = TextBlock | ImageBlock;

/** アプリから /v1/chat に送られてくるメッセージ。 */
export interface ChatMessage {
  role: "user" | "assistant";
  /**
   * 画像を含まないときは文字列。
   *
   * 配列だけにしないのは、画像を持たないアプリ（古い版）が送ってくる
   * 形をそのまま受け続けるため。画像の無い会話のリクエストが今までと
   * 変わらないほうが、問題が起きたときの切り分けもしやすい。
   */
  content: string | ContentBlock[];
}

export function isClaudeModel(value: unknown): value is ClaudeModel {
  return (
    typeof value === "string" &&
    (CLAUDE_MODELS as readonly string[]).includes(value)
  );
}

export function isCloudProvider(value: unknown): value is CloudProvider {
  return (
    typeof value === "string" &&
    (CLOUD_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * モデル ID として形が妥当かだけを見る。許可リストとは無関係。
 *
 * `model` は chat.ts で `${GEMINI_BASE}/${model}:streamGenerateContent` と
 * URL に直接埋め込まれる。以前は静的な許可リストが暗黙にこれを守っていたが、
 * 一覧が動的になったぶん、パス注入は明示的に防ぐ必要がある。
 * `/` `?` `#` `:` を弾くのが要点。
 */
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

/**
 * 表示用の短いモデル名。
 *
 * Gemini は一覧が動的になったので手書きの表を持てない。ID から機械的に
 * 導出する（"gemini-3.6-flash" → "3.6 Flash"）。導出できない形は ID を
 * そのまま返す。それらしい嘘の名前を出すより生の ID のほうがましなため。
 *
 * この規則は Web UI 側（device/web）と揃えてある。
 */
export function shortModelName(model: string): string {
  const claude = CLAUDE_SHORT_NAMES[model as ClaudeModel];
  if (claude) return claude;

  const match = /^gemini-(.+)$/.exec(model);
  if (!match) return model;

  return (match[1] as string)
    .split("-")
    .map((part) =>
      /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}
