/**
 * 端末 id の検証。
 *
 * **保存できない環境でも動くこと**が要。プライベートウィンドウでは
 * localStorage が投げるので、ここで落ちると画面ごと開かなくなる。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeId, read } from "../src/api/device-id.ts";

/** 偽の localStorage。`throws` を立てると触った瞬間に投げる。 */
function fakeStorage(initial: Record<string, string> = {}, throws = false): Storage {
  const map = new Map(Object.entries(initial));
  const boom = () => {
    throw new Error("サイトデータが拒否されています");
  };
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (throws ? boom() : (map.get(k) ?? null)),
    setItem: (k: string, v: string) => {
      if (throws) boom();
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  } as Storage;
}

test("保存された id を読む", () => {
  assert.equal(read(fakeStorage({ "aichat-device-id": "living" })), "living");
});

test("保存が無ければ空", () => {
  assert.equal(read(fakeStorage()), "");
});

test("書き換えられた値は捨てる", () => {
  // devtools から触れる場所なので、サーバーに送る前に一度見る。
  for (const bad of ["../evil", "a/b", "-rf", "a b", "あ", "a".repeat(33)]) {
    assert.equal(read(fakeStorage({ "aichat-device-id": bad })), "", bad);
  }
});

test("localStorage に触れなくても落ちない", () => {
  // プライベートウィンドウやサイトデータの拒否。ここで投げると画面が開かない。
  assert.equal(read(null), "");
  assert.equal(read(fakeStorage({}, true)), "");
});

test("作る id はサーバーの規則に通る", () => {
  const safe = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
  for (let i = 0; i < 50; i += 1) {
    const id = makeId();
    assert.ok(id.startsWith("browser-"), id);
    assert.ok(safe.test(id), id);
  }
});
