from PIL import Image, ImageDraw

W, H = 720, 1280

def vgrad(size, top, bottom):
    img = Image.new('RGB', size)
    d = ImageDraw.Draw(img)
    for y in range(size[1]):
        t = y / max(1, size[1]-1)
        c = tuple(int(top[i] + (bottom[i]-top[i]) * t) for i in range(3))
        d.line([(0, y), (size[0], y)], fill=c)
    return img

def hexs(s): return tuple(int(s[i:i+2], 16) for i in (1, 3, 5))

# ---------- Pair A: lighthouse coast, morning -> sunset ----------
def coast(sunset):
    if not sunset:
        img = vgrad((W, H), hexs('#79bfe0'), hexs('#fdeecb'))
        sun_c, sun_xy, sun_r = hexs('#fff3b0'), (545, 400), 52
        sea_top, sea_bot = hexs('#4d94c4'), hexs('#1d5f8f')
        cloud_c, rock_c, light_on = hexs('#ffffff'), hexs('#4a4a52'), False
    else:
        img = vgrad((W, H), hexs('#3d4470'), hexs('#ff9e57'))
        sun_c, sun_xy, sun_r = hexs('#ffdf6b'), (545, 690), 64
        sea_top, sea_bot = hexs('#7a5f8e'), hexs('#2c3e70')
        cloud_c, rock_c, light_on = hexs('#ffb98a'), hexs('#2e2a38'), True
    d = ImageDraw.Draw(img, 'RGBA')
    d.ellipse([sun_xy[0]-sun_r, sun_xy[1]-sun_r, sun_xy[0]+sun_r, sun_xy[1]+sun_r], fill=sun_c)
    # sea
    sea = vgrad((W, H-760), sea_top, sea_bot)
    img.paste(sea, (0, 760)); d = ImageDraw.Draw(img, 'RGBA')
    for i, y in enumerate(range(790, 1240, 42)):
        x0 = (i * 67) % 260
        d.line([(x0, y), (x0+130, y)], fill=(255, 255, 255, 90), width=5)
    # clouds (same positions)
    for (cx, cy, s) in [(120, 180, 1.0), (430, 120, 0.8), (250, 300, 0.7)]:
        for dx, dy, r in [(-60, 0, 42), (0, -18, 55), (60, 0, 40)]:
            d.ellipse([cx+dx*s-r*s, cy+dy*s-r*s*0.55, cx+dx*s+r*s, cy+dy*s+r*s*0.55], fill=cloud_c + (210,))
    # rock + lighthouse (same geometry)
    d.polygon([(0, 1280), (0, 800), (90, 760), (210, 790), (260, 900), (240, 1280)], fill=rock_c)
    tower_x0, tower_x1, tower_top, tower_bot = 105, 175, 470, 785
    bands = ['#e8452c', '#f5f2ea', '#e8452c', '#f5f2ea']
    bh = (tower_bot - tower_top) // 4
    for i, c in enumerate(bands):
        shrink = i * 4
        d.polygon([(tower_x0+shrink, tower_top+i*bh), (tower_x1-shrink, tower_top+i*bh),
                   (tower_x1-shrink-3, tower_top+(i+1)*bh), (tower_x0+shrink+3, tower_top+(i+1)*bh)], fill=hexs(c))
    d.rectangle([tower_x0-8, tower_top-38, tower_x1+8, tower_top], fill=hexs('#333340'))
    d.rectangle([tower_x0+18, tower_top-30, tower_x1-18, tower_top-4], fill=hexs('#ffe98a'))
    if light_on:
        d.polygon([(tower_x1-10, tower_top-32), (700, tower_top-95), (700, tower_top+25)], fill=(255, 240, 160, 110))
    return img

# ---------- Pair B: hot-air balloon valley, morning -> dusk ----------
def valley(dusk, bx, by, scale):
    if not dusk:
        img = vgrad((W, H), hexs('#8ec9ee'), hexs('#e8f7e9'))
        m1, m2, field = hexs('#7fae7a'), hexs('#4e7d5a'), hexs('#79b657')
        sun_c, sun_xy = hexs('#fff3b0'), (110, 150)
    else:
        img = vgrad((W, H), hexs('#51457f'), hexs('#ffab5e'))
        m1, m2, field = hexs('#5d5680'), hexs('#3c3a5e'), hexs('#8a7a44')
        sun_c, sun_xy = hexs('#ffb347'), (610, 620)
    d = ImageDraw.Draw(img, 'RGBA')
    d.ellipse([sun_xy[0]-48, sun_xy[1]-48, sun_xy[0]+48, sun_xy[1]+48], fill=sun_c)
    d.polygon([(0, 700), (180, 520), (360, 680), (520, 500), (720, 660), (720, 1280), (0, 1280)], fill=m1)
    d.polygon([(0, 850), (220, 660), (430, 830), (600, 690), (720, 820), (720, 1280), (0, 1280)], fill=m2)
    d.rectangle([0, 1080, W, 1280], fill=field)
    for x in range(30, 720, 90):
        d.line([(x, 1120), (x-25, 1280)], fill=(0, 0, 0, 40), width=6)
    # balloon: vertical stripes clipped to an ellipse
    r = int(95 * scale)
    cols = ['#e8452c', '#f6a21e', '#f5f2ea', '#3a7bd5']
    seg = 2 * r // 4
    mask = Image.new('L', (W, H), 0)
    dm = ImageDraw.Draw(mask)
    dm.ellipse([bx-r, by-r, bx+r, by+r], fill=255)
    stripes = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ds = ImageDraw.Draw(stripes)
    for i, c in enumerate(cols):
        ds.rectangle([bx-r+i*seg, by-r, bx-r+(i+1)*seg, by+r], fill=hexs(c) + (255,))
    img = Image.composite(stripes, img.convert('RGBA'), mask).convert('RGB')
    d = ImageDraw.Draw(img, 'RGBA')
    d.line([(bx-r//2, by+r-6), (bx-16, by+r+52)], fill=(60, 40, 20, 255), width=5)
    d.line([(bx+r//2, by+r-6), (bx+16, by+r+52)], fill=(60, 40, 20, 255), width=5)
    d.rectangle([bx-26, by+r+52, bx+26, by+r+92], fill=hexs('#8a5a2b'))
    return img

out = '/home/hatch/workspace/RH-Runner-Cloud-Linux/test-assets'
coast(False).save(f'{out}/test1-first.jpg', quality=92)
coast(True).save(f'{out}/test1-last.jpg', quality=92)
valley(False, 240, 430, 1.0).save(f'{out}/test2-first.jpg', quality=92)
valley(True, 450, 300, 1.2).save(f'{out}/test2-last.jpg', quality=92)
print('done')
