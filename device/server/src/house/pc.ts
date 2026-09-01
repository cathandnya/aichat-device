/**
 * PC の電源。**読むだけでなく、動かす。**
 *
 * マザーボードのフロントパネルピンを Raspberry Pi Zero W で無線化した
 * 装置（pc_power / Front Panel Bridge）に頼む。物理ボタンを押すのと
 * 同じことを、光結合を通してやっている。
 *
 * ### `/power/off` は使わない ★
 *
 * 装置には `/power/on` `/power/off` `/power/toggle` `/reset` があるが、
 * **こちらから呼ぶのは `/power/toggle` だけ**にしてある。
 *
 * `/power/off` は電源ピンを **5 秒**押し続ける（`PULSE_POWER_OFF = 5.0`）。
 * これは物理ボタンの長押しと同じで、**OS に断らず電源を切る**。
 * 保存していない仕事が消えるし、書き込みの最中ならファイルが壊れる。
 * `/reset` も同じ理由で呼ばない。
 *
 * `/power/toggle` は 0.5 秒（`PULSE_POWER_ON` と同じ）。**ボタンを
 * ちょんと押すのと同じ**なので、動いている PC では OS が受け取って
 * 通常の終了に入り、止まっている PC では起動する。
 *
 * 声で「消して」と言われて消えるのは、この 0.5 秒のほうだけでよい。
 * 強制的に切りたい場面は、声で頼む場面ではない。
 *
 * ### なぜ失敗しても投げないか
 *
 * `house/power.ts` と同じ。例外にすると会話ごと落ちる。
 */

/** 待つ上限。**声の返事なので、待たせるくらいなら諦める。** */
const TIMEOUT_MS = 3_000;

/** PC の電源が入っているか。分からなければ null。 */
export async function readPcPower(baseUrl: string): Promise<boolean | null> {
  const status = await getStatus(baseUrl);
  return status ? status.on : null;
}

interface Status {
  /** 電源が入っているか（PWR_LED を見ている）。 */
  on: boolean;
  /** 装置がいま別の操作をしている最中か。 */
  busy: boolean;
}

async function getStatus(baseUrl: string): Promise<Status | null> {
  if (!baseUrl) return null;

  let raw: unknown;
  try {
    const res = await fetch(`${baseUrl}/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[pc] ${res.status} が返りました`);
      return null;
    }
    raw = await res.json();
  } catch (error) {
    console.warn("[pc] 電源の装置に繋がりません:", error);
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  // **真偽値以外は「分からない」に倒す。** 欠けたキーを偽として扱うと
  // 「消えています」と断言してしまう。
  if (typeof data.pc_power !== "boolean") return null;
  return { on: data.pc_power, busy: data.busy === true };
}

/** 頼まれたこと。 */
export type Want = "on" | "off";

export type PressResult =
  /** ボタンを押した。 */
  | { ok: true; pressed: true; want: Want }
  /** 押していない。**もうその状態だったから。** */
  | { ok: true; pressed: false; want: Want }
  | { ok: false; reason: string };

/**
 * 頼まれた向きに合わせて、電源ボタンを 0.5 秒押す。
 *
 * ### 「点けて」と言われて既に点いていたら、押さない ★
 *
 * 装置が持つのは `toggle`（入れ替える）だけなので、**言われたまま
 * 押すと逆のことが起きる**。点いている PC に「点けて」で押せば、
 * 消えてしまう。仕事が消える向きの間違いなので、必ず手前で状態を
 * 読んで、**既にその状態なら何もしない**。
 *
 * 「消して」で既に消えているときも同じ。押せば点いてしまう。
 *
 * ### なぜ押す前に状態を読むか
 *
 * `/power/toggle` の応答にも `pc_power` は入るが、**押した直後の値**
 * なので当てにならない。PC の電源が実際に落ちるまでには数秒かかるし、
 * 通常終了なら OS の後始末を待つぶんもっとかかる。
 */
export async function pressPcPower(baseUrl: string, want: Want): Promise<PressResult> {
  if (!baseUrl) return { ok: false, reason: "電源の装置の場所が分かりません" };

  const before = await getStatus(baseUrl);
  // **状態が読めないなら押さない。** 向きが分からないまま押すと、
  // 点けるつもりで消すことになる。
  if (!before) return { ok: false, reason: "電源の装置に繋がりません" };

  // 既に頼まれた状態。**押さない。**
  if (before.on === (want === "on")) return { ok: true, pressed: false, want };

  // **重ねて押さない。** 装置は操作中を `busy` で教えてくれる。
  // 押している最中にもう一度押すと、装置側で拒まれる（`RuntimeError("busy")`）。
  if (before.busy) return { ok: false, reason: "いま別の操作をしています" };

  try {
    const res = await fetch(`${baseUrl}/power/toggle`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[pc] toggle が ${res.status} を返しました`);
      return { ok: false, reason: "電源のボタンを押せませんでした" };
    }
  } catch (error) {
    console.warn("[pc] toggle に失敗しました:", error);
    return { ok: false, reason: "電源のボタンを押せませんでした" };
  }

  console.log(`[pc] 電源ボタンを押しました（${want === "on" ? "点ける" : "消す"}）`);
  return { ok: true, pressed: true, want };
}
