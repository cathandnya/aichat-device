/**
 * 履歴の画面。**読むだけ。**
 *
 * チャットの画面（main.ts）から履歴を外して、実機（Pi + 液晶）に
 * 近づけた。その受け皿がここ。話す仕掛けは一切持たない
 * （マイクも WebSocket も読み上げも読み込まない）。
 *
 * 題名も本文も上流の AI や音声認識から来た文字列なので、
 * HTML を組み立てずに `createElement` + `textContent` で作る。
 */

import {
  deleteChat,
  fetchChat,
  fetchChats,
  type ChatSummary,
  type ChatTurn,
} from "./api/client.ts";

const el = {
  list: byId("list"),
  detail: byId("detail"),
  count: byId("count"),
};

let chats: ChatSummary[] = [];
let selected: string | null = null;

void start();

async function start(): Promise<void> {
  await refresh();

  // 別の窓やデバイスで話したぶんを、戻ってきたときに拾う。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
}

async function refresh(): Promise<void> {
  chats = await fetchChats();
  el.count.textContent = chats.length ? `${chats.length} 件` : "";
  renderList();

  if (selected && !chats.some((c) => c.id === selected)) {
    selected = null;
    showEmpty("選んでいたチャットは消えています。");
    return;
  }
  // 最初に開いたときは一番新しいものを出す。空の画面を見せない。
  if (!selected && chats[0]) void open(chats[0].id);
}

function renderList(): void {
  const items = chats.map((chat) => {
    const li = document.createElement("li");
    if (chat.id === selected) li.dataset.current = "1";

    const button = document.createElement("button");
    button.type = "button";

    const title = document.createElement("span");
    title.className = "title";
    // デバイスで話したものが分かるようにしておく。
    title.textContent = `${chat.origin === "device" ? "🎙 " : ""}${chat.title}`;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${when(chat.startedAt)}・${chat.turns} 発言`;

    button.append(title, meta);
    button.addEventListener("click", () => void open(chat.id));
    li.append(button);
    return li;
  });

  el.list.replaceChildren(...items);
}

async function open(id: string): Promise<void> {
  selected = id;
  renderList();

  const chat = await fetchChat(id);
  if (!chat) {
    showEmpty("読み込めませんでした。");
    return;
  }

  const summary = chats.find((c) => c.id === id);

  const head = document.createElement("div");
  head.className = "detail-head";

  const title = document.createElement("h2");
  title.textContent = chat.title;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [
    summary ? when(summary.startedAt) : "",
    summary?.origin === "device" ? "デバイス" : "ブラウザ",
    `${chat.turns.length} 発言`,
  ]
    .filter(Boolean)
    .join("・");

  head.append(title, meta, removeButton(id, chat.title));

  const turns = document.createElement("div");
  turns.className = "turns";
  for (const turn of chat.turns) turns.append(renderTurn(turn));

  el.detail.replaceChildren(head, turns);
}

function renderTurn(turn: ChatTurn): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "turn";
  wrap.dataset.role = turn.role;

  const who = document.createElement("div");
  who.className = "who";
  who.textContent = turn.role === "user" ? "質問" : "回答";

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = turn.content;

  wrap.append(who, body);

  if (turn.sources?.length) {
    const list = document.createElement("ul");
    list.className = "sources";
    for (const source of turn.sources) {
      const item = document.createElement("li");
      // リンクにしない。どこを見たかが分かればよい。
      item.textContent = source.title;
      list.append(item);
    }
    wrap.append(list);
  }
  return wrap;
}

/**
 * 消すボタン。**2回押させる。**
 *
 * 読み返している最中に一度で消えると取り返しがつかない
 * （家族の会話が入っている）。
 */
function removeButton(id: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "remove";
  button.textContent = "消す";

  button.addEventListener("click", () => {
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = `「${title}」を消す`;
      setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.armed = "0";
        button.textContent = "消す";
      }, 5_000);
      return;
    }
    void remove(id);
  });
  return button;
}

async function remove(id: string): Promise<void> {
  if (!(await deleteChat(id))) return;
  selected = null;
  showEmpty("消しました。");
  await refresh();
}

function showEmpty(message: string): void {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = message;
  el.detail.replaceChildren(p);
}

/** 日付は今日かどうかで出し分ける。並んだときに読みやすい。 */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";

  const time = at.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();

  if (sameDay) return time;
  return `${at.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })} ${time}`;
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`要素が見つかりません: ${id}`);
  return found;
}
