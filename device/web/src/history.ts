/**
 * 履歴の画面。**読むだけ。**
 *
 * チャットの画面（main.ts）から履歴を外して、実機（丸い小さな画面）に
 * 近づけた。その受け皿がここ。話す仕掛けは一切持たない
 * （マイクも WebSocket も読み上げも読み込まない）。
 *
 * **既定はこの端末のぶんだけ。** 居間のデバイスで寝室の会話を読み返す
 * 場面が思いつかないうえ、端末を分ける前の記録まで並んで邪魔になる。
 * 家じゅうを見返すのは `?all=1`（管理画面からの入口）。
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
import { deviceId } from "./api/device-id.ts";

const el = {
  list: byId("list"),
  detail: byId("detail"),
  count: byId("count"),
};

let chats: ChatSummary[] = [];
let selected: string | null = null;

/** すべての端末を見るか。管理画面からの入口だけが立てる。 */
const showAll = new URLSearchParams(location.search).get("all") === "1";

void start();

async function start(): Promise<void> {
  if (showAll) {
    document.title = "履歴（すべての端末）";
    byId("heading").textContent = "履歴（すべての端末）";
  }
  await refresh();

  // 別の窓やデバイスで話したぶんを、戻ってきたときに拾う。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
}

async function refresh(): Promise<void> {
  chats = await fetchChats(showAll ? undefined : deviceId());
  el.count.textContent = chats.length ? `${chats.length} 件` : "";
  renderList();

  if (!chats.length) {
    showEmpty(
      showAll ? "まだ何も話していません。" : "この端末ではまだ話していません。",
    );
  }
  if (selected && !chats.some((c) => c.id === selected)) {
    selected = null;
    showEmpty("選んでいたチャットは消えています。");
    return;
  }
  // 最初に開いたときは一番新しいものを出す。空の画面を見せない。
  if (!selected && chats[0]) void open(chats[0].id);
}

function renderList(): void {
  // 1台ぶんしか出さないときに見出しを立てても、同じ名前が1つ並ぶだけ。
  el.list.replaceChildren(
    ...(showAll ? groupsOf(chats).map(renderGroup) : chats.map(renderItem)),
  );
}

/**
 * 端末ごとにまとめる。
 *
 * `chats` は新しい順なので、**一度舐めて詰めるだけで並べ替えが要らない**。
 * Map は入れた順を覚えているので、見出しの順は「最近話した端末の順」になる。
 */
function groupsOf(items: ChatSummary[]): [string, ChatSummary[]][] {
  const groups = new Map<string, ChatSummary[]>();
  for (const chat of items) {
    const found = groups.get(chat.deviceId);
    if (found) found.push(chat);
    else groups.set(chat.deviceId, [chat]);
  }
  return Array.from(groups);
}

function renderGroup([id, items]: [string, ChatSummary[]]): HTMLElement {
  const group = document.createElement("section");
  group.className = "group";

  const head = document.createElement("h2");
  head.className = "group-head";
  head.textContent = `${deviceLabel(id)}・${items.length} 件`;

  const list = document.createElement("ul");
  list.className = "group-items";
  list.append(...items.map(renderItem));

  group.append(head, list);
  return group;
}

/**
 * 見出しに出す名前。
 *
 * 実機は自分で `living` のような id を名乗るので、そのまま出せば読める。
 * 名乗らなかったものと、端末を区別する前の記録には言葉を当てる。
 */
function deviceLabel(id: string): string {
  if (!id) return "端末を分ける前の記録";
  if (id === "unknown") return "名前のない端末";
  if (id === deviceId()) return `${id}（この端末）`;
  return id;
}

function renderItem(chat: ChatSummary): HTMLElement {
  const li = document.createElement("li");
  if (chat.id === selected) li.dataset.current = "1";

  const button = document.createElement("button");
  button.type = "button";

  const title = document.createElement("span");
  title.className = "title";
  // 見出しは「どの機械か」、こちらは「どの経路か」。意味が違うので両方出す。
  title.textContent = `${chat.origin === "device" ? "🎙 " : ""}${chat.title}`;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${when(chat.startedAt)}・${chat.turns} 発言`;

  button.append(title, meta);
  button.addEventListener("click", () => void open(chat.id));
  li.append(button);
  return li;
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
    showAll && summary ? deviceLabel(summary.deviceId) : "",
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
