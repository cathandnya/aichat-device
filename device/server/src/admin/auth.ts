/**
 * 認証まわり。
 *
 * - アプリ向け: 家族共通の Bearer トークン
 * - 管理UI向け: 管理者パスワード + HMAC 署名付き Cookie セッション
 */

/**
 * 管理UI の認証に要るもの。
 *
 * もとは Worker の Env（シークレット）から来ていた。
 */
export interface AdminSecrets {
  /** 空なら管理画面に鍵をかけない（下の `isLocked` を参照）。 */
  adminPassword: string;
  adminSessionSecret: string;
}

/**
 * 管理画面に鍵をかけるか。
 *
 * `ADMIN_PASSWORD` が空なら鍵をかけない。**これは意図した動作。**
 *
 * このサーバーは 127.0.0.1 でしか待ち受けず、そもそも外から届かない。
 * さらに `/api/chat` は元から無認証なので、仮に LAN へ開いたなら
 * パスワードの有無に関わらず AI を呼ばれる。**防御線は待ち受けアドレス
 * であって、管理画面のパスワードではない。**
 * 家庭内の1台に毎回パスワードを打たせる意味が薄いので、任意にしている。
 *
 * ただし `verifySameOrigin` は鍵の有無に関わらず必ず通す。
 * これが無いと、家族が見ている無関係な Web ページから
 * `localhost:8080` へ設定変更を送り込める。
 */
export function isLocked(secrets: AdminSecrets): boolean {
  return secrets.adminPassword.length > 0;
}

const SESSION_COOKIE_NAME = "aichat_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日

const encoder = new TextEncoder();

/**
 * タイミング安全な文字列比較。
 *
 * 素の `a === b` は不一致バイトを見つけた時点で打ち切るため、
 * 応答時間からトークンを1バイトずつ推測される余地がある。
 * ここでは長さを先に確認したうえで、全バイトを XOR で走査する。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // 長さが違う時点で不一致だが、早期 return せず
  // 固定長のダミー比較を行って処理時間を揃える。
  const length = aBytes.length;
  const compare = aBytes.length === bBytes.length ? bBytes : aBytes;

  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] as number) ^ (compare[i] as number);
  }
  return diff === 0;
}

/*
 * 家族共通の合鍵（SHARED_ACCESS_TOKEN）による認証はここには無い。
 *
 * Worker を挟んでいた頃は、デバイスが外のサーバーを叩くための合鍵が
 * 要った。いまは画面もこのサーバーが配っていて、127.0.0.1 でしか
 * 待ち受けないので、届く時点で「この機械の上のブラウザ」だと分かる。
 *
 * **裏を返すと、LAN に開くと無認証の API になる。** config.ts の
 * bindWarning がそれを警告する。
 */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return toBase64Url(signature);
}

/**
 * Cookie に `Secure` を付けるべきか判定する。
 *
 * `Secure` 付き Cookie はブラウザが HTTPS でしか保存しないため、
 * `http://127.0.0.1` で開く通常の運用では付けてはいけない（ログインできなくなる）。
 * リバースプロキシで HTTPS にした場合のために判定は残してある。
 */
function isSecureContext(request: Request): boolean {
  // リバースプロキシを挟んだ場合、TLS 終端の情報がこのヘッダに入る。
  const forwardedProto = request.headers.get("X-Forwarded-Proto");
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim() === "https";

  // ローカル判定は Host を優先する（request.url は書き換わることがある）。
  const host = request.headers.get("Host") ?? new URL(request.url).host;
  const hostname = host.split(":")[0] ?? "";
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return false;
  }

  return new URL(request.url).protocol === "https:";
}

/**
 * ログイン成功時に発行する Cookie の値を作る。
 * 形式: `<有効期限(ms)>.<HMAC-SHA256 署名>`
 */
export async function createSessionCookie(
  request: Request,
  secrets: AdminSecrets,
): Promise<string> {
  const expiry = String(Date.now() + SESSION_TTL_MS);
  const signature = await sign(expiry, secrets.adminSessionSecret);
  const value = `${expiry}.${signature}`;

  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  const secure = isSecureContext(request) ? " Secure;" : "";
  return (
    `${SESSION_COOKIE_NAME}=${value}; HttpOnly;${secure} SameSite=Strict; ` +
    `Path=/; Max-Age=${maxAgeSeconds}`
  );
}

/** ログアウト用に Cookie を即時失効させる。 */
export function clearSessionCookie(request: Request): string {
  const secure = isSecureContext(request) ? " Secure;" : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

/** 管理セッション Cookie が有効かどうかを検証する。 */
export async function verifyAdminSession(
  request: Request,
  secrets: AdminSecrets,
): Promise<boolean> {
  const cookie = readCookie(request, SESSION_COOKIE_NAME);
  if (!cookie) return false;

  const separator = cookie.lastIndexOf(".");
  if (separator === -1) return false;

  const expiryPart = cookie.slice(0, separator);
  const signaturePart = cookie.slice(separator + 1);

  const expiry = Number(expiryPart);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  const expected = await sign(expiryPart, secrets.adminSessionSecret);
  return timingSafeEqual(signaturePart, expected);
}

/** 管理者パスワードを検証する。 */
export function verifyAdminPassword(
  password: string,
  secrets: AdminSecrets,
): boolean {
  return timingSafeEqual(password, secrets.adminPassword);
}

/**
 * CSRF 対策。状態を変える POST では Origin が自分自身と一致することを確認する。
 * SameSite=Strict Cookie と併せた二重の防御。
 */
export function verifySameOrigin(request: Request): boolean {
  // Sec-Fetch-Site は現代のブラウザが必ず付ける、偽装できないヘッダ。
  // 同一オリジンからのフォーム送信は same-origin になる。
  // Referrer-Policy の設定次第で Origin が "null" になることがあるため、
  // まずこちらで判定する。
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite) {
    return fetchSite === "same-origin";
  }

  const origin = request.headers.get("Origin");
  // Sec-Fetch-Site 非対応のブラウザ向けのフォールバック。
  if (!origin) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  // request.url はランタイムやプロキシによって scheme / host が
  // 書き換わることがある（wrangler dev で localhost ⇄ 127.0.0.1 が
  // 食い違うなど）。ブラウザが実際に宛先として送った Host ヘッダと
  // 突き合わせるほうが確実。
  const host = request.headers.get("Host");
  if (host) return originHost === host;

  // Host が無い場合のみ request.url にフォールバックする。
  try {
    return originHost === new URL(request.url).host;
  } catch {
    return false;
  }
}
