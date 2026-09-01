/**
 * 設定の読み込みと検証。
 *
 * 足りない値は **起動時に落とす**。動き始めてから最初のリクエストで
 * 気づくより、起動しないほうが原因が分かりやすい。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdminSecrets } from "./admin/auth.ts";
import { sttVendor, type Runtime } from "./ai/types.ts";
import { readConfig as readSavedConfig } from "./store.ts";
import { resolveSecret } from "./secrets.ts";

export const MODES = ["stub", "live"] as const;
export type Mode = (typeof MODES)[number];

export interface Config {
  mode: Mode;
  host: string;
  port: number;
  /** AI と音声認識の鍵。**ブラウザには決して渡さない。** */
  anthropicApiKey: string;
  geminiApiKey: string;
  /** 音声認識に OpenAI を選んだときだけ要る。 */
  openaiApiKey: string;
  /** ローカルの whisper-server（whisper.cpp）の URL。 */
  whisperUrl: string;
  /** macOS の音声認識を包む ohr サーバーの URL。 */
  appleSpeechUrl: string;
  /** 管理UI のログインパスワード。 */
  adminPassword: string;
  /** ログインセッションの署名鍵。 */
  adminSessionSecret: string;
  /**
   * 上流の差し替え。**テスト用**。本番では未設定にする。
   * 既定が本物になるようにしてあるので、設定漏れでスタブを向くことはない。
   */
  geminiModelsEndpoint: string;
  anthropicBaseUrl?: string;
  geminiBaseUrl?: string;
  voicevoxUrl: string;
  voicevoxSpeaker: number;
  /**
   * 家の消費電力を測っているサーバー（house_power）の URL。
   * 空なら電力について聞かれても答えられない（道具を持たせない）。
   */
  housePowerUrl: string;
  /**
   * 製氷機タンクの水位センサー（water-level）の URL。
   * 空なら水について聞かれても答えられない（道具を持たせない）。
   */
  waterLevelUrl: string;
  stubSaveAudio: boolean;
  stubTranscript: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `.env` を読んで `process.env` に流し込む。
 *
 * dotenv を入れないのは、必要なのが「KEY=VALUE を読む」だけだから。
 * 人が居ない家で無人起動する機械なので、依存は増やさないほうがよい。
 * すでに環境変数にある値は上書きしない（`AICHAT_MODE=live npm start` を効かせるため）。
 */
export function loadDotEnv(path = join(ROOT, ".env")): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // 無くてよい。環境変数だけで動かす道も残す。
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    // 値を引用符で囲む書き方も受ける（トークンに # が入っても切れないように）。
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * 環境変数から設定を組み立てる。矛盾があれば throw する。
 *
 * `env` を引数で受けるのはテストのため（`process.env` を書き換えない）。
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.AICHAT_MODE ?? "stub";
  if (!isMode(mode)) {
    throw new Error(
      `AICHAT_MODE の値が不正です: ${mode}（${MODES.join(" / ")} のいずれか）`,
    );
  }

  // 鍵は .env に直接書く形と、OS の鍵束から読む形の両方を受ける
  // （secrets.ts）。読めなければここで throw して起動を止める。
  const secret = (name: string): string =>
    resolveSecret(name, env[name] ?? "");

  const anthropicApiKey = secret("ANTHROPIC_API_KEY");
  const geminiApiKey = secret("GEMINI_API_KEY");
  const openaiApiKey = secret("OPENAI_API_KEY");
  const adminPassword = secret("ADMIN_PASSWORD");
  const adminSessionSecret = secret("ADMIN_SESSION_SECRET");

  // stub は AI を呼ばないので鍵が要らない。live で欠けていたら、
  // 動かしてから 401 で気づくことになるのでここで止める。
  //
  // OPENAI_API_KEY は要求しない。音声認識に OpenAI を選んだときだけ
  // 必要で、既定の Gemini なら無くてよいため。
  if (mode === "live") {
    if (!anthropicApiKey && !geminiApiKey) {
      throw new Error(
        "AICHAT_MODE=live には ANTHROPIC_API_KEY か GEMINI_API_KEY が要ります。",
      );
    }
    // 管理画面に鍵をかけるかは任意（admin/auth.ts の isLocked）。
    // 鍵をかけるなら、セッションの署名鍵も要る。
    if (adminPassword && !adminSessionSecret) {
      throw new Error(
        "ADMIN_PASSWORD を設定するなら ADMIN_SESSION_SECRET も要ります（openssl rand -base64 32）。",
      );
    }
  }

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT の値が不正です: ${env.PORT}`);
  }

  const voicevoxSpeaker = Number(env.VOICEVOX_SPEAKER ?? 3);
  if (!Number.isInteger(voicevoxSpeaker) || voicevoxSpeaker < 0) {
    throw new Error(`VOICEVOX_SPEAKER の値が不正です: ${env.VOICEVOX_SPEAKER}`);
  }

  return {
    mode,
    host: env.HOST ?? "127.0.0.1",
    port,
    anthropicApiKey,
    geminiApiKey,
    openaiApiKey,
    adminPassword,
    adminSessionSecret,
    geminiModelsEndpoint: env.GEMINI_MODELS_ENDPOINT ?? "",
    // 上流の差し替え。**テスト用**。本番では設定しない。
    // 既定が本物になるので、設定漏れでスタブを向くことはない。
    ...(env.ANTHROPIC_BASE_URL ? { anthropicBaseUrl: env.ANTHROPIC_BASE_URL } : {}),
    ...(env.GEMINI_BASE_URL ? { geminiBaseUrl: env.GEMINI_BASE_URL } : {}),
    whisperUrl: (env.WHISPER_URL ?? "").replace(/\/+$/, ""),
    appleSpeechUrl: (env.APPLE_SPEECH_URL ?? "").replace(/\/+$/, ""),
    voicevoxUrl: (env.VOICEVOX_URL ?? "").replace(/\/+$/, ""),
    housePowerUrl: (env.HOUSE_POWER_URL ?? "").replace(/\/+$/, ""),
    waterLevelUrl: (env.WATER_LEVEL_URL ?? "").replace(/\/+$/, ""),
    voicevoxSpeaker,
    stubSaveAudio: env.STUB_SAVE_AUDIO === "1",
    stubTranscript: env.STUB_TRANSCRIPT ?? "明日の天気を教えて",
  };
}

/**
 * 127.0.0.1 以外で待ち受けるときの警告文。無ければ null。
 *
 * **`/api/*` は認証を持たない。** 届けば誰でも AI を呼べる
 * （＝こちらに課金される）。守りは「そもそも外から届かない」ことだけなので、
 * その前提が崩れたことに気づけるようにしておく。
 * 手元の機械から管理UI を開きたいだけなら、SSH のポート転送を使う。
 *
 * ブラウザ側にも事情がある。`getUserMedia` は secure context でしか
 * 動かず、HTTP で secure context 扱いになるのは localhost / 127.0.0.1 だけ。
 * LAN の IP で開くとマイクがそもそも使えない。
 */
export function bindWarning(host: string): string | null {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return null;
  }
  return (
    `HOST=${host} で待ち受けています。/api/* は認証を持たないので、` +
    "同じネットワークの誰でも AI を呼べます（課金はこちら持ち）。" +
    "またブラウザは localhost 以外の HTTP ではマイクを使えません。" +
    "遠隔から使いたいときは ssh -L 8080:127.0.0.1:8080 を使ってください。"
  );
}

/**
 * 起動時に伝えておきたいこと。止めるほどではないもの。
 *
 * 管理パスワードが空だと `/admin` は誰も開けない（照合が必ず外れる）。
 * 設定を変えようとした時点で気づくより、起動時に言うほうが早い。
 */
export function startupNotes(config: Config): string[] {
  const notes: string[] = [];

  if (config.mode === "live") {
    // **選ばれている経路の鍵**があるかを見る。
    // 「どちらか一方があればよい」で通してしまうと、Gemini の鍵だけ入れて
    // 設定は Claude のまま、という状態で起動でき、最初の質問で 401 になる。
    const saved = readSavedConfig();
    const needed = saved.provider === "claude" ? "ANTHROPIC" : "GEMINI";
    const have =
      saved.provider === "claude" ? config.anthropicApiKey : config.geminiApiKey;

    if (!have) {
      notes.push(
        `設定は「${saved.provider}」ですが ${needed}_API_KEY がありません。` +
          `質問しても認証エラーになります。鍵を入れるか、/admin で経路を変えてください。`,
      );
    }

    const stt = sttVendor(saved.sttModel);
    const sttUrl =
      stt === "apple" ? config.appleSpeechUrl : stt === "local" ? config.whisperUrl : "-";
    if (sttUrl === "") {
      notes.push(
        `音声認識は「${saved.sttModel}」ですが接続先が設定されていません。` +
          "/admin で切り替えるか、.env の URL を設定してください。",
      );
    }
  }

  // 鍵をかけないこと自体は意図した使い方なので何も言わない
  // （127.0.0.1 でしか待ち受けず、外から届かないため）。
  // ただし **外に開いたうえで鍵も無い** のは事故なので、そこだけ伝える。
  if (!config.adminPassword && bindWarning(config.host) !== null) {
    notes.push(
      `管理画面に鍵が無いまま ${config.host} で待ち受けています。` +
        "同じネットワークの誰でも設定を書き換えられます。",
    );
  }
  if (config.adminPassword && !config.adminSessionSecret) {
    notes.push(
      "ADMIN_SESSION_SECRET が空なので、/admin にログインできません。" +
        "（openssl rand -base64 32 で作って .env に書いてください）",
    );
  }
  if (config.mode === "live" && !config.voicevoxUrl) {
    notes.push(
      "VOICEVOX_URL が空なので読み上げができません。画面に文字だけが出ます。",
    );
  }
  return notes;
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

/**
 * AI を呼ぶ側（ai/*.ts）に渡すもの。
 *
 * Config から鍵だけを抜き出した形。上流を呼ぶコードに、
 * 待ち受けアドレスや読み上げの設定まで見せる必要は無い。
 */
export function runtimeFrom(config: Config): Runtime {
  return {
    anthropicApiKey: config.anthropicApiKey,
    geminiApiKey: config.geminiApiKey,
    openaiApiKey: config.openaiApiKey,
    whisperUrl: config.whisperUrl,
    appleSpeechUrl: config.appleSpeechUrl,
    ...(config.geminiModelsEndpoint
      ? { geminiModelsEndpoint: config.geminiModelsEndpoint }
      : {}),
    ...(config.anthropicBaseUrl ? { anthropicBaseUrl: config.anthropicBaseUrl } : {}),
    ...(config.geminiBaseUrl ? { geminiBaseUrl: config.geminiBaseUrl } : {}),
  };
}

/** 管理UI に渡す秘密。 */
export function adminSecretsFrom(config: Config): AdminSecrets {
  return {
    adminPassword: config.adminPassword,
    adminSessionSecret: config.adminSessionSecret,
  };
}
