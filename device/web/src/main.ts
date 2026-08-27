/**
 * 画面の配線。
 *
 * 状態は5つだけ。据え置きの画面なので、いま何が起きているかが
 * 離れて見ても分かることを優先している。
 *
 *   idle      待機。時計を出す
 *   listening 聞き取り中。音量の目安を出す
 *   thinking  考え中。最初の delta が来るまで
 *   speaking  回答中。本文を足しながら読み上げる
 *   error     エラー。数秒で idle に戻る
 */

import {
  deleteChat,
  endChat,
  fetchChat,
  fetchChats,
  fetchConfig,
  fetchHealth,
  streamChat,
  transcribe,
  type ChatSummary,
  type Source,
} from "./api/client.ts";
import { DeviceSocket, type DeviceEvent } from "./api/device.ts";
import { MicrophoneError, captureUtterance } from "./audio/capture.ts";
import { MicStream, SampleRateError } from "./audio/stream.ts";
import { AudioPlayer } from "./speech/player.ts";
import { SentenceSplitter } from "./speech/sentences.ts";
import {
  RemoteSpeaker,
  SpeechQueue,
  WebSpeechSpeaker,
  type Speaker,
} from "./speech/speaker.ts";

/**
 * 画面の状態。
 *
 * `following` は**マイクを開いているときだけ**現れる（追い質問の窓）。
 * サーバーの `DeviceState` と同じ並びにしてあり、WebSocket 経路では
 * サーバーから来た値をそのまま映す。
 */
type State =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "following"
  | "error";

const el = {
  stage: byId("stage"),
  status: byId("status"),
  level: byId("level-bar"),
  question: byId("question"),
  answer: byId("answer"),
  sources: byId("sources"),
  clock: byId("clock"),
  badge: byId("badge"),
  model: byId("model"),
  talk: byId("talk") as HTMLButtonElement,
  app: byId("app"),
  chats: byId("chats"),
  chatList: byId("chat-list"),
  newChat: byId("new-chat") as HTMLButtonElement,
  toggleChats: byId("toggle-chats") as HTMLButtonElement,
  transcript: byId("transcript"),
  mic: byId("mic") as HTMLButtonElement,
};

/**
 * いま開いているチャット。
 *
 * **会話の履歴はサーバーが持つ。** 以前はここにも「直近N往復・TTL」の
 * 同じ処理があり、サーバー側と二重になっていた。
 */
let chatId: string | null = null;

let state: State = "idle";
let session: AbortController | null = null;
let speech: SpeechQueue | null = null;

/**
 * マイクを開いているか。
 *
 * **開いている間はサーバーが状態機械を持つ**（WebSocket 経路）。
 * ウェイクワードが効き、追い質問も続けられる。
 *
 * 閉じているときは「押したときだけマイクを開く」従来の経路（HTTP）。
 * 常時待ち受けにしたくないときのために残してある。
 */
let micOn = false;
const socket = new DeviceSocket();
const mic = new MicStream();
const player = new AudioPlayer();
/** WebSocket 経路で、いま組み立て中の質問と回答。 */
let liveQuestion = "";
let liveAnswer = "";

void start();

async function start(): Promise<void> {
  clock();
  setInterval(clock, 10_000);

  el.talk.addEventListener("click", onTalk);
  el.mic.addEventListener("click", () => void toggleMic());
  el.newChat.addEventListener("click", () => void onNewChat());
  el.toggleChats.addEventListener("click", () => {
    const hidden = el.app.dataset.chats === "hidden";
    el.app.dataset.chats = hidden ? "shown" : "hidden";
  });
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    event.preventDefault();
    onTalk();
  });

  const health = await fetchHealth();
  if (health && health.mode !== "live") {
    // 本番と取り違えて「なぜか同じ答えしか返らない」と悩まないように。
    el.badge.textContent = health.mode;
    el.badge.hidden = false;
  }

  speech = new SpeechQueue(pickSpeaker(health?.tts === "voicevox"));
  // 読み上げが失敗したことを画面にも出す。黙って無音になると、
  // 利用者には「壊れた」としか分からない。
  speech.onError = () => {
    if (state === "speaking") el.status.textContent = "回答中（読み上げできません）";
  };

  setMicLabel();
  await refreshChats();

  const config = await fetchConfig();
  if (config) {
    const model =
      config.provider === "gemini" ? config.geminiModel : config.claudeModel;
    el.model.textContent = model ?? "";
  }
}

/**
 * 読み上げの実装を選ぶ。
 *
 * VOICEVOX があればそちら。無ければブラウザの読み上げに落とすが、
 * **日本語の音声が入っていない環境では何も聞こえない。**その場合は
 * 画面に文字だけが出る（無言で固まるよりはよい）。
 */
function pickSpeaker(hasVoicevox: boolean): Speaker {
  if (hasVoicevox) return new RemoteSpeaker();

  if (WebSpeechSpeaker.isUsable()) {
    console.warn("VOICEVOX が無いので、ブラウザの読み上げを使います。");
    return new WebSpeechSpeaker();
  }

  console.warn("読み上げに使えるものがありません。文字だけ表示します。");
  return { prepare: async () => null, play: async () => {}, cancel: () => {} };
}

// --- マイクの開閉（常時待ち受け） ---

/**
 * マイクを開く／閉じる。
 *
 * 開くと WebSocket でサーバーに繋ぎ、80ms ごとに音を流す。
 * **ウェイクワードの判定はサーバーが行う。** 画面は届いた状態を映すだけ。
 */
async function toggleMic(): Promise<void> {
  // **触った流れの中で音を出せる状態にする。**
  // ウェイクワードで始まると、鳴るのが最初の操作から遠く離れるため、
  // ここで済ませておかないと自動再生の制限で無音になる。
  void player.prime();

  if (micOn) {
    await closeMic();
    return;
  }
  await openMic();
}

async function openMic(): Promise<void> {
  try {
    await mic.open((pcm) => socket.sendFrame(pcm));
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
  el.status.textContent = "話しかけてください";
}

function setMicLabel(): void {
  el.mic.textContent = micOn ? "マイク ON" : "マイク OFF";
  el.mic.dataset.on = micOn ? "1" : "0";
  el.mic.title = micOn
    ? "常時待ち受け中。ウェイクワードでチャットが始まります"
    : "押したときだけマイクを開きます";
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
        void refreshChats();
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
      if (chatId !== event.chatId) {
        chatId = event.chatId;
        reset();
        el.transcript.replaceChildren();
      }
      void refreshChats();
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

function onTalk(): void {
  // **触った瞬間に音を出せる状態にする。**
  // ブラウザは利用者が触る前に音を鳴らさない。読み上げが始まるのは
  // 聞き取りと生成が終わったあとで、そこまで来ると最初の操作から
  // 離れすぎていて拒否されることがある（実際に音が出なかった）。
  void speech?.prime();
  void player.prime();

  const busy = state !== "idle" && state !== "error";

  // マイクを開いているときはサーバーが状態を持つ。
  // ボタンは「ウェイクワードを言わずに起こす」ためのもの。
  if (micOn) {
    if (busy) socket.cancel();
    else socket.wake();
    return;
  }

  // 話している最中のボタンは「やめて」。
  if (busy) {
    stop();
    return;
  }
  void ask();
}

function stop(): void {
  session?.abort();
  session = null;
  speech?.cancel();
  setState("idle");
  el.status.textContent = "話しかけてください";
}

async function ask(): Promise<void> {
  const controller = new AbortController();
  session = controller;

  reset();
  setState("listening");
  el.status.textContent = "聞いています";

  let wav: ArrayBuffer;
  try {
    const captured = await captureUtterance({
      signal: controller.signal,
      onSpeechStart: () => {
        el.status.textContent = "どうぞ";
      },
      onLevel: (level) => {
        // 0.3 で振り切る。話し声はだいたいこの範囲に収まる。
        el.level.style.width = `${Math.min(100, level * 330)}%`;
      },
    });

    if (controller.signal.aborted) return;

    if (!captured.ok) {
      fail("聞き取れませんでした。もう一度どうぞ。");
      return;
    }
    wav = captured.wav;
  } catch (error) {
    fail(
      error instanceof MicrophoneError
        ? error.message
        : "マイクを使えませんでした。",
    );
    return;
  }

  setState("thinking");
  el.status.textContent = "聞き取っています";
  el.level.style.width = "0%";

  let question: string;
  try {
    question = (await transcribe(wav)).trim();
  } catch (error) {
    fail(error instanceof Error ? error.message : "音声を認識できませんでした。");
    return;
  }

  if (controller.signal.aborted) return;
  if (!question) {
    fail("聞き取れませんでした。もう一度どうぞ。");
    return;
  }

  el.question.textContent = question;
  el.question.hidden = false;
  el.status.textContent = "考えています";

  await answer(question, controller);
}

async function answer(question: string, controller: AbortController): Promise<void> {
  const splitter = new SentenceSplitter();
  let text = "";
  let failed = false;

  try {
    for await (const event of streamChat(question, {
      chatId,
      signal: controller.signal,
    })) {
      if (controller.signal.aborted) return;

      switch (event.type) {
        case "chat":
          // サーバーが新しく作ったチャットに入ることがある（上限で仕切り直し）。
          if (chatId !== event.chatId) {
            chatId = event.chatId;
            void refreshChats();
          }
          break;
        case "delta": {
          if (!text) {
            setState("speaking");
            el.status.textContent = "回答中";
          }
          text += event.text;
          el.answer.textContent = text;
          // 1文できた端から読み上げる。全部待つと声が返るまでが遅い。
          for (const sentence of splitter.push(event.text)) {
            speech?.enqueue(sentence);
          }
          break;
        }
        case "sources":
          showSources(event.sources);
          break;
        case "error":
          failed = true;
          fail(event.message);
          break;
        case "done":
          if (event.stopReason === "empty" && !text) {
            failed = true;
            fail("答えが返りませんでした。もう一度お試しください。");
          }
          if (event.stopReason === "max_tokens") {
            text += "\n\n（長くなったので、ここまでにします）";
            el.answer.textContent = text;
          }
          break;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    failed = true;
    fail(error instanceof Error ? error.message : "通信に失敗しました。");
  }

  if (controller.signal.aborted || failed) return;

  for (const sentence of splitter.flush()) speech?.enqueue(sentence);

  // いままでの往復を上に積む。次の質問のときに文脈が見えるように。
  if (text) {
    appendTranscript(question, text);
    void refreshChats();
  }

  await speech?.drain();
  if (controller.signal.aborted) return;

  setState("idle");
  el.status.textContent = "続けて話しかけられます";
  session = null;
}

// --- チャットの履歴 ---

/** 一覧を取り直して描く。 */
async function refreshChats(): Promise<void> {
  renderChats(await fetchChats());
}

/**
 * 一覧を描く。
 *
 * `showSources` と同じ流儀で、テンプレート文字列で HTML を組まずに
 * `createElement` + `textContent` で作る（題名に何が入っていても安全）。
 */
function renderChats(items: ChatSummary[]): void {
  const list = document.createElement("ul");

  for (const chat of items) {
    const li = document.createElement("li");
    if (chat.id === chatId) li.dataset.current = "1";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "open";
    // デバイスで話したものが分かるようにしておく。
    open.textContent = `${chat.origin === "device" ? "🎙 " : ""}${chat.title}`;
    open.title = `${chat.title}（${chat.turns} 発言）`;
    open.addEventListener("click", () => void openChat(chat.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "消す";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeChat(chat.id);
    });

    li.append(open, remove);
    list.append(li);
  }

  el.chatList.replaceChildren(...list.children);
}

/** 過去のチャットを開く。**続きを話せる**（読むだけにしない）。 */
async function openChat(id: string): Promise<void> {
  stop();

  const chat = await fetchChat(id);
  if (!chat) return;

  chatId = id;
  reset();
  el.transcript.replaceChildren();

  for (let i = 0; i < chat.turns.length; i += 2) {
    const question = chat.turns[i];
    const answer = chat.turns[i + 1];
    if (question?.role === "user") {
      appendTranscript(question.content, answer?.content ?? "");
    }
  }
  el.status.textContent = "続けて話しかけられます";
  void refreshChats();
}

async function removeChat(id: string): Promise<void> {
  if (!(await deleteChat(id))) return;
  if (chatId === id) {
    chatId = null;
    reset();
    el.transcript.replaceChildren();
  }
  void refreshChats();
}

/** 仕切り直す。いま開いているチャットは閉じる。 */
async function onNewChat(): Promise<void> {
  stop();
  if (chatId) await endChat(chatId);

  chatId = null;
  reset();
  el.transcript.replaceChildren();
  el.status.textContent = "話しかけてください";
  void refreshChats();
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
  speech?.cancel();
  setState("error");
  el.status.textContent = "うまくいきませんでした";
  el.answer.textContent = message;
  session = null;

  // 放っておいても待機に戻る。家族が「壊れた」と思わないように。
  setTimeout(() => {
    if (state !== "error") return;
    setState("idle");
    el.status.textContent = "話しかけてください";
  }, 6_000);
}

function reset(): void {
  el.question.hidden = true;
  el.question.textContent = "";
  el.answer.textContent = "";
  el.sources.hidden = true;
  el.sources.replaceChildren();
}

function setState(next: State): void {
  state = next;
  el.stage.dataset.state = next;
  // `following`（追い質問の窓）も「話している最中」に含める。
  // ボタンは「やめる」になり、押せば会話を終えられる。
  const busy = next !== "idle" && next !== "error";
  el.talk.textContent = busy ? "やめる" : "話す";
  el.talk.dataset.mode = busy ? "stop" : "talk";
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
