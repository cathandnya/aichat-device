/**
 * stub モードの /api/stt。音声は Workers AI に送らず、固定の文字列を返す。
 *
 * `STUB_SAVE_AUDIO=1` のときは受け取った WAV を `tmp/` に保存する。
 * **録音経路のデバッグはこれが一番速い。** 保存したファイルを
 *
 *     afinfo tmp/xxx.wav        16000Hz / 1ch / 16bit になっているか
 *     open  tmp/xxx.wav         語頭が切れていないか・無音判定が早すぎないか
 *
 * で確かめれば、Workers AI を一度も呼ばずに「ブラウザが正しい音を作れて
 * いるか」を確定できる。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "hono";

import type { Config } from "../config.ts";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tmp");

/** 本番と同じ上限。routes/stt.ts と揃えておく。 */
const MAX_AUDIO_BYTES = 1_000_000;

export async function handleStubStt(c: Context, config: Config): Promise<Response> {
  const audio = await c.req.arrayBuffer();

  // 断り方は本番（routes/stt.ts）と同じにする。ここだけ通ってしまうと、
  // 画面のエラー処理がスタブでは確かめられない。
  if (audio.byteLength === 0) {
    return c.json({ error: { message: "音声が空です。" } }, 400);
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return c.json({ error: { message: "音声が長すぎます。" } }, 413);
  }

  if (config.stubSaveAudio) {
    await save(audio).catch((error: unknown) => {
      // 保存に失敗しても検証は続けたい。
      console.error("[stub/stt] 保存できませんでした", error);
    });
  }

  // 音が短すぎるときは、本物と同じく空文字を返す。画面の
  // 「聞き取れませんでした」の経路を確かめられるようにする。
  // 16kHz mono 16bit で 0.3 秒ぶんに満たないもの。
  if (audio.byteLength < 16_000 * 2 * 0.3) {
    return c.json({ text: "" });
  }

  return c.json({ text: c.req.query("text") ?? config.stubTranscript });
}

async function save(audio: ArrayBuffer): Promise<void> {
  await mkdir(TMP, { recursive: true });

  const seconds = (audio.byteLength / (16_000 * 2)).toFixed(1);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(TMP, `${stamp}-${seconds}s.wav`);

  await writeFile(path, Buffer.from(audio));
  console.log(`[stub/stt] 保存しました: ${path}（${audio.byteLength} バイト）`);
}
