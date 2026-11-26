"""Read one public dialogue line from stdin, emit MP3 to stdout; never write files."""
import asyncio
import json
import os
import sys


async def main():
    try:
        import edge_tts
    except ImportError:
        sys.stderr.write("VOICE_DEPENDENCY")
        return 2
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    speech = edge_tts.Communicate(
        data["text"], data["voice"], rate=data["rate"], pitch=data["pitch"],
        proxy=os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY"),
        connect_timeout=12, receive_timeout=30,
    )
    async for chunk in speech.stream():
        if chunk["type"] == "audio":
            sys.stdout.buffer.write(chunk["data"])
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    try:
        result = asyncio.run(main())
    except Exception:
        # Upstream errors can contain request data; do not echo them.
        sys.stderr.write("VOICE_NETWORK_ERROR")
        result = 1
    sys.exit(result)
