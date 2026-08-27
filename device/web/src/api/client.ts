/**
 * ローカルサーバー（/api/*）の呼び出し。
 *
 * AI を直接叩かないのは、鍵をブラウザに置かないためと、`getUserMedia` が
 * localhost でしか動かないため。画面もローカルサーバーが配っているので、
 * すべて同一オリジンで済む。
 *
 * **回答を作る経路はここに無い。** 画面から「話す」ボタンを外し、
 * 声のやりとりは WebSocket（api/device.ts）に一本化した。
 * 文を切るのも読み上げるのもサーバー側の仕事で、ブラウザは
 * 届いた音を鳴らすだけになっている。
 */

/** 回答の裏付けに使われたページ。 */
export interface Source {
  uri: string;
  title: string;
}

/** 動作モード。画面の隅に出して、本番と取り違えないようにする。 */
export async function fetchHealth(): Promise<{ mode: string; tts: string } | null> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return null;
    return (await response.json()) as { mode: string; tts: string };
  } catch {
    return null;
  }
}

// --- チャットの履歴 ---

export interface ChatSummary {
  id: string;
  startedAt: string;
  updatedAt: string;
  origin: "device" | "web";
  /** どの端末で話したか。名乗らなかったものは "unknown"、古い記録は空。 */
  deviceId: string;
  title: string;
  endedBy: string | null;
  turns: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
  sources?: Source[];
}

export interface Chat extends ChatSummary {
  turns: never;
}

/** 一覧。新しい順。取れなければ空。`device` を渡すとその端末のぶんだけ。 */
export async function fetchChats(device?: string): Promise<ChatSummary[]> {
  try {
    const query = device ? `?device=${encodeURIComponent(device)}` : "";
    const response = await fetch(`/api/chats${query}`);
    if (!response.ok) return [];
    return ((await response.json()) as { chats: ChatSummary[] }).chats;
  } catch {
    return [];
  }
}

/** 1件の全文。 */
export async function fetchChat(
  id: string,
): Promise<{ id: string; title: string; turns: ChatTurn[] } | null> {
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    return (await response.json()) as never;
  } catch {
    return null;
  }
}

/** 消す。 */
export async function deleteChat(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}
