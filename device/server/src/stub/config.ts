/**
 * stub モードの /api/config。
 *
 * 値は Worker の DEFAULT_CONFIG（worker/src/types.ts）に合わせてある。
 * 画面の表示を確かめるためだけのもの。
 */

import type { Context } from "hono";

export function handleStubConfig(c: Context): Response {
  return c.json({
    version: 0,
    provider: "claude",
    claudeModel: "claude-haiku-4-5",
    geminiModel: "gemini-3.6-flash",
    thinkingLevel: "minimal",
    sttModel: "@cf/openai/whisper-large-v3-turbo",
    answerLength: "standard",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}
