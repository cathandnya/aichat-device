/**
 * 音声認識の検証。**本物の上流は呼ばない**。
 *
 * Workers AI のバインディングをやめて上流を直接呼ぶ形にしたので、
 * 「鍵の渡し方」と「返り値の取り出し方」がここで守られる。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const DATA_DIR = mkdtempSync(join(tmpdir(), "aichat-stt-"));
process.env.AICHAT_DATA_DIR = DATA_DIR;

const { createApp } = await import("../src/app.ts");
const { startUpstreamMock } = await import("./upstream-mock.ts");
const { DEFAULT_CONFIG, STT_MODELS, isSttModel, sttVendor, MAX_AUDIO_BYTES } =
  await import("../src/ai/types.ts");

type Config = Parameters<typeof createApp>[0];

const GEMINI_KEY = "gemini-test-key";

function setConfig(patch: Record<string, unknown>): void {
  writeFileSync(
    join(DATA_DIR, "config.json"),
    JSON.stringify({ ...DEFAULT_CONFIG, ...patch }),
  );
}

function configFor(url: string): Config {
  return {
    mode: "live",
    host: "127.0.0.1",
    port: 0,
    anthropicApiKey: "test-anthropic-key",
    geminiApiKey: GEMINI_KEY,
    openaiApiKey: "",
    whisperUrl: url,
    appleSpeechUrl: url,
    adminPassword: "pw",
    adminSessionSecret: "secret",
    geminiModelsEndpoint: "",
    geminiBaseUrl: url,
    anthropicBaseUrl: url,
    voicevoxUrl: "",
    voicevoxSpeaker: 3,
    stubSaveAudio: false,
    stubTranscript: "",
  };
}

/** 1秒ぶんの音声に見えるバイト列。 */
const oneSecond = (): ArrayBuffer => new ArrayBuffer(16_000 * 2);

// --- macOS の音声認識（ohr 経由）---

test("macOS の音声認識で書き起こせる", async () => {
  setConfig({ sttModel: "apple-speech" });

  const upstream = await startUpstreamMock({ appleText: "駅までの行き方は" });
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    assert.deepEqual(await response.json(), { text: "駅までの行き方は" });
    assert.equal(upstream.received.at(-1)?.path, "/v1/audio/transcriptions");
  } finally {
    await upstream.close();
  }
});

test("日本語の途中に入る余計な空白を詰める", async () => {
  // SpeechAnalyzer は語の区切りごとに空白を入れてくる。
  setConfig({ sttModel: "apple-speech" });

  const upstream = await startUpstreamMock({
    appleText: "明日の天気 を教 えて",
  });
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    assert.deepEqual(await response.json(), { text: "明日の天気を教えて" });
  } finally {
    await upstream.close();
  }
});

test("英数字どうしの空白は残す", async () => {
  // 全部詰めると「hello world」まで壊れる。
  setConfig({ sttModel: "apple-speech" });

  const upstream = await startUpstreamMock({
    appleText: "hello world と 150 グラム",
  });
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    const { text } = (await response.json()) as { text: string };
    assert.ok(text.includes("hello world"), text);
    assert.ok(text.includes("150グラム"), text);
  } finally {
    await upstream.close();
  }
});

test("ohr が居なければその旨を返す", async () => {
  setConfig({ sttModel: "apple-speech" });

  const upstream = await startUpstreamMock({});
  try {
    const app = createApp({ ...configFor(upstream.url), appleSpeechUrl: "" });
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /APPLE_SPEECH_URL/);
  } finally {
    await upstream.close();
  }
});

// --- ローカル（whisper.cpp）---

test("ローカルの whisper で書き起こせる", async () => {
  setConfig({ sttModel: "local-whisper" });

  const upstream = await startUpstreamMock({ whisperText: "駅までの行き方は" });
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    assert.deepEqual(await response.json(), { text: "駅までの行き方は" });
    assert.equal(upstream.received.at(-1)?.path, "/inference");
  } finally {
    await upstream.close();
  }
});

test("無音に対する whisper の作り話は捨てる", async () => {
  // whisper は無音に対して学習データ由来の定型句を返すことがある。
  // そのまま AI に投げると見当違いの回答が返る。
  setConfig({ sttModel: "local-whisper" });

  for (const hallucination of [
    "ご視聴ありがとうございました。",
    "（音楽）",
    "[BLANK_AUDIO]",
    "   ",
  ]) {
    const upstream = await startUpstreamMock({ whisperText: hallucination });
    try {
      const app = createApp(configFor(upstream.url));
      const response = await app.request("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: oneSecond(),
      });
      assert.deepEqual(await response.json(), { text: "" }, hallucination);
    } finally {
      await upstream.close();
    }
  }
});

test("本当の発話は作り話と誤判定しない", async () => {
  setConfig({ sttModel: "local-whisper" });

  const upstream = await startUpstreamMock({
    whisperText: "ご視聴ありがとうございましたと言っていた番組の名前を教えて",
  });
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });
    const { text } = (await response.json()) as { text: string };
    assert.ok(text.length > 0, "本当の発話を消してしまっている");
  } finally {
    await upstream.close();
  }
});

test("whisper-server が居なければその旨を返す", async () => {
  setConfig({ sttModel: "local-whisper" });

  const upstream = await startUpstreamMock({});
  try {
    const app = createApp({ ...configFor(upstream.url), whisperUrl: "" });
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /WHISPER_URL/);
  } finally {
    await upstream.close();
  }
});

// --- クラウド ---

test("音声を送ると書き起こしが返る", async () => {
  setConfig({ sttModel: "gemini-flash-latest" });

  const upstream = await startUpstreamMock({});
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    assert.deepEqual(await response.json(), { text: "明日の天気は" });
    assert.equal(response.headers.get("X-AIChatDevice-STT-Model"), "gemini-flash-latest");
  } finally {
    await upstream.close();
  }
});

test("思考のパートは書き起こしに混ざらない", async () => {
  // Gemini は汎用モデルなので、書き起こし以外を返しうる。
  setConfig({ sttModel: "gemini-flash-latest" });

  const upstream = await startUpstreamMock({});
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    const { text } = (await response.json()) as { text: string };
    assert.ok(!text.includes("考え中"), text);
  } finally {
    await upstream.close();
  }
});

test("鍵はヘッダで渡し、URL には載せない", async () => {
  setConfig({ sttModel: "gemini-flash-latest" });

  const upstream = await startUpstreamMock({});
  try {
    const app = createApp(configFor(upstream.url));
    await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    const sent = upstream.received.at(-1);
    assert.equal(sent?.headers["x-goog-api-key"], GEMINI_KEY);
    assert.ok(!sent?.path.includes(GEMINI_KEY), sent?.path);
  } finally {
    await upstream.close();
  }
});

test("鍵が無ければ上流を呼ばずに断る", async () => {
  // 音声認識に OpenAI を選んだのに鍵が無い場合。管理UIで戻せる旨を伝える。
  setConfig({ sttModel: "gpt-4o-transcribe" });

  const upstream = await startUpstreamMock({});
  try {
    const app = createApp(configFor(upstream.url));
    const response = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: oneSecond(),
    });

    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /OPENAI_API_KEY/);
    assert.equal(upstream.received.length, 0);
  } finally {
    await upstream.close();
  }
});

test("空・大きすぎる音声は上流を呼ばずに断る", async () => {
  setConfig({ sttModel: "gemini-flash-latest" });

  const upstream = await startUpstreamMock({});
  try {
    const app = createApp(configFor(upstream.url));

    const empty = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new ArrayBuffer(0),
    });
    assert.equal(empty.status, 400);

    const huge = await app.request("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new ArrayBuffer(MAX_AUDIO_BYTES + 1),
    });
    assert.equal(huge.status, 413);

    assert.equal(upstream.received.length, 0);
  } finally {
    await upstream.close();
  }
});

// --- 許可リスト ---

test("許可リストにあるモデルだけが通る", () => {
  for (const model of STT_MODELS) assert.equal(isSttModel(model), true, model);
  for (const value of ["@cf/openai/whisper-large-v3-turbo", "whisper", "", null, 1]) {
    assert.equal(isSttModel(value), false, String(value));
  }
});

test("モデルからどこで動かすか分かる", () => {
  assert.equal(sttVendor("apple-speech"), "apple");
  assert.equal(sttVendor("local-whisper"), "local");
  assert.equal(sttVendor("gemini-flash-latest"), "gemini");
  assert.equal(sttVendor("gpt-4o-transcribe"), "openai");
  assert.equal(sttVendor("whisper-1"), "openai");
});

test("上限は 16kHz mono 16bit でおよそ 30 秒ぶん", () => {
  // 画面側の録音の打ち切り時間（20秒）を決める根拠。
  const seconds = MAX_AUDIO_BYTES / (16_000 * 2);
  assert.ok(seconds > 25 && seconds < 35, String(seconds));
});
