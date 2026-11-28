"""Regenerate bundled narration: pip install -r scripts/requirements-voice.txt.

Only the public rule scripts are sent to the speech service. No game data or keys.
Normal gameplay plays the bundled MP3 files and does not need Python or network.
"""
import asyncio
import hashlib
import json
import os
from tempfile import TemporaryDirectory
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]


async def main():
    source = ROOT / "assets" / "rules-narration.json"
    config = json.loads(source.read_text(encoding="utf-8"))
    metadata = {"voice": config["voice"], "rate": config["rate"], "pitch": config["pitch"], "rooms": {}}
    assets = source.parent
    with TemporaryDirectory(dir=assets) as directory:
        staging = Path(directory)
        for room, text in config["narrations"].items():
            if room not in ("6", "12"):
                raise ValueError("Unsupported room")
            target = staging / f"rules-{room}.mp3"
            with target.open("wb") as audio:
                for paragraph in text.split("\n\n"):
                    if not paragraph.strip():
                        continue
                    for attempt in range(3):
                        try:
                            speech = edge_tts.Communicate(
                                paragraph, config["voice"], rate=config["rate"], pitch=config["pitch"],
                                proxy=os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY"),
                            )
                            frames = bytearray()
                            async for chunk in speech.stream():
                                if chunk["type"] == "audio":
                                    frames.extend(chunk["data"])
                            if not frames:
                                raise ValueError("Empty audio paragraph")
                            break
                        except Exception:
                            if attempt == 2:
                                raise
                            await asyncio.sleep(2 ** attempt)
                    audio.write(frames)
            if target.stat().st_size < 10000:
                raise ValueError("Speech service returned incomplete audio")
            metadata["rooms"][room] = {
                "file": target.name,
                "voice": config["voice"],
                "textSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "audioSha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "bytes": target.stat().st_size,
            }
            print(f"Generated {target.name}: {target.stat().st_size} bytes", flush=True)
        (staging / "rules-audio-metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        for output in staging.iterdir():
            output.replace(assets / output.name)


if __name__ == "__main__":
    asyncio.run(main())
