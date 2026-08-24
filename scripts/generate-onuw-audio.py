#!/usr/bin/env python3
"""Generate the fixed One Night Werewolf narration with neural voices.

Setup:  python3 -m pip install edge-tts
Run:    python3 scripts/generate-onuw-audio.py
"""

import asyncio
from pathlib import Path
import wave

import edge_tts


ROOT = Path(__file__).resolve().parents[1] / "public" / "audio" / "onuw"
VOICES = {
    "en": "en-US-AvaMultilingualNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
}
LINES = {
    "en": {
        "wake-nightfall": "Everyone, close your eyes.",
        "wake-dawn": "Everyone, wake up.",
        "wake-werewolf": "Werewolves, wake up and look for each other.",
        "sleep-werewolf": "Werewolves, close your eyes.",
        "wake-minion": "Minion, wake up. Werewolves, stick out your thumbs.",
        "sleep-minion": "Werewolves, put your thumbs away. Minion, close your eyes.",
        "wake-mason": "Masons, wake up and look for each other.",
        "sleep-mason": "Masons, close your eyes.",
        "wake-seer": "Seer, wake up. Look at another player's card, or two of the center cards.",
        "sleep-seer": "Seer, close your eyes.",
        "wake-robber": "Robber, wake up. Swap your card with another player's, then look at it.",
        "sleep-robber": "Robber, close your eyes.",
        "wake-troublemaker": "Troublemaker, wake up. Swap two other players' cards.",
        "sleep-troublemaker": "Troublemaker, close your eyes.",
        "wake-drunk": "Drunk, wake up and swap your card with a center card.",
        "sleep-drunk": "Drunk, close your eyes.",
        "wake-insomniac": "Insomniac, wake up and look at your own card.",
        "sleep-insomniac": "Insomniac, close your eyes.",
    },
    "zh": {
        "wake-nightfall": "天黑请闭眼。",
        "wake-dawn": "天亮了，所有人请睁眼。",
        "wake-werewolf": "狼人请睁眼，互相确认。",
        "sleep-werewolf": "狼人请闭眼。",
        "wake-minion": "爪牙请睁眼。狼人请伸出拇指。",
        "sleep-minion": "狼人请收回拇指，爪牙请闭眼。",
        "wake-mason": "守夜人请睁眼，互相确认。",
        "sleep-mason": "守夜人请闭眼。",
        "wake-seer": "预言家请睁眼。可以查看一名玩家的牌，或者两张中央牌。",
        "sleep-seer": "预言家请闭眼。",
        "wake-robber": "强盗请睁眼。可以与一名玩家交换牌，然后查看。",
        "sleep-robber": "强盗请闭眼。",
        "wake-troublemaker": "捣蛋鬼请睁眼。可以交换另外两名玩家的牌。",
        "sleep-troublemaker": "捣蛋鬼请闭眼。",
        "wake-drunk": "酒鬼请睁眼，与一张中央牌交换。",
        "sleep-drunk": "酒鬼请闭眼。",
        "wake-insomniac": "失眠者请睁眼，查看自己的牌。",
        "sleep-insomniac": "失眠者请闭眼。",
    },
}


async def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    # This brief inaudible clip lets the shared player start during a user
    # gesture, which permits later SSE-triggered calls on mobile browsers.
    with wave.open(str(ROOT / "unlock.wav"), "wb") as audio:
        audio.setparams((1, 2, 8_000, 800, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 800)

    for lang, lines in LINES.items():
        target = ROOT / lang
        target.mkdir(parents=True, exist_ok=True)
        for name, text in lines.items():
            output = target / f"{name}.mp3"
            print(f"{lang}: {name}")
            # A slight lift keeps the longest sleep/wake pair inside the
            # shortest seven-second role step at the brisk game pace.
            await edge_tts.Communicate(text, VOICES[lang], rate="+5%").save(output)


if __name__ == "__main__":
    asyncio.run(main())
