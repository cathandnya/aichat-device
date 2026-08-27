/**
 * ウェイクワードの試験画面。
 *
 * マイクの音を 80ms ごとにサーバーへ流し、窓ごとの書き起こしと
 * 判定の結果を受け取って並べる。
 *
 * **AI は呼ばない。** `?mode=wake` で繋ぐと、サーバーは判定だけを行い、
 * チャットも作らず読み上げもしない（`ws/wake-probe.ts`）。
 * 音声認識は手元なので、何時間流しても費用はゼロ。
 *
 * 合成音声で測った成績（検出 10/10・誤起動 0/15）は楽観的な下限。
 * 実際の発話・小声・早口・生活音の中で測り直すための道具。
 */

import { MicrophoneError, openMicrophone } from "./audio/capture.ts";
import { SAMPLE_RATE } from "./audio/wav.ts";

const FRAME_SAMPLES = 1280; // 80ms。サーバーの取り決めと同じ

const el = {
  toggle: byId("toggle") as HTMLButtonElement,
  stats: byId("stats"),
  words: byId("words") as HTMLTextAreaElement,
  notice: byId("notice"),
  log: byId("log"),
  save: byId("save") as HTMLButtonElement,
  clear: byId("clear") as HTMLButtonElement,
};

interface Entry {
  at: string;
  text: string;
  fired: boolean;
  ms: number;
}

let socket: WebSocket | null = null;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let startedAt = 0;
let fires = 0;
let windows = 0;
const entries: Entry[] = [];

void start();

async function start(): Promise<void> {
  el.toggle.addEventListener("click", () => void toggle());
  el.save.addEventListener("click", saveLog);
  el.clear.addEventListener("click", clearLog);
  // 語を変えたら繋ぎ直して即座に反映する。
  el.words.addEventListener("change", () => {
    if (socket?.readyState === WebSocket.OPEN) sendWords();
  });

  setInterval(tickStats, 1000);
}

async function toggle(): Promise<void> {
  if (socket || stream) {
    await stop();
    return;
  }
  await open();
}

async function open(): Promise<void> {
  hideNotice();

  try {
    stream = await openMicrophone();
  } catch (error) {
    show(error instanceof MicrophoneError ? error.message : "マイクを使えませんでした。");
    return;
  }

  // サーバーは 16kHz 固定なので、ここで揃える。
  context = new AudioContext({ sampleRate: SAMPLE_RATE });

  // **Firefox はこの指定を無視する。** 本番の経路では WAV ヘッダに
  // 実測値を書いて逃げていたが、こちらは生の PCM を流すので誤魔化せない。
  if (context.sampleRate !== SAMPLE_RATE) {
    show(
      `このブラウザは ${context.sampleRate}Hz で動いており、` +
        `${SAMPLE_RATE}Hz に固定できません。Chrome か Safari で開いてください。`,
    );
    await stop();
    return;
  }

  await context.audioWorklet.addModule("./recorder-worklet.js");
  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, "recorder");
  source.connect(recorder);
  // 出力には繋がない。繋ぐと自分の声がスピーカーから出る。

  socket = new WebSocket(wsUrl());
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    sendWords();
    startedAt = Date.now();
    setOn(true);
  });
  socket.addEventListener("message", (event) => onMessage(event.data as string));
  socket.addEventListener("close", () => void stop());
  socket.addEventListener("error", () => show("サーバーに繋がりませんでした。"));

  recorder.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(toPcm(event.data));
  };
}

async function stop(): Promise<void> {
  socket?.close();
  socket = null;

  // マイクを掴んだままにしない。録音中の表示が出っぱなしだと不安になる。
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;

  await context?.close().catch(() => {});
  context = null;

  setOn(false);
}

/**
 * Float32（-1〜1）を 16bit PCM にする。
 *
 * **クリップしてから整数にする。** 省くと大きな音で値が回り込み、
 * 正の音が負になって認識が壊れる（本番の wav.ts と同じ扱い）。
 */
function toPcm(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(FRAME_SAMPLES);
  const n = Math.min(samples.length, FRAME_SAMPLES);

  for (let i = 0; i < n; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm.buffer;
}

function onMessage(raw: string): void {
  let message: {
    type: string;
    text?: string;
    fired?: boolean;
    at?: string;
    ms?: number;
    wakeWords?: string[];
  };
  try {
    message = JSON.parse(raw) as never;
  } catch {
    return;
  }

  // 設定の語を初期値として入れる（まだ触っていなければ）。
  if (message.type === "config" && !el.words.value.trim()) {
    el.words.value = (message.wakeWords ?? []).join("\n");
    sendWords();
    return;
  }

  if (message.type !== "heard") return;

  windows += 1;
  if (message.fired) fires += 1;

  const entry: Entry = {
    at: message.at ?? new Date().toISOString(),
    text: message.text ?? "",
    fired: message.fired === true,
    ms: message.ms ?? 0,
  };
  entries.push(entry);
  prepend(entry);
  tickStats();
}

/** 新しいものを上に積む。古いものは画面から落とす（記録には残る）。 */
function prepend(entry: Entry): void {
  const row = document.createElement("div");
  row.className = "row";
  if (entry.fired) row.dataset.fired = "1";
  if (!entry.text) row.dataset.quiet = "1";

  const at = document.createElement("span");
  at.className = "at";
  at.textContent = new Date(entry.at).toLocaleTimeString("ja-JP");

  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = entry.fired ? "★" : "";

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = entry.text || "（無音）";

  row.append(at, mark, text);
  el.log.prepend(row);

  while (el.log.childElementCount > 300) el.log.lastElementChild?.remove();
}

function tickStats(): void {
  if (!socket) {
    el.stats.textContent = entries.length
      ? `停止中 — 起動 ${fires} 回 / ${windows} 窓`
      : "待機中";
    return;
  }

  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  // 暗騒音の推定が落ち着くまで少しかかる。それを隠さない。
  const warming = seconds < 3 ? "（暗騒音を測定中）" : "";
  const perHour = seconds > 0 ? ((fires / seconds) * 3600).toFixed(1) : "—";

  el.stats.innerHTML = "";
  el.stats.append(
    text(`起動 `),
    strong(String(fires)),
    text(` 回 / 経過 `),
    strong(`${minutes}分${String(seconds % 60).padStart(2, "0")}秒`),
    text(` / ${windows} 窓 / 1時間あたり ${perHour} 回 ${warming}`),
  );
}

function sendWords(): void {
  const words = el.words.value
    .split("\n")
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  socket?.send(JSON.stringify({ type: "wake-words", words }));
}

function saveLog(): void {
  const lines = entries.map(
    (e) =>
      `${e.at}\t${e.fired ? "FIRED" : "-"}\t${e.ms}ms\t${e.text || "(無音)"}`,
  );
  const header = [
    `# ウェイクワードの試験`,
    `# 判定語: ${el.words.value.split("\n").filter(Boolean).join(" / ")}`,
    `# 窓 ${windows} / 起動 ${fires}`,
    "",
  ];
  const blob = new Blob([header.concat(lines).join("\n")], {
    type: "text/plain;charset=utf-8",
  });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wake-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearLog(): void {
  entries.length = 0;
  fires = 0;
  windows = 0;
  startedAt = Date.now();
  el.log.replaceChildren();
  tickStats();
}

function setOn(on: boolean): void {
  el.toggle.textContent = on ? "マイクを閉じる" : "マイクを開く";
  el.toggle.dataset.on = on ? "1" : "0";
  tickStats();
}

/** `npm run dev:lan` は HTTPS なので wss になる。 */
function wsUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws?mode=wake`;
}

function show(message: string): void {
  el.notice.textContent = message;
  el.notice.hidden = false;
}

function hideNotice(): void {
  el.notice.hidden = true;
}

function text(value: string): Text {
  return document.createTextNode(value);
}

function strong(value: string): HTMLElement {
  const node = document.createElement("strong");
  node.textContent = value;
  return node;
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`要素が見つかりません: ${id}`);
  return found;
}
