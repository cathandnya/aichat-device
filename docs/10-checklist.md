# 動作確認の項目（2026-08-30 の変更ぶん）

この日に入れた 4 つの変更を、実機で確かめるための一覧。
**上から順にやれば、前の項目が次の前提になる**ように並べてある。

## 準備

| | |
|---|---|
| サーバー | `cd device/server && AICHAT_MODE=stub AICHAT_VOICEVOX_URL=http://192.168.1.2:50021 AICHAT_HOST=0.0.0.0 npm start` |
| モード | **stub（課金なし）**。起動時の表示で確かめる |
| 端末の接続先 | いま `ws://192.168.1.20:9801/ws`（このマシン）。pino に戻すなら下記 |
| 音量 | **上げておく**。低音量だとエコーが小さく、消去の確認にならない |

端末のログ: `adb logcat -s aichat aichat-aec -v time`

接続先を戻すとき（**home アプリなので `--es` が届かない。prefs を直接書く**）:

```sh
adb shell am force-stop jp.local.aichat.device
adb shell "run-as jp.local.aichat.device sh -c 'cat > /data/data/jp.local.aichat.device/shared_prefs/aichat-device.xml' <<'X'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="server">ws://192.168.1.2:9801/ws</string>
    <string name="device-id">android-ebe7</string>
</map>
X"
adb shell am start -n jp.local.aichat.device/.MainActivity
```

---

## 1. ゲインを 24 倍に下げた（issue #1-1）

36 倍は上限まで 2.1 倍しか余裕がなく、手を叩く程度で割れていた。

- [ ] **普通の距離で「ずんだもん」と呼んで反応するか**
      ← 下げすぎて遠くの声を拾えなくなっていないか
- [ ] 近くで大きめに話しても、認識がおかしくならないか（割れの確認）

**駄目なら**: `MicStream.kt` の `GAIN`。24 → 30 あたりに戻す。

---

## 2. 完了判定をやめ、無音 1 秒にした（issue #1-3）

「3 秒待ちが意図せず発生する」への対処。言い切り判定を撤去した。

- [ ] 「ずんだもん、明日の天気は」と**一息で**言い、
      **3 秒待たずに**返ってくるか ← これが狙い
- [ ] 「えーっと…」と 1 秒以上黙ると、そこで切られる
      ← **想定どおりの副作用**。速さと引き換えに承知したもの

**駄目なら**: `endpoint.ts` の `HANGOVER_MS`（いま 1000）。

---

## 3. エコーキャンセル（issue #1-4）★ 今日の山

ハードの AEC が無いので自前で書いた。**線形の引き算では消えず**、
帯域ごとの抑圧に切り替えた（詳細は [03](03-tech-stack.md)）。

- [ ] **読み上げ中に自分の声で起動しないか**
      ← 一番大事。長めの答え（天気など）を最後まで鳴らして、
        `[wake] ★` が出なければ合格
- [ ] `adb logcat` の `[aec] erle=...` が **8dB 以上**出ているか
      ← 参考値。3dB 台なら効いていない

**駄目なら**: 消去を切る。効きが落ちれば `ready` が false になり、
**放っておいても元の挙動（読み上げ中は送らない）に戻る**が、手で切るなら:

```sh
# **`--es aec off` は届かない。** home アプリなので起動意図が競合する。
# prefs に直接書く（server 行はいまの接続先に合わせること）。
adb shell am force-stop jp.local.aichat.device
adb shell "run-as jp.local.aichat.device sh -c 'cat > /data/data/jp.local.aichat.device/shared_prefs/aichat-device.xml' <<'X'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="server">ws://192.168.1.20:9801/ws</string>
    <string name="device-id">android-ebe7</string>
    <boolean name="aec" value="false" />
</map>
X"
adb shell am start -n jp.local.aichat.device/.MainActivity
```

ビルド時に切るなら `Aec.kt` の `ENABLED = false`。

---

## 4. 声で割り込む（未検証）

3 が効いたので、読み上げ中もウェイクワードを判定するようにした。
**ここだけまだ一度も試していない。**

- [ ] 答えを読み上げている**途中で「ずんだもん」と呼ぶ**
- [ ] サーバーに `[wake] 読み上げ中に呼ばれたので止めます` が出るか
- [ ] **読み上げが止まって**、聞き直しに入るか

うまくいかないときに見るところ:

| 症状 | 原因と直し方 |
|---|---|
| 呼んでも反応しない | 抑圧が強すぎて人の声も消えている。`aec_jni.c` の `3.0f`（引く量）を 2.0 くらいに下げる |
| 質問に読み上げの尻尾が混ざる | 割り込み時に 2 秒遡っているため。`beginListening()` の遡りを削る |
| 自分の声で止まってしまう | 3 が効いていない。`--es aec off` に戻す |

---

## 5. 音声を 500ms ずつ刻んで送る

1 文が最大 494KB の 1 メッセージだったのを刻んだ。

- [ ] **鳴り始めが速くなったか** ← 狙い
- [ ] 文の**途中で途切れたり沈黙が入ったりしない**か
      ← 余韻（350ms）がかたまりごとに入ると 3 秒の文に 2 秒の沈黙が
        混ざる。対処済みだが実機で確認したい
- [ ] 表情が文の途中で切り替わり直さないか
      ← 表情は最初のかたまりだけに載せてある

**駄目なら**: `format.ts` の `CHUNK_MS`（いま 500）。

---

## 併せて直したもの（ついでに見る）

- [ ] **読み上げの最後が切れない**か
      （`AudioPlayer` のフレーム数の数え違いを直した。バイト数と
      フレーム数を比べていて 2 倍過大だった）
- [ ] 追い質問で**自分の声を質問として拾わない**か
      （鳴り終わりより前に遡らないようにした。実機で「うん。」を
      質問として答え、勝手に喋り続けたことがある）

---

## 終わったら

- [ ] 接続先を **pino に戻す**（上記のコマンド）
- [ ] 音量を普段の高さに戻す
