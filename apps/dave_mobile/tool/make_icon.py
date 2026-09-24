"""Draws the Dave app icon at every Android size from one description.

Run from apps/dave_mobile:
  python3 tool/make_icon.py android/app/src/main/res /tmp/icon-preview.png ios/Runner/Assets.xcassets/AppIcon.appiconset
(needs Pillow and numpy). The iOS folder is optional.

Design: deep blue -> indigo field, three rising frosted-glass bars, and a white trend line with an
end dot. Everything is drawn at 4x and downsampled, so edges are clean at every density.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

RES = sys.argv[1]  # android/app/src/main/res
PREVIEW = sys.argv[2]  # where the 1024 preview goes
SS = 4  # supersampling


def superellipse_mask(size, inset=0.0, n=4.6):
    """Continuous-curvature squircle. n=5 is the closest simple superellipse to Apple's mask."""
    s = size * SS
    y, x = np.mgrid[0:s, 0:s].astype(np.float64)
    half = s / 2.0
    r = half * (1 - inset)
    v = np.abs((x + 0.5 - half) / r) ** n + np.abs((y + 0.5 - half) / r) ** n
    return Image.fromarray(((v <= 1.0) * 255).astype(np.uint8), "L")


def gradient(size):
    s = size * SS
    t = np.linspace(0, 1, s)[:, None]
    top = np.array([64, 140, 255], dtype=np.float64)  # bright system blue
    bottom = np.array([36, 44, 190], dtype=np.float64)  # indigo
    rgb = top * (1 - t) + bottom * t
    img = np.repeat(rgb[:, None, :], s, axis=1).reshape(s, s, 3)
    # soft light from the top-left, as if lit from above
    yy, xx = np.mgrid[0:s, 0:s] / s
    glow = np.clip(1 - np.hypot(xx - 0.25, yy - 0.1) / 0.9, 0, 1) ** 2 * 40
    img = np.clip(img + glow[..., None], 0, 255)
    return Image.fromarray(img.astype(np.uint8), "RGB").convert("RGBA")


def rrect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def glyph_layers(size, scale=1.0):
    """Returns (glass bars RGBA, line RGBA, silhouette L) for a canvas of `size`, glyph scaled around centre."""
    s = size * SS
    u = s / 100.0 * scale  # glyph units: 100 = full canvas at scale 1
    cx = s / 2
    ox = cx - 50 * u  # origin so the 100-unit glyph box is centred
    oy = s / 2 - 50 * u

    def P(x, y):
        return (ox + x * u, oy + y * u)

    bars = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sil = Image.new("L", (s, s), 0)
    bd = ImageDraw.Draw(bars)
    sd = ImageDraw.Draw(sil)
    base = 78
    width = 15
    for i, h in enumerate([22, 36, 52]):
        x0 = 20 + i * 22
        box = [*P(x0, base - h), *P(x0 + width, base)]
        rrect(bd, box, 4.5 * u, (255, 255, 255, 70))
        bd.rounded_rectangle(box, radius=4.5 * u, outline=(255, 255, 255, 90), width=max(1, int(0.6 * u)))
        rrect(sd, box, 4.5 * u, 150)
        # specular top edge of each glass bar
        edge = [*P(x0 + 2, base - h + 1.2), *P(x0 + width - 2, base - h + 2.6)]
        rrect(bd, edge, 1.2 * u, (255, 255, 255, 150))

    line = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ld = ImageDraw.Draw(line)
    pts = [P(16, 64), P(38, 50), P(54, 56), P(80, 28)]
    w = int(5.0 * u)
    ld.line(pts, fill=(255, 255, 255, 255), width=w, joint="curve")
    sd.line(pts, fill=255, width=w, joint="curve")
    for p in pts[:1]:
        ld.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=(255, 255, 255, 255))
        sd.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=255)
    end = pts[-1]
    rdot = 5.8 * u
    ld.ellipse([end[0] - rdot, end[1] - rdot, end[0] + rdot, end[1] + rdot], fill=(255, 255, 255, 255))
    sd.ellipse([end[0] - rdot, end[1] - rdot, end[0] + rdot, end[1] + rdot], fill=255)
    return bars, line, sil


def compose(bg, bars, line):
    """Glass = the background blurred and brightened where the bars are, plus their tint and edges."""
    blurred = bg.filter(ImageFilter.GaussianBlur(bg.width / 40))
    frost = Image.blend(blurred, Image.new("RGBA", bg.size, (255, 255, 255, 255)), 0.18)
    mask = bars.split()[3].point(lambda a: 255 if a > 0 else 0)
    out = bg.copy()
    out.paste(frost, (0, 0), mask)
    out = Image.alpha_composite(out, bars)
    # a soft shadow under the line lifts it off the glass
    shadow = Image.new("RGBA", bg.size, (10, 20, 80, 0))
    shadow.putalpha(line.split()[3].filter(ImageFilter.GaussianBlur(bg.width / 90)).point(lambda a: int(a * 0.45)))
    shadow = shadow.transform(shadow.size, Image.AFFINE, (1, 0, 0, 0, 1, -bg.width / 160))
    out = Image.alpha_composite(out, shadow)
    return Image.alpha_composite(out, line)


def down(img, size):
    return img.resize((size, size), Image.LANCZOS)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


# 1. Legacy launcher icons + round icons: the full squircle on transparent.
def squircle_icon(size, inset=0.0):
    bg = gradient(size)
    bars, line, _ = glyph_layers(size, scale=0.88)
    art = compose(bg, bars, line)
    # hairline light rim, the glass edge of the tile itself
    mask = superellipse_mask(size, inset)
    rim = superellipse_mask(size, inset + 0.012)
    edge = Image.eval(Image.fromarray(np.array(mask) - np.minimum(np.array(mask), np.array(rim))), lambda a: int(a * 0.35))
    art = Image.alpha_composite(art, Image.merge("RGBA", (Image.new("L", art.size, 255),) * 3 + (edge,)))
    art.putalpha(mask)
    return down(art, size)


density = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, f in density.items():
    px = int(48 * f)
    icon = squircle_icon(px, inset=0.04)
    save(icon, f"{RES}/mipmap-{name}/ic_launcher.png")
    save(icon, f"{RES}/mipmap-{name}/ic_launcher_round.png")

    # 2. Adaptive icon layers (108dp canvas, 72dp visible, 66dp safe zone). The launcher applies
    #    its own shape, so the background is full bleed and the glyph stays inside the safe zone.
    ap = int(108 * f)
    bg = gradient(ap)
    bars, line, sil = glyph_layers(ap, scale=0.60)
    save(down(bg, ap), f"{RES}/mipmap-{name}/ic_launcher_background.png")
    # the glass bars need the background to frost; bake a frosted copy into the foreground
    fg = compose(bg, bars, line)
    fg_mask = Image.eval(bars.split()[3], lambda a: 255 if a else 0)
    fg_mask = Image.fromarray(np.maximum(np.array(fg_mask), np.array(line.split()[3])))
    fg.putalpha(fg_mask)
    save(down(fg, ap), f"{RES}/mipmap-{name}/ic_launcher_foreground.png")
    # 3. Monochrome layer for Android 13+ themed icons: the silhouette only.
    mono = Image.new("RGBA", sil.size, (255, 255, 255, 0))
    mono.putalpha(sil)
    save(down(mono, ap), f"{RES}/mipmap-{name}/ic_launcher_monochrome.png")

    # 4. Notification small icon: white on transparent, the line and dot only (bars are too fine
    #    at 24dp). Android tints it; any colour here would be ignored.
    nb = int(24 * f)
    _, line_n, _ = glyph_layers(nb, scale=1.25)
    stat = Image.new("RGBA", line_n.size, (255, 255, 255, 0))
    stat.putalpha(line_n.split()[3])
    save(down(stat, nb), f"{RES}/drawable-{name}/ic_stat_dave.png")

save(squircle_icon(1024, inset=0.08), PREVIEW)

# 5. iOS: one full-bleed, opaque 1024 image -- iOS applies its own rounded mask and makes every
#    other size from it (single-size app icon, Xcode 14+). Alpha is not allowed in an iOS icon.
if len(sys.argv) > 3:
    ios = sys.argv[3]
    bg = gradient(1024)
    bars, line, _ = glyph_layers(1024, scale=0.84)
    save(down(compose(bg, bars, line), 1024).convert("RGB"), f"{ios}/Icon-1024.png")
    with open(f"{ios}/Contents.json", "w") as f:
        f.write('{\n  "images" : [\n    {\n      "filename" : "Icon-1024.png",\n      "idiom" : "universal",\n'
                '      "platform" : "ios",\n      "size" : "1024x1024"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n')
print("ok")
