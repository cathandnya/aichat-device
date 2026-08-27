/**
 * Gemini のモデル一覧。管理UI の「一覧を更新」からのみ取得し、
 * `data/gemini-models.json` に保存する（もとは KV に置いていた）。
 *
 * 自動更新はしない。上流の一覧が一時的に短く返っただけで、管理者が選んだ
 * モデルが黙って別物に置き換わるのを避けるため、取得は明示的な操作に限る。
 */

import { dataPath, readJsonSafe, writeJsonAtomic } from "../data.ts";

import { isModelId, type GeminiModelCatalog, type GeminiModelInfo, type Runtime } from "./types.ts";

const CATALOG_PATH = dataPath("gemini-models.json");

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** 1ページあたりの件数。API の上限は 1000。 */
const PAGE_SIZE = 1000;

/**
 * ページングの暴走止め。
 * 1000件 × 5 で足りないことはまずないが、nextPageToken が同じ値を
 * 返し続けるような上流の異常で無限ループにならないようにする。
 */
const MAX_PAGES = 5;

/** 上流が固まったときに管理画面ごと待たせないための上限。 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 取得先。既定は本物の API。
 *
 * e2e テストではローカルのスタブを指すために差し替える。
 * **未設定なら必ず本物の URL** になるようにしておく
 * （設定漏れで本番が意図せずスタブを向くことがないように）。
 */
function endpointFor(runtime: Runtime): string {
  const override = runtime.geminiModelsEndpoint;
  return typeof override === "string" && override.length > 0
    ? override
    : DEFAULT_ENDPOINT;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * チャットに使えない用途のモデルを落とすための語。
 *
 * `generateContent` に対応していても、実際にはチャット用ではないものが
 * 多く混ざる（画像生成の Nano Banana 系、音声合成、ロボティクス、
 * 画面操作、動画理解の EAP など）。管理者が誤って選ぶと、
 * 応答の形が違ったり想定外の課金になったりする。
 *
 * ID に現れる語で落とす。displayName は表記揺れが大きく当てにならない。
 */
const EXCLUDED_PURPOSES = [
  "image", // Nano Banana 系（画像生成）
  "tts", // 音声合成
  "robotics", // ロボティクス
  "computer-use", // 画面操作
  "video-understanding", // 動画理解
  "eap", // Early Access Program（[Confidential] 付きで出てくる）
  "customtools", // ツール定義が前提の派生版
  "omni", // 動画生成つきの派生版
] as const;

/**
 * チャット用の Gemini モデルか。
 *
 * `gemini-` で始まるものに限る。gemma / lyria / deep-research /
 * antigravity / nano-banana といった別系統は落とす。
 * そのうえで上の用途語を含むものを除く。
 *
 * 一覧が長すぎて選びにくいという実際の問題への対処なので、
 * 判定は「迷ったら落とす」側に倒している。落としすぎた場合は
 * ここに手を入れる。
 */
function isChatModel(id: string): boolean {
  if (!id.startsWith("gemini-")) return false;

  // "-image" や "image-" のように語として現れる場合だけ落とす。
  // 単純な includes だと将来 "imagine" のような語を巻き込む。
  const words = id.split("-");
  return !EXCLUDED_PURPOSES.some((purpose) =>
    purpose.includes("-")
      ? id.includes(purpose)
      : words.includes(purpose),
  );
}

/**
 * models.list の1ページ分の生 JSON を GeminiModelInfo[] に落とす。
 *
 * - `generateContent` を持つものだけ残す。埋め込み・TTS・動画生成などは
 *   ここで落ちる
 * - `name` は "models/gemini-3.6-flash" の形で来るので接頭辞を剥がす。
 *   剥がした結果が ID として不正なものは捨てる（URL に埋め込まれるため）
 * - 壊れた要素は例外にせず黙って捨てる。1件の破損で一覧全体を失わない
 *
 * 純粋関数。テストから直接呼ぶので export している。
 */
export function parseModelPage(payload: unknown): GeminiModelInfo[] {
  if (!payload || typeof payload !== "object") return [];

  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  const result: GeminiModelInfo[] = [];

  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;

    const raw = entry as Record<string, unknown>;

    // チャットに使えるものだけ。ここが唯一の絞り込み条件。
    const methods = raw.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.includes("generateContent")) {
      continue;
    }

    if (typeof raw.name !== "string") continue;
    const id = raw.name.startsWith("models/")
      ? raw.name.slice("models/".length)
      : raw.name;

    // URL に埋め込む値なので、ここを通らないものは持ち込まない。
    if (!isModelId(id)) continue;

    // チャット用の Gemini だけに絞る。
    if (!isChatModel(id)) continue;

    const displayName =
      typeof raw.displayName === "string" && raw.displayName.trim()
        ? raw.displayName.trim()
        : id;

    result.push({
      id,
      displayName,
      inputTokenLimit: toFiniteNumber(raw.inputTokenLimit),
      outputTokenLimit: toFiniteNumber(raw.outputTokenLimit),
    });
  }

  return result;
}

/**
 * 表示順を整える。新しい世代を上に出したいので id の降順にする。
 *
 * "gemini-3.6-flash" > "gemini-3.5-flash" のような素直な文字列比較で
 * おおむね期待どおりの順になる。厳密な世代解釈はしない。
 */
export function sortModels(models: GeminiModelInfo[]): GeminiModelInfo[] {
  return [...models].sort((a, b) => b.id.localeCompare(a.id));
}

export type FetchModelsResult =
  | { ok: true; models: GeminiModelInfo[] }
  | { ok: false; error: string };

/**
 * 上流から全ページを取得する。
 *
 * 失敗は例外ではなく文言で返す。管理UI にそのまま出して、
 * 管理者が次に何をすればよいか分かるようにするため。
 */
export async function fetchGeminiModels(runtime: Runtime): Promise<FetchModelsResult> {
  if (!runtime.geminiApiKey) {
    return {
      ok: false,
      error:
        "GEMINI_API_KEY が設定されていません。device/server/.env に書いてください。",
    };
  }

  const endpoint = endpointFor(runtime);
  const collected: GeminiModelInfo[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(endpoint);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        // キーは x-goog-api-key ヘッダで渡す。?key= だと URL にキーが載り、
        // Cloudflare Traces の url.full や例外メッセージ経由で漏れる
        // （chat.ts の callGemini と同じ方針）。
        headers: { "x-goog-api-key": runtime.geminiApiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      // 例外オブジェクトを丸ごと出さない。URL が含まれると
      // 認証情報が漏れる経路になりうる（chat.ts と同じ方針）。
      const name = error instanceof Error ? error.name : "unknown";
      console.error("gemini models fetch failed", name);
      return {
        ok: false,
        error:
          name === "TimeoutError"
            ? "モデル一覧の取得がタイムアウトしました。時間をおいて再度お試しください。"
            : "モデル一覧の取得に失敗しました。ネットワークを確認してください。",
      };
    }

    if (!response.ok) {
      // 上流の本文はそのまま出さない（キーの断片や内部情報が入りうる）。
      const detail = await response.text().catch(() => "");
      console.error("gemini models error", response.status, detail.slice(0, 200));
      return { ok: false, error: modelsErrorMessage(response.status) };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        error: "モデル一覧の応答を解釈できませんでした。",
      };
    }

    collected.push(...parseModelPage(payload));

    const next = (payload as { nextPageToken?: unknown }).nextPageToken;
    if (typeof next !== "string" || !next) break;
    pageToken = next;
  }

  // 空の一覧は「壊れている」のと区別できない。保存すると選択肢が
  // 無い <select> ができ、以後モデルを変更できなくなる。
  if (collected.length === 0) {
    return {
      ok: false,
      error:
        "generateContent に対応するモデルが1件も返りませんでした。APIキーの権限を確認してください。",
    };
  }

  return { ok: true, models: sortModels(collected) };
}

function modelsErrorMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "APIキーが拒否されました。GEMINI_API_KEY の値と権限を確認してください。";
  }
  if (status === 429) {
    return "APIの利用制限に達しました。しばらく待ってから再度お試しください。";
  }
  if (status >= 500) {
    return "Google 側が一時的に応答できません。時間をおいて再度お試しください。";
  }
  return `モデル一覧の取得に失敗しました（HTTP ${status}）。`;
}

/** 取得済みの一覧を読む。無い／壊れていれば null。 */
export function readGeminiCatalog(): GeminiModelCatalog | null {
  const stored = readJsonSafe(CATALOG_PATH);

  if (!stored || typeof stored !== "object") return null;

  const raw = stored as Record<string, unknown>;
  if (!Array.isArray(raw.models)) return null;

  // 保存時に検証済みだが、ファイルを手で書き換えられた場合に備えて形は見る。
  const models = raw.models.filter(
    (m): m is GeminiModelInfo =>
      !!m &&
      typeof m === "object" &&
      isModelId((m as GeminiModelInfo).id) &&
      typeof (m as GeminiModelInfo).displayName === "string",
  );

  if (models.length === 0) return null;

  return {
    models,
    fetchedAt:
      typeof raw.fetchedAt === "string" ? raw.fetchedAt : "1970-01-01T00:00:00.000Z",
  };
}

export function writeGeminiCatalog(catalog: GeminiModelCatalog): void {
  writeJsonAtomic(CATALOG_PATH, catalog);
}
