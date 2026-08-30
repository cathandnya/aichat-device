/**
 * 音量の道具。
 *
 * **サーバーは段数を知らない。** 機種で違う（この端末は 15 段）ので、
 * 0〜1 の割合でやり取りし、段に落とすのは端末の仕事。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.AICHAT_DATA_DIR = mkdtempSync(join(tmpdir(), "aichat-volume-"));

const { Session } = await import("../src/ws/session.ts");
type ServerTools = import("../src/ai/chat.ts").ServerTools;

interface Sent {
  type: string;
  level?: number;
}

function make(): { session: InstanceType<typeof Session>; sent: Sent[]; tools: ServerTools } {
  const sent: Sent[] = [];
  const session = new Session(
    { mode: "stub", voicevoxUrl: "", speakerId: 3 } as never,
    { send: (m: unknown) => sent.push(m as Sent), sendAudio: async () => {} },
    "dev-volume",
  );
  // 道具は private なので、ここだけ覗く。
  const tools = (session as unknown as { tools(): ServerTools }).tools();
  return { session, sent, tools };
}

function levels(sent: Sent[]): number[] {
  return sent.filter((m) => m.type === "volume").map((m) => m.level ?? -1);
}

test("**基準が無いうちは増減できない**", async () => {
  // 端末から届く前は今の音量が分からない。「もう少し大きく」を
  // 適当な値から計算すると、いきなり爆音になる。
  const { session, sent, tools } = make();
  const result = await tools.execute("set_volume", { change: 0.2 });
  assert.deepEqual(result, { ok: false, reason: "いまの音量が分かりません" });
  assert.equal(levels(sent).length, 0, "端末に送ってしまっている");
  session.dispose();
});

test("基準が無くても、割合の指定なら効く", async () => {
  // 「最大にして」は今の音量を知らなくても答えられる。
  const { session, sent, tools } = make();
  const result = await tools.execute("set_volume", { level: 1 });
  assert.deepEqual(result, { ok: true, percent: 100 });
  assert.deepEqual(levels(sent), [1]);
  session.dispose();
});

test("端末が教えてきた値から増減する", async () => {
  const { session, sent, tools } = make();
  session.onVolume(0.4);

  assert.deepEqual(await tools.execute("get_volume", {}), {
    known: true,
    percent: 40,
  });
  assert.deepEqual(await tools.execute("set_volume", { change: 0.3 }), {
    ok: true,
    percent: 70,
  });
  assert.deepEqual(levels(sent), [0.7]);
  session.dispose();
});

test("**上と下で止まる**", async () => {
  // 0〜1 から出さない。出すと端末側の段数計算が壊れる。
  const { session, tools } = make();
  session.onVolume(0.9);
  assert.deepEqual(await tools.execute("set_volume", { change: 0.5 }), {
    ok: true,
    percent: 100,
  });
  assert.deepEqual(await tools.execute("set_volume", { level: -3 }), {
    ok: true,
    percent: 0,
  });
  session.dispose();
});

test("壊れた値は受け取らない", async () => {
  const { session, tools } = make();
  session.onVolume(0.5);
  const broken = (await tools.execute("set_volume", {
    level: Number.NaN,
  })) as { ok: boolean };
  assert.equal(broken.ok, false);
  // 端末からの報告も同じ。壊れた値で上書きしない。
  session.onVolume(Number.NaN);
  assert.deepEqual(await tools.execute("get_volume", {}), {
    known: true,
    percent: 50,
  });
  session.dispose();
});

test("教わる前は分からないと答える", async () => {
  const { session, tools } = make();
  assert.deepEqual(await tools.execute("get_volume", {}), { known: false });
  session.dispose();
});
