/**
 * 家の消費電力（house_power への問い合わせ）。
 *
 * **本物の house_power は呼ばない。** 偽のサーバーを立てて、
 * 値を読めるか、繋がらないときに落ちないかを見る。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { readPower } from "../src/house/power.ts";

/** 偽の house_power。 */
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

test("いまの電力を読む", async () => {
  const fake = await startFake({
    instant_power: 647,
    timestamp: "2026-09-01T10:03:54.828922",
  });
  try {
    assert.equal(await readPower(fake.url), 647);
  } finally {
    await fake.close();
  }
});

test("メーターと繋がる前の null を 0 と混ぜない", async () => {
  const fake = await startFake({ instant_power: null, timestamp: null });
  try {
    assert.equal(await readPower(fake.url), null);
  } finally {
    await fake.close();
  }
});

test("繋がらなくても投げない", async () => {
  // 誰も待ち受けていないポート。**会話ごと落ちてはいけない。**
  assert.equal(await readPower("http://127.0.0.1:1"), null);
});

test("URL が空なら何もせず null", async () => {
  assert.equal(await readPower(""), null);
});
