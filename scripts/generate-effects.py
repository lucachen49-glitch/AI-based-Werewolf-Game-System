"""Generate versioned, single-strike bell cues without replacing older assets."""
import math
import struct
import wave
from pathlib import Path

RATE = 44100
DURATION = 0.40
OUT = Path(__file__).resolve().parent.parent / 'assets' / 'sfx'

# Distinct pitches keep role cues recognizable while sharing one bell sound.
FREQUENCIES = {
    'shuffle': 659.25, 'deal': 783.99, 'flip': 880.00,
    'night': 493.88, 'wolf': 523.25, 'guard': 698.46,
    'seer': 987.77, 'save': 1174.66, 'poison': 587.33,
    'vote': 830.61, 'exile': 622.25, 'hunter': 739.99,
    'good-win': 1046.50, 'wolf-win': 554.37,
}


def bell_samples(frequency):
    samples = []
    total = int(RATE * DURATION)
    for i in range(total):
        t = i / RATE
        attack = min(1.0, t / 0.004)
        fade = min(1.0, (DURATION - t) / 0.055)
        tone = (math.sin(2 * math.pi * frequency * t) * math.exp(-7 * t)
                + 0.30 * math.sin(2 * math.pi * frequency * 2.76 * t) * math.exp(-15 * t)
                + 0.12 * math.sin(2 * math.pi * frequency * 5.40 * t) * math.exp(-24 * t))
        samples.append(tone * attack * fade)
    scale = 0.55 * 32767 / max(abs(sample) for sample in samples)
    return b''.join(struct.pack('<h', round(sample * scale)) for sample in samples)


OUT.mkdir(parents=True, exist_ok=True)
for name, frequency in FREQUENCIES.items():
    with wave.open(str(OUT / (name + '-bell-v1.wav')), 'wb') as wav:
        wav.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        wav.writeframes(bell_samples(frequency))
print('Generated', len(FREQUENCIES), 'versioned bell cues')
