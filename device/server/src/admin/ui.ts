/**
 * 管理UI。素の HTML をサーバーサイドレンダリングする（外部依存なし）。
 *
 * ここで設定した内容が全端末に適用される。家族の端末側からは変更できない。
 */

import {
  type AdminSecrets,
  clearSessionCookie,
  isLocked,
  createSessionCookie,
  verifyAdminPassword,
  verifyAdminSession,
  verifySameOrigin,
} from "./auth.ts";
import { readConfig, validatePatch, writeConfig } from "../store.ts";
import {
  fetchGeminiModels,
  readGeminiCatalog,
  writeGeminiCatalog,
} from "../ai/gemini-models.ts";
import { escapeHtml, htmlResponse, redirect } from "../http.ts";
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_LABELS,
  ANSWER_LENGTHS,
  ANSWER_LENGTH_LABELS,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  MAX_END_PHRASES,
  MAX_FOLLOW_UP_SEC,
  MAX_WAKE_REPLY_LENGTH,
  MAX_WAKE_WORDS,
  SPEECH_SPEEDS,
  STT_MODELS,
  STT_MODEL_LABELS,
  SYSTEM_PROMPT_MAX_LENGTH,
  type AppConfig,
  type CloudProvider,
  type Runtime,
  type GeminiModelCatalog,
} from "../ai/types.ts";

/**
 * 使う AI の選択肢。
 *
 * 本家 AIChat にあった「自動」「端末内のみ」は無い。据え置きデバイスに
 * 端末内モデルは無く、選べてしまうとその瞬間にデバイスが黙るため。
 */
/** 管理UI が要るもの。 */
export interface AdminDeps {
  secrets: AdminSecrets;
  runtime: Runtime;
}

const PROVIDER_LABELS: Record<CloudProvider, { title: string; description: string }> = {
  claude: {
    title: "Claude",
    description: "常に Claude を使う。音声で読み上げる前提なら Haiku が速い。",
  },
  gemini: {
    title: "Gemini",
    description:
      "常に Gemini を使う。Flash 系は安価で高速。検索を伴うと出典が付く。",
  },
};

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
    line-height: 1.6; margin: 0; padding: 2rem 1rem;
    background: #f6f6f7; color: #1a1a1a;
  }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: #666; font-size: .85rem; margin: 0 0 1.5rem; }
  .card {
    background: #fff; border: 1px solid #e2e2e4; border-radius: 12px;
    padding: 1.25rem; margin-bottom: 1rem;
  }
  fieldset { border: none; margin: 0 0 1.5rem; padding: 0; }
  legend { font-weight: 600; font-size: .95rem; padding: 0; margin-bottom: .5rem; }
  label { display: block; }
  .radio {
    display: flex; gap: .6rem; align-items: flex-start;
    padding: .6rem; border: 1px solid #e2e2e4; border-radius: 8px; margin-bottom: .4rem;
    cursor: pointer;
  }
  .radio:hover { background: #fafafa; }
  .radio input { margin-top: .3rem; }
  .radio .t { font-weight: 600; }
  .radio .d { color: #666; font-size: .82rem; }
  select, input[type=number], input[type=password], textarea {
    width: 100%; padding: .55rem .65rem; font: inherit;
    border: 1px solid #ccc; border-radius: 8px; background: #fff; color: inherit;
  }
  textarea { min-height: 9rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .hint { color: #666; font-size: .8rem; margin-top: .3rem; }
  button {
    font: inherit; font-weight: 600; padding: .6rem 1.4rem; border: none;
    border-radius: 8px; background: #1a1a1a; color: #fff; cursor: pointer;
  }
  button:hover { background: #333; }
  button.secondary { background: transparent; color: #666; border: 1px solid #ccc; padding: .4rem 1rem; font-weight: 400; }
  .banner { padding: .7rem .9rem; border-radius: 8px; margin-bottom: 1rem; font-size: .88rem; }
  .banner.ok { background: #e7f6ec; color: #14532d; }
  .banner.err { background: #fdeaea; color: #7f1d1d; }
  .banner ul { margin: .3rem 0 0; padding-left: 1.2rem; }
  /* fieldset 内の注意書き。ページ上部の .banner とは別物
     （テストや読み手が「保存エラー」と取り違えないよう class を分ける）。 */
  .notice { padding: .6rem .8rem; border-radius: 8px; font-size: .82rem;
            background: #fdeaea; color: #7f1d1d; }
  .meta { display: flex; gap: 1.5rem; flex-wrap: wrap; color: #666; font-size: .8rem; }
  .meta b { color: #1a1a1a; font-weight: 600; }
  .footer { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #161618; color: #e8e8ea; }
    .card { background: #1f1f22; border-color: #333; }
    .radio { border-color: #333; }
    .radio:hover { background: #26262a; }
    select, input, textarea { background: #161618; border-color: #444; }
    .sub, .hint, .radio .d, .meta { color: #999; }
    .radio .t, .meta b { color: #e8e8ea; }
    button { background: #e8e8ea; color: #161618; }
    button:hover { background: #fff; }
    button.secondary { background: transparent; color: #999; border-color: #444; }
    .banner.ok { background: #14311f; color: #a7e8bf; }
    .banner.err { background: #3a1a1a; color: #f5a9a9; }
    .notice { background: #3a1a1a; color: #f5a9a9; }
  }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function loginPage(error?: string): string {
  const banner = error
    ? `<div class="banner err">${escapeHtml(error)}</div>`
    : "";
  return page(
    "AIChat Device 管理 — ログイン",
    `<h1>AIChat Device 管理</h1>
     <p class="sub">管理者パスワードでログインしてください。</p>
     <div class="card">
       ${banner}
       <form method="post" action="/admin/login">
         <label>
           <span style="font-weight:600;font-size:.9rem">管理者パスワード</span>
           <input type="password" name="password" autocomplete="current-password"
                  required autofocus style="margin-top:.4rem">
         </label>
         <div style="margin-top:1rem"><button type="submit">ログイン</button></div>
       </form>
     </div>`,
  );
}

function formatTimestamp(iso: string): string {
  if (iso === "1970-01-01T00:00:00.000Z") return "未設定（既定値を使用中）";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(date) + " (JST)";
}

interface Banner {
  kind: "ok" | "err";
  messages: string[];
}

/**
 * Gemini のモデル欄。
 *
 * 一覧をまだ取得できていないときは select を **出さない**。
 * 出さなければ form に geminiModel が含まれず、validatePatch の分岐が
 * 飛んで現在値が保たれる。Gemini の一覧が取れないことを理由に
 * 他の設定（プロバイダの切り替えなど）まで保存できなくなるのは困る
 * ——Gemini が落ちているときこそ Claude へ逃げたいので。
 */
function geminiFieldset(
  config: AppConfig,
  catalog: GeminiModelCatalog | null,
): string {
  if (!catalog || catalog.models.length === 0) {
    return `<fieldset>
           <legend>Gemini のモデル</legend>
           <div class="notice">モデル一覧をまだ取得できていません。下の「一覧を更新」で取得してください。取得できるまで Gemini のモデルは変更できません（他の設定は保存できます）。</div>
           <p class="hint">現在の設定: <b>${escapeHtml(config.geminiModel)}</b></p>
         </fieldset>`;
  }

  const known = catalog.models.some((m) => m.id === config.geminiModel);

  // 現在の設定が一覧に無い場合、そのための option を足す。
  // 無いとブラウザが黙って先頭を選び、意図しないモデル変更が
  // 保存されてしまう。
  const missingOption = known
    ? ""
    : `<option value="${escapeHtml(config.geminiModel)}" selected>${escapeHtml(config.geminiModel)}（現在の設定。一覧に無し）</option>`;

  const options = catalog.models
    .map((model) => {
      const selected = config.geminiModel === model.id ? " selected" : "";
      // displayName だけだと preview 同士で見分けが付かないことがある。
      // 課金対象は ID のほうなので併記する。
      const label = `${model.displayName} — ${model.id}`;
      return `<option value="${escapeHtml(model.id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const staleNote = known
    ? ""
    : `<p class="hint">現在の設定 <b>${escapeHtml(config.geminiModel)}</b> は取得した一覧にありません。一覧にあるモデルを選び直してください。</p>`;

  return `<fieldset>
           <legend>Gemini のモデル</legend>
           <select name="geminiModel">${missingOption}${options}</select>
           <p class="hint">Gemini を使うときのモデル。一覧は Gemini API から取得したチャット用のモデルです（${escapeHtml(formatTimestamp(catalog.fetchedAt))} 時点・${catalog.models.length}件）。画像生成・音声合成などチャット以外の用途のモデルは除いています。</p>
           ${staleNote}
         </fieldset>`;
}

function settingsPage(
  config: AppConfig,
  catalog: GeminiModelCatalog | null,
  banner?: Banner,
): string {
  const providerFields = (Object.keys(PROVIDER_LABELS) as CloudProvider[])
    .map((key) => {
      const { title, description } = PROVIDER_LABELS[key];
      const checked = config.provider === key ? " checked" : "";
      return `<label class="radio">
        <input type="radio" name="provider" value="${key}"${checked}>
        <span><span class="t">${escapeHtml(title)}</span><br>
        <span class="d">${escapeHtml(description)}</span></span>
      </label>`;
    })
    .join("");

  const claudeOptions = CLAUDE_MODELS.map((model) => {
    const selected = config.claudeModel === model ? " selected" : "";
    return `<option value="${model}"${selected}>${escapeHtml(CLAUDE_MODEL_LABELS[model])}</option>`;
  }).join("");

  const lengthOptions = ANSWER_LENGTHS.map((length) => {
    const selected = config.answerLength === length ? " selected" : "";
    return `<option value="${length}"${selected}>${escapeHtml(ANSWER_LENGTH_LABELS[length])}</option>`;
  }).join("");

  const thinkingOptions = THINKING_LEVELS.map((level) => {
    const selected = config.thinkingLevel === level ? " selected" : "";
    return `<option value="${level}"${selected}>${escapeHtml(THINKING_LEVEL_LABELS[level])}</option>`;
  }).join("");

  const speedOptions = SPEECH_SPEEDS.map((speed) => {
    const selected = config.speechSpeed === speed ? " selected" : "";
    const note =
      speed === 1.0 ? "（VOICEVOX の既定）" : speed === 1.5 ? "（推奨）" : "";
    return `<option value="${speed}"${selected}>${Math.round(speed * 100)}%${note}</option>`;
  }).join("");

  const sttOptions = STT_MODELS.map((model) => {
    const selected = config.sttModel === model ? " selected" : "";
    return `<option value="${model}"${selected}>${escapeHtml(STT_MODEL_LABELS[model])}</option>`;
  }).join("");

  const bannerHtml = banner
    ? `<div class="banner ${banner.kind}">${
        banner.messages.length === 1
          ? escapeHtml(banner.messages[0] as string)
          : `<ul>${banner.messages.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`
      }</div>`
    : "";

  return page(
    "AIChat Device 管理",
    `<h1>AIChat Device 管理</h1>
     <p class="sub">ここでの設定が据え置きデバイスに適用されます。デバイス側からは変更できません。</p>
     ${bannerHtml}
     <form method="post" action="/admin/config">
       <div class="card">
         <fieldset>
           <legend>使用するAI</legend>
           ${providerFields}
         </fieldset>

         <fieldset>
           <legend>Claude のモデル</legend>
           <select name="claudeModel">${claudeOptions}</select>
           <p class="hint">Claude を使うときのモデル。価格は入力 / 出力の 100万トークンあたり。</p>
         </fieldset>

         ${geminiFieldset(config, catalog)}

         <fieldset>
           <legend>Gemini の思考レベル</legend>
           <select name="thinkingLevel">${thinkingOptions}</select>
           <p class="hint">答える前にどれだけ考えるか。深いほど遅く、高コストになります。思考に使う分は自動で上乗せされるので、回答の長さが削られることはありません。Claude には影響しません。<strong>モデルによっては特定の段を受け付けません</strong>（例: gemini-flash-latest は「最小」を拒否します）。保存後に質問が失敗したら、ここを一段上げてください。</p>
         </fieldset>

         <fieldset>
           <legend>システムプロンプト</legend>
           <textarea name="systemPrompt" maxlength="${SYSTEM_PROMPT_MAX_LENGTH}"
             placeholder="例: あなたは親切なアシスタントです。専門用語は避け、わかりやすく答えてください。"
           >${escapeHtml(config.systemPrompt)}</textarea>
           <p class="hint">Claude・Gemini の両方に同じ内容が適用されます（${SYSTEM_PROMPT_MAX_LENGTH}文字以内）。空欄でも構いません。回答は音声で読み上げられるので、箇条書きや記号を避けるよう書いておくと聞きやすくなります。</p>
         </fieldset>

         <fieldset>
           <legend>回答の長さ</legend>
           <select name="answerLength">${lengthOptions}</select>
           <p class="hint">回答が途中で切れる場合は長くしてください。必要なトークン数は思考レベルと併せて自動で決まります。読み上げる前提なら「短め」が扱いやすいです。</p>
         </fieldset>

         <fieldset>
           <legend>ウェイクワード</legend>
           <textarea name="wakeWords" rows="3"
             placeholder="ずんだもん&#10;すんだもん">${escapeHtml(config.wakeWords.join("\n"))}</textarea>
           <p class="hint">
             1行に1つ、${MAX_WAKE_WORDS}個まで。書き起こしにこのどれかが出たら起動します。
             <strong>音声認識が実際に出す文字列で書いてください。</strong>
             同じ発話でも濁点が落ちることがあるため（「ずんだもん」→「すんだもん」）、
             聞こえ方の候補を並べておくと取りこぼしが減ります。
             「ねえ」で始まる語は実在語に寄せられて認識されません
             （「ねえアイチャット」→「恋愛チャット」）。
           </p>
         </fieldset>

         <fieldset>
           <legend>追い質問</legend>
           <label class="radio" style="display:block">
             <input type="number" name="followUpSec" min="0" max="${MAX_FOLLOW_UP_SEC}"
               value="${config.followUpSec}" style="width:5rem"> 秒
           </label>
           <p class="hint">
             回答のあと、この秒数はウェイクワード無しで続けて話せます。
             <strong>0 にすると毎回ウェイクワードが要ります。</strong>
             窓が開いている間は部屋の話し声を拾って AI に投げてしまうので、
             誤って反応するのが気になるときは 0 にしてください。
           </p>
         </fieldset>

         <fieldset>
           <legend>呼ばれたときの返事</legend>
           <input type="text" name="wakeReply" value="${escapeHtml(config.wakeReply)}"
             maxlength="${MAX_WAKE_REPLY_LENGTH}" placeholder="はい？"
             style="width:100%;padding:.6rem;border-radius:8px;border:1px solid #d5d5d8">
           <p class="hint">
             名前を呼ばれただけで質問が続かなかったときに、これを読み上げて待ちます。
             <strong>AI は呼ばないので費用はかかりません。</strong>
             空にすると、返事をせずに黙って待ちます。
           </p>
         </fieldset>

         <fieldset>
           <legend>会話を終える語</legend>
           <textarea name="endPhrases" rows="2"
             placeholder="ありがとう&#10;おわり">${escapeHtml(config.endPhrases.join("\n"))}</textarea>
           <p class="hint">
             1行に1つ、${MAX_END_PHRASES}個まで。これが聞こえたら会話を終えます。
             空にもできます。<strong>「ありがとう」は会話の途中にも出る</strong>ので、
             意図せず終わるようなら減らしてください。
           </p>
         </fieldset>

         <fieldset>
           <legend>読み上げの速さ</legend>
           <select name="speechSpeed">${speedOptions}</select>
           <p class="hint">声の高さは変えずに話す速さだけを変えます（VOICEVOX の speedScale）。据え置きのデバイスは待たされる感じが出やすいので、既定より速めにしてあります。</p>
         </fieldset>

         <fieldset style="margin-bottom:0">
           <legend>音声認識のモデル</legend>
           <select name="sttModel">${sttOptions}</select>
           <p class="hint">デバイスのマイクで拾った音声を文字にするモデル（Workers AI）。日本語の聞き取りが弱いと感じたら切り替えてください。</p>
         </fieldset>
       </div>

       <div class="card footer">
         <div class="meta">
           <span>設定バージョン <b>${config.version}</b></span>
           <span>最終更新 <b>${escapeHtml(formatTimestamp(config.updatedAt))}</b></span>
         </div>
         <button type="submit">保存する</button>
       </div>
     </form>

     <form method="post" action="/admin/gemini-models">
       <div class="card">
         <fieldset style="margin-bottom:0">
           <legend>Gemini のモデル一覧</legend>
           <p class="hint">Gemini API から最新のモデル一覧を取り込みます。新しいモデルが出たときはこれを押してください。保存していない変更は失われます。</p>
           <button type="submit" class="secondary">一覧を更新</button>
         </fieldset>
       </div>
     </form>

     <form method="post" action="/admin/logout" style="text-align:right">
       <button type="submit" class="secondary">ログアウト</button>
     </form>`,
  );
}

export async function handleAdminRoot(
  request: Request,
  deps: AdminDeps,
): Promise<Response> {
  if (isLocked(deps.secrets) && !(await verifyAdminSession(request, deps.secrets))) {
    return htmlResponse(loginPage(), { status: 401 });
  }

  const config = readConfig();
  const catalog = readGeminiCatalog();

  const url = new URL(request.url);
  // PRG パターンのリダイレクト後に結果を表示する。
  let banner: Banner | undefined;
  if (url.searchParams.get("saved") === "1") {
    banner = { kind: "ok", messages: ["設定を保存しました。"] };
  } else if (url.searchParams.get("models") === "1") {
    const count = catalog?.models.length ?? 0;
    banner = {
      kind: "ok",
      messages: [`モデル一覧を更新しました（${count}件）。`],
    };
  }

  return htmlResponse(settingsPage(config, catalog, banner));
}

export async function handleAdminLogin(
  request: Request,
  deps: AdminDeps,
): Promise<Response> {
  if (!verifySameOrigin(request)) {
    return htmlResponse(loginPage("不正なリクエストです。"), { status: 403 });
  }

  const form = await request.formData();
  const password = form.get("password");

  if (typeof password !== "string" || !verifyAdminPassword(password, deps.secrets)) {
    return htmlResponse(loginPage("パスワードが違います。"), { status: 401 });
  }

  return redirect("/admin", {
    "Set-Cookie": await createSessionCookie(request, deps.secrets),
  });
}

export function handleAdminLogout(request: Request): Response {
  if (!verifySameOrigin(request)) {
    return htmlResponse(loginPage("不正なリクエストです。"), { status: 403 });
  }
  return redirect("/admin", { "Set-Cookie": clearSessionCookie(request) });
}

export async function handleAdminConfigUpdate(
  request: Request,
  deps: AdminDeps,
): Promise<Response> {
  if (isLocked(deps.secrets) && !(await verifyAdminSession(request, deps.secrets))) {
    return htmlResponse(loginPage("セッションが切れました。再度ログインしてください。"), {
      status: 401,
    });
  }
  if (!verifySameOrigin(request)) {
    return htmlResponse(loginPage("不正なリクエストです。"), { status: 403 });
  }

  const form = await request.formData();
  const current = readConfig();
  const catalog = readGeminiCatalog();

  const result = validatePatch(
    current,
    {
      provider: form.get("provider") ?? undefined,
      claudeModel: form.get("claudeModel") ?? undefined,
      geminiModel: form.get("geminiModel") ?? undefined,
      thinkingLevel: form.get("thinkingLevel") ?? undefined,
      sttModel: form.get("sttModel") ?? undefined,
      speechSpeed: form.get("speechSpeed") ?? undefined,
      wakeWords: form.get("wakeWords") ?? undefined,
      followUpSec: form.get("followUpSec") ?? undefined,
      endPhrases: form.get("endPhrases") ?? undefined,
      wakeReply: form.get("wakeReply") ?? undefined,
      systemPrompt: form.get("systemPrompt") ?? undefined,
      answerLength: form.get("answerLength") ?? undefined,
    },
    catalog?.models.map((m) => m.id) ?? [],
  );

  if (!result.ok) {
    return htmlResponse(
      settingsPage(current, catalog, { kind: "err", messages: result.errors }),
      { status: 400 },
    );
  }

  writeConfig(result.config);

  // PRG: リロードでの二重送信を防ぐ。
  return redirect("/admin?saved=1");
}

/**
 * 「一覧を更新」。Gemini API からモデル一覧を取り込んで KV に保存する。
 *
 * 失敗しても KV の前回分は消さない。一時的なネットワーク障害で
 * 選択肢を失うほうが困るため。エラーは画面に出す。
 */
export async function handleAdminGeminiModelsRefresh(
  request: Request,
  deps: AdminDeps,
): Promise<Response> {
  if (isLocked(deps.secrets) && !(await verifyAdminSession(request, deps.secrets))) {
    return htmlResponse(loginPage("セッションが切れました。再度ログインしてください。"), {
      status: 401,
    });
  }
  if (!verifySameOrigin(request)) {
    return htmlResponse(loginPage("不正なリクエストです。"), { status: 403 });
  }

  const result = await fetchGeminiModels(deps.runtime);

  if (!result.ok) {
    const config = readConfig();
    const catalog = readGeminiCatalog();
    return htmlResponse(
      settingsPage(config, catalog, { kind: "err", messages: [result.error] }),
      { status: 502 },
    );
  }

  writeGeminiCatalog({
    models: result.models,
    fetchedAt: new Date().toISOString(),
  });

  // PRG: リロードでの再取得を防ぐ。
  return redirect("/admin?models=1");
}
