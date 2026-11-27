"""Regenerate bundled narration: pip install -r scripts/requirements-voice.txt.

Only the public rule scripts are sent to the speech service. No game data or keys.
Normal gameplay plays the bundled MP3 files and does not need Python or network.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]


async def main():
    source = ROOT / "assets" / "rules-narration.json"
    config = json.loads(source.read_text(encoding="utf-8"))
    metadata = {"voice": config["voice"], "rate": config["rate"], "pitch": config["pitch"], "rooms": {}}
    for room, text in config["narrations"].items():
        if room not in ("6", "12"):
            raise ValueError("Unsupported room")
        target = ROOT / "assets" / f"rules-{room}.mp3"
        temporary = target.with_suffix(".mp3.part")
        try:
            await edge_tts.Communicate(
                text, config["voice"], rate=config["rate"], pitch=config["pitch"],
                proxy=os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY"),
            ).save(str(temporary))
            if temporary.stat().st_size < 10000:
                raise ValueError("Speech service returned incomplete audio")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        metadata["rooms"][room] = {
            "file": target.name,
            "voice": config["voice"],
            "textSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "audioSha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "bytes": target.stat().st_size,
        }
        print(f"Generated {target.name}: {target.stat().st_size} bytes", flush=True)
    (ROOT / "assets" / "rules-audio-metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    asyncio.run(main())
