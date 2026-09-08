# CLAUDE.md

エージェント向けの覚え書き。**実際に踏んだ落とし穴だけ**を書く。

仕様や設計の説明は書かない（[README](README.md) と [docs/](docs/) にある）。
ここに書くのは「知らないと同じ間違いをする」ことに限る。

## 課金

**Claude / Gemini の API を実際に呼んで動作確認しない。** 検証はユーザーが
自分の判断で行う（[README の「開発上の決めごと」](README.md#開発上の決めごと)）。

サーバーは既定が stub（AI を呼ばない）。`npm start` は
**`data/config.json` の設定で live になることがある**ので、
起こす前に確かめる。起動時のログに出る。

```
モード: live（AI の課金が発生します）
```

**自分で起こしたサーバーは自分で止める。** 確認が済んだら落とす。

## 実機（Echo Spot）

`adb` の相手が複数いることがある（エミュレータが残っているなど）。
**`-s` で必ず指名する。**

```bash
adb devices -l          # 実機のシリアルを確かめる
adb -s <シリアル> ...
```

### `am start --es` は届かないことがある ★

この端末はアプリを**ホームに設定して**いる（[docs/09](docs/09-echo-spot-jailbreak.md)）。
`launchMode="singleTask"` と合わせて、次の 2 つが効いてくる。

- **`force-stop` しても止まったままにならない。** 系がすぐホームとして
  起こし直すので、「止めてから `--es` 付きで起動」ができない
- 起動中の `am start` は `onNewIntent` に来る。**`onCreate` でしか読まない
  値は差し替わらない**

`--es mock` / `--es emotion` は `onNewIntent` でも拾う（`MainActivity`）。
**`--es server` は拾わない**ので、繋ぎ先は下のとおり prefs を直接書く。

> `Warning: Activity not started, intent has been delivered to currently
> running top-most instance.` が出ても、mock は効いている。
> **`adb logcat -s aichat` の `mock:` 行で確かめる。**

### 繋ぎ先を変える

手順は [device/android/README](device/android/README.md#繋ぎ先を変える) にある。
その上で踏んだもの。

**`sed` の置換元を決め打ちにしない。** 外れても `sed` は黙って何もしないので、
**成功したように見えて古いまま**になる。先に読む。

```bash
adb -s <シリアル> shell "run-as jp.local.aichat.device \
  cat /data/data/jp.local.aichat.device/shared_prefs/aichat-device.xml"
```

**heredoc でファイルごと書き直さない。** `run-as` の shell は `/data/local` に
一時ファイルを作れず heredoc が使えない。**リダイレクトだけが先に走って
ファイルが空になる**（`device-id` ごと消える。実際に消した）。
丸ごと置き換えるなら `push` してから `cp`。

### 繋がったかは**サーバー側**で確かめる ★

**端末の `繋がりました` は当てにならない。** 古い接続先に繋がっても
同じログが出る。これで「繋がっている」と誤認した。

```bash
lsof -iTCP:9801 -P | grep ESTABLISHED     # LISTEN だけなら繋がっていない
```

サーバーのログにも出る。

```
[ws] つながりました: <端末の IP> (<device-id>)
```

**Mac の IP を思い込まない。** 常用サーバーと開発機の IP が 1 桁違いで
紛らわしいことがある。毎回 `ipconfig getifaddr en0` で確かめる。

### 見た目を確かめる

画面は `adb -s ... exec-out screencap -p > out.png` で取って**実際に見る**。
480x480 の丸なので、ログだけでは収まりや重なりが分からない。

## 素材（立ち絵・音）

**git に入っていない**（`.gitignore`）。
元ファイルは `device/android/zundamon/`、置き場所は
`app/src/main/assets/character/`。**追加したら assets にコピーが要る。**

`assets` であって `drawable` / `res/raw` ではない。**無くても壊れない**
ようにするため（顔が出ない・鳴らないだけで会話は動く）。

## 顔と状態

顔を決めるものが **2 系統**ある。混ぜないこと。

| | 何 | 誰が決める |
|---|---|---|
| `Emotion` | 感情。`[happy]` のタグ | AI が文ごとに吐く（[docs/08](docs/08-emotion.md)） |
| `State` | いま何をしているか | サーバーの状態機械 |

`thinking`（考え中）は**状態であって感情ではない**。`Emotion` に足すと
AI に `[thinking]` を吐かせる話になってしまう。どちらを出すかは
`FaceView.faceSlug` が決める。
