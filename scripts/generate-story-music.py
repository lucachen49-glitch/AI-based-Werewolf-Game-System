"""Original story scores: shared D-minor harmony, seamless 32-second loops.
No recordings, network access, third-party samples or credentials.
"""
import math
import random
import struct
import wave
from array import array
from pathlib import Path

RATE, SECONDS = 22050, 32
N = RATE * SECONDS
ROOT = Path(__file__).resolve().parents[1] / 'assets/music'
CHORDS = [(38, 57, 60, 64), (34, 57, 62, 65), (31, 58, 62, 69), (33, 55, 62, 64)]

def render(name, mood):
    rng = random.Random(4173 + mood)
    mix = array('d', [0]) * N

    def note(midi, start, duration, gain, instrument='strings'):
        f = 440 * 2 ** ((midi - 69) / 12)
        for i in range(int(duration * RATE)):
            t = i / RATE
            pluck = instrument in ('harp', 'pulse')
            attack = min(1, t / (.035 if pluck else 1.6))
            release = min(1, (duration-t) / (.6 if pluck else 2.8))
            envelope = attack * release * (math.exp(-t / (1.2 if instrument == 'pulse' else 2)) if pluck else 1)
            a = math.tau * f * t
            tone = math.sin(a) + .13 * math.sin(a*2) + .035 * math.sin(a*3)
            if instrument == 'strings':
                tone = .65*tone + .35*math.sin(a + .12*math.sin(math.tau*3.2*t))
            mix[(int(start*RATE)+i) % N] += gain * envelope * tone

    for bar, chord in enumerate(CHORDS):
        start = bar * 8
        for pitch in chord:
            note(pitch + (12 if mood == 4 else 0), start, 12, .055 if pitch < 40 else .032)
        if mood == 0:  # Cold exterior: sparse high glass tones and a restrained low bed.
            for j, pitch in enumerate([chord[2]+24, chord[3]+12]):
                note(pitch, start+2+j*3, 5, .022, 'harp')
        elif mood == 1:  # Candlelit conversation: chamber harp, space around speech.
            for j, pitch in enumerate([chord[1]+12, chord[2]+12, chord[3]+12]):
                note(pitch, start+1+j*2.4, 4, .035, 'harp')
        elif mood == 2:  # Night and story crisis: lower register, no role-specific cue.
            for j in range(4):
                note(chord[0], start+j*2, 1.8, .042, 'pulse')
            note(chord[3], start+4.4, 4, .018, 'harp')
        elif mood == 3:  # Voting: faster muted ostinato, no sharp impact sounds.
            for j in range(8):
                note(chord[0]+(12 if j%2 else 0), start+j, .9, .04, 'pulse')
            note(chord[2]+12, start+3, 4, .022, 'harp')
        else:  # Resolution: high strings, a gentler cadence.
            for j, pitch in enumerate([chord[1]+12, chord[3]+12]):
                note(pitch, start+1+j*3, 5.5, .032, 'harp')
    peak = max(abs(x) for x in mix)
    dest = ROOT / (name + '.wav')
    with wave.open(str(dest), 'wb') as out:
        out.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        out.writeframes(b''.join(struct.pack('<h', round(x / peak * 18000)) for x in mix))
    print(f'{name}: {SECONDS}s, {dest.stat().st_size} bytes')

if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    for mood, name in enumerate(['snow-arrival', 'candle-intrigue', 'bloodmoon-night', 'verdict-pulse', 'dawn-accord']):
        render(name, mood)
