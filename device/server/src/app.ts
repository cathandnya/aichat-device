/**
 * ルーティングの組み立て。
 *
 * `serve()` と分けてあるのは、テストからポートを開かずに `app.request()` で
 * 叩けるようにするため。
 *
 * **圧縮ミドルウェアを入れないこと。** /api/chat の SSE が途中で
 * バッファされ、回答ができあがるまで画面に何も出なくなる。
 */

import { Hono } from "hono";
import type { Context } from "hono";

import {
  handleAdminConfigUpdate,
  handleAdminGeminiModelsRefresh,
  handleAdminLogin,
  handleAdminLogout,
  handleAdminRoot,
  type AdminDeps,
} from "./admin/ui.ts";
import { adminSecretsFrom, runtimeFrom, type Config } from "./config.ts";
import { handleChat } from "./routes/chat.ts";
import {
  handleCreateChat,
  handleDeleteChat,
  handleEndChat,
  handleGetChat,
  handleListChats,
} from "./routes/chats.ts";
import { handleConfig } from "./routes/config.ts";
import { handleStt } from "./routes/stt.ts";
import { synthesize } from "./speech/tts.ts";
import { handleTts } from "./routes/tts.ts";
import { handleStubChat } from "./stub/chat.ts";
import { handleStubConfig } from "./stub/config.ts";
import { handleStubStt } from "./stub/stt.ts";
import { mountStatic } from "./static.ts";

export function createApp(config: Config): Hono {
  const app = new Hono();
  const runtime = runtimeFrom(config);
  const adminDeps: AdminDeps = { secrets: adminSecretsFrom(config), runtime };

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    // 1リクエスト1行。**鍵は絶対に出さない**ので、ヘッダは記録しない。
    console.log(
      `${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - started}ms`,
    );
  });

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      tts: config.voicevoxUrl ? "voicevox" : "none",
    }),
  );

  const stub = config.mode === "stub";

  app.post("/api/chat", (c) => (stub ? handleStubChat(c) : handleChat(c, runtime)));
  app.post("/api/stt", (c) =>
    stub ? handleStubStt(c, config) : handleStt(c, runtime),
  );
  app.get("/api/config", (c) => (stub ? handleStubConfig(c) : handleConfig(c)));

  // 読み上げはスタブにしない。VOICEVOX はローカルで無料なので、
  // 本物を鳴らさないと文の区切り方や間の良し悪しを確かめられない。
  app.post("/api/tts", (c) => handleTts(c, config));

  // **試験用。** つながっている端末に任意の文を喋らせる。
  //
  // `AICHAT_AEC_PROBE=1` のときだけ生きる。読み上げ中に**自分の
  // ウェイクワードを鳴らして誤爆するか**を、音量を変えながら試す。
  // これが確かめられないと「自己起動しない」と言い切れない。
  // **試験用。** つながっている端末の音量を変える。
  // `AICHAT_AEC_PROBE=1` のときだけ生きる（試験用の口をまとめてある）。
  app.post("/api/volume-test", async (c) => {
    if (process.env.AICHAT_AEC_PROBE !== "1") return c.text("off", 404);
    const { getLiveSession } = await import("./ws/index.ts");
    const live = getLiveSession();
    if (!live) return c.text("端末がつながっていません", 503);
    const level = Number((await c.req.text()).trim());
    if (!Number.isFinite(level)) return c.text("0〜1 の数を送ってください", 400);
    live.session.setVolumeForTest(level);
    return c.json({ ok: true, level });
  });

  app.post("/api/aec-test", async (c) => {
    if (process.env.AICHAT_AEC_PROBE !== "1") return c.text("off", 404);
    const { getLiveSession } = await import("./ws/index.ts");
    const liveSession = getLiveSession();
    if (!liveSession) return c.text("端末がつながっていません", 503);
    const text = (await c.req.text()).trim() || "ずんだもん";
    const wav = await synthesize(text, config, AbortSignal.timeout(30_000));
    await liveSession.session.speakForTest(wav);
    return c.json({ ok: true, text, bytes: wav.byteLength });
  });

  // チャット履歴。**catch-all より前に置くこと。**
  app.get("/api/chats", handleListChats);
  app.post("/api/chats", handleCreateChat);
  app.get("/api/chats/:id", handleGetChat);
  app.delete("/api/chats/:id", handleDeleteChat);
  app.post("/api/chats/:id/end", handleEndChat);

  app.all("/api/*", notFound);

  // --- 管理UI（パスワード + Cookie セッション） ---
  //
  // 127.0.0.1 でしか待ち受けないので、外からは届かない。
  // 手元の機械から開きたいときは ssh -L 9801:127.0.0.1:9801。
  app.get("/admin", (c) => handleAdminRoot(c.req.raw, adminDeps));
  app.get("/admin/", (c) => handleAdminRoot(c.req.raw, adminDeps));
  app.post("/admin/login", (c) => handleAdminLogin(c.req.raw, adminDeps));
  app.post("/admin/logout", (c) => handleAdminLogout(c.req.raw));
  app.post("/admin/config", (c) => handleAdminConfigUpdate(c.req.raw, adminDeps));
  app.post("/admin/gemini-models", (c) =>
    handleAdminGeminiModelsRefresh(c.req.raw, adminDeps),
  );

  // API と管理UI より後に置く。先に置くと、それらが静的配信に食われる。
  mountStatic(app);

  return app;
}

function notFound(c: Context): Response {
  return c.json({ error: { message: "そのような API はありません。" } }, 404);
}
