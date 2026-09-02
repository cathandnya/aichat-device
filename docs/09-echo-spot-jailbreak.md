# 09. Echo Spot に LineageOS を入れる

デバイスを自作せず、**家にある Echo Spot 初代の中身を入れ替えて使う**
（[06](06-device-implementation.md) の決定）。その作業手順。

> **この文書は XDA の2つのスレッドを読んで書いた。**
> 実際に流すファイルと最終的な手順は**必ず本家を見ること**。
> ここは「何が起きるか」「どこで詰まるか」を先に把握するためのもの。
>
> - [解除・root・TWRP・復旧（rook）](https://xdaforums.com/t/unlock-root-twrp-unbrick-amazon-echo-spot-2017-rook.4754878/)
> - [LineageOS 18.1（rook）](https://xdaforums.com/t/rom-unofficial-11-rook-lineageos-18-1-for-the-amazon-echo-spot-2017.4762459/)

---

## 対象

| | |
|---|---|
| 機種 | **Echo Spot 第1世代（2017）だけ。** コード名 `rook`、型番 `VN94DQ` |
| FireOS | `5.5.6.9`（最新）/ `5.5.5.2`（2022）/ `5.5.3.4`（2019） のいずれか |
| SoC | MediaTek MT8163 |

**Echo Spot 2024（第2世代）は対象外。** 別のハードで、この穴が無い。
`amonet` は機種ごとに中身が違うので、**Echo Show 5（`checkers`）用のファイルを
流用しない**こと。

確かめ方は `設定 → デバイスオプション → デバイスについて`、または背面のラベル。

---

## 始める前に

### 1. これ以上アップデートさせない ★

`5.5.6.9` は対応リストの上限。**ネットに繋いだまま放置すると更新されて、
条件から外れる可能性がある。** 作業すると決めたら**先に WiFi を切る**。
一番安いリスク回避。

### 2. 背面の隠しパネルを剥がす

**micro-USB は隠れている。** 見えているのは電源ジャックと 3.5mm だけ。

```
        ┌─── 背面 ───┐
        │  ⏻    ▭    ○  │
        │ 電源 [板] 3.5mm │
        │       ↑        │
        └─ micro-USB ─┘
```

電源ジャックと 3.5mm の**間**にある小さなプラスチックの板を、
**小さなマイナスドライバーで剥がす**。細い接着剤で留まっているだけで、
ネジは無い。分解ではない。

貼り直せるが、**外したままのほうがよい**（あとで `adb` を繋ぐたびに剥がすことになる）。

### 3. 用意するもの

| | |
|---|---|
| 母艦 | **Windows か Linux。** macOS は手順に書かれていない |
| ケーブル | micro-USB。**データが通るもの**（充電専用は認識しない） |
| 電源 | **AC アダプタも要る。** micro-USB は給電用ではないので両方挿す |
| XDA のアカウント | 添付ファイルのダウンロードに要る |
| Windows のとき | **Kindle Fire ドライバ**（`kindle_fire_usb_driver.zip` の `Fire_Devices ADB drivers.exe`）。駄目なら Google の USB ドライバ |
| どちらでも | **Android SDK Platform-Tools**（`adb` / `fastboot`） |

### 4. 覚悟しておくこと

> **多くの個体は BROM USBDL が使えないので、文鎮化は永久で復旧不能になりうる。**

- **パーティションテーブル（GPT）が書き換わり、userdata は消える。**
  Alexa の設定は戻らない
- **`TEE1` / `LK` / `Preloader` は絶対に書き換えない。** 復旧の手段が無くなる
  （原文は「BOOTLOADER や CRITICAL PARTITIONS（LK・Preloader・TZ）」とも書く。同じもの）
- 純正ファームの更新を当てるときは、**必ず TWRP から**焼く
  （critical partition を触らないため。`.bin` を `.zip` に改名すればよい）
- 実験台は**初代の1台だけ**。Spot 2024 は触らない

### 5. バックアップの取り方に注意 ★

**TWRP 標準のバックアップは失敗する。** 内部ストレージの空きが足りないため
（Echo Show 5 で実際に踏んだ人の記録）。

代わりに **`dd` で各パーティションを adb 経由で PC に直接流す**。

```bash
adb shell "dd if=/dev/block/by-name/boot" > boot.img
```

`boot` / `system` / `userdata` / `recovery` を同じ要領で。
**戻せる状態を作ってから先に進むこと。**

> **分解せずに丸ごとバックアップする道もある。** ZIP 同梱の `brick.sh` は
> Preloader のヘッダを意図的に壊して BootROM モードに落とす。
> そこから `mtkclient` でフラッシュ全体を吸い出せる。
> **本体を開けなくてよい**のが利点。

---

## 解除する（正常に動く機体）

現行版は **`amonet-rook-v2.0.0.zip`**（解除スレッドの添付）。

1. zip を展開する
2. **先にスクリプトを走らせる。** Windows は `fastbrick.bat` をダブルクリック、
   Linux は展開先で `./fastbrick.sh`
3. **本体上部の 3 つのボタン（MUTE / 音量− / 音量＋）を全部押しながら、
   AC アダプタを挿す** → 画面に `=> FASTBOOT mode...` が出る
4. micro-USB で PC に繋ぐ。スクリプトが自動で見つける
5. 訊かれたら **`YES`（大文字・半角）** と入力する。PC と本体の両方の指示に従う
6. **⚠ 10 秒の猶予を過ぎたら絶対に中断しない。中断＝文鎮化**
7. 最大 5 分待つ。TWRP で再起動したら解除完了

**すでに解除済みで版を上げるだけなら**、TWRP で zip を焼くだけでよい。

> **一発で通るとは限らない。** 実際にやった人の記録に
> 「何度か試してようやく意図どおり動いた」とある。
> **一番文鎮化しやすいのがここ**なので、焦らないこと。

### 解除したあとのブートモード ★

exploit が音量ボタンを再割り当てするので、**電源を挿すときに押しているキーで
行き先が変わる**。ここを覚えておかないと、あとで TWRP に入れず詰まる。

| 押すキー | 行き先 |
|---|---|
| **音量− だけ** | HACKED FASTBOOT |
| **音量＋ だけ** | TWRP / RECOVERY |
| **MUTE + 音量−**（USB 必須） | USBDL（復旧用） |

PC 側から `boot-recovery.sh` / `boot-fastboot.sh` でも切り替えられる。

### ADB を有効にする

hacked fastboot で 1 回だけ。

```
fastboot oem flags 61
```

### v2.0.0 を使う理由 ★

**退路が増えている。** `MUTE + 音量下` を押しながら（USB を繋いだ状態で）
起動すると、insecure な Preloader USBDL モードに入る。画面は黒いままだが、
`dmesg` に出る。

```
Product: MT8163 Preloader
Manufacturer: PWNED
```

この状態なら **MTKClient で復旧できる。** 古い版にはこれが無い。

> **⚠ USBDL モードで `TEE1` / `LK` / `Preloader` を焼くと hard brick する。**
> 復旧モードなのに、ここで一番やってはいけないことができてしまう。

### 版は必ず最新を使う

過去の更新に、**古い版では詰む**ものが混ざっている。

| 版 | 何が変わったか |
|---|---|
| v1.1.0 | 音量− + MUTE で起動したときに**意図しない初期化**が起きるのを直した |
| v1.1.1 | TWRP の symlink の問題を修正。**LineageOS 18.1 を焼くのにこれが要る** |
| **v2.0.0** | insecure Preloader USBDL（＝復旧の道）を追加 |

---

## ROM を焼く

| | |
|---|---|
| 配布 | [amazon-oss/releases](https://github.com/amazon-oss/releases/releases/tag/lineage-18.1-rook-v0.3) |
| ファイル | `lineage-18.1-20251108-UNOFFICIAL-rook.zip`（452MB、2025-11-08） |

1. TWRP で再起動する
2. **TWRP を最新版にする**
3. **data / system / cache を消す**
4. ROM を焼く
5. 再起動

セットアップウィザードは**外されている**（丸い画面でうまく動かないため）。
出てこなくても壊れていない。

---

## 文鎮化して fastboot に入れなくなったら

**Linux が要る。** 本体を開ける。

```bash
sudo apt update
sudo add-apt-repository universe
sudo apt install python3 python3-serial adb fastboot dos2unix

sudo systemctl stop ModemManager
sudo systemctl disable ModemManager
```

1. **電源と USB のフレキを繋いだまま**分解し、背面のテストポイントを探す
2. `sudo ./bootrom-step.sh` を走らせ、micro-USB を繋ぐと同時に
   **テストポイントを GND にショート**する
   （GND はネジ穴まわりの金属リングや、露出した銅箔ならどこでもよい）
3. スクリプトが「離してよい」と言うまでショートを保つ。Enter を押して待つ
4. hacked fastboot で再起動したら `sudo ./fastboot-step.sh` → Enter
5. TWRP で再起動したら解除完了

> **テストポイントの名前が原文で揺れている。** 「背面の **TP30** を探す」と
> 書かれた直後に「**TM18** をショートする」とある。**添付の写真が正**なので、
> 名前ではなく写真で位置を確かめること。

---

## 入れたあとに効いてくる仕様

**マイクは動いた（実測）。** [06](06-device-implementation.md) の関門はここで越えている。
ただし**入力が小さい**ので、端末側で持ち上げないと使えない（下の「実際に入れてみて」）。

| | |
|---|---|
| **WPA3 非対応** | チップセットの制限。**家の WiFi が WPA3 専用だと繋がらない**。先に確認する |
| **ミュートスイッチが動かない** | しかも **MUTE ボタンが電源ボタンを兼ねる**。[01](01-requirements.md) の「物理ミュートスイッチ」は取り下げ |
| **SELinux が Permissive** | 「機微なデータを置くな」と明記されている。音声は Mac に流すだけで端末に残らないが、[05](05-issues.md) の F 章の前提として書き留める |
| **ディープスリープが意図的に無効** | 据え置きには好都合 |
| 電池 | 常に 100% と報告する見せかけ |
| 5GHz WiFi | 純正では無効だったものが有効 |
| カメラ・Bluetooth | 動かない／不安定。**どちらも使わない** |
| 丸い画面 | 「アプリが丸を考慮していない」は既知の不具合だが、**こちらのアプリは丸前提で描く**ので該当しない |
| `scrcpy` | PC から操作できる。**丸い画面での初期設定はこれが楽** |

**実験的なビルド**であることは作者が明記している。

---

## アプリを入れる

```bash
cd device/android
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

繋ぎ先と立ち絵の入れ方は [`device/android/README.md`](../device/android/README.md)。

## 据え置きの機械にする ★

**電源を入れたら勝手に立ち上がり、余計なものを出さない。** どれも
`adb` で入れる**端末側の設定**なので、リポジトリには残らない。
初期化したら入れ直すことになる。

```bash
# 1. このアプリをホームにする
adb shell cmd package set-home-activity jp.local.aichat.device/.MainActivity

# 2. **標準ランチャーを止める。ここが要点。**
adb shell pm disable-user --user 0 com.android.launcher3

# 3. ロック画面を無効にする
adb shell locksettings set-disabled true
adb shell settings put secure lockscreen.disabled 1

# 4. 通知を出さない
adb shell settings put global heads_up_notifications_enabled 0
adb shell settings put secure lock_screen_show_notifications 0
```

> **`cmd notification set_dnd none` は使わない。** 「すべて消音」なので
> 通知だけでなく**音量スライダーごと無効になる**（設定アプリからも
> 動かせなくなる）。実際にそうして「音量が変えられない」と気づいた。
>
> この端末はサードパーティのアプリが自分のものだけで、通知を出すのは
> システムの常駐ぶん（充電状態など）くらい。それも全画面表示で隠れる
> ので、DND を使わなくても実害は無い。
>
> すでに掛けてしまったときは `adb shell cmd notification set_dnd off`。

**2 を飛ばすと動かない。** ホームの候補が 2 つ（標準ランチャーと
このアプリ）あると、起動のたびに**「どのアプリで開きますか」の選択画面**
（`ResolverActivity`）が出て止まる。実際にそうなった。

`BootReceiver`（`BOOT_COMPLETED`）もアプリに入れてあるが、**ホームに
するほうが確実**。Android 10 以降はバックグラウンドからの Activity 起動に
制限があり、`BOOT_COMPLETED` からの `startActivity` は弾かれることがある。
ホームなら OS が起動時に必ず呼ぶ。

再起動して、設定が残ることと自動で立ち上がることを確かめた。

> **戻すとき**
>
> ```bash
> adb shell pm enable com.android.launcher3
> adb shell locksettings set-disabled false
> adb shell cmd notification set_dnd off
> ```

---

## 実際に入れてみて詰まったところ ★

**どれも実機でしか出ない。** 素の Android の知識だけだと当たらない。

### `.local` が引けない

Android は mDNS を `NsdManager` の層にしか持たないので、OkHttp が使う
`InetAddress` からは `.local` の名前を解決できない（API 30 の実機で確認。
`ping <名前>.local` も通らない）。**繋ぎ先は IP で書く。**

### 平文の `ws://` が既定で拒まれる

Android 9 以降。`AndroidManifest.xml` に `usesCleartextTraffic="true"` が要る。
**失敗しても何も出ない**ので、これに気づくまで時間を使った。

### マイクの入力が小さい ★

**普通の話し声が rms 0.008 ほどにしかならない。** サーバーの音量判定
（暗騒音の 3 倍・下限 0.015）を超えられず、**追い質問だけが反応しない**という
形で出る。ウェイクワードは書き起こしで判定するので通ってしまい、原因が
分かりにくい。

端末側で**送る前に一律 4 倍**する（`MicStream`）。AGC は使わない——無音を
底上げするとウェイクワードの誤検出が増えるし、**そもそもこの端末は
効果チェーンを持たない**（`0 Effect Chains`）。

### 読み上げの最後が切れる

`AudioTrack.stop()` の直後に `playState` は STOPPED になるので、
「鳴り終わるまで待つ」つもりのループが素通りして `release()` が未再生ぶんを
捨てる。`playbackHeadPosition` が書いた長さに追いつくまで数える。

### 鳴り始めと鳴り終わりは端末しか知らない ★

サーバーが WAV の長さから計算すると**実際の再生とずれる**。表情が声より
先に進んだり、追い質問の窓が読み上げ中に開いて**自分の声を拾って話が
遮られた**。表情は音と同じメッセージに載せ、窓は端末の合図で開く。

エコーキャンセルが無いので、**再生中はマイクを送らない**。鳴り終わってからも
350ms 伏せる（スピーカーはバッファのぶん遅れて鳴る）。

### 丸い画面ではスワイプが click になる

上から下へのスワイプ（通知を出す動き）が View の click として拾われ、
**喋っていないのに起動していた**。タッチでの起動はやめた。

## 実際にやった人の記録から

Echo Spot そのものの作業記録は見つからなかったので、**同じ `amonet` を使う
Echo Show 5 の記録**から。手順の骨格は同じ。

> **ただし Echo Show 5 は FireOS 6.5.7.1、Spot は 5.5.6.9。** ファイルも別物。
> **手順書を混ぜないこと。** 実際に「第2世代向けのスクリプトで弾かれ、
> 正しいスレッドを探し直した」という記録がある。

| | |
|---|---|
| 所要時間 | **丸一日**。1〜2時間で終わる作業ではない |
| 母艦 | Windows |
| 難所 | `fastbrick.bat` の 10 秒カウントダウン。**「ここで失敗すると文鎮化する」** |
| 通るまで | 「何度か試してようやく意図どおり動いた」。**一発で通らなくても異常ではない** |
| バックアップ | TWRP 標準は**内部ストレージ不足で失敗**。`dd` + adb で PC に流して回避 |

### こちらの設計の裏づけになったもの ★

同じことをやった人が踏んだ穴のうち、**2つはこの設計では最初から存在しない**。

| 向こうが踏んだ穴 | こちらはどうなっているか |
|---|---|
| **ウェイクワードの頭が録音から欠けた。** 音量で録音を始めるので、気づいたときには語頭が過ぎている。リングバッファで 0.5 秒前を継ぎ足して解決した | **サーバーが 8 秒の輪を常に回している**（`audio/ring.ts`）。検出後に手前を遡って取るので、**端末にバッファが要らない**（[06](06-device-implementation.md) の「プリロールの問題が消える」） |
| **LineageOS 18.1 に日本語 TTS が入っていない。** TalkBack も eSpeak も PicoTTS も無く、オフラインの日本語音声の配布元も消えていた。結局クラウド TTS に逃げた | **読み上げは Mac の VOICEVOX。** 端末は届いた WAV を鳴らすだけなので、端末側の TTS 事情に一切影響されない |

「判断も推論も Mac に集める」という方針が、**そのまま移植の障害を消している**。

---

## 最初に確かめること

| 確かめること | 結果 |
|---|---|
| **マイクが録れるか** | **録れた。** ここが駄目なら計画ごと止まるところだった |
| **エコーキャンセル** | **`false`。** MT8163 に載っていない（`0 Effect Chains`）。読み上げ中の割り込みは**このハードでは成立しない**。[01](01-requirements.md) の要件はここを見直す必要がある |
| 480×480 の丸に収まるか | 収まった。density 160、`FLAG_ROUND` |

---

## 参考

| | |
|---|---|
| 解除・復旧（本家） | [XDA `rook` unlock スレッド](https://xdaforums.com/t/unlock-root-twrp-unbrick-amazon-echo-spot-2017-rook.4754878/) |
| ROM（本家） | [XDA `rook` LineageOS スレッド](https://xdaforums.com/t/rom-unofficial-11-rook-lineageos-18-1-for-the-amazon-echo-spot-2017.4762459/) |
| ビルド配布 | [amazon-oss/releases](https://github.com/amazon-oss/releases/releases/tag/lineage-18.1-rook-v0.3) |
| exploit のソース | [R0rt1z2/amonet（mt8163-rook ブランチ）](https://github.com/R0rt1z2/amonet/tree/mt8163-rook) |
| TWRP のソース | [R0rt1z2/twrp_device_amazon_echo-mt8163](https://github.com/R0rt1z2/twrp_device_amazon_echo-mt8163) |
| 隠し USB の場所 | [AFTVnews](https://www.aftvnews.com/amazons-echo-spot-has-a-hidden-usb-port-concealed-behind-a-removable-panel/) |
| 日本語の実施記録（Show 5） | [LineageOS 化と自作アプリの全記録](https://note.com/huge_lynx6067/n/n9fccdbc081ab) |
| 日本語の手順（Show 5） | [yyoossk のブログ](https://yyoossk.blogspot.com/2025/10/amazon-echo-show-5-12019oslineageos.html) |

> **UART が要るとき**は `TM3` パッド（RX）。既定では LK がカーネルログを
> UART に出さない設定になっている。開発者向け。
