#!/usr/bin/env python3
"""Génère lib/assets/chatfont.json : atlas de glyphes (alpha 8 bits) de la police Inter (licence SIL OFL 1.1),
utilisé par lib/chatimg.js pour dessiner le chat sans aucune dépendance npm.
Usage : python3 tools/make-chatfont.py [taille_px] [fichier_sortie]   (nécessite Pillow et les polices Inter)
Atlas fournis : 17 px -> lib/assets/chatfont.json (720p et moins), 26 px -> lib/assets/chatfont26.json (1080p, panneau net sans agrandissement)"""
import base64, json, sys
from PIL import Image, ImageDraw, ImageFont

SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 17
OUT = sys.argv[2] if len(sys.argv) > 2 else 'lib/assets/chatfont.json'
FONTS = {'regular': '/usr/share/fonts/opentype/inter/Inter-Regular.otf', 'bold': '/usr/share/fonts/opentype/inter/Inter-Bold.otf'}
# ASCII, Latin-1, Latin étendu A, ponctuation typographique courante
CHARS = [chr(c) for c in range(32, 127)] + [chr(c) for c in range(160, 384)] + list('‘’‚“”„…–—•€™‹›←→↑↓♥★☆✓✔✗×÷≈≠≤≥°′″')

out = {'size': SIZE}
for name, path in FONTS.items():
    f = ImageFont.truetype(path, SIZE)
    asc, desc = f.getmetrics()
    out['asc'], out['desc'] = asc, desc
    glyphs = {}
    for ch in CHARS:
        adv = f.getlength(ch)
        x0, y0, x1, y1 = f.getbbox(ch, anchor='ls')  # par rapport à la ligne de base
        w, h = x1 - x0, y1 - y0
        if w <= 0 or h <= 0:
            glyphs[ch] = [round(adv, 2), 0, 0, 0, 0, '']
            continue
        im = Image.new('L', (w, h), 0)
        ImageDraw.Draw(im).text((-x0, -y0), ch, font=f, fill=255, anchor='ls')
        glyphs[ch] = [round(adv, 2), w, h, x0, y0, base64.b64encode(im.tobytes()).decode()]
    out[name] = glyphs
with open(OUT, 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
print('glyphes :', len(CHARS), '× 2 · taille', SIZE, 'px')
