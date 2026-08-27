/**
 * ウェイクワードの試験経路（?mode=wake）の確認。
 *
 * 本物のブラウザを使わずに、WAV を流して「起動すべき音で fired が来るか」
 * 「日常会話で来ないか」を見る。**AI は呼ばれない**ので費用はゼロ。
 *
 *     node test/wake-probe.mjs
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const PORT = process.env.PORT ?? 9801;
const FRAME = 1280 * 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pcm = (p) => readFileSync(p).subarray(44);

const CASES = [
  ["起動すべき", "/tmp/wake/16k-pos-0.wav", true],
  ["起動すべき", "/tmp/wake/16k-pos-3.wav", true],
  ["無視すべき", "/tmp/wake/16k-neg-0.wav", false],
  ["無視すべき", "/tmp/wake/16k-neg-8.wav", false],
];

let ok = 0;
for (const [label, path, want] of CASES) {
  const heard = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?mode=wake`);
  await new Promise((resolve) => {
    ws.on("open", async () => {
      ws.send(JSON.stringify({ type: "wake-words", words: ["ずんだもん", "すんだもん"] }));
      const silence = Buffer.alloc(FRAME);
      for (let i = 0; i < 14; i++) { ws.send(silence); await sleep(80); }
      const audio = pcm(path);
      for (let o = 0; o < audio.length; o += FRAME) {
        ws.send(audio.subarray(o, Math.min(o + FRAME, audio.length)));
        await sleep(80);
      }
      for (let i = 0; i < 26; i++) { ws.send(silence); await sleep(80); }
      ws.close();
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "heard") heard.push(m);
    });
    ws.on("close", resolve);
  });

  const fired = heard.some((h) => h.fired);
  const mark = fired === want ? "○" : "✕";
  if (fired === want) ok++;
  const texts = heard.filter((h) => h.text).map((h) => h.text).join(" / ");
  console.log(`  ${mark} ${label}  fired=${fired}  ${texts.slice(0, 48)}`);
}
console.log(`\n  ${ok}/${CASES.length} 期待どおり`);
