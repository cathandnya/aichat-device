/**
 * PC の電源（pc_power への問い合わせと操作）。
 *
 * **本物の装置は呼ばない。** 偽のサーバーを立てて、押すべきときに
 * 押し、押してはいけないときに押さないかを見る。
 *
 * ここは**唯一 物を動かす道具**なので、見たいのは「動くか」より
 * 「余計に動かさないか」のほう。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { pressPcPower, readPcPower } from "../src/house/pc.ts";

/** 偽の pc_power。**叩かれた道を覚える。** */
async function startFake(
  status: unknown,
): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/status" ? status : { status: "toggle_sent" }));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const OFF = { pc_power: false, hdd_active: false, beep: false, busy: false };
const ON = { pc_power: true, hdd_active: false, beep: false, busy: false };

test("電源の状態を読む", async () => {
  const on = await startFake(ON);
  try {
    assert.equal(await readPcPower(on.url), true);
  } finally {
    await on.close();
  }

  const off = await startFake(OFF);
  try {
    assert.equal(await readPcPower(off.url), false);
  } finally {
    await off.close();
  }
});

test("切れているとき「点けて」なら押す", async () => {
  const fake = await startFake(OFF);
  try {
    const result = await pressPcPower(fake.url, "on");
    assert.deepEqual(result, { ok: true, pressed: true, want: "on" });
    assert.ok(fake.hits.includes("/power/toggle"), "押していない");
  } finally {
    await fake.close();
  }
});

test("**入っているとき「点けて」なら押さない**", async () => {
  // 言われたまま押すと消えてしまう。仕事が消える向きの間違い。
  const fake = await startFake(ON);
  try {
    const result = await pressPcPower(fake.url, "on");
    assert.deepEqual(result, { ok: true, pressed: false, want: "on" });
    assert.ok(!fake.hits.includes("/power/toggle"), "押してしまった");
  } finally {
    await fake.close();
  }
});

test("**切れているとき「消して」なら押さない**", async () => {
  const fake = await startFake(OFF);
  try {
    const result = await pressPcPower(fake.url, "off");
    assert.deepEqual(result, { ok: true, pressed: false, want: "off" });
    assert.ok(!fake.hits.includes("/power/toggle"), "押してしまった");
  } finally {
    await fake.close();
  }
});

test("入っているとき「消して」なら押す", async () => {
  const fake = await startFake(ON);
  try {
    const result = await pressPcPower(fake.url, "off");
    assert.deepEqual(result, { ok: true, pressed: true, want: "off" });
    assert.ok(fake.hits.includes("/power/toggle"), "押していない");
  } finally {
    await fake.close();
  }
});

test("**状態が読めないときは押さない**", async () => {
  // 向きが分からないまま押すと、点けるつもりで消すことになる。
  const fake = await startFake({ hdd_active: false });
  try {
    const result = await pressPcPower(fake.url, "on");
    assert.deepEqual(result, { ok: false, reason: "電源の装置に繋がりません" });
    assert.ok(!fake.hits.includes("/power/toggle"), "押してしまった");
  } finally {
    await fake.close();
  }
});

test("操作中なら押さない", async () => {
  const fake = await startFake({ ...OFF, busy: true });
  try {
    const result = await pressPcPower(fake.url, "on");
    assert.deepEqual(result, { ok: false, reason: "いま別の操作をしています" });
    assert.ok(!fake.hits.includes("/power/toggle"), "押してしまった");
  } finally {
    await fake.close();
  }
});

test("繋がらなくても投げない。押しもしない", async () => {
  assert.equal(await readPcPower("http://127.0.0.1:1"), null);
  const result = await pressPcPower("http://127.0.0.1:1", "on");
  assert.equal(result.ok, false);
});

test("URL が空なら何もしない", async () => {
  assert.equal(await readPcPower(""), null);
  const result = await pressPcPower("", "on");
  assert.equal(result.ok, false);
});

test("**強制停止の口は叩かない**", async () => {
  // /power/off は電源ピンを5秒押す（＝OS に断らず切る）。
  // /reset も同じ。どちらも声から届いてはいけない。
  const fake = await startFake(ON);
  try {
    await pressPcPower(fake.url, "off");
    assert.ok(!fake.hits.some((h) => h === "/power/off" || h === "/reset"), fake.hits.join(","));
  } finally {
    await fake.close();
  }
});
