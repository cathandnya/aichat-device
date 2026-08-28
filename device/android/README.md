# デバイスのアプリ（Android）

Echo Spot 初代に LineageOS 18.1 を入れたものに載せる。
**判断はすべて Mac のサーバーが持つ**ので、ここは
「マイクを送る・音を鳴らす・顔を出す」だけ（[docs/06](../../docs/06-device-implementation.md)）。

## なぜブラウザ（`device/web`）ではないのか

素の Android なら `device/web` を Chrome で開くだけでも動く。それをやめたのは
3 つが消えるため。

| | ブラウザ | このアプリ |
|---|---|---|
| **secure context** | `getUserMedia` に HTTPS が要る。自己署名を通すか Chrome のフラグを立てる | 無関係 |
| **キオスク化** | 別のアプリ（Fully Kiosk 等）で全画面・自動起動・スリープ抑止 | `FLAG_KEEP_SCREEN_ON` と `BOOT_COMPLETED` |
| **エコーキャンセル** | ブラウザ任せ | `AcousticEchoCanceler` を**明示的に付けられる** |

`device/web` は**手元で内容を読む画面**として残る（文字も履歴もそちらにある）。

## 建てる

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug
```

`app/build/outputs/apk/debug/app-debug.apk` ができる。

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 繋ぎ先を変える

既定は `ws://192.168.1.2:9801/ws`。焼き込んでいないので、引っ越しても
建て直さずに済む。

```bash
adb shell am force-stop jp.local.aichat.device
adb shell am start -n jp.local.aichat.device/.MainActivity \
  --es server "ws://192.168.1.10:9801/ws"
```

一度渡せば `SharedPreferences` に残る。

> **先に `force-stop` する。** `singleTask` なので、起動したままだと
> `--es` は既存のインスタンスに届くだけで、繋ぎ直さない。
>
> **`.local` は書かない。** Android は mDNS を `NsdManager` の層にしか
> 持たず、OkHttp が使う `InetAddress` からは引けない（API 30 の実機で確認）。
> 名前で書くと、アプリのデータを消したときに繋がらなくなる。

## 立ち絵を入れる

`app/src/main/assets/character/` に置く。**git には入れない**
（素材の配布元の規約を確かめていない。[web/public/character/README.md](../web/public/character/README.md)
と同じ方針で `.gitignore` 済み）。

**`drawable` ではなく `assets`。** `drawable` に置くと `R.drawable.*` が
コンパイル時に要るので、**画像が無いとビルドごと通らない**。clone した
だけの人が build できなくなってしまう。`assets` なら名前で引くだけなので、
無ければ顔が出ないだけで済む。

| ファイル | 中身 |
|---|---|
| `normal.png` | 土台。**目も口も描かれていない** |
| `normal_eye.png` / `normal_eye_close.png` | 目。まばたきで入れ替える |
| `mouse_0.png` | 閉じた口。既定 |
| `mouse_1.png` | 半開き |
| `mouse_2.png` | 大きく開く |

表情は土台と目を差し替える（[docs/08](../../docs/08-emotion.md) の 5 種類）。
`happy` / `sad` / `angry` / `surprised` も同じ組を用意する。
**口は表情で変わらないので共通の 1 組**でよい。

- **全部同じ大きさにすること**（480x480）。重ねて位置を合わせるので、
  1 枚でも違うとずれる
- **画像が無くても壊れない**（顔が出ないだけで、声はそのまま動く）。
  表情の絵が欠けているときは `normal` に落ちる

## 起動音を入れる

`app/src/main/assets/wake.mp3`。**git には入れない**（立ち絵と同じで、
配布元の規約を確かめていない）。

**`res/raw` ではなく `assets`。** `R.raw.*` はコンパイル時に要るので、
音が無いとビルドごと通らない。**無ければ鳴らないだけ**で会話は動く。

## 見た目だけ試す

サーバーを介さず状態と表情を差し込める。話しかけて音声認識を通さなくても、
登場・口パク・まばたきが見られる。

```bash
adb shell am force-stop jp.local.aichat.device
adb shell am start -n jp.local.aichat.device/.MainActivity \
  --es mock speaking --es emotion happy
```

`mock` は `listening` / `following` / `thinking` / `speaking` / `error`。
`speaking` のときだけ口が動く（音は鳴らない）。

## 実機で最初に見ること

1. **マイクが録れるか。** ここが駄目なら計画ごと止まる
2. **`AcousticEchoCanceler` が有効になるか。** `adb logcat -s aichat` に
   「エコーキャンセル: true/false」が出る。**true なら読み上げ中の割り込みに進める**
3. 顔と縁の光が 480×480 の丸に収まるか

## 依存

**OkHttp だけ。** androidx も Compose も入れていない。画面は `View` を1枚に
描いているだけで、部品を増やすほど据え置きの機械では負債になる。

> **OkHttp は 4.x に留めている。** 5.x は `okhttp-android` を引き込み、
> `compileSdk 37`（プレビュー）を要求してくる。Android 11 に載せる機械に
> プレビュー SDK は要らない。
