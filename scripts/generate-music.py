"""Original seamless chamber-ambient loop. No samples, services or credentials."""
import math
import random
import struct
import wave
from pathlib import Path

RATE = 22050
SECONDS = 64
N = RATE * SECONDS
TAU = math.tau
rng = random.Random(4173)
mix = [0.0] * N

def note(midi, start, duration, gain, bell=False):
    frequency = 440 * 2 ** ((midi - 69) / 12)
    for i in range(int(duration * RATE)):
        t = i / RATE
        attack = min(1, t / (.06 if bell else 2.8))
        release = min(1, (duration - t) / (1.4 if bell else 3.5))
        envelope = attack * release * (math.exp(-t / 2.4) if bell else 1)
        # Soft rounded harmonics, no harsh transients or sub-bass impacts.
        tone = math.sin(TAU * frequency * t)
        tone += (.20 if bell else .12) * math.sin(TAU * frequency * 2 * t)
        tone += .045 * math.sin(TAU * frequency * 3 * t)
        if not bell:
            tone *= .92 + .08 * math.sin(TAU * .18 * t)
        mix[(int(start * RATE) + i) % N] += gain * envelope * tone

# D minor/add9 -> Bb major7 -> G minor9 -> A suspended: slow unresolved suspense.
for bar, chord in enumerate([(38,57,60,64),(34,57,62,65),(31,58,62,69),(33,55,62,64)]):
    for pitch in chord:
        note(pitch, bar * 16, 21, .09 if pitch < 40 else .045)
    for beat, pitch in zip([3,8.5,13], [chord[2]+12,chord[3]+12,chord[1]+12]):
        note(pitch, bar * 16 + beat + rng.uniform(-.2,.2), 5.5, .04, True)

# Wrapped note tails make the 64-second loop continuous at its boundary.
peak = max(abs(v) for v in mix)
dest = Path(__file__).resolve().parents[1] / 'assets/music/manor-nocturne.wav'
dest.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(dest), 'wb') as out:
    out.setparams((1,2,RATE,0,'NONE','not compressed'))
    out.writeframes(b''.join(struct.pack('<h',round(v / peak * 20000)) for v in mix))
print(f'{dest.name}: {SECONDS}s, {dest.stat().st_size} bytes')
