# 03. 技術選定

## 全体構成

```
[ブラウザ]  Mac: Chrome / Pi: Chromium --kiosk
  getUserMedia ─▶ AudioWorklet(80ms) ─▶ 無音検出 ─▶ 16kHz mono WAV
      │  POST /api/stt            ─▶ {"text":"明日の天気は"}
      │  POST /api/chat  (SSE)    ─▶ delta / sources / done / error
      │  文分割 ─▶ POST /api/tts  ─▶ WebAudio で再生
      │  GET  /api/config         ─▶ 「いま Haiku 4.5」の表示
      ▼  すべて同一オリジン http://127.0.0.1:8080
[ローカルサーバー]  device/server   Node + Hono
  画面の配信・管理UI・AI の呼び出し。**鍵を持つのはここだけ**
      ▼
  Claude / Gemini   Gemini or OpenAI（音声認識）   VOICEVOX（読み上げ）
```

原則は `../aichat` から引き継ぐ。**AI の鍵はサーバーにだけ置く。**

## サーバーは1つ

もとは Cloudflare Worker を挟んでいた。ブラウザには鍵を置けないので
中継が要る、という理屈だった。ローカルサーバーを置いた時点で
**そのローカルサーバー自身が鍵を持てる**ので、Worker を二重に置く理由が
無くなった。Worker はやめ、すべてローカルサーバーに寄せている。

失ったものと得たものは次のとおり。

| | |
|---|---|
| 失った | 家に置く箱に長期の課金キーが載る（→ 上限付きキーと OS の鍵束で緩和） |
| 失った | `/admin` に外から入れない（→ SSH のポート転送で代替） |
| 得た | 上流までのホップが1つ減る |
| 得た | デプロイ・KV・シークレット管理が丸ごと不要 |
| 得た | Workers AI に縛られず音声認識の先を選べる |

### ローカルサーバーが要る理由（これは変わらない）

ブラウザから AI を直接叩けない理由が3つある。

1. **鍵**。API キーをブラウザの JS に埋めると DevTools で読める
2. **secure context**。`getUserMedia` は secure context でしか動かず、HTTP で
   secure context 扱いになるのは `localhost` / `127.0.0.1` だけ。
   **「静的ファイルをどこかに置いて開く」という選択肢が最初から無い**
3. **置き場所**。VOICEVOX の2段呼び出しや、Pi のハードウェアに触る処理の行き先

**127.0.0.1 にバインドする。** `/api/*` は認証を持たないので、LAN に開くと
同じネットワークの誰でも AI を呼べる（課金はこちら持ち）。守りは
「そもそも外から届かない」ことだけ。

## 鍵の置き方

`.env` に直接書く形と、OS の鍵束（macOS の `security` / Linux の `secret-tool`）
から読む形の両方を受ける（`device/server/src/secrets.ts`）。

**鍵束は防御の境界にはならない。** デバイスは人が居なくても起動して喋る必要が
あるので、復号のための秘密もデバイス上にある。守れるのは「うっかり commit する」
「バックアップや画面共有に写る」「同じ機械の別プロセスが読む」まで。

効き目が確かなのは**鍵の被害額を絞ること**。Anthropic の Workspace ごとに
月次の上限を付けた API キーを使えば、漏れても上限で止まる。

## 1. 音声の取り込み

- `getUserMedia({channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true})`
- `new AudioContext({sampleRate:16000})` でグラフごと 16kHz で回す。**自前のリサンプラは要らない**
  （Firefox はこの指定を無視するので、作った後に `ctx.sampleRate` を検算して警告を出す）
- `AudioWorkletNode` で 80ms（1280 サンプル）ずつメインスレッドへ渡す。
  1280 にしているのは openWakeWord のフレーム長に合わせるため。
  **判断は worklet に書かない**（オーディオスレッドが詰まると音が途切れる）
- WAV 化は `device/web/src/audio/wav.ts`。クリップしてから 16bit にする

## 2. 発話の始まりと終わり

`device/web/src/audio/endpoint.ts`。いまは音量（RMS）だけを見る素朴な実装。

| 決めごと | 値 | 理由 |
|---|---|---|
| しきい値 | 開始 300ms の暗騒音 × 3（下限 0.01） | 固定値は部屋によって必ず外れる |
| **プリロール** | **300ms** | **これが無いと語頭が切れる。**「あした」の「あ」で音量が上がったと気づく頃には、その「あ」は過ぎている |
| 話し終わり | 無音 700ms | |
| 末尾を残す | 200ms | 全部落とすと「〜です」が「〜で」に聞こえる |
| 諦める | 声が3秒無ければ | |
| 打ち切り | 20 秒 | 音声の上限（約31秒）に余裕を持たせる |

テレビやエアコンの音がある部屋では RMS では無理。入り口を
「80ms の塊を流し込む」形にしてあるので、Silero VAD（`@ricky0123/vad-web`）に
差し替えられる。その際 onnx と wasm は `public/` に置く（CDN 依存を残すと Pi が
オフラインのとき無言で壊れる）。

## 3. 音声認識（STT）

**既定は macOS の音声認識（SpeechAnalyzer）。** 実測で一番速くて正確で、
音声が家の外に出ず、課金も無い。VOICEVOX と同じく別プロセスとして立てる。

```bash
brew tap Arthur-Ficial/tap && brew install ohr
# 常駐させる（LaunchAgent。device/deploy/macos/ にある）
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/jp.local.aichat-device.ohr.plist
```

> **既定のポート 11434 は Ollama と衝突する。** 8091 で立てること。

待機時 21MB / CPU 0% と軽い（whisper-server は 756MB、VOICEVOX は 711MB）。
`ohr` にも `brew services` にもサービス化の仕組みが無いので、
macOS 本来の LaunchAgent で常駐させている。

| モデル | 備考 |
|---|---|
| `apple-speech` | **既定。** macOS 26+ / Apple Silicon。`ohr` が要る |
| `local-whisper` | ローカル。**Pi ではこちらになる。** `whisper-server` が要る |
| `gemini-flash-latest` | 回答で使う鍵をそのまま使える（鍵が増えない） |
| `gpt-4o-transcribe` / `whisper-1` | 書き起こし専用。`OPENAI_API_KEY` が要る |

どれを使うかは `/admin` で決める（画面からは指定できない）。

### 実測（Apple Silicon / VOICEVOX の合成音声 6 文・常駐サーバー）

| | 1文あたり | 意味が変わる誤り |
|---|---|---|
| **Apple SpeechAnalyzer（ohr）** | **0.14秒** | **0件** |
| whisper large-v3-turbo + `-ac 512` | 0.74秒 | 6件中1件（行き方→生き方） |
| whisper large-v3-turbo（既定設定） | 2.42秒 | 0件 |
| whisper small | 0.86秒 | 6件中1件（オンス→**温度**） |

Apple が whisper の **5 倍速く**、精度でも上回った（whisper が
「行き方→生き方」を外した文も正しく取れている）。残る差分は
「くもり→曇り」「晩ごはん→晩御飯」「百五十グラム→150グラム」といった
**表記ゆれ**で、LLM に渡す文としてはどれも正解。

whisper の `-ac 512` は音声文脈を縮める指定。whisper は入力を 30 秒窓に
詰めて処理するので、2秒の問いかけでも 25 秒の発話と同じ固定費がかかる。
窓を縮めると 3 倍速くなり、数秒しか話さないこの用途では精度もほぼ落ちない。

> 合成音声での計測なので、実際の発話ではこれより悪い。下限の目安として読む。

### 空白の詰め方

SpeechAnalyzer は語の区切りごとに空白を入れてくる（「明日の天気 を教 えて」）。
日本語としては誤りなので詰めるが、**英数字どうしの空白は残す**
（`ai/stt.ts` の `joinJapanese`）。全部詰めると「hello world」まで壊れる。

### 無音のときの作り話

whisper は無音に対して「ご視聴ありがとうございました」のような学習データ由来の
定型句を返すことがある。そのまま AI に投げると見当違いの回答になるので、
既知の定型句と括弧だけの出力は空文字に倒す（`ai/stt.ts` の `isHallucination`）。
判定を広げすぎると本当の発話まで消すので、既知のものに絞っている。

### 自前で Speech framework を呼ぶのは諦めた

`SFSpeechRecognizer` を自分で呼ぶ CLI を書いたが、TCC に阻まれた。
TCC は「**責任のあるプロセス**」の Info.plist を見るため、常駐サーバーから
子プロセスとして呼ぶと必ず中断される（バイナリへの plist 埋め込み・
ad-hoc 署名・`.app` バンドル化・`/tmp` の外への移動、いずれも SIGABRT）。

`ohr` は配布物として正しく作られているのでこの問題が起きない。
自前で書くより速く（SpeechAnalyzer は SFSpeechRecognizer より新しい API）、
保守も要らない。

### Pi に持っていくとき

**Raspberry Pi には Apple の音声認識が無い。** Phase C では
`local-whisper` に切り替わる見込み。設定は `/admin` から変えるだけで済むよう、
両方を実装して残してある。

**ブラウザの `SpeechRecognition`（Web Speech API）は使わない。**
音声を Google のサーバーに送るので、プライバシー要件と噛み合わない。

## 4. 読み上げ（TTS）— ここが一番の落とし穴

**本命は VOICEVOX。`speechSynthesis` は Mac での確認用に留める。**

Mac で開発していると `speechSynthesis` で普通に日本語が喋れてしまう
（この機械には ja_JP の音声が 9 種類ある）。**それに頼ると Pi で詰む。**

| | macOS の Chrome / Safari | Linux (Pi) の Chromium |
|---|---|---|
| 日本語の音声 | ◎ Kyoko ほか標準で入っている | **✕ 既定では無い**。`getVoices()` が空配列になる |
| 仕組み | OS の音声合成をそのまま使う | speech-dispatcher 経由。既定の espeak-ng は**漢字を読めない** |

さらに2つ、`speechSynthesis` を避けるべき理由がある。

- **エコーキャンセルの参照信号に入らない。** ブラウザの AEC は「自分が鳴らした音」を
  参照にする。speech-dispatcher は別プロセスで音を出すのでその対象外になり、
  **読み上げ中の自分の声をマイクが拾ってループする**。
  `/api/tts` で取った WAV をブラウザ内の WebAudio で鳴らせば確実に参照に入る
- **自動再生の制限。** 起動直後、ユーザーが触る前には喋れない。キオスクでは
  `--autoplay-policy=no-user-gesture-required` か、起動時に一度だけ触らせる導線が要る

したがって **Mac の段階から VOICEVOX を使って開発する**。
Apple Silicon の Mac と Raspberry Pi 5 はどちらも arm64 なので、
**まったく同じイメージ**が動く。

```bash
docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-arm64-latest
```

`audio_query` → `synthesis` の2段はローカルサーバーが隠す。ブラウザからは
`POST /api/tts {text}` の1回に見える。

**読み上げの速さは `/admin` で変える**（既定 150%）。1段目の結果に
`speedScale` を上書きして渡す。ブラウザ側で `playbackRate` を上げる方法も
あるが、そちらは**声の高さまで上がって不自然になる**。`speedScale` なら
高さを保ったまま速く話す。

実測（「明日の東京は晴れ時々くもりの見込みです。」）:
100% で 3.53秒 → **150% で 2.40秒** → 200% で 1.80秒。

**先読み**: `delta` を「。」「！」「？」「改行」で切り、1文できた時点で投げる
（`device/web/src/speech/sentences.ts`）。短い断片は次とまとめる。

**文末でだけ切る。** 以前は 60 字を超えると読点で切っていたが、日本語の
60 字はごく普通の長さで、「〜親子丼のような丼ものにするか、」のように
**文の途中で読み上げが途切れて不自然だった**。非常口として 200 字の上限は
残してあるが、これは句点を打たない回答が来たときだけ働く。

**合成と再生を分ける**（`speech/speaker.ts` の `prepare` / `play`）。
文が届いた時点で合成を始め、再生だけを順番に行う。**いま鳴っている文の裏で
次の文を用意する**ので、文と文の間が空かない。

直列（合成 → 再生 → 合成 → 再生）にしていたときは、文が変わるたびに
合成の待ち時間ぶん黙っていた。実測で 3 文の回答（音声 9.2 秒）に対して
**無音が 3.4 秒**入り、「たまに途切れる」と受け取られた。
先読みにして無音は 0 秒、全体も 2.3 秒短くなった。

### 実測（Mac / Apple M 系 / VOICEVOX 0.25.2 の Docker）

生成の速さ。**実時間比が 1.0 を下回っていれば、再生している間に次の文を
作れる**ので、2文目以降は待ちが出ない。

| 文の長さ | 生成時間 | 音声の長さ | 実時間比 |
|---|---|---|---|
| 3字 | 0.51秒 | 0.62秒 | 0.82x |
| 20字 | 1.54秒 | 3.53秒 | 0.44x |
| 61字 | 4.32秒 | 10.86秒 | 0.40x |

体感を決めるのは**最初の1文**。実際の文分割ロジックで測るとこうなる。

```
0.40秒  最初の delta が届く
0.61秒  1文目が確定「明日の東京は晴れ時々くもりの見込みです。」（20字）
1.94秒  ★ 声が出せる（合成に 1.32秒）
```

**要件（話し終わり → 喋り始め 2 秒以内）にぎりぎり収まっている。**
ただしこれは音声認識の時間を含んでいないので、実際にはこれより遅い。
詰めるなら次の順で効く。

1. 1文目だけ短く切る（`sentences.ts` の `MIN_LENGTH` は短い断片を次と
   まとめる方向に働くので、1文目に限って緩める余地がある）
2. 音声認識を速いものにする
3. 回答の長さを「短め」にする（`/admin`）

> **Pi では作り直しになる見込み。** 上の数字は Apple Silicon のもので、
> Raspberry Pi 5 は数倍遅い。実時間比が 1.0 を超えると
> **再生が生成に追いつかれて途切れる**。Phase C で必ず測り直すこと。
> 超えていたら (a) 話者を軽いものに変える (b) 1文をもっと短く切る
> (c) 読み上げだけクラウド（ElevenLabs 等）に逃がす、のいずれか。

## 5. ウェイクワード（あと回し）

MVP は画面タップ / スペースキー。先に体験の骨格（先読み読み上げ・状態遷移・
「やめる」）を固める。

足すときの順番:

1. onnxruntime-web + openWakeWord の 3 モデル直列
   （`melspectrogram` → `embedding` → 語）を 80ms ごとに。**専用の Web Worker で回す**
   （メインスレッドだと逐次表示の描画で詰まる）。前処理は WASM バックエンド固定
2. **日本語のウェイクワードモデルは既製品が無い。** VOICEVOX で
   「ねえアイチャット」を数千サンプル合成して学習させる。学習は Mac か Colab で行い、
   `.onnx` だけを `public/` に置く。ブラウザ側は推論のみ
3. 先に英語の既製モデル（`hey_jarvis`）で経路を通し、体験として成立するかを見る

**逃げ道**: ブラウザで重い / 不安定なら、Pi では Python の `openwakeword` で
常時待ち受けし、検出だけをローカルサーバー経由でブラウザに伝える。
`/api/*` の契約は変えずに実装だけ移せる。

## 6. デバイス側ソフト

| 層 | 選定 | 理由 |
|---|---|---|
| ローカルサーバー | **Node 22 + Hono** | Worker から移してきたコードが Web 標準 API（fetch / Response / ReadableStream / crypto.subtle）しか使っておらず、ほぼそのまま動いた。Node 22 は `.ts` をそのまま実行できるのでビルド手順が要らない |
| 画面 | **Vite + 素の TypeScript**（フレームワーク無し） | 状態は5つと本文だけ。`delta` を DOM に直接足すのが最速で、VDOM を挟む理由が無い |
| 配色 | 常に暗い。`prefers-color-scheme` は見ない | 夜のテーブルで白背景は眩しい |
| OS（Pi） | Raspberry Pi OS（64bit, Desktop） | Touch Display 2 とカメラの公式サポート |
| サービス化（Pi） | systemd（`aichat-device-server`, `voicevox`） | 再起動で復旧 |
| 鍵 | `device/server/.env` か OS の鍵束 | git に入れない |
| 設定の保存 | `device/server/data/config.json` | もとは Cloudflare KV。一時ファイル → rename で書くので、電源が落ちても壊れない |
| 更新 | `git pull` + `systemctl restart` | 家庭内 1 台なので OTA は作らない |

`node_modules` を Pi でビルドし直さずに済むよう、`device/web` は Mac で
`vite build` して `dist` を持ち込む。

## 7. Mac で先に動かす

ハードを買う前に、Mac のブラウザで一周を確かめる。**書いたものはそのまま Pi で動く。**

```bash
cd device/server && npm start          # 既定は stub（AI を呼ばない）
cd device/web    && npm run dev        # http://127.0.0.1:5173
```

`127.0.0.1` で開くこと。LAN の IP ではマイクが使えない。

## 決定事項まとめ

| 項目 | 決定 |
|---|---|
| ハード | Raspberry Pi 5 8GB + Touch Display 2 + USB 会議マイク |
| フロント | ブラウザ（Vite + 素の TypeScript）。マイク・無音検出・読み上げもここ |
| サーバー | Node 22 + Hono **1つだけ**。鍵を持ち、AI を直接呼ぶ。Cloudflare Worker は廃止 |
| STT | **ローカルの whisper.cpp**（large-v3-turbo + `-ac 512`、0.74秒）。クラウドにも切り替えられる |
| TTS | **VOICEVOX**。Mac の段階から使う。`speechSynthesis` は確認用のみ |
| 無音検出 | RMS + プリロール 300ms。将来 Silero VAD に差し替え |
| ウェイクワード | あと回し。まずタップ / スペースキー |
| 先行検証 | **Mac のブラウザ**（iPad 版は不採用） |
