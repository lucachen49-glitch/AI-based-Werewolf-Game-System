"""Derive lids and mouth anchors for 07--12 only, retaining the original six."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math, json

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/imagegen/twelve-extension'
# Coordinates on the 456x396 face inspection crop. Never alter eyebrows or faces.
EYES={
7:[([(140,159),(164,156),(191,162),(207,173),(201,184),(175,187),(146,177)],(145,168,203,174)), ([(246,182),(272,179),(302,187),(314,198),(302,208),(275,208),(247,198)],(250,189,309,197))],
8:[([(78,202),(104,196),(130,203),(146,218),(132,234),(103,236),(77,221)],(82,213,143,216)), ([(184,183),(213,170),(241,172),(264,184),(263,202),(237,216),(205,216),(184,202)],(190,198,260,188))],
9:[([(139,177),(171,174),(202,183),(219,194),(203,207),(172,208),(141,196)],(144,187,214,192)), ([(250,194),(277,190),(304,198),(311,210),(298,220),(270,220),(250,209)],(254,202,307,209))],
10:[([(139,150),(162,147),(189,157),(201,173),(190,187),(164,185),(141,171)],(143,161,196,171)), ([(242,183),(268,179),(295,187),(312,203),(300,216),(272,216),(244,204)],(247,194,308,202))],
11:[([(141,164),(168,157),(197,164),(214,177),(201,191),(169,192),(143,181)],(146,173,210,177)), ([(260,178),(286,173),(312,181),(325,197),(311,211),(282,212),(261,199)],(265,188,321,197))],
12:[([(126,151),(153,146),(181,155),(199,174),(187,187),(154,186),(128,172)],(130,161,195,170)), ([(242,179),(267,173),(290,184),(299,198),(281,212),(257,211),(241,198)],(245,190,294,197))],
}
MOUTHS={7:(220,286),8:(192,303),9:(217,303),10:(205,276),11:(227,302),12:(207,276)}

sheet=Image.new('RGB',(1368,792),'#29221d');anchors={}
for index,eyes in EYES.items():
    filename=ROOT/f'assets/manor/portrait-{index:02}.webp'
    if not filename.exists(): continue
    source=Image.open(filename).convert('RGBA');w,h=source.size
    box=(int(w*.32),int(h*.03),int(w*.70),int(h*.25))
    face=source.crop(box).resize((456,396),Image.Resampling.LANCZOS);original=face.copy()
    for polygon,(x1,y1,x2,y2) in eyes:
        mask=Image.new('L',face.size);ImageDraw.Draw(mask).polygon(polygon,fill=255)
        mask=mask.filter(ImageFilter.GaussianBlur(1.7))
        bottom=max(p[1] for p in polygon);top=min(p[1] for p in polygon)
        skin=original.copy()
        for x in range(max(0,min(p[0] for p in polygon)-8),min(456,max(p[0] for p in polygon)+9)):
            samples=[original.getpixel((x,min(395,bottom+d))) for d in (5,8,11)]
            colour=tuple(round(sum(c[k] for c in samples)/len(samples)) for k in range(3))
            for y in range(max(0,top-8),min(396,bottom+9)):
                shade=1-.035*max(0,(bottom-y)/max(1,bottom-top))
                skin.putpixel((x,y),tuple(round(c*shade) for c in colour)+(255,))
        face=Image.composite(skin,face,mask);draw=ImageDraw.Draw(face)
        curve=[(x1+(x2-x1)*t/100,y1+(y2-y1)*t/100+7*math.sin(math.pi*t/100)) for t in range(101)]
        draw.line(curve,fill=(65,38,32,255),width=3)
        draw.line([(x,y-4) for x,y in curve[12:-12]],fill=(151,107,88,255),width=1)
    source.paste(face.resize((box[2]-box[0],box[3]-box[1]),Image.Resampling.LANCZOS),box[:2])
    source.save(ROOT/f'assets/manor/portrait-{index:02}-closed.webp',quality=92,method=6)
    tile=Image.new('RGBA',face.size,'#29221d');tile.alpha_composite(face)
    ImageDraw.Draw(tile).text((12,370),f'Seat {index}',fill='#efcc86')
    sheet.paste(tile.convert('RGB'),(((index-7)%3)*456,((index-7)//3)*396))
    x,y=MOUTHS[index];anchors[f'portrait-{index:02}']={'x':round((box[0]+x/456*(box[2]-box[0]))/w,4),'y':round((box[1]+y/396*(box[3]-box[1]))/h,4)}
sheet.save(OUT/'closed-eye-inspection.jpg',quality=95)
(OUT/'mouth-anchors.json').write_text(json.dumps(anchors,indent=2))
print('Created closed lids and anchors for',list(anchors))
