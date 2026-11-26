"""Derive closed lids from existing portraits; no model requests or new faces.
Coordinates are on each portrait's 400x250 face reference crop.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math

ROOT=Path(__file__).resolve().parents[1]
EYES=[
 [([(85,31),(145,25),(182,48),(187,66),(166,81),(115,79),(84,56)],(90,48,178,61)), ([(248,65),(290,57),(328,75),(329,94),(305,114),(265,112),(242,91)],(250,85,322,87))],
 [([(104,44),(153,41),(196,61),(201,74),(177,86),(127,82),(103,62)],(109,57,195,70)), ([(247,67),(283,60),(324,75),(328,87),(309,100),(265,98),(243,86)],(250,81,323,84))],
 [([(128,63),(172,59),(217,77),(220,91),(200,106),(147,103),(126,85)],(132,77,214,88)), ([(284,92),(322,83),(363,94),(365,109),(345,125),(305,124),(280,110)],(285,106,360,104))],
 [([(40,98),(78,85),(120,92),(134,110),(121,128),(88,143),(49,132),(37,113)],(44,114,127,106)), ([(199,66),(241,47),(281,47),(293,62),(293,76),(255,98),(213,100),(197,82)],(203,84,286,62))],
 [([(126,51),(166,48),(209,60),(211,76),(193,90),(151,91),(122,74)],(129,65,206,71)), ([(277,72),(317,65),(357,70),(359,87),(341,102),(301,102),(274,88)],(281,86,355,81))],
 [([(111,30),(151,29),(178,45),(191,67),(180,82),(143,84),(113,67)],(115,48,185,65)), ([(263,81),(298,73),(328,83),(343,108),(326,124),(291,127),(263,109)],(267,99,337,107))]
]

sheet=Image.new('RGB',(1200,600),'#29221d')
for index,eyes in enumerate(EYES,1):
    source=Image.open(ROOT/f'assets/manor/portrait-{index:02}.webp').convert('RGBA')
    w,h=source.size
    box=(int(w*.38),int(h*.105),int(w*.62),int(h*.20))
    face=source.crop(box).resize((400,250),Image.Resampling.LANCZOS)
    original=face.copy()
    for polygon,(x1,y1,x2,y2) in eyes:
        mask=Image.new('L',face.size);ImageDraw.Draw(mask).polygon(polygon,fill=255)
        mask=mask.filter(ImageFilter.GaussianBlur(2))
        bottom=max(p[1] for p in polygon)
        left=min(p[0] for p in polygon);right=max(p[0] for p in polygon)
        # Interpolate the adjacent cheek skin, preserving each face's own coloring.
        skin=Image.new('RGBA',face.size)
        for x in range(max(0,left-8),min(400,right+9)):
            samples=[original.getpixel((x,min(249,bottom+dy))) for dy in (6,9,12)]
            color=tuple(round(sum(c[k] for c in samples)/len(samples)) for k in range(3))
            for y in range(max(0,min(p[1] for p in polygon)-8),min(250,bottom+9)):
                shade=1-.045*max(0,(bottom-y)/(bottom-min(p[1] for p in polygon)))
                skin.putpixel((x,y),tuple(round(c*shade) for c in color)+(255,))
        face=Image.composite(skin,face,mask)
        draw=ImageDraw.Draw(face)
        curve=[]
        for step in range(101):
            t=step/100
            curve.append((x1+(x2-x1)*t,y1+(y2-y1)*t+10*math.sin(math.pi*t)))
        draw.line(curve,fill=(68,39,33,255),width=3)
        draw.line([(x,y-5) for x,y in curve[10:-10]],fill=(153,105,86,255),width=1)
    source.paste(face.resize((box[2]-box[0],box[3]-box[1]),Image.Resampling.LANCZOS),box[:2])
    source.save(ROOT/f'assets/manor/portrait-{index:02}-closed.webp',quality=92)
    sheet.paste(face.convert('RGB'),(((index-1)%3)*400,((index-1)//3)*300+25))
sheet.save(ROOT/'output/playwright/eyes-closed-reference.jpg',quality=95)
print('Created six closed-eye portrait variants.')
