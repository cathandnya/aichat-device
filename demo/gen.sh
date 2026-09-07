#!/bin/bash
#
# 動画用のデモ音声を作る。家の VOICEVOX を呼ぶ（HOST で変えられる）。
#
# ウェイクワードと用件を **別のファイルに分けてある**。端末は
# 「ずんだもん」に気づくと効果音（wake.mp3, 約 1.0 秒）を鳴らすが、
# **その間もマイクは録り続けている**（MainActivity.kt の Event.Wake は
# 鳴らすだけで、聞き取りを止めない）。続けて喋ると用件の頭が効果音と
# 重なり、聞き取りを損なう。**効果音が鳴り終わってから用件を鳴らす。**
#
#   afplay demo/00-wake.wav      # 呼ぶ → 効果音が鳴る
#   afplay demo/05-timer-10s.wav # 鳴り終わってから用件
#
# 続けて鳴らすだけで済むよう、間に無音を挟んだ 1 本ものも作る（-full）。
#
#   afplay demo/05-timer-10s-full.wav
#
set -e
HOST="${HOST:-http://localhost:50021}"
SPK="${SPK:-8}"      # 8 = 春日部つむぎ ノーマル
WAKE="${WAKE:-ずんだもん}"
# 効果音（1.04 秒）が鳴り終わるまでの間。少し余裕を持たせる。
GAP="${GAP:-1.4}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUTDIR="${OUTDIR:-$HERE}"
mkdir -p "$OUTDIR"

# 文字列を JSON にする。台詞に " や \ は使わないが、素通しにはしない。
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' "$1"; }

# VOICEVOX で 1 本合成する。$1 = 出力パス, $2 = テキスト
synth() {
  curl -sf -X POST "$HOST/audio_query?speaker=$SPK" --get --data-urlencode "text=$2" \
  | curl -sf -X POST "$HOST/synthesis?speaker=$SPK" \
      -H "Content-Type: application/json" -d @- -o "$1"
}

# **一覧は台本から作る。** remote.html に台詞を書き写すと、
# ここを直したときに片方だけ古くなる。
MANIFEST="$OUTDIR/commands.json"

section() { printf '{"section":%s}\n' "$(json_str "$1")" >> "$MANIFEST.tmp"; }

# 呼びかけと組にしない言葉（会話を終える言葉）。-full は作らない。
end() {
  local num="$1" text="$2"
  synth "$OUTDIR/${num}.wav" "$text"
  printf '{"id":%s,"text":%s,"nofull":true}\n' "$(json_str "$num")" "$(json_str "$text")" \
      >> "$MANIFEST.tmp"
  printf '%-26s %s\n' "$num" "$text"
}

# 用件だけを作り、続けて「ウェイクワード＋無音＋用件」の 1 本ものも作る。
say() {
  local num="$1" text="$2"
  synth "$OUTDIR/${num}.wav" "$text"
  "$HERE/join.py" "$OUTDIR/00-wake.wav" "$OUTDIR/${num}.wav" \
      "$OUTDIR/${num}-full.wav" "$GAP"
  printf '{"id":%s,"text":%s}\n' "$(json_str "$num")" "$(json_str "$text")" \
      >> "$MANIFEST.tmp"
  printf '%-26s %s\n' "$num" "$text"
}

# --- 呼びかけ（これだけ単体。効果音が鳴り終わるのを待つ） ---
: > "$MANIFEST.tmp"
synth "$OUTDIR/00-wake.wav" "$WAKE"
printf '%-26s %s\n' "00-wake" "$WAKE"

# 以下は **用件だけ**。頭にウェイクワードを付けない。
# --- 一息で聞く（3 秒待たない） ---
section "一息で聞く"
say 02-weather             "明日の天気は"
say 03-weather-today       "今日の天気は？"
# 日付・時刻・曜日は道具ではなく、chat.ts が指示文に入れた「いま」で答える。
say 04-clock               "今何時？"
say 34-train               "中央線動いてる？"
# --- タイマー ---
section "タイマー"
say 05-timer-10s           "10秒のタイマーかけて"
say 06-timer-remain        "あと何分？"
say 07-timer-dup           "5分のタイマーかけて"
say 08-timer-cancel        "タイマーやめて"
say 09-timer-pasta         "パスタのタイマー、7分でかけて"
# --- 音量 ---
section "音量"
say 10-vol-up              "音量を大きくして"
say 11-vol-down            "音量を小さくして"
say 12-vol-max             "音量を最大にして"
say 13-vol-half            "音量を半分にして"
say 14-vol-get             "いま音量どれくらい？"
# --- 家の情報 ---
section "家の情報"
say 15-house-power         "今、いえでどれくらい電気使ってる？"
say 16-ice-water           "製氷機の水ある？"
# 遠回しな聞き方。道具は水の有無しか分からないので、氷が作れるかは
# そこから答えさせる。
say 35-ice-can             "氷作れる？"
# --- PC の電源 ---
section "PC の電源"
say 17-pc-status           "パソコンついてる？"
say 18-pc-on               "パソコンつけて"
say 19-pc-off              "パソコン消して"
# --- 雑談・その他 ---
section "雑談・その他"
say 20-hello               "おはよう"
say 21-selfintro           "あなたは誰？"
# 道具を使わない問い。**答えが定まるものにする。**
# 開いた問い（「元気？」「面白い話して」）は、指示文の「結論を2〜3文」
# 「推測で埋めない」が短く切り上げる方に働いて、薄い返事になった。
say 36-pasta-yude          "パスタの茹で方は？"
say 38-shoyu               "醤油とたまり醤油の違いは？"

# --- 追い質問の窓で言う言葉 ---
#
# **呼びかけを付けない。** 追い質問の窓（既定 8 秒）の中で言う言葉なので、
# ウェイクワードは要らない。会話が続くところを撮るのに使う。
# 窓の間に話しかければ同じチャットの続きになり、窓が開き直る。
section "相槌（呼びかけ不要）"
end 22-aizuchi-sounanda      "そうなんだ"
end 23-aizuchi-hee           "へえ"
end 24-aizuchi-naruhodo      "なるほど"
end 25-aizuchi-sugoi         "すごいね"

section "話をつなぐ（呼びかけ不要）"
end 26-tsunagi-tokorode      "ところで"
end 27-tsunagi-sorekara      "それから"
end 28-tsunagi-jaa           "じゃあ"
end 29-tsunagi-hokoniha      "ほかには？"

# --- 会話を終える言葉 ---
#
# **これだけは呼びかけを付けない。** 追い質問の窓（8 秒）の中で言う言葉で、
# ウェイクワードは要らない。session.ts が AI を呼ばずにその場で閉じる。
# 判定は部分一致（wake.ts の matchesWake）なので「もういいよ」でも当たる。
# 語そのものは admin の「追い質問 › 終了語」で変えられる。
section "会話を終える（呼びかけ不要）"
end 30-end-thanks           "ありがとう"
end 31-end-owari            "おわり"
end 32-end-mouii            "バイバイ"
end 33-end-matane           "またね"

# 行ごとの JSON をひとつにまとめる。
python3 -c 'import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump({"wake":{"id":"00-wake","text":sys.argv[2]},"gap":float(sys.argv[3]),"rows":rows},
          open(sys.argv[4],"w"), ensure_ascii=False, indent=2)' \
  "$MANIFEST.tmp" "$WAKE" "$GAP" "$MANIFEST"
rm -f "$MANIFEST.tmp"
echo "一覧: $MANIFEST"
