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
  fetchConfig,
  fetchHealth,
  streamChat,
  transcribe,
  type Source,
} from "./api/client.ts";
import { MicrophoneError, captureUtterance } from "./audio/capture.ts";
import { SentenceSplitter } from "./speech/sentences.ts";
import {
  RemoteSpeaker,
  SpeechQueue,
  WebSpeechSpeaker,
  type Speaker,
} from "./speech/speaker.ts";

type State = "idle" | "listening" | "thinking" | "speaking" | "error";

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
};

/** 会話の持ち越し。家族で共用するので長くは持たない。 */
const HISTORY_LIMIT = 6;
const HISTORY_TTL_MS = 5 * 60_000;

let history: { role: string; content: string }[] = [];
let historyAt = 0;

let state: State = "idle";
let session: AbortController | null = null;
let speech: SpeechQueue | null = null;

void start();

async function start(): Promise<void> {
  clock();
  setInterval(clock, 10_000);

  el.talk.addEventListener("click", onTalk);
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
 * **Pi では日本語の音声が無いので何も聞こえない。**その場合は
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

function onTalk(): void {
  // **触った瞬間に音を出せる状態にする。**
  // ブラウザは利用者が触る前に音を鳴らさない。読み上げが始まるのは
  // 聞き取りと生成が終わったあとで、そこまで来ると最初の操作から
  // 離れすぎていて拒否されることがある（実際に音が出なかった）。
  void speech?.prime();

  // 話している最中のボタンは「やめて」。
  if (state !== "idle" && state !== "error") {
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
  const messages = [...validHistory(), { role: "user", content: question }];

  const splitter = new SentenceSplitter();
  let text = "";
  let failed = false;

  try {
    for await (const event of streamChat(messages, { signal: controller.signal })) {
      if (controller.signal.aborted) return;

      switch (event.type) {
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

  if (text) {
    history = [
      ...validHistory(),
      { role: "user", content: question },
      { role: "assistant", content: text },
    ].slice(-HISTORY_LIMIT);
    historyAt = Date.now();
  }

  await speech?.drain();
  if (controller.signal.aborted) return;

  setState("idle");
  el.status.textContent = "続けて話しかけられます";
  session = null;
}

/**
 * 持ち越してよい会話だけ返す。
 *
 * 家族で共用する画面なので、前の人の話が次の人に引き継がれないよう
 * 短い時間で捨てる。
 */
function validHistory(): { role: string; content: string }[] {
  if (Date.now() - historyAt > HISTORY_TTL_MS) history = [];
  return history;
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
