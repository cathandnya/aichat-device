/**
 * 鍵の取り出し。
 *
 * `.env` に値を直接書く形と、OS の鍵束から読む形の両方を受ける。
 *
 *     ANTHROPIC_API_KEY=sk-ant-...                              直接
 *     ANTHROPIC_API_KEY=keychain:aichat-device/ANTHROPIC_API_KEY  鍵束から
 *
 * **鍵束は万能ではない。** このデバイスは人が居なくても起動して喋れる
 * 必要があるので、鍵を復号するための秘密もデバイス上に無ければならない。
 * つまり機械ごと持って行かれたり root を取られたりすれば同じことで、
 * 「攻撃者にとっての一手間」以上のものにはならない。
 *
 * それでも次の事故には効くので用意している。
 *   - `.env` をうっかり commit する
 *   - バックアップ・画面共有・スクリーンショットに写る
 *   - 同じ機械の別のプロセスやユーザーが読む
 *
 * 効き目が確かなのは鍵束より **鍵そのものの被害額を絞ること**。
 * Anthropic の Workspace ごとに月次の上限を付けた API キーを使えば、
 * 漏れても上限で止まる。
 */

import { execFileSync } from "node:child_process";

const PREFIX = "keychain:";

/**
 * 値を解決する。`keychain:` で始まっていなければそのまま返す。
 *
 * 読めなかったら throw する。起動時に落としたいので、
 * 空文字を返して後で 401 になる形にはしない。
 */
export function resolveSecret(name: string, raw: string): string {
  if (!raw.startsWith(PREFIX)) return raw;

  const locator = raw.slice(PREFIX.length);
  const slash = locator.indexOf("/");
  if (slash <= 0) {
    throw new Error(
      `${name}: 鍵束の指定は keychain:<サービス>/<項目> の形で書いてください（${raw}）`,
    );
  }

  const service = locator.slice(0, slash);
  const account = locator.slice(slash + 1);

  const value = readFromKeychain(service, account);
  if (!value) {
    throw new Error(
      `${name}: 鍵束に項目がありません（サービス ${service} / 項目 ${account}）。\n` +
        `  macOS: security add-generic-password -s ${service} -a ${account} -w '値'\n` +
        `  Linux: secret-tool store --label='${account}' service ${service} account ${account}`,
    );
  }
  return value;
}

/**
 * OS の鍵束から読む。
 *
 * macOS は `security`、Linux は `secret-tool`（libsecret-tools）。
 * どちらも標準入力を使わずに値だけを吐く呼び方にしてある。
 */
function readFromKeychain(service: string, account: string): string | null {
  const attempts: [string, string[]][] =
    process.platform === "darwin"
      ? [["security", ["find-generic-password", "-w", "-s", service, "-a", account]]]
      : [["secret-tool", ["lookup", "service", service, "account", account]]];

  for (const [command, args] of attempts) {
    try {
      const out = execFileSync(command, args, {
        encoding: "utf8",
        // 鍵束が施錠されていると GUI の入力を待って固まることがある。
        // 起動時に呼ぶので、待たずに諦めて .env に倒せるようにする。
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const value = out.replace(/\n$/, "");
      if (value) return value;
    } catch {
      // 見つからない・コマンドが無い・施錠されている。呼び出し側で扱う。
    }
  }
  return null;
}
