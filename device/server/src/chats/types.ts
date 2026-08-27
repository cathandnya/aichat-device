/** チャット（会話の単位）。 */

import type { Source } from "../ws/protocol.ts";

/** どこから始まったか。デバイスと Web UI で履歴は共有する。 */
export const CHAT_ORIGINS = ["device", "web"] as const;
export type ChatOrigin = (typeof CHAT_ORIGINS)[number];

/**
 * 何で終わったか。進行中は null。
 *
 * 記録しておくと、あとから「窓が短すぎないか」「終了語が誤爆していないか」を
 * 見返せる。設定を調整する材料になる。
 */
export const CHAT_END_REASONS = [
  "timeout", // 追い質問の窓が無言で閉じた
  "phrase", // 終了語が聞こえた
  "wake", // ウェイクワードで仕切り直された
  "limit", // 往復数か時間の上限
  "error", // 失敗した
  "manual", // Web UI の「新しいチャット」
] as const;
export type ChatEndReason = (typeof CHAT_END_REASONS)[number];

export interface Turn {
  role: "user" | "assistant";
  content: string;
  /** ISO8601 */
  at: string;
  /** assistant のみ。Gemini が検索したときに付く。 */
  sources?: Source[];
}

export interface Chat {
  /** `YYYYMMDD-HHMMSS-xxxx`。**先頭が時刻なので、名前の順＝時系列。** */
  id: string;
  startedAt: string;
  updatedAt: string;
  origin: ChatOrigin;
  /** 最初の質問の冒頭。AI には作らせない（課金と遅延を増やさないため）。 */
  title: string;
  endedBy: ChatEndReason | null;
  turns: Turn[];
}

/** 一覧に出す分。本文は含めない。 */
export interface ChatSummary {
  id: string;
  startedAt: string;
  updatedAt: string;
  origin: ChatOrigin;
  title: string;
  endedBy: ChatEndReason | null;
  turns: number;
}

/** 題名に使う長さ。一覧で読めればよい。 */
export const TITLE_MAX_LENGTH = 24;

export function titleFrom(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "（無題）";
  return trimmed.length <= TITLE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
}
