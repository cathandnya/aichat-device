# device

デバイス側。**サーバーは Mac に置く。** 既定の音声認識（macOS の SpeechAnalyzer）が
Mac でしか動かないうえ、ウェイクワードの判定もここで回すため。
将来つなぐ小さな箱は端末に徹し、判断は持たない（[../docs/06](../docs/06-device-implementation.md)）。

```
device/
├── server/   ローカルサーバー（Node 22 + Hono）。判断はすべてここ
│              ウェイクワード判定・音声認識・AI・読み上げ・チャットの保存・/admin
├── web/      画面（Vite + 素の TypeScript）。マイクの取り込みと音の再生
└── deploy/   常駐の設定（macOS の LaunchAgent）
```

## URL

**画面も管理画面も同じホスト・同じポート**で開く。

| | URL |
|---|---|
| 話しかける画面 | `https://aichat.local:9800` |
| 管理画面 | `https://aichat.local:9800/admin` |
| ウェイクワードの試験 | `https://aichat.local:9800/wake.html` |

ローカルサーバー（9801）は 127.0.0.1 でしか待ち受けず、外からは届かない。
外の端末は Vite（9800）経由でのみ `/api` と `/admin` に届く。

> **`/admin` に鍵をかけていないので、LAN に開くと誰でも設定を変えられる。**
> 気になるなら `.env` の `ADMIN_PASSWORD` を設定する。

## 動かす

```bash
# ローカルサーバー。既定は stub（AI を呼ばない・課金なし）
cd server && npm ci && cp .env.example .env && npm start

# 画面。別のターミナルで
cd web && npm ci && npm run dev
```

**`https://aichat.local:9800` で開くこと。** `getUserMedia` は secure context でしか
動かず、HTTP で secure context 扱いになるのは「ホスト名が `localhost` /
`*.localhost`」か「ループバックの **IP リテラル**（`127.0.0.1` / `::1`）」のときだけ。

判定は名前解決の結果ではなく**ホスト名の文字列**で行われる。`aichat.local` が
127.0.0.1 に解決されても対象外なので、`http://aichat.local:5173` では
マイクが使えない。

## 別の端末から開く

iPad やスマホ、隣の機械から開きたいときは **HTTPS が要る**。

```bash
cd web && npm run dev:lan     # 0.0.0.0 に HTTPS で待ち受ける
# → 他の端末で https://aichat.local:9800 を開く
```

自己署名の証明書なので初回は警告が出る。「詳細 → このまま進む」で通せば、
以後そのオリジンは HTTPS として扱われ、マイクも使えるようになる。

> **`/api/*` が LAN に開く。** Vite の proxy 経由で誰でも届き、認証は無い。
> `stub` なら無害だが、**`live` だと誰でも AI を呼べる（課金はこちら持ち）**。
> LAN で試すのは `stub` のときだけにする。
>
>
> ローカルサーバー（:9801）自体は外に出ない。Vite が 127.0.0.1 に繋ぐため。
>
> 外に出したくないなら SSH のポート転送を使う（マイクも使える）。
>
> ```bash
> ssh -L 9800:127.0.0.1:9800 <ユーザー>@<サーバーの Mac>.local
> # → 手元で https://aichat.local:9800
> ```

読み上げには VOICEVOX が要る。

**ウェイクワードに気づいたときの音**は `web/public/wake.mp3`。
立ち絵と同じく git に入れていないので、clone しただけでは鳴らない
（鳴らないだけで、会話はそのまま動く）。

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

## ログイン時から常駐させる（macOS）

`brew services` のようなものが無いので、macOS 本来のやり方
（**LaunchAgent**）で登録する。**サーバーと音声認識の 2 つ。**
plist は `deploy/macos/` にある。

### サーバー

```bash
mkdir -p ~/Library/Logs/aichat-device
cp deploy/macos/jp.local.aichat-device.server.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/jp.local.aichat-device.server.plist
```

**入れる前に手で起こしたサーバーを落とす**（`lsof -iTCP:9801 -P`）。
残っていると後から来た方が `EADDRINUSE` で落ち、`KeepAlive` が
それを延々と起こし直す。

| したいこと | コマンド |
|---|---|
| 状態を見る | `launchctl print gui/$UID/jp.local.aichat-device.server` |
| 止める | `launchctl bootout gui/$UID/jp.local.aichat-device.server` |
| 入れ直す | `launchctl kickstart -k gui/$UID/jp.local.aichat-device.server` |
| ログ | `tail -f ~/Library/Logs/aichat-device/server.log` |

**`server` を直したら `kickstart -k`。** `web` を直したときは
`npm run build` だけでよい（配信はリクエストごとにディスクを読む）。

plist が置いている前提が 2 つある。**どちらも外すと静かに壊れる。**

- **`WorkingDirectory`** … `src/static.ts` の `serveStatic` の root が
  作業ディレクトリからの相対。外すと画面が全部 404 になるが、
  `dist` の有無の判定は絶対パスで通るので**配れているつもりで配れない**
- **`node` の絶対パス** … ふだんの `node` は fnm のシェルごとの
  一時ディレクトリにあり、**launchd からは存在しない**

**ログは回していない。**放っておくと太るので、気になったら消す。

### 音声認識（ohr）

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

**LaunchDaemon（システム全体）ではなく LaunchAgent（ユーザーごと）**に
している。macOS の音声認識はユーザーのセッションで動くもので、TCC の判定も
ユーザー単位のため。デバイスは自動ログインで起動するのでこれで足りる。
サーバーも同じ揃えにしてある。

### 読み上げ（VOICEVOX）

Docker の `--restart unless-stopped` で復帰するので、
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
cd web && npm run dev      # → https://aichat.local:9800
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
サーバーのログに上流の本文がそのまま出る
（常駐させているなら `tail -f ~/Library/Logs/aichat-device/server.log`）。

## ウェイクワードを実マイクで試す

`https://aichat.local:9800/wake.html`

**AI を呼ばない。** 判定だけを行う経路（`/ws?mode=wake`）に繋ぐので、
チャットも作らず読み上げもしない。音声認識は手元なので費用はゼロ。
何時間流しっぱなしにしてもよい。

- 窓ごとの聞こえ方が全部出る（当たらなかった窓も）
- **判定語をその場で差し替えられる。**設定は書き換えないので、
  同じ部屋の音で候補を比べられる
- 起動回数・経過時間・1時間あたりの換算。ログを保存できる

測り方:

1. マイクを開き、**何も話さずに放置**する（テレビを付けた状態でも）→ 誤起動の回数
2. 離れた位置・小声・早口で 10 回ずつ呼ぶ → 検出率
3. 候補語を変えて同じことをする

> Firefox では使えない（`sampleRate` の指定を無視するため）。Chrome か Safari で。

## 設定を変える

`/admin`（`https://aichat.local:9800/admin`）から。モデル・システムプロンプト・
回答の長さ・音声認識モデルを決める。画面側に設定は無い。

127.0.0.1 でしか開けないので、別の機械から開きたいときは SSH のポート転送。
**転送先はサーバーを動かしている Mac。**

```bash
ssh -L 9800:127.0.0.1:9800 <ユーザー>@<サーバーの Mac>.local
```

## 据え置きで動かす

サーバーは Mac に置いたままなので、**持っていくものは無い。**
Vite を別プロセスで動かすのをやめて、ローカルサーバーに画面ごと配らせる。

```bash
cd web && npm run build          # web/dist を作る
cd ../server && npm start        # dist があれば画面もここが配る（プロセスが1つ）
```

据え置きの本番はこれを手で起こさず、**LaunchAgent に任せる**
（上の[「ログイン時から常駐させる」](#ログイン時から常駐させるmacos)）。

**Mac を寝かせないこと。**寝ると端末が黙る。この機械は `pmset` が
`sleep 0` / `displaysleep 0` / `autorestart 1` になっているので
`caffeinate` は要らない。別の機械に移すときは `pmset -g custom` で確かめる。

### 端末を繋ぐとき

`/ws` にバイナリのフレーム（16kHz mono 16bit LE、80ms）を流し、
返ってくる JSON とバイナリを画面と音に出すだけ。**判断は一切しない。**
取り決めは `server/src/ws/protocol.ts`。実装案は
[../docs/06](../docs/06-device-implementation.md)（Pi Zero 2 W / ESP32-S3 / Pi 4 が候補）。

**`HOST` を LAN に開くことになるので、そのときは `/api/*` に認証が要る。**
いまは 127.0.0.1 でしか待ち受けないことだけが守りになっている。
