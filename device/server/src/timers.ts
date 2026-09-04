/**
 * タイマー。**1台につき1本だけ。**
 *
 * 「3分のタイマーかけて」と頼まれたら数えて、時間が来たら知らせる。
 * 数えるのはサーバー。端末は判断を持たない（`ws/protocol.ts` の方針）。
 *
 * ### なぜ Session ではなくモジュールに置くか
 *
 * **WebSocket は切れて繋がり直す。** 実測でも頻繁に起きる（アプリの
 * 再起動、WiFi の瞬断）。`Session` に持たせると、切れた時点でタイマーが
 * 消える。3分のタイマーが2分で消えるのでは使い物にならない。
 *
 * 端末ごとに1本なので、鍵は `deviceId`。
 *
 * ### なぜ複数持たないか
 *
 * **要らないと決めた。** 台所で1つ動かす使い方しか想定していない。
 * 複数持つと「どれを止めるか」を声で指定させることになり、
 * 言い回しの理解も取り消しの UI も一気に重くなる。
 * 動いている最中にもう1本頼まれたら、**かけずに残りを伝える**。
 *
 * ### なぜディスクに書かないか
 *
 * サーバーを再起動したら消える。数分の用途なので、消えて困る場面より
 * 「再起動したのに古いタイマーが鳴る」ほうが気味が悪い。
 */

/** かけられる長さの下限。**押し間違いよけ。** */
const MIN_SEC = 1;

/**
 * かけられる長さの上限。
 *
 * 24時間。これを超える指定は言い間違いか聞き間違いとみなす
 * （「3分」が「3000分」に化けるより、断って言い直してもらうほうがよい）。
 */
const MAX_SEC = 24 * 60 * 60;

export interface Timer {
  deviceId: string;
  /** 「パスタ」など。無ければ null。 */
  label: string | null;
  /** 鳴る時刻（epoch ms）。 */
  endsAt: number;
  /** 頼まれた長さ（秒）。読み上げの文面に使う。 */
  durationSec: number;
}

/** 残り秒つきの姿。**AI に渡すのはこちら。** */
export interface TimerView extends Timer {
  remainingSec: number;
}

interface Entry {
  timer: Timer;
  handle: NodeJS.Timeout;
}

const timers = new Map<string, Entry>();
const listeners = new Map<string, (timer: Timer) => void>();

/**
 * 鳴らす相手が居ないまま時間が来たぶん。
 *
 * **端末が切断中に発火することがある。** 捨てると「タイマーをかけたのに
 * 何も言われない」になるので、繋ぎ直したときに流す。
 */
const pending = new Map<string, Timer>();

function view(timer: Timer, now: number): TimerView {
  return {
    ...timer,
    remainingSec: Math.max(0, Math.ceil((timer.endsAt - now) / 1000)),
  };
}

/**
 * かける。**既に動いていたら、かけずに動いているものを返す。**
 *
 * 呼ぶ側（AI）は `ok` を見て、false なら「もう動いている」と伝える。
 */
export function setTimer(
  deviceId: string,
  seconds: number,
  label?: string | null,
  now = Date.now(),
): { ok: true; timer: TimerView } | { ok: false; running: TimerView } {
  const running = timers.get(deviceId);
  if (running) return { ok: false, running: view(running.timer, now) };

  // **壊れた値でも落ちない。** AI が渡してくる値なので、何が来ても
  // おかしくない（文字列、小数、負、NaN）。
  const rounded = Math.round(Number(seconds));
  const safe = Number.isFinite(rounded)
    ? Math.min(Math.max(rounded, MIN_SEC), MAX_SEC)
    : MIN_SEC;

  const timer: Timer = {
    deviceId,
    label: typeof label === "string" && label.trim() ? label.trim() : null,
    endsAt: now + safe * 1000,
    durationSec: safe,
  };

  const handle = setTimeout(() => {
    timers.delete(deviceId);
    const listener = listeners.get(deviceId);
    // **聞く相手が居なければ取っておく。** 切断中に捨てると黙って消える。
    if (listener) listener(timer);
    else pending.set(deviceId, timer);
  }, safe * 1000);
  // **プロセスを生かし続けない。**
  //
  // サーバーは WebSocket で生き続けるので、タイマー1本のために
  // イベントループを掴む必要はない。
  //
  // ただし `unref` すると**それ以外に生きたハンドルが無いとき、
  // 発火を待たずにプロセスが終わる**。テストではそれで足を掬われる
  // （node のランナーが先に終わり、テストが cancelled になる）ので、
  // テスト側は実時間を待たずに済むよう `fire()` を使う。
  handle.unref?.();

  timers.set(deviceId, { timer, handle });
  return { ok: true, timer: view(timer, now) };
}

/**
 * やめる。動いていなければ null。
 *
 * **溜めてあるぶんも捨てる。** 切断中に時間が来たものは `pending` に
 * 残り、繋ぎ直した瞬間に鳴る（`onRing`）。ここで消さないと
 * **止めたはずのタイマーが後から鳴る**。
 */
export function cancelTimer(deviceId: string, now = Date.now()): TimerView | null {
  const held = pending.get(deviceId);
  pending.delete(deviceId);

  const entry = timers.get(deviceId);
  if (!entry) return held ? view(held, now) : null;
  clearTimeout(entry.handle);
  timers.delete(deviceId);
  return view(entry.timer, now);
}

/** いま動いているもの。「あと何分？」に答えるのに使う。 */
export function getTimer(deviceId: string, now = Date.now()): TimerView | null {
  const entry = timers.get(deviceId);
  return entry ? view(entry.timer, now) : null;
}

/**
 * 鳴ったときの受け口を登録する。**1台に1つ。付け替えられる。**
 *
 * 繋ぎ直すと新しい `Session` ができるので、そのたびに呼ばれる。
 * 登録した時点で溜まっているぶん（切断中に鳴ったもの）があれば流す。
 */
export function onRing(deviceId: string, fn: (timer: Timer) => void): void {
  listeners.set(deviceId, fn);
  const held = pending.get(deviceId);
  if (held) {
    pending.delete(deviceId);
    fn(held);
  }
}

/**
 * 試験用。**時間を待たずに、いま鳴らす。**
 *
 * 実時間を待つテストは遅いうえ、`unref` の都合でランナーが先に
 * 終わることがある。時計に依存せず筋道だけを確かめるための口。
 */
export function fire(deviceId: string): boolean {
  const entry = timers.get(deviceId);
  if (!entry) return false;
  clearTimeout(entry.handle);
  timers.delete(deviceId);
  const listener = listeners.get(deviceId);
  if (listener) listener(entry.timer);
  else pending.set(deviceId, entry.timer);
  return true;
}

/** 試験用。**本番では呼ばない。** */
export function resetAll(): void {
  for (const entry of timers.values()) clearTimeout(entry.handle);
  timers.clear();
  listeners.clear();
  pending.clear();
}
