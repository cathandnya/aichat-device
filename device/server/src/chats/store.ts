/**
 * チャット履歴の保存。**1チャット1ファイル。**
 *
 * ### なぜデータベースにしないか
 *
 * 保存上限（200件）で実測したところ、合計 250KB・一覧 12ms・全文検索 4.2ms
 * だった。この規模でデータベースが解く問題（索引・同時書き込み・複雑な検索）が
 * 存在しない。書き手は単一プロセスの Node 1つだけ。
 *
 * ファイルにしておくと `cat` や `jq` で中身を読めるのが実際に効く。
 * 既存の設定・モデル一覧と同じ作法（data.ts）で書けるのも大きい。
 *
 * 件数が 1,000 を超えるか、全文検索が主要機能になったら考え直す
 * （`node:sqlite` が依存なしで使えるので、そのときの移行は重くない）。
 *
 * ### 索引ファイルを持たない
 *
 * 一覧はディレクトリを舐めて作る。索引を別に持つと本体と食い違いうるが、
 * 12ms で済む以上その二重管理を抱える理由がない。
 * **ディレクトリが唯一の真実。**
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { dataPath, readJsonSafe, writeJsonAtomic } from "../data.ts";
import {
  CHAT_END_REASONS,
  CHAT_ORIGINS,
  titleFrom,
  type Chat,
  type ChatEndReason,
  type ChatOrigin,
  type ChatSummary,
  type Turn,
} from "./types.ts";

/** 残す件数。超えたら古いものから消す。 */
export const CHAT_RETENTION = 200;

/** 1つのチャットに入る往復の上限。安全弁。 */
export const MAX_TURNS = 10;

/** 1つのチャットが続けられる時間。安全弁。 */
export const MAX_CHAT_MINUTES = 5;

const DIR = dataPath("chats");

function pathOf(id: string): string {
  return join(DIR, `${id}.json`);
}

/**
 * id を作る。`YYYYMMDD-HHMMSS-xxxx`。
 *
 * 先頭を時刻にするのは、**ファイル名の並び順が時系列になる**ため。
 * 一覧の並べ替えが名前だけで済み、中身を開かなくても新旧が分かる。
 * 末尾の乱数は、同じ秒に2つ始まったときの衝突よけ。
 */
export function newChatId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

/**
 * 保存された 1 件を、形を確かめてから返す。壊れていれば null。
 *
 * 要素単位で捨てるのは、1 つの turn の破損で会話全体を失わないため
 * （設定の readConfig と同じ考え方）。
 */
function parseChat(raw: unknown): Chat | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;

  if (typeof c.id !== "string" || !c.id) return null;
  if (!Array.isArray(c.turns)) return null;

  const turns: Turn[] = [];
  for (const t of c.turns) {
    if (!t || typeof t !== "object") continue;
    const turn = t as Record<string, unknown>;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    if (typeof turn.content !== "string") continue;
    turns.push({
      role: turn.role,
      content: turn.content,
      at: typeof turn.at === "string" ? turn.at : "",
      ...(Array.isArray(turn.sources) ? { sources: turn.sources as never } : {}),
    });
  }

  const origin = (CHAT_ORIGINS as readonly string[]).includes(c.origin as string)
    ? (c.origin as ChatOrigin)
    : "web";
  const endedBy = (CHAT_END_REASONS as readonly string[]).includes(
    c.endedBy as string,
  )
    ? (c.endedBy as ChatEndReason)
    : null;

  return {
    id: c.id,
    startedAt: typeof c.startedAt === "string" ? c.startedAt : "",
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
    origin,
    title: typeof c.title === "string" && c.title ? c.title : "（無題）",
    endedBy,
    turns,
  };
}

export function readChat(id: string): Chat | null {
  if (!isSafeId(id)) return null;
  return parseChat(readJsonSafe(pathOf(id)));
}

/**
 * 一覧。新しい順。
 *
 * ファイル名が時系列なので、名前で降順に並べてから読む。
 * 壊れた 1 件は飛ばす（一覧全体を失わない）。
 */
export function listChats(limit = CHAT_RETENTION): ChatSummary[] {
  if (!existsSync(DIR)) return [];

  const names = readdirSync(DIR)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);

  const out: ChatSummary[] = [];
  for (const name of names) {
    const chat = parseChat(readJsonSafe(join(DIR, name)));
    if (!chat) continue;
    out.push({
      id: chat.id,
      startedAt: chat.startedAt,
      updatedAt: chat.updatedAt,
      origin: chat.origin,
      title: chat.title,
      endedBy: chat.endedBy,
      turns: chat.turns.length,
    });
  }
  return out;
}

export function createChat(origin: ChatOrigin, now = new Date()): Chat {
  const at = now.toISOString();
  const chat: Chat = {
    id: newChatId(now),
    startedAt: at,
    updatedAt: at,
    origin,
    title: "（無題）",
    endedBy: null,
    turns: [],
  };
  save(chat);
  prune();
  return chat;
}

/** 1 発言を足す。最初の質問で題名が決まる。 */
export function appendTurn(id: string, turn: Turn): Chat | null {
  const chat = readChat(id);
  if (!chat) return null;

  chat.turns.push(turn);
  chat.updatedAt = turn.at || new Date().toISOString();
  if (chat.title === "（無題）" && turn.role === "user") {
    chat.title = titleFrom(turn.content);
  }
  save(chat);
  return chat;
}

export function endChat(id: string, endedBy: ChatEndReason): void {
  const chat = readChat(id);
  if (!chat) return;
  chat.endedBy = endedBy;
  chat.updatedAt = new Date().toISOString();
  save(chat);
}

export function deleteChat(id: string): boolean {
  if (!isSafeId(id) || !existsSync(pathOf(id))) return false;
  rmSync(pathOf(id));
  return true;
}

/** 上限を超えた古いものを消す。 */
export function prune(limit = CHAT_RETENTION): number {
  if (!existsSync(DIR)) return 0;

  const names = readdirSync(DIR).filter((n) => n.endsWith(".json")).sort();
  const over = names.length - limit;
  if (over <= 0) return 0;

  for (const name of names.slice(0, over)) {
    rmSync(join(DIR, name), { force: true });
  }
  return over;
}

/** 保存された発言を、AI に渡す形にする。 */
export function messagesOf(chat: Chat): { role: string; content: string }[] {
  return chat.turns.map((t) => ({ role: t.role, content: t.content }));
}

/** 上限に達しているか。往復か時間のどちらか。 */
export function reachedLimit(chat: Chat, now = Date.now()): boolean {
  if (chat.turns.length >= MAX_TURNS * 2) return true;

  const started = Date.parse(chat.startedAt);
  if (!Number.isNaN(started) && now - started >= MAX_CHAT_MINUTES * 60_000) {
    return true;
  }
  return false;
}

function save(chat: Chat): void {
  mkdirSync(DIR, { recursive: true });
  writeJsonAtomic(pathOf(chat.id), chat);
}

/**
 * id がファイル名として安全か。
 *
 * id は URL のパスから来る（`/api/chats/:id`）。`..` や `/` を弾かないと
 * `data/` の外を読み書きされる。
 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(id);
}
