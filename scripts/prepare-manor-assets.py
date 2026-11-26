"""Prepare already-generated, chroma-backed production art; never calls an API."""
from pathlib import Path
from PIL import Image, ImageChops, ImageOps, ImageDraw
import json

SOURCE = Path('output/imagegen')
TARGET = Path('assets/manor')
TARGET.mkdir(parents=True, exist_ok=True)
report = []
for name in ['manor-room', 'manor-table'] + [f'portrait-{n:02d}' for n in range(1, 7)]:
    source = SOURCE / (name + '.png')
    if not source.exists():
        continue
    original = Image.open(source).convert('RGB')
    if name == 'manor-room':
        result = original.copy()
        result.thumbnail((1600, 1200), Image.Resampling.LANCZOS)
    else:
        red, green, blue = original.split()
        excess = ImageChops.subtract(green, ImageChops.lighter(red, blue))
        alpha = excess.point(lambda v: round(255 * (1 - min(1, max(0, (v - 20) / 65)))))
        # Suppress green spill before resampling to avoid a colored fringe.
        green = ImageChops.subtract(green, excess.point(lambda v: max(0, v - 8)))
        result = Image.merge('RGBA', (red, green, blue, alpha))
        bounds = alpha.getbbox()
        if not bounds or alpha.getextrema() != (0, 255):
            raise ValueError('Unexpected chroma matte: ' + name)
        result = ImageOps.expand(result.crop(bounds), border=4, fill=(0, 0, 0, 0))
        result.thumbnail((1500, 1000) if name == 'manor-table' else (800, 1100), Image.Resampling.LANCZOS)
    target = TARGET / (name + '.webp')
    result.save(target, 'WEBP', quality=89, method=6)
    if name.startswith('portrait-'):
        w, h = result.size
        thumb = result.crop((int(w * .18), 0, int(w * .82), int(h * .44)))
        thumb = ImageOps.fit(thumb, (160, 160), method=Image.Resampling.LANCZOS, centering=(.5, .2))
        thumb.save(TARGET / (name + '-thumb.webp'), 'WEBP', quality=85, method=6)
    report.append({'asset':name,'width':result.width,'height':result.height,'bytes':target.stat().st_size,'alpha':result.mode == 'RGBA'})
(SOURCE / 'asset-metadata.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
portraits = list(TARGET.glob('portrait-??.webp'))
if portraits:
    sheet = Image.new('RGB', (1200, 900), '#392b25')
    draw = ImageDraw.Draw(sheet)
    for i, path in enumerate(portraits):
        sprite = Image.open(path).convert('RGBA')
        sprite.thumbnail((380, 410), Image.Resampling.LANCZOS)
        x, y = (i % 3) * 400, (i // 3) * 450
        sheet.paste(sprite, (x + (400 - sprite.width) // 2, y), sprite)
        draw.text((x + 20, y + 420), path.stem, fill='#eed29a')
    sheet.save(SOURCE / 'portrait-contact-sheet.jpg', quality=93)
print(json.dumps(report))
