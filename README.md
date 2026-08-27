# aichat-device

家に置いて話しかけると答える、Echo Show 風の据え置きデバイス。
`../aichat`（家族向けの AI チャットアプリ）のバックエンドを土台に、デバイス専用に作り直したもの。

**まず Mac のブラウザで動かして体験を確かめ、同じものを Raspberry Pi 5 に移す。**

## 構成

```
[ブラウザ]  Mac: Chrome / Pi: Chromium --kiosk
  マイク ─▶ 無音検出 ─▶ 16kHz mono WAV
     │  POST /api/stt   ─▶ 書き起こし
     │  POST /api/chat  ─▶ 回答（SSE で逐次）
     │  文ごとに読み上げ ─▶ POST /api/tts
     ▼  すべて同一オリジン http://127.0.0.1:8080
[ローカルサーバー]  device/server   Node + Hono
     画面の配信・管理UI・AI の呼び出し。**鍵を持つのはここだけ**
     ▼
  Claude / Gemini（回答）   Gemini or OpenAI（音声認識）   VOICEVOX（読み上げ）
```

サーバーは1つだけ。以前は Cloudflare Worker を挟んでいたが、ローカルサーバーが
鍵を持てる以上そちらを二重に置く理由が無くなったため、すべてここに寄せた。

| ディレクトリ | 中身 |
|---|---|
| [device/server/](device/server/) | ローカルサーバー。画面の配信、AI の呼び出し、音声認識、読み上げ、管理UI |
| [device/web/](device/web/) | 画面。マイク・無音検出・読み上げの再生はすべてここ（ブラウザ） |
| [docs/](docs/) | 設計と経緯 |

### なぜブラウザから AI を直接叩かないのか

1. **鍵**。API キーをブラウザの JS に埋めると誰でも読める
2. **secure context**。`getUserMedia` は `localhost` / `127.0.0.1` でしか動かない。
   静的ファイルをどこかに置いて開く、という選択肢が最初から無い
3. **置き場所**。VOICEVOX の2段呼び出しや、Pi のハードウェアに触る処理の行き先が要る

## 動かす

```bash
# 読み上げ。Apple Silicon の Mac と Raspberry Pi はどちらも arm64 なので、
# **まったく同じイメージ**が動く（Intel Mac なら cpu-amd64-latest）。
docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-arm64-latest

# ローカルサーバー。既定は stub（AI を呼ばない・課金なし）
cd device/server && npm ci && cp .env.example .env && npm start

# 画面。別のターミナルで
cd device/web && npm ci && npm run dev
#    → http://127.0.0.1:5173 を Chrome で開く（127.0.0.1 でないとマイクが使えない）
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

`/admin` は 127.0.0.1 でしか開けない。手元の機械から開きたいときは SSH のポート転送。

```bash
ssh -L 8080:127.0.0.1:8080 pi@raspberrypi.local
# → http://127.0.0.1:8080/admin
```

### 鍵

`.env` に直接書く形と、OS の鍵束から読む形の両方を受ける。

```bash
security add-generic-password -s aichat-device -a ANTHROPIC_API_KEY -w 'sk-ant-...'
# .env: ANTHROPIC_API_KEY=keychain:aichat-device/ANTHROPIC_API_KEY
```

VOICEVOX は Docker でなく[公式アプリ](https://voicevox.hiroshiba.jp/)でもよい。
どちらも `:50021` に同じ API が立つので、こちらのコードは変わらない。
ただしアプリは開いている間しか動かず、Pi には持っていけない。

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
- `device/server` と `device/web` は独立した npm プロジェクト。Pi には `device/` を持っていく
