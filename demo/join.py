#!/usr/bin/env python3
"""ウェイクワードと用件を、間に無音を挟んで 1 本に繋ぐ。

**sox は使わない**（入っていない機械がある）。wave は標準添付。

    join.py 00-wake.wav 05-timer-30s.wav 05-timer-30s-full.wav 1.4
"""
import sys
import wave


def main(wake: str, body: str, out: str, gap: float) -> None:
    with wave.open(wake) as w:
        params = w.getparams()
        head = w.readframes(w.getnframes())
    with wave.open(body) as w:
        # 形式が違うまま繋ぐと、片方が雑音になる。
        if w.getparams()[:3] != params[:3]:
            sys.exit(f"形式が違う: {wake} と {body}")
        tail = w.readframes(w.getnframes())
    frames = int(params.framerate * gap)
    silence = b"\x00" * (frames * params.sampwidth * params.nchannels)
    with wave.open(out, "w") as w:
        w.setparams(params)
        w.writeframes(head + silence + tail)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]))
