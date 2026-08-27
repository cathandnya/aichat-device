# aichat-device

家に置いて話しかけると答える、Echo Show 風の据え置きデバイス。
`../aichat`（家族向けの AI チャットアプリ）のバックエンドを土台に、デバイス専用に作り直したもの。

**判断も推論もローカルサーバーに集める。デバイスは端末に徹する。**
ウェイクワードの判定・音声認識・AI の呼び出し・読み上げは、すべてサーバーが行う。
デバイス側は「マイクを送る・音を鳴らす・文字を描く」だけで、機械学習を載せない
（[06](docs/06-device-implementation.md)）。

サーバーは Mac に置いたままにする。**Raspberry Pi へ「移す」構成ではない。**
既定の音声認識が macOS の SpeechAnalyzer で、実測で一番速く（0.14秒）正確で、
音声も家の外に出ない。デバイス（**Raspberry Pi Zero 2 W**）は端末として繋ぐ。

## 構成

```
[端末]  いまは Mac のブラウザ（device/web）。将来は小さな箱
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

サーバーは1つだけ。以前は Cloudflare Worker を挟んでいたが、ローカルサーバーが
鍵を持てる以上そちらを二重に置く理由が無くなったため、すべてここに寄せた。

### ブラウザには経路が2つある

いまの画面（`device/web`）は、**どちらの経路でも動く**。

| | 起こし方 | 状態を持つ場所 | 使う口 |
|---|---|---|---|
| **WebSocket** | マイクを開きっぱなしにして**ウェイクワード**（既定「ずんだもん」） | **サーバー** | `/ws` |
| HTTP | マイクを閉じたまま**ボタン / スペースキー** | ブラウザ | `/api/stt` `/api/chat` `/api/tts` |

WebSocket が本命。デバイスに載せるのはこちらで、ブラウザは端末の代役をしている。
HTTP の経路は先に作ったもので、**マイクを開かずに一周を確かめられる**ので残してある。

| ディレクトリ | 中身 |
|---|---|
| [device/server/](device/server/) | ローカルサーバー。画面の配信、AI の呼び出し、音声認識、読み上げ、管理UI |
| [device/web/](device/web/) | 画面。マイクの取り込みと音の再生。WebSocket 経路では**判断はしない** |
| [docs/](docs/) | 設計と経緯。[05-issues](docs/05-issues.md) の課題、[06](docs/06-device-implementation.md) のデバイス実装案、[07](docs/07-chat-design.md) のチャット設計 |

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

# ローカルサーバー。既定は stub（AI を呼ばない・課金なし）
cd device/server && npm ci && cp .env.example .env && npm start

# 画面。別のターミナルで
cd device/web && npm ci && npm run dev
#    → https://aichat.local:9800 を Chrome で開く（HTTPS でないとマイクが使えない）
```

### モード

| `AICHAT_MODE` | 中身 | 課金 |
|---|---|---|
| `stub`（既定） | AI を呼ばず固定の応答を返す。UI と音声の検証用 | なし |
| `live` | 本物の AI を呼ぶ | **あり** |

`stub` では `?scenario=long|slow|error|empty|truncated` でエラー側の画面も確かめられる。
**エラーの見え方は本番では狙って再現できない**ので、作り込むならここ。

### 設定

モデル・システムプロンプト・回答の長さ・音声認識モデルは **`/admin` から** 変える。
画面側に設定は無い。

`/admin` は 127.0.0.1 でしか開けない。別の機械から開きたいときは SSH のポート転送。
**転送先はサーバーを動かしている Mac。**

```bash
ssh -L 9800:127.0.0.1:9800 <ユーザー>@<サーバーの Mac>.local
# → https://aichat.local:9800/admin
```

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

- **Claude / Gemini の API を実際に呼んで動作確認しない。** 課金が発生する。
  検証はユーザーが自分の判断で行う（`../aichat/CLAUDE.md` と同じ）。
  テストは偽の上流を立てて本物のコードを通す
- 設定はサーバー側で完結させる。デバイス側に設定画面は置かない
- `device/server` と `device/web` は独立した npm プロジェクト
- **サーバーは Mac に残す。** デバイスを作るときに書くのは端末側だけで、
  判断のロジックはサーバーから動かさない（[06](docs/06-device-implementation.md)）
