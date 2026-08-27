# device

デバイス側。**Mac でも Raspberry Pi でも同じものが動く。**

```
device/
├── server/   ローカルサーバー（Node 22 + Hono）。画面の配信と /api/* の中継
└── web/      画面（Vite + 素の TypeScript）。マイク・無音検出・読み上げもここ
```

## 動かす

```bash
# ローカルサーバー。既定は stub（AI を呼ばない・課金なし）
cd server && npm ci && cp .env.example .env && npm start

# 画面。別のターミナルで
cd web && npm ci && npm run dev
```

**`http://127.0.0.1:5173` で開くこと。** `getUserMedia` は secure context でしか
動かず、HTTP で secure context 扱いになるのは「ホスト名が `localhost` /
`*.localhost`」か「ループバックの **IP リテラル**（`127.0.0.1` / `::1`）」のときだけ。

判定は名前解決の結果ではなく**ホスト名の文字列**で行われる。`aichat.local` が
127.0.0.1 に解決されても対象外なので、`http://aichat.local:5173` では
マイクが使えない。

## 別の端末から開く

iPad やスマホ、隣の機械から開きたいときは **HTTPS が要る**。

```bash
cd web && npm run dev:lan     # 0.0.0.0 に HTTPS で待ち受ける
# → 他の端末で https://aichat.local:5173 を開く
```

自己署名の証明書なので初回は警告が出る。「詳細 → このまま進む」で通せば、
以後そのオリジンは HTTPS として扱われ、マイクも使えるようになる。

> **`/api/*` が LAN に開く。** Vite の proxy 経由で誰でも届き、認証は無い。
> `stub` なら無害だが、**`live` だと誰でも AI を呼べる（課金はこちら持ち）**。
> LAN で試すのは `stub` のときだけにする。
>
> ローカルサーバー（:8080）自体は外に出ない。Vite が 127.0.0.1 に繋ぐため。
>
> 外に出したくないなら SSH のポート転送を使う（マイクも使える）。
>
> ```bash
> ssh -L 5173:127.0.0.1:5173 -L 8080:127.0.0.1:8080 pi@aichat.local
> # → 手元で http://127.0.0.1:5173
> ```

読み上げには VOICEVOX が要る。

```bash
docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-arm64-latest
```

## 確かめる

```bash
cd server && npm test      # 回答の経路・音声認識・設定の保存
cd web    && npm test      # WAV・文分割・無音検出
```

`npm test` は本物の上流を叩かない。偽の上流（`server/test/upstream-mock.ts`）を
相手に、**本物のコード**を通している。

## 録音がおかしいとき

`STUB_SAVE_AUDIO=1` で、受け取った音声が `server/tmp/` に残る。

```bash
afinfo server/tmp/*.wav     # 16000 Hz / 1ch / Int16 になっているか
open   server/tmp/*.wav     # 語頭が切れていないか・無音判定が早すぎないか
```

**上流を一度も呼ばずに録音経路を確定できる。**

## 音声認識を常駐させる（macOS）

`ohr` にも `brew services` にもサービス化の仕組みが無いので、
macOS 本来のやり方（**LaunchAgent**）で常駐させる。

```bash
cp deploy/macos/jp.local.aichat-device.ohr.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/jp.local.aichat-device.ohr.plist
```

ログイン時に立ち上がり、落ちても 1 秒ほどで復帰する（`KeepAlive`）。
待機時 **21MB / CPU 0%** なので常駐させて構わない
（同居する VOICEVOX は 711MB なので、比べれば誤差）。

| したいこと | コマンド |
|---|---|
| 状態を見る | `launchctl print gui/$UID/jp.local.aichat-device.ohr` |
| 止める | `launchctl bootout gui/$UID/jp.local.aichat-device.ohr` |
| ログ | `tail -f /tmp/aichat-device-ohr.log` |

**LaunchDaemon（システム全体）ではなく LaunchAgent（ユーザーごと）**にしている。
macOS の音声認識はユーザーのセッションで動くもので、TCC の判定も
ユーザー単位のため。デバイスは自動ログインで起動するのでこれで足りる。

読み上げ（VOICEVOX）は Docker の `--restart unless-stopped` で復帰するので、
OrbStack がログイン時に立ち上がる設定になっていれば別途の登録は要らない。

## 本物の AI に繋ぐ（live）

**ここから課金が発生する。** 先に上限付きの API キーを用意しておくこと
（Anthropic は Console の Workspace ごとに月次の上限を付けられる）。

```bash
# 1. 鍵を入れる。OS の鍵束からも読める
#    security add-generic-password -s aichat-device -a ANTHROPIC_API_KEY -w 'sk-ant-...'
#    → .env に ANTHROPIC_API_KEY=keychain:aichat-device/ANTHROPIC_API_KEY

# 2. 周辺のプロセスを立てる（常駐させていれば不要）
#    音声認識 → 上の LaunchAgent で常駐済み
docker run -d --name voicevox -p 50021:50021 --restart unless-stopped \
  voicevox/voicevox_engine:cpu-arm64-latest    # 読み上げ

# 3. live で起動
cd server && AICHAT_MODE=live npm start

# 4. 画面
cd web && npm run dev      # → http://127.0.0.1:5173
```

起動時に**設定と鍵の食い違いを警告する**。たとえば「設定は claude だが
`ANTHROPIC_API_KEY` が無い」「音声認識は apple-speech だが接続先が空」を
出すので、質問して 401 が返ってから気づくことはない。

使う AI を Gemini にしたいなら `/admin` で切り替える（`.env` ではなく設定側）。

### 質問すると「AI の設定が受け付けられませんでした」と出るとき

モデルと**思考レベル**の組み合わせが上流に拒否されている。
待っても直らないので `/admin` で一段上げる。

実例: `gemini-flash-latest` は思考レベル「最小」を拒否する
（`Thinking level MINIMAL is not supported for this model`）。
**既定値は「最小」なので、このモデルを選ぶと初回から失敗する。**「低」にすれば通る。

詳しい理由は画面には出ない（家族に内部の事情を見せないため）。
`tail -f /tmp/aichat-server.log` に上流の本文がそのまま出る。

## 設定を変える

`/admin`（`http://127.0.0.1:8080/admin`）から。モデル・システムプロンプト・
回答の長さ・音声認識モデルを決める。画面側に設定は無い。

127.0.0.1 でしか開けないので、手元の機械から開きたいときは SSH のポート転送。

```bash
ssh -L 8080:127.0.0.1:8080 pi@raspberrypi.local
```

## Pi へ持っていく

```bash
cd web && npm run build          # Mac でビルドする（Pi ではビルドしない）
# device/ を丸ごと Pi にコピーし、server/ で npm ci --omit=dev && npm start
```

`web/dist` があれば、ローカルサーバーが画面も配る（プロセスが1つで済む）。
