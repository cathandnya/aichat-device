/**
 * 製氷機タンクの水（water-level への問い合わせ）。
 *
 * **本物のセンサーは呼ばない。** 偽のサーバーを立てて、
 * 有無を読めるか、分からないときに「無い」と断言しないかを見る。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { readWater } from "../src/house/water.ts";

/** 偽の water-level。 */
async function startFake(body: unknown): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("水があるとき", async () => {
  const fake = await startFake({ water: true, notifyEnabled: true, emptyForMs: 0 });
  try {
    assert.equal(await readWater(fake.url), true);
  } finally {
    await fake.close();
  }
});

test("水が無いとき", async () => {
  const fake = await startFake({ water: false, notifyEnabled: true, emptyForMs: 300000 });
  try {
    assert.equal(await readWater(fake.url), false);
  } finally {
    await fake.close();
  }
});

test("water が無い応答を「水なし」と断言しない", async () => {
  // **false ではなく null。** 欠けたキーを偽として扱うと、
  // 分からないだけなのに「水がありません」と言い切ってしまう。
  const fake = await startFake({ notifyEnabled: true });
  try {
    assert.equal(await readWater(fake.url), null);
  } finally {
    await fake.close();
  }
});

test("繋がらなくても投げない", async () => {
  // 冷蔵庫の中の ESP32 は落ちていることがある。**会話ごと落ちてはいけない。**
  assert.equal(await readWater("http://127.0.0.1:1"), null);
});

test("URL が空なら何もせず null", async () => {
  assert.equal(await readWater(""), null);
});
