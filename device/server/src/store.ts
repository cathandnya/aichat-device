/**
 * 設定の読み書き。`data/config.json` に JSON で保存する。
 *
 * もとは Cloudflare KV に置いていた。ローカルサーバーに移したので
 * ただのファイルになった。1台のデバイスが持つ設定が1つだけ、という
 * 前提は変わっていない。変更は管理UIからのみ行える。
 *
 * 書き込みは一時ファイル → rename で行う。途中で電源が落ちても
 * 中途半端な JSON が残らないようにするため（設定が壊れると
 * デバイスが黙るので、ここは丁寧にやる価値がある）。
 */

import { dataPath, readJsonSafe, writeJsonAtomic } from "./data.ts";

import {
  DEFAULT_CONFIG,
  SYSTEM_PROMPT_MAX_LENGTH,
  isAnswerLength,
  isClaudeModel,
  isCloudProvider,
  isModelId,
  isSpeechSpeed,
  isSttModel,
  isContextTurns,
  isConversationGapMin,
  isEndPhrases,
  isFollowUpSec,
  isWakeReply,
  isWakeWords,
  MAX_END_PHRASES,
  MAX_CONTEXT_TURNS,
  MAX_CONVERSATION_GAP_MIN,
  MAX_FOLLOW_UP_SEC,
  MAX_WAKE_REPLY_LENGTH,
  MAX_WAKE_WORDS,
  WAKE_WORD_MAX_LENGTH,
  WAKE_WORD_MIN_LENGTH,
  isThinkingLevel,
  type AppConfig,
} from "./ai/types.ts";

const CONFIG_PATH = dataPath("config.json");

/**
 * 設定を読む。ファイルが無い／壊れている場合は既定値を返す。
 *
 * 設定が読めないことでチャット全体が止まるのは避けたいので、
 * ここでは決して throw しない。
 *
 * 同期で読むのは、ファイルが数百バイトで、呼ぶのがリクエストごとの
 * 1回だけだから。非同期にしても得るものが無い。
 */
export function readConfig(): AppConfig {
  const stored = readJsonSafe(CONFIG_PATH);

  if (!stored || typeof stored !== "object") return { ...DEFAULT_CONFIG };

  const raw = stored as Record<string, unknown>;

  // 各フィールドを個別に検証し、不正な値だけ既定値に落とす。
  // 1フィールドの破損で設定全体を失わないようにする。
  return {
    version: typeof raw.version === "number" ? raw.version : DEFAULT_CONFIG.version,
    provider: isCloudProvider(raw.provider) ? raw.provider : DEFAULT_CONFIG.provider,
    claudeModel: isClaudeModel(raw.claudeModel)
      ? raw.claudeModel
      : DEFAULT_CONFIG.claudeModel,
    // Gemini のモデルは形だけ見る。取得済み一覧との突き合わせは
    // 書き込み時（validatePatch）に済んでいる。ここは毎回のチャットが
    // 通る経路なので、一覧が一時的に短く取得されただけで動いている
    // 設定が別のモデルに置き換わることのないようにする。
    geminiModel: isModelId(raw.geminiModel)
      ? raw.geminiModel
      : DEFAULT_CONFIG.geminiModel,
    thinkingLevel: isThinkingLevel(raw.thinkingLevel)
      ? raw.thinkingLevel
      : DEFAULT_CONFIG.thinkingLevel,
    sttModel: isSttModel(raw.sttModel) ? raw.sttModel : DEFAULT_CONFIG.sttModel,
    speechSpeed: isSpeechSpeed(raw.speechSpeed)
      ? raw.speechSpeed
      : DEFAULT_CONFIG.speechSpeed,
    wakeWords: isWakeWords(raw.wakeWords)
      ? raw.wakeWords
      : [...DEFAULT_CONFIG.wakeWords],
    followUpSec: isFollowUpSec(raw.followUpSec)
      ? raw.followUpSec
      : DEFAULT_CONFIG.followUpSec,
    endPhrases: isEndPhrases(raw.endPhrases)
      ? raw.endPhrases
      : [...DEFAULT_CONFIG.endPhrases],
    wakeReply: isWakeReply(raw.wakeReply)
      ? raw.wakeReply
      : DEFAULT_CONFIG.wakeReply,
    conversationGapMin: isConversationGapMin(raw.conversationGapMin)
      ? raw.conversationGapMin
      : DEFAULT_CONFIG.conversationGapMin,
    contextTurns: isContextTurns(raw.contextTurns)
      ? raw.contextTurns
      : DEFAULT_CONFIG.contextTurns,
    systemPrompt:
      typeof raw.systemPrompt === "string"
        ? raw.systemPrompt
        : DEFAULT_CONFIG.systemPrompt,
    answerLength: isAnswerLength(raw.answerLength)
      ? raw.answerLength
      : DEFAULT_CONFIG.answerLength,
    updatedAt:
      typeof raw.updatedAt === "string" ? raw.updatedAt : DEFAULT_CONFIG.updatedAt,
  };
}

export interface ConfigPatch {
  provider?: unknown;
  claudeModel?: unknown;
  geminiModel?: unknown;
  thinkingLevel?: unknown;
  sttModel?: unknown;
  speechSpeed?: unknown;
  wakeWords?: unknown;
  followUpSec?: unknown;
  endPhrases?: unknown;
  wakeReply?: unknown;
  conversationGapMin?: unknown;
  contextTurns?: unknown;
  systemPrompt?: unknown;
  answerLength?: unknown;
}

export type ValidationResult =
  | { ok: true; config: AppConfig }
  | { ok: false; errors: string[] };

/**
 * 管理UIからの入力を検証して次の設定を組み立てる。
 * 保存は行わない（呼び出し側が writeConfig を呼ぶ）。
 *
 * `allowedGeminiModels` は取得済みモデル一覧の ID。呼び出し側が読んで渡す。
 * ここで中から読むこともできるが、
 * 「読む（readConfig）／決める（validatePatch）／書く（writeConfig）」の
 * 3層分離を保ちたいのと、純粋関数のままならテストがファイルに触らずに
 * 済むため、依存は引数で受ける。
 *
 * 一覧が空のときは Gemini のモデルを変更できない。ただし管理UI 側は
 * そもそも select を出さないので、通常この経路には来ない
 * （来るのは option を偽装した送信のとき）。
 */
export function validatePatch(
  current: AppConfig,
  patch: ConfigPatch,
  allowedGeminiModels: readonly string[],
): ValidationResult {
  const errors: string[] = [];

  let provider = current.provider;
  if (patch.provider !== undefined) {
    if (isCloudProvider(patch.provider)) {
      provider = patch.provider;
    } else {
      errors.push("プロバイダの値が不正です。");
    }
  }

  let claudeModel = current.claudeModel;
  if (patch.claudeModel !== undefined) {
    if (isClaudeModel(patch.claudeModel)) {
      claudeModel = patch.claudeModel;
    } else {
      errors.push(
        "Claude モデルの値が不正です。許可されたモデルのみ選択できます。",
      );
    }
  }

  let geminiModel = current.geminiModel;
  if (patch.geminiModel !== undefined) {
    if (
      isModelId(patch.geminiModel) &&
      allowedGeminiModels.includes(patch.geminiModel)
    ) {
      geminiModel = patch.geminiModel;
    } else {
      errors.push(
        "Gemini モデルの値が不正です。取得済みの一覧にあるモデルのみ選択できます。",
      );
    }
  }

  let thinkingLevel = current.thinkingLevel;
  if (patch.thinkingLevel !== undefined) {
    if (isThinkingLevel(patch.thinkingLevel)) {
      thinkingLevel = patch.thinkingLevel;
    } else {
      errors.push("思考レベルの値が不正です。");
    }
  }

  let speechSpeed = current.speechSpeed;
  if (patch.speechSpeed !== undefined) {
    // フォームからは文字列で来るので数値に直してから見る。
    const parsed = Number(patch.speechSpeed);
    if (isSpeechSpeed(parsed)) {
      speechSpeed = parsed;
    } else {
      errors.push("読み上げの速さの値が不正です。");
    }
  }

  let wakeWords = current.wakeWords;
  if (patch.wakeWords !== undefined) {
    // 管理UI からは改行区切りの文字列で来る。
    const list =
      typeof patch.wakeWords === "string"
        ? patch.wakeWords
            .split(/[\n,、]/)
            .map((w) => w.trim())
            .filter((w) => w.length > 0)
        : patch.wakeWords;

    if (isWakeWords(list)) {
      wakeWords = list.map((w) => w.trim());
    } else {
      errors.push(
        `ウェイクワードの値が不正です（${WAKE_WORD_MIN_LENGTH}〜${WAKE_WORD_MAX_LENGTH}文字を ` +
          `${MAX_WAKE_WORDS}個まで、1つ以上）。`,
      );
    }
  }

  let followUpSec = current.followUpSec;
  if (patch.followUpSec !== undefined) {
    const parsed = Number(patch.followUpSec);
    if (isFollowUpSec(parsed)) {
      followUpSec = parsed;
    } else {
      errors.push(`追い質問の秒数の値が不正です（0〜${MAX_FOLLOW_UP_SEC} の整数）。`);
    }
  }

  let endPhrases = current.endPhrases;
  if (patch.endPhrases !== undefined) {
    // 管理UI からは改行区切りの文字列で来る。空にもできる。
    const list =
      typeof patch.endPhrases === "string"
        ? patch.endPhrases
            .split(/[\n,、]/)
            .map((w) => w.trim())
            .filter((w) => w.length > 0)
        : patch.endPhrases;

    if (isEndPhrases(list)) {
      endPhrases = list.map((w) => w.trim());
    } else {
      errors.push(`終了語の値が不正です（2文字以上を ${MAX_END_PHRASES} 個まで）。`);
    }
  }

  let wakeReply = current.wakeReply;
  if (patch.wakeReply !== undefined) {
    if (isWakeReply(patch.wakeReply)) {
      wakeReply = (patch.wakeReply as string).trim();
    } else {
      errors.push(`呼ばれたときの返事が長すぎます（${MAX_WAKE_REPLY_LENGTH}文字以内）。`);
    }
  }

  let conversationGapMin = current.conversationGapMin;
  if (patch.conversationGapMin !== undefined) {
    const parsed = Number(patch.conversationGapMin);
    if (isConversationGapMin(parsed)) {
      conversationGapMin = parsed;
    } else {
      errors.push(
        `会話が切れるまでの分数が不正です（0〜${MAX_CONVERSATION_GAP_MIN} の整数）。`,
      );
    }
  }

  let contextTurns = current.contextTurns;
  if (patch.contextTurns !== undefined) {
    const parsed = Number(patch.contextTurns);
    if (isContextTurns(parsed)) {
      contextTurns = parsed;
    } else {
      errors.push(`覚えておく往復数が不正です（1〜${MAX_CONTEXT_TURNS} の整数）。`);
    }
  }

  let sttModel = current.sttModel;
  if (patch.sttModel !== undefined) {
    if (isSttModel(patch.sttModel)) {
      sttModel = patch.sttModel;
    } else {
      errors.push(
        "音声認識モデルの値が不正です。許可されたモデルのみ選択できます。",
      );
    }
  }

  let systemPrompt = current.systemPrompt;
  if (patch.systemPrompt !== undefined) {
    if (typeof patch.systemPrompt !== "string") {
      errors.push("システムプロンプトの形式が不正です。");
    } else if (patch.systemPrompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
      errors.push(
        `システムプロンプトが長すぎます（${SYSTEM_PROMPT_MAX_LENGTH}文字以内、` +
          `現在 ${patch.systemPrompt.length}文字）。`,
      );
    } else {
      systemPrompt = patch.systemPrompt;
    }
  }

  let answerLength = current.answerLength;
  if (patch.answerLength !== undefined) {
    if (isAnswerLength(patch.answerLength)) {
      answerLength = patch.answerLength;
    } else {
      errors.push("回答の長さの値が不正です。");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      version: current.version + 1,
      provider,
      claudeModel,
      geminiModel,
      thinkingLevel,
      sttModel,
      speechSpeed,
      wakeWords,
      followUpSec,
      endPhrases,
      wakeReply,
      conversationGapMin,
      contextTurns,
      systemPrompt,
      answerLength,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * 設定を書く。
 *
 * 一時ファイルに書いてから rename する。rename は同じファイルシステム上では
 * 不可分なので、途中で落ちても「古い設定」か「新しい設定」のどちらかが
 * 残り、壊れた JSON にはならない。
 */
export function writeConfig(config: AppConfig): void {
  writeJsonAtomic(CONFIG_PATH, config);
}
