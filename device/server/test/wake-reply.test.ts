/**
 * 名前を呼ばれただけのときの振る舞い。
 *
 * **既定は効果音だけで返事をしない**（アレクサに合わせた）。
 * 声で返すと、続けて話そうとしているところに被る。
 *
 * ここで確かめたいのは**窓が開くか**の一点。返事をしないと
 * `speaking` に入らないので、鳴り終わりを合図にしている経路
 * （`onSpoken` / `armSpokenFallback`）が素通りする。開け忘れると
 * **音は鳴るのに何も聞いていない**機械になる。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.AICHAT_DATA_DIR = mkdtempSync(join(tmpdir(), "aichat-wakereply-"));

const { readConfig, writeConfig } = await import("../src/store.ts");
const { Session } = await import("../src/ws/session.ts");

interface Sent {
  type: string;
  state?: string;
}

function run(wakeReply: string): { states: string[]; types: string[] } {
  writeConfig({ ...readConfig(), wakeReply });
  const sent: Sent[] = [];
  const session = new Session(
    { mode: "stub", voicevoxUrl: "", speakerId: 3 } as never,
    { send: (m: unknown) => sent.push(m as Sent), sendAudio: async () => {} },
    "dev-wakereply",
  );
  const inner = session as unknown as {
    startChat(): void;
    acknowledge(): Promise<void>;
    dispose(): void;
  };
  inner.startChat();
  void inner.acknowledge();
  inner.dispose();
  return {
    states: sent.filter((m) => m.type === "state").map((m) => m.state ?? ""),
    types: sent.map((m) => m.type),
  };
}

test("既定は返事をしない", () => {
  // 設定を触っていない状態が「効果音だけ」であること。
  assert.equal(readConfig().wakeReply, "");
});

test("**返事をしなくても窓が開く**", () => {
  const { states, types } = run("");
  assert.ok(states.includes("following"), `窓が開いていない: ${states}`);
  // 鳴らさないので speaking には入らない。
  assert.ok(!states.includes("speaking"), `喋ってしまっている: ${states}`);
  // 鳴らすものが無いので終わりの合図も要らない。
  assert.ok(!types.includes("speech-end"), "鳴らしていないのに speech-end");
});

test("返事を設定すれば喋る", () => {
  // 何か言わせたい人のために、経路は残してある。
  const { states } = run("はい？");
  assert.ok(states.includes("speaking"), `喋っていない: ${states}`);
});
