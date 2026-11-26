"""Public-domain wolf call with original blade and impact foley (v4)."""
import array
import glob
import math
import random
import shutil
import struct
import subprocess
import wave
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/sfx/sources/wolf-howls.ogg'
RATE = 44100
DURATION = 2.8
tools = glob.glob(str(ROOT / '.video-venv/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg*.exe'))
exe = tools[0] if tools else 'ffmpeg'
raw = subprocess.check_output([exe, '-v', 'error', '-ss', '6.2', '-i', str(SOURCE), '-t', '1.42', '-af', 'highpass=f=180,lowpass=f=2600,afftdn=nf=-28,atempo=1.75', '-ac', '1', '-ar', str(RATE), '-f', 's16le', '-'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
howl = array.array('h', raw)
peak = max(abs(x) for x in howl) or 1
howl = [x / peak for x in howl]
samples = []
rng = random.Random(4917)
low_noise = 0.0
for i in range(round(DURATION * RATE)):
    t = i / RATE
    value = 0.0
    if i < len(howl):
        envelope = min(1, t / .07) * min(1, max(0, 1.42-t) / .34)
        value += howl[i] * envelope * .60
    noise = rng.uniform(-1, 1)
    low_noise += .085 * (noise - low_noise)
    # A rising air cut, brief blade ring and damped thud follow the real call.
    u = (t - 1.08) / .37
    if 0 < u < 1:
        value += (noise - low_noise) * math.sin(math.pi*u)**2 * .23
    hit = t - 1.44
    if 0 <= hit < .8:
        value += .10 * math.exp(-hit*32) * math.sin(2*math.pi*2350*hit)
        value += .32 * math.exp(-hit*10) * math.sin(2*math.pi*(92*hit-16*hit*hit))
        value += .19 * math.exp(-hit*24) * low_noise
    samples.append(value)
dry = samples[:]
for delay, gain in [(.055, .11), (.10, .065), (.17, .03)]:
    offset = round(delay * RATE)
    for i in range(offset, len(samples)):
        samples[i] += dry[i-offset] * gain
peak = max(abs(x) for x in samples) or 1
with wave.open(str(ROOT / 'assets/sfx/wolf.wav'), 'wb') as output:
    output.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
    output.writeframes(b''.join(struct.pack('<h', round(x / peak * .79 * 32767 * min(1, (len(samples)-i)/(RATE*.16)))) for i, x in enumerate(samples)))
shutil.copyfile(ROOT / 'assets/sfx/wolf.wav', ROOT / 'assets/sfx/wolf-attack-v4.wav')
print(f'Wolf cue v4: {DURATION}s, short call / blade / impact, peak -2.05dBFS')
