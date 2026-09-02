/**
 * 家の消費電力。**別のローカルサーバー（house_power）に聞く。**
 *
 * スマートメーターから Wi-SUN Bルートで瞬時電力を取っているサーバーが、
 * 家の中で既に動いている（既定は `http://localhost:8000`。`.env` で変えられる）。
 * こちらはその値を読むだけで、メーターとは直接話さない。
 *
 * ### なぜ失敗しても投げないか
 *
 * house_power は別プロセスで、落ちていることも Pi ごと居ないこともある。
 * 例外にすると会話ごと落ちるので、**null を返して
 * 「いま分かりません」と言わせる**。
 */

/** 待つ上限。**声の返事なので、待たせるくらいなら諦める。** */
const TIMEOUT_MS = 3_000;

/** いまの消費電力（W）。取れなければ null。 */
export async function readPower(baseUrl: string): Promise<number | null> {
  if (!baseUrl) return null;

  let raw: unknown;
  try {
    const res = await fetch(`${baseUrl}/api/power`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[power] ${res.status} が返りました`);
      return null;
    }
    raw = await res.json();
  } catch (error) {
    console.warn("[power] 電力計に繋がりません:", error);
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const watt = (raw as Record<string, unknown>).instant_power;

  // **メーターと繋がる前は null が入っている。** 0 と混ぜない。
  // `Number(null)` は 0 になるので、型を先に見る（実際に 0W と答えかけた）。
  return typeof watt === "number" && Number.isFinite(watt) ? watt : null;
}
