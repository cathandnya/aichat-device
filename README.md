# aichat-device

[![YouTube](https://github.com/user-attachments/assets/db916435-0c07-442c-8a4f-7c4a15976d66)](https://youtu.be/3ew4TTjtNao)

家に置いて話しかけると答える、Echo Show 風の据え置きデバイス。

**判断も推論もローカルサーバーに集める。デバイスは端末に徹する。**
ウェイクワードの判定・音声認識・AI の呼び出し・読み上げは、すべてサーバーが行う。
デバイス側は「マイクを送る・音を鳴らす・顔を出す」だけで、機械学習を載せない
（[06](docs/06-device-implementation.md)）。

**サーバーは Mac に置いたままにする。** 既定の音声認識が macOS の
SpeechAnalyzer で、実測で一番速く（0.14秒）正確で、音声も家の外に出ない。
デバイス（**Echo Spot 初代に LineageOS を入れたもの**）は端末として繋ぐ。

## 構成

```
[端末]  Echo Spot（device/android）。確認用に Mac のブラウザ（device/web）
   マイク ────80ms のフレームを常時────▶ ┐
   画面    ◀───状態・文字───────────────  │  WebSocket /ws
   スピーカー ◀─読み上げの WAV──────────  │
                                          ▼
[ローカルサーバー]  device/server   Node + Hono   ★ 判断はすべてここ
   ウェイクワードの判定（連続 ASR + 文字列一致）・発話の切り出し
   音声認識 ─▶ AI ─▶ 文に切って読み上げ ─▶ WAV を返す
   チャットの保存・画面の配信・管理UI。**鍵を持つのはここだけ**
                                          ▼
  Claude / Gemini（回答）   ohr = macOS の音声認識（既定）   VOICEVOX（読み上げ）
```

**サーバーは1つだけ。** 鍵を持つのもここだけで、中継は挟まない。

### 話しかける経路は1つ

マイクを開きっぱなしにして**ウェイクワード**（既定「ずんだもん」）。
状態機械を持つのは**サーバー**で、ブラウザは `/ws` に音を流し、
届いた状態を描いて音を鳴らすだけ。

**端末は `/ws?device=<id>` で名乗る。** 会話を継ぐ相手は同じ端末のものだけに
なるので、居間と寝室に1台ずつ置いても文脈が混ざらない。id は端末が自分で作る
（ブラウザは `localStorage` に `browser-a3f9`、実機は `SharedPreferences` に
`android-4e21`）。名乗らなければ「名前のない端末」として1つにまとまる。

**履歴もその端末のぶんだけ**（`/history`）。家じゅうを見返すのは
管理画面（`/admin`）の「すべての端末の履歴を見る」から。

`/api/stt` `/api/chat` `/api/tts` はサーバーに口として残っているが、
**画面からは呼ばない。** 実機にボタンは無いので、ボタンで話す経路を持つと
実機で困ることに気づけない。

### 画面は2つ

| | 何をする |
|---|---|
| `/` | チャット。**いまの会話だけ。** 実機に無いボタンは置かない（残るのはマイクの入り切り） |
| `/history` | 読み返す。**ここでは話せない** |

| ディレクトリ | 中身 |
|---|---|
| [device/server/](device/server/) | ローカルサーバー。画面の配信、AI の呼び出し、音声認識、読み上げ、管理UI |
| [device/web/](device/web/) | **確認用の画面。** 手元で内容を読む・試す。判断はしない |
| [device/android/](device/android/) | **実機のアプリ**（Kotlin）。Echo Spot に載せる。マイク・音・顔だけ |
| [device/deploy/](device/deploy/) | 常駐の設定（macOS の LaunchAgent） |
| [demo/](demo/) | 動画用のデモ音声。VOICEVOX で作って実機に聞かせる |
| [docs/](docs/) | 設計。[01](docs/01-requirements.md) の要件、[03](docs/03-tech-stack.md) の技術選定、[06](docs/06-device-implementation.md) の端末実装、[07](docs/07-chat-design.md) のチャット設計、[08](docs/08-emotion.md) の感情表現、[09](docs/09-echo-spot-jailbreak.md) の Echo Spot の手順 |

### なぜブラウザから AI を直接叩かないのか

1. **鍵**。API キーをブラウザの JS に埋めると誰でも読める
2. **secure context**。`getUserMedia` は HTTPS か `localhost` / `127.0.0.1` でしか動かない。
   静的ファイルをどこかに置いて開く、という選択肢が最初から無い
3. **置き場所**。VOICEVOX の2段呼び出し・ウェイクワードの判定・チャットの保存の行き先が要る

## 動かす

```bash
# 読み上げ。Apple Silicon なら arm64 のイメージ（Intel Mac は cpu-amd64-latest）。
docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-arm64-latest

# 音声認識。macOS の SpeechAnalyzer を OpenAI 互換の HTTP で包む。
# **既定のポート 11434 は Ollama と衝突する**ので 8091 で立てる。
brew tap Arthur-Ficial/tap && brew install ohr
ohr --serve --port 8091 --host 127.0.0.1
#    常駐させるなら device/deploy/macos/ の LaunchAgent

# ローカルサーバー（:9801）。既定は stub（AI を呼ばない・課金なし）
cd device/server && npm ci && cp .env.example .env && npm start

# 画面。別のターミナルで
cd device/web && npm ci && npm run dev
#    → https://aichat.local:9800 を Chrome で開く（HTTPS でないとマイクが使えない）
```

**ポートは2つある。** サーバーは **9801** でしか待ち受けない。開発中に開く
**9800** は Vite で、`/api`・`/admin`・`/ws` を 9801 へ中継している。
**`npm run dev` を止めると 9800 は消える。**

据え置きで動かすときは Vite を使わず、サーバーに画面ごと配らせる
（プロセスが1つで済む）。

```bash
cd device/web && npm run build     # web/dist を作る
cd ../server && npm start          # → http://127.0.0.1:9801
```

常駐させるなら [device/deploy/macos/](device/deploy/macos/) の LaunchAgent
（**中のパスを自分の環境に書き換えてから入れる**。手順は
[device/README](device/README.md#ログイン時から常駐させるmacos)）。

### モード

| `AICHAT_MODE` | 中身 | 課金 |
|---|---|---|
| `stub`（既定） | AI を呼ばず固定の応答を返す。UI と音声の検証用 | なし |
| `live` | 本物の AI を呼ぶ | **あり** |

`stub` には `?scenario=long|slow|error|empty|truncated` という口もあるが、
**いまは `POST /api/chat` を直に叩いたときだけ効く。** 画面が使う `/ws` の経路は
常に `normal` を返すので、**エラー側の見え方は画面では確かめられない。**

### 設定

モデル・システムプロンプト・回答の長さ・音声認識モデルは **`/admin` から** 変える。
画面側に設定は無い。

**`/admin` を守っているのは待ち受けアドレス**（`HOST=127.0.0.1`）で、
アクセス元の検査ではない。`HOST` を変えれば LAN からも開く。
別の機械から開きたいときは SSH のポート転送を使う。
**転送先はサーバーを動かしている Mac。**

```bash
# 据え置き（Vite なし。サーバーが画面ごと配る）
ssh -L 9801:127.0.0.1:9801 <ユーザー>@<サーバーの Mac>.local
# → http://127.0.0.1:9801/admin

# 開発中（別プロセスで npm run dev を動かしているとき）
ssh -L 9800:127.0.0.1:9800 <ユーザー>@<サーバーの Mac>.local
# → https://aichat.local:9800/admin
```

### 家の情報

家の中で動いている別のサーバーに聞いて答える。**このサーバーは値を読むだけ**で、
機器とは直接話さない。`.env` に URL があるものだけ、AI に道具として渡す。
URL が空なら道具ごと渡さない（宣言だけして失敗すると、「調べます」と
言ってから黙る挙動になる）。

| 情報 | 聞く先 | `.env` |
|---|---|---|
| 消費電力 | [house_power](https://github.com/cathandnya/house_power)（スマートメーターを Wi-SUN Bルートで読む） | `HOUSE_POWER_URL` |
| 製氷機の水 | [water-level](https://github.com/cathandnya/water-level)（冷蔵庫の中の ESP32-C3 + 非接触センサー） | `WATER_LEVEL_URL` |
| PC の電源 | [pc_power](https://github.com/cathandnya/pc_power)（フロントパネルピンを Pi Zero W で無線化） | `PC_POWER_URL` |

```
「いま電気どれくらい使ってる？」   → およそ640ワット
「製氷機の水ある？」               → 入っている / 空っぽ
「PC 点いてる？」                  → 入っている / 切れている
「PC 点けて」「PC 消して」          → 電源ボタンを 0.5 秒押す
```

**取れない値は装わない。** 水位センサーが持つのは有無だけなので、
残量は答えない。

聞く先が落ちていても会話は落とさない。「分かりません」と言う。

#### PC の電源だけは物を動かす

読むだけの他と違い、ここは**押す**。危ないほうへ倒れないよう2つ決めてある。

**強制停止の口は叩かない。** 装置には `/power/off`（電源ピンを **5 秒**押す
＝OS に断らず切る）と `/reset` があるが、**呼ぶのは `/power/toggle` だけ**。
0.5 秒なのでボタンをちょんと押すのと同じで、OS が受け取って通常どおり
終了する。保存していない仕事は消さない。

**既にその状態なら押さない。** 装置が持つのは「入れ替える」だけなので、
点いている PC に「点けて」で押すと**消えてしまう**。必ず手前で状態を
読み、頼まれた向きと違うときだけ押す。状態が読めないときも押さない。

### 鍵

`.env` に直接書く形と、OS の鍵束から読む形の両方を受ける。

```bash
security add-generic-password -s aichat-device -a ANTHROPIC_API_KEY -w 'sk-ant-...'
# .env: ANTHROPIC_API_KEY=keychain:aichat-device/ANTHROPIC_API_KEY
```

VOICEVOX は Docker でなく[公式アプリ](https://voicevox.hiroshiba.jp/)でもよい。
どちらも `:50021` に同じ API が立つので、こちらのコードは変わらない。
ただしアプリは**開いている間しか動かない**。人が居なくても起動して喋る機械なので、
据え置きにするなら Docker（か公式エンジンの常駐）にする。

**鍵束は万能ではない。** デバイスは人が居なくても起動して喋る必要があるので、
復号のための秘密もデバイス上にある。守れるのは「うっかり commit する」
「バックアップに写る」「同じ機械の別プロセスが読む」あたりまで。

効き目が確かなのは**鍵の被害額を絞ること**。Anthropic の Workspace ごとに
月次の上限を付けた API キーを使えば、漏れても上限で止まる。

## 開発上の決めごと

実際に踏んだ落とし穴（実機の `adb`、繋ぎ先の切り替え、素材の置き場所）は
[CLAUDE.md](CLAUDE.md) にまとめてある。

- **Claude / Gemini の API を実際に呼んで動作確認しない。** 課金が発生する。
  検証はユーザーが自分の判断で行う。
  テストは偽の上流を立てて本物のコードを通す
- 設定はサーバー側で完結させる。デバイス側に設定画面は置かない
- `device/server` と `device/web` は独立した npm プロジェクト
- **サーバーは Mac に残す。** デバイスを作るときに書くのは端末側だけで、
  判断のロジックはサーバーから動かさない（[06](docs/06-device-implementation.md)）

## ライセンス

このリポジトリのコードは [MIT](LICENSE)。

**同梱・利用しているもの**は、それぞれの権利者のものでライセンスも別。

| | |
|---|---|
| [speexdsp](https://gitlab.xiph.org/xiph/speexdsp)（エコー消去） | ソースを同梱している（`device/android/app/src/main/cpp/speexdsp/`）。BSD-3-Clause。[COPYING](device/android/app/src/main/cpp/speexdsp/COPYING) がそれ |
| [VOICEVOX](https://voicevox.hiroshiba.jp/)（読み上げ） | 呼ぶだけで同梱していない。**音声の利用規約は各話者のものに従う** |
| [ohr](https://github.com/Arthur-Ficial/ohr) / [whisper.cpp](https://github.com/ggerganov/whisper.cpp)（音声認識） | 呼ぶだけで同梱していない |

**立ち絵と効果音は入っていない**（[置き方](device/web/public/character/README.md)）。
無くても会話は動く。

[docs/09](docs/09-echo-spot-jailbreak.md) は Amazon の端末を改造する手順で、
**失敗すると復旧できない**。やるかどうかは自分で判断すること。
