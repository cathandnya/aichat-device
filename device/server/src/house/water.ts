/**
 * 製氷機タンクの水。**冷蔵庫の中の ESP32 に聞く。**
 *
 * 非接触の液面センサーを付けた ESP32-C3 が、水の有無だけを持っている
 * （画面は mDNS の名前で見られる。**こちらから叩くのは IP**。下記）。
 * センサーは「ある/ない」しか返さないので、
 * **残量は分からない**。分かるのは「入っているか」だけ。
 *
 * ### `.local` を設定に書かないこと ★
 *
 * センサー自身は速い（**実測 40ms**）。遅いのは名前の解決のほうで、
 * mDNS の名前を Node から引くと **1 回 5 秒**かかった
 * （`curl` の内訳で `time_namelookup` が 5.00 秒）。声の返事としては
 * 待てない長さなので、`.env` には**IP を書く**。
 *
 * mDNS が引けないと丸ごと失敗する点も同じ。ESP32 は DHCP で IP が
 * 変わりうるので、動かなくなったらシリアルログか `/api/status` の
 * `ip` を見て書き換える。
 *
 * ### なぜ失敗しても投げないか
 *
 * `house/power.ts` と同じ。例外にすると会話ごと落ちるので、
 * **null を返して「分かりません」と言わせる**。
 */

/**
 * 待つ上限。
 *
 * IP で指せば 40ms で返る相手なので、これは**落ちているときに
 * 見切る**ための値。声の返事なので長くは待てない。
 */
const TIMEOUT_MS = 3_000;

/** 製氷機のタンクに水があるか。分からなければ null。 */
export async function readWater(baseUrl: string): Promise<boolean | null> {
  if (!baseUrl) return null;

  let raw: unknown;
  try {
    const res = await fetch(`${baseUrl}/api/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[water] ${res.status} が返りました`);
      return null;
    }
    raw = await res.json();
  } catch (error) {
    console.warn("[water] 水位センサーに繋がりません:", error);
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const water = (raw as Record<string, unknown>).water;

  // **真偽値以外は「分からない」に倒す。** 欠けたキーは undefined になり、
  // そのまま偽として扱うと「水がありません」と断言してしまう。
  return typeof water === "boolean" ? water : null;
}
