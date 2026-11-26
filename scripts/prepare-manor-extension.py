from pathlib import Path
from PIL import Image, ImageOps, ImageDraw, ImageFilter
import numpy as np, json, hashlib
ROOT=Path.cwd(); src=ROOT/'output/imagegen/twelve-extension'; dst=ROOT/'assets/manor'
hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in dst.glob('portrait-0[1-6]*.webp')}
(src/'original-six-sha256.json').write_text(json.dumps(hashes,indent=2)) if not (src/'original-six-sha256.json').exists() else None
for p in src.glob('portrait-??.png'):
 a=np.asarray(Image.open(p).convert('RGB')).astype(float);r,g,b=[a[:,:,i] for i in range(3)]
 # Strong bright-magenta backdrop only; retains forest green and dark plum clothing.
 strength=np.clip((np.minimum(r,b)-g-25)/190,0,1)*np.clip((np.minimum(r,b)-80)/65,0,1)
 alpha=1-strength
 alpha[alpha<.08]=0
 # Extend actual interior colours to antialiased edges instead of inverting the
 # matte, which can produce green specks on dark hair. Green clothing is opaque.
 known=np.asarray(Image.fromarray(((alpha>.995)*255).astype('uint8')).filter(ImageFilter.MinFilter(7)))>0
 edge=~known;clean=a.copy()
 for _ in range(14):
  count=np.zeros(alpha.shape); colours=np.zeros_like(a)
  for dy,dx in [(0,1),(0,-1),(1,0),(-1,0),(1,1),(1,-1),(-1,1),(-1,-1)]:
   valid=np.roll(known,(dy,dx),(0,1));values=np.roll(clean,(dy,dx),(0,1))
   if dy>0:valid[:dy]=False
   if dy<0:valid[dy:]=False
   if dx>0:valid[:,:dx]=False
   if dx<0:valid[:,dx:]=False
   count+=valid;colours+=values*valid[:,:,None]
  fill=(~known)&(count>0);clean[fill]=colours[fill]/count[fill,None];known|=fill
 a[edge&known]=clean[edge&known]
 out=Image.fromarray(np.dstack([a,np.round(alpha*255)]).astype('uint8'),'RGBA');bounds=out.getchannel('A').point(lambda v:255 if v>5 else 0).getbbox()
 out=ImageOps.expand(out.crop(bounds),border=4,fill=(0,0,0,0));out.thumbnail((800,1100),Image.Resampling.LANCZOS);out.save(dst/(p.stem+'.webp'),quality=91,method=6)
 w,h=out.size;thumb=ImageOps.fit(out.crop((int(w*.18),0,int(w*.82),int(h*.44))),(160,160),method=Image.Resampling.LANCZOS,centering=(.5,.2));thumb.save(dst/(p.stem+'-thumb.webp'),quality=90,method=6)
 face=out.crop((int(w*.32),int(h*.03),int(w*.70),int(h*.25))).resize((456,396),Image.Resampling.LANCZOS)
 preview=Image.new('RGBA',face.size,'#29221d');preview.alpha_composite(face)
 preview.convert('RGB').save(src/(p.stem+'-face.jpg'),quality=95)
 print(p.stem,out.size)
