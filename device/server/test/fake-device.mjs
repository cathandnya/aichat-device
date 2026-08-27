/**
 * デバイスの代わり。実機を買う前に一周を確かめるためのもの。
 *
 * WAV を 80ms ずつ WebSocket に流し、返ってくる状態・文字・音声を表示する。
 *
 *     node test/fake-device.mjs <16kHz mono の wav> [話し終わったあとの無音の秒数]
 *
 * **AI を呼ばずに試すには**、偽の上流（test/upstream-mock.ts）を立てて
 * そちらを向いたサーバーを別ポートで起動する:
 *
 *     GEMINI_BASE_URL=<偽の上流> ANTHROPIC_BASE_URL=<偽の上流> \
 *       AICHAT_MODE=live PORT=9899 node src/main.ts
 *
 * `AICHAT_DEVICE_ID=living` を付けると、その端末として名乗る（実機と同じ）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const FRAME = 1280 * 2;
const [, , wavPath, ...rest] = process.argv;
const quietSec = Number(rest[0] ?? 3);

function pcmOf(path) {
  const buf = readFileSync(path);
  return buf.subarray(44); // WAV ヘッダを飛ばす
}

// **実機と同じ作法で名乗る。** 名乗らないと、同じ家の他のデバイスと
// 会話が混ざる（サーバーは「名前のない端末」として1つにまとめる）。
const deviceId = process.env.AICHAT_DEVICE_ID ?? "";
const query = deviceId ? `?device=${encodeURIComponent(deviceId)}` : "";
const ws = new WebSocket(`ws://127.0.0.1:9801/ws${query}`);
const started = Date.now();
const t = () => ((Date.now() - started) / 1000).toFixed(2).padStart(5);
let audioBytes = 0, audioCount = 0;

ws.on("open", async () => {
  console.log(`  ${t()}s  つながりました`);
  const speech = pcmOf(wavPath);
  const silence = Buffer.alloc(FRAME);

  // 発話の前に少し無音を流し、暗騒音を測らせる
  for (let i = 0; i < 12; i++) { ws.send(silence); await sleep(80); }
  for (let o = 0; o < speech.length; o += FRAME) {
    ws.send(speech.subarray(o, Math.min(o + FRAME, speech.length)));
    await sleep(80);
  }
  // 話し終わったあとの無音（VAD が終わりを判定する）
  const n = Math.ceil((quietSec * 1000) / 80);
  for (let i = 0; i < n; i++) { ws.send(silence); await sleep(80); }
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    audioBytes += data.length; audioCount++;
    writeFileSync(`/tmp/spoken-${audioCount}.wav`, data);
    console.log(`  ${t()}s  ♪ 音声 ${data.length} バイト → /tmp/spoken-${audioCount}.wav`);
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.type === "state")    console.log(`  ${t()}s  [${m.state}] ${m.status}`);
  if (m.type === "question") console.log(`  ${t()}s  聞き取り: 「${m.text}」`);
  if (m.type === "answer")   process.stdout.write(`\r  ${t()}s  回答: ${m.text.slice(0, 60)}`);
  if (m.type === "sources")  console.log(`\n  ${t()}s  出典: ${m.sources.map(s=>s.title).join(", ")}`);
  if (m.type === "error")    console.log(`\n  ${t()}s  ✕ ${m.message}`);
  if (m.type === "config")   console.log(`  ${t()}s  設定: ${m.provider}/${m.model} 語=${m.wakeWords.join("|")}`);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
setTimeout(() => { console.log(`\n  ${t()}s  終了（音声 ${audioCount} 個 / ${audioBytes} バイト）`); ws.close(); process.exit(0); }, 45000);
