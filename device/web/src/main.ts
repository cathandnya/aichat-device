/**
 * チャットの画面の配線。
 *
 * **実機（丸い小さな画面）に寄せてある。** ボタンは下にまとめ、本文だけを大きく出す。
 * **ボタンは実機に無いものを置かない。** 残っているのはマイクの入り切りだけ。
 * 話しかけるにはウェイクワードを言う。会話の区切りは間があいたかで決まるので、
 * 「新しい会話」も要らない。
 *
 * 状態は6つ。**離れて見ても分かること**を最優先にしている。
 *
 *   idle      待機。時計だけ
 *   listening 聞き取り中。**画面の縁が光り、声の大きさが動く**
 *   thinking  考え中。最初の delta が来るまで
 *   speaking  回答中
 *   following 追い質問の窓。listening と同じく縁が光る
 *   error     エラー。数秒で idle に戻る
 *
 * マイクを開いている間は**サーバーが状態機械を持つ**。この画面は
 * 届いた状態を映すだけで、判断はしない。
 */

import { fetchHealth, type Source } from "./api/client.ts";
import { DeviceSocket, type DeviceEvent } from "./api/device.ts";
import { MicStream, SampleRateError } from "./audio/stream.ts";
import { MicrophoneError } from "./audio/capture.ts";
import { Mouth } from "./character/mouth.ts";
import { AudioPlayer } from "./speech/player.ts";

/** 画面の状態。サーバーの `DeviceState` と同じ並び。 */
type State =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "following"
  | "error";

/** ウェイクワードに気づいたときの音。 */
const WAKE_SOUND = "/wake.mp3";

/** 声を受け付けている状態。ここだけ見た目を大きく変える。 */
const HEARING: State[] = ["listening", "following"];

const el = {
  stage: byId("stage"),
  status: byId("status"),
  level: byId("level-bar"),
  question: byId("question"),
  answer: byId("answer"),
  sources: byId("sources"),
  clock: byId("clock"),
  badge: byId("badge"),
  transcript: byId("transcript"),
  mic: byId("mic") as HTMLButtonElement,
  character: byId("character"),
};

/**
 * いま開いているチャット。
 *
 * **会話の履歴はサーバーが持つ。** 以前はここにも「直近N往復・TTL」の
 * 同じ処理があり、サーバー側と二重になっていた。
 */
let chatId: string | null = null;

let state: State = "idle";

/** マイクを開いているか。開いている間だけ話しかけられる。 */
let micOn = false;
const socket = new DeviceSocket();
const mic = new MicStream();
const mouth = new Mouth(el.character);
/**
 * **口パクは再生に合わせる。サーバーの `speaking` では合わない。**
 *
 * あちらは最初の delta で立って WAV を送り終えた時点で降りるので、
 * 合成の待ち（1 秒以上）ぶん早く動き出し、まだ鳴っている途中で止まる。
 */
const player = new AudioPlayer((speaking) => {
  if (speaking) mouth.start();
  else mouth.stop();
});
/** いま組み立て中の質問と回答。 */
let liveQuestion = "";
let liveAnswer = "";

void start();

async function start(): Promise<void> {
  clock();
  setInterval(clock, 10_000);

  showCharacterWhenLoaded();

  el.mic.addEventListener("click", () => void toggleMic());

  // ボタンを消したぶん、キーボードから起こせるようにしておく
  // （手元で試すとき用。実機では使わない）。
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || !micOn) return;
    event.preventDefault();
    if (busy()) socket.cancel();
    else socket.wake();
  });

  const health = await fetchHealth();
  if (health && health.mode !== "live") {
    // 本番と取り違えて「なぜか同じ答えしか返らない」と悩まないように。
    el.badge.textContent = health.mode;
    el.badge.hidden = false;
  }

  setMicLabel();
  setState("idle");
}

function busy(): boolean {
  return state !== "idle" && state !== "error";
}

/**
 * 立ち絵は、**画像が読めたときだけ出す。**
 *
 * `public/character/*.png` は git に入れていないので、clone しただけの
 * 状態では1枚も無い。そのまま出すと
 * 壊れた画像の印が4つ並ぶ。読めなければ隠したままにして、
 * **立ち絵が無いだけの画面**にする。
 */
function showCharacterWhenLoaded(): void {
  const body = el.character.querySelector<HTMLImageElement>(".body");
  if (!body) return;

  if (body.complete) {
    // naturalWidth が 0 なら読み込みに失敗している。
    if (body.naturalWidth > 0) el.character.hidden = false;
    return;
  }
  body.addEventListener("load", () => {
    el.character.hidden = false;
  });
  // error は拾わない。hidden のままでよい。
}

// --- マイクの開閉（常時待ち受け） ---

/**
 * マイクを開く／閉じる。
 *
 * 開くと WebSocket でサーバーに繋ぎ、80ms ごとに音を流す。
 * **ウェイクワードの判定はサーバーが行う。**
 */
async function toggleMic(): Promise<void> {
  // **触った流れの中で音を出せる状態にする。**
  // ウェイクワードで始まると、鳴るのが最初の操作から遠く離れるため、
  // ここで済ませておかないと自動再生の制限で無音になる。
  // ボタンが減ったぶん、ここが唯一の機会になった。
  void player.prime();

  if (micOn) {
    await closeMic();
    return;
  }
  await openMic();
}

async function openMic(): Promise<void> {
  try {
    await mic.open(onMicFrame);
  } catch (error) {
    fail(
      error instanceof SampleRateError || error instanceof MicrophoneError
        ? error.message
        : "マイクを開けませんでした。",
    );
    await mic.close();
    return;
  }

  socket.connect(onDeviceEvent);
  micOn = true;
  setMicLabel();
}

async function closeMic(): Promise<void> {
  socket.cancel();
  socket.close();
  await mic.close();
  player.cancel();

  micOn = false;
  liveQuestion = "";
  liveAnswer = "";
  setMicLabel();
  setState("idle");
  el.status.textContent = "マイクを ON にすると話しかけられます";
}

/**
 * 80ms ごとの音。サーバーに流しつつ、声の大きさを画面に出す。
 *
 * **これが「聞こえている」ことの証。** 状態の文字だけだと、本当に
 * 声が届いているのか、黙って固まっているのかが分からない。
 */
function onMicFrame(pcm: ArrayBuffer): void {
  socket.sendFrame(pcm);
  if (!HEARING.includes(state)) return;

  // 0.3 で振り切る。話し声はだいたいこの範囲に収まる。
  el.level.style.width = `${Math.min(100, rms(pcm) * 330)}%`;
}

function rms(pcm: ArrayBuffer): number {
  const samples = new Int16Array(pcm);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) / 32768;
}

function setMicLabel(): void {
  el.mic.textContent = micOn ? "マイク ON" : "マイク OFF";
  el.mic.dataset.on = micOn ? "1" : "0";
  el.mic.title = micOn
    ? "常時待ち受け中。ウェイクワードで話しかけられます"
    : "ここを押すと待ち受けを始めます";
}

/** サーバーから届いたものを画面に映す。判断はしない。 */
function onDeviceEvent(event: DeviceEvent): void {
  switch (event.type) {
    case "state": {
      // **読み上げが終わった合図が無い**ので、speaking から出たことで見る。
      if (state === "speaking" && event.state !== "speaking" && liveAnswer) {
        appendTranscript(liveQuestion, liveAnswer);
        liveQuestion = "";
        liveAnswer = "";
        el.question.hidden = true;
        el.answer.textContent = "";
      }
      setState(event.state);
      el.status.textContent = event.status;
      break;
    }
    case "question":
      liveQuestion = event.text;
      el.question.textContent = event.text;
      el.question.hidden = false;
      break;
    case "answer":
      // 累積全文なので置き換える。
      liveAnswer = event.text;
      el.answer.textContent = event.text;
      break;
    case "sources":
      showSources(event.sources);
      break;
    case "chat":
      // 別のチャットに移ったときだけ画面を空にする。**継いだときは残す。**
      if (chatId !== event.chatId) {
        chatId = event.chatId;
        reset();
        el.transcript.replaceChildren();
      }
      break;
    case "wake":
      // **気づいたことをすぐ返す。** 聞き取りが始まるまで無反応だと、
      // 呼んだ人はもう一度呼んでしまう。
      void player.chime(WAKE_SOUND);
      break;
    case "audio":
      player.enqueue(event.wav);
      break;
    case "error":
      el.answer.textContent = event.message;
      player.cancel();
      break;
    case "closed":
      if (micOn) void closeMic();
      break;
  }
}

/** 済んだ往復を上に積む。 */
function appendTranscript(question: string, answer: string): void {
  const u = document.createElement("div");
  u.className = "u";
  u.textContent = question;

  const a = document.createElement("div");
  a.className = "a";
  a.textContent = answer;

  el.transcript.append(u, a);
}

function showSources(sources: Source[]): void {
  if (sources.length === 0) return;

  el.sources.hidden = false;
  for (const source of sources) {
    const item = document.createElement("li");
    // リンクにしない。据え置きの画面でブラウザが開くと、
    // 家族が戻れなくなる。どこを見たかが分かればよい。
    item.textContent = source.title;
    el.sources.append(item);
  }
}

function fail(message: string): void {
  player.cancel();
  setState("error");
  el.status.textContent = "うまくいきませんでした";
  el.answer.textContent = message;

  // 放っておいても待機に戻る。家族が「壊れた」と思わないように。
  setTimeout(() => {
    if (state !== "error") return;
    setState("idle");
    el.status.textContent = micOn
      ? "話しかけてください"
      : "マイクを ON にすると話しかけられます";
  }, 6_000);
}

function reset(): void {
  el.question.hidden = true;
  el.question.textContent = "";
  el.answer.textContent = "";
  el.sources.hidden = true;
  el.sources.replaceChildren();
}

/**
 * 状態を映す。
 *
 * `data-state` は **body にも置く**。画面の縁を光らせるのに、
 * 本文の入れ物より外側の要素が要るため。
 */
function setState(next: State): void {
  state = next;
  el.stage.dataset.state = next;
  document.body.dataset.state = next;
  document.body.dataset.hearing = HEARING.includes(next) ? "1" : "0";

  // 声を受け付けていない間は、声の大きさを 0 に戻しておく。
  if (!HEARING.includes(next)) el.level.style.width = "0%";
}

function clock(): void {
  el.clock.textContent = new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`要素が見つかりません: ${id}`);
  return found;
}
