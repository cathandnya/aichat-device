/**
 * この端末の id。**会話を継ぐ相手はこれで決まる。**
 *
 * 据え置きを複数台置くと、居間の会話を寝室のデバイスが引き取ってしまう。
 * 見分ける鍵が要るが、
 *
 * - **MAC アドレスは使えない。** TCP では届かない（同じ L2 で ARP を引く必要がある）
 * - **IP は弱い。** 開発中は Vite のプロキシ経由なので全部 `127.0.0.1` に潰れる。
 *   DHCP で変われば会話が切れ、同じ機械の 2 つのブラウザは同じ扱いになる
 *
 * なので**端末が自分で名乗る**。実機（Pi）は環境変数で固定の id を持ち、
 * ブラウザはここで作って `localStorage` に置く。
 *
 * DOM にも WebSocket にも触らない。テストからそのまま読み込める。
 */

const KEY = "aichat-device-id";

/**
 * サーバー側の `normalizeDeviceId`（`server/src/chats/types.ts`）と同じ規則。
 *
 * **ずれても壊れない。** サーバーが弾けば「名乗らない端末」に落ちるだけで、
 * いまと同じ挙動になる。
 */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

/**
 * 覚えておく。
 *
 * `localStorage` に書けなかったとき（プライベートウィンドウ、サイトデータの
 * 拒否）でも、**そのページが生きている間は同じ id を使い続ける**ため。
 * 再読み込みすると新しい id になり、履歴の見出しが増えていく。
 * 保存できない以上これは避けられないので、諦めて動くほうを採る。
 */
let cached: string | null = null;

/** この端末の id。**必ず何かを返す**（保存できなくても動く）。 */
export function deviceId(): string {
  if (cached) return cached;

  const storage = safeStorage();
  const saved = read(storage);
  if (saved) {
    cached = saved;
    return saved;
  }

  const made = makeId();
  write(storage, made);
  cached = made;
  return made;
}

/**
 * `localStorage`。触れなければ null。
 *
 * **`typeof localStorage` の判定だけでは足りない。** 存在していても、
 * サイトデータを全面的に拒否した設定では**触った瞬間に投げる**。
 */
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 保存された id。無いか壊れていれば空。 */
export function read(storage: Storage | null): string {
  if (!storage) return "";
  try {
    const saved = storage.getItem(KEY) ?? "";
    // 利用者が devtools で書き換えられる。サーバーに送る前に一度見る。
    return SAFE.test(saved) ? saved : "";
  } catch {
    return "";
  }
}

function write(storage: Storage | null, id: string): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, id);
  } catch {
    // 書けなくても動く。文脈が再読み込みで切れるだけ。
  }
}

/**
 * `browser-a3f9` のような短い id を作る。
 *
 * **`crypto.randomUUID` は使わない。** secure context でしか生えず、
 * 履歴の画面は LAN の HTTP で開かれうる。長すぎて見出しにも向かない。
 */
export function makeId(): string {
  return `browser-${hex4()}`;
}

function hex4(): string {
  try {
    const bytes = new Uint8Array(2);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // crypto が無い環境でも id が要る。衝突しても「同じ端末」になるだけ。
    return Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  }
}
