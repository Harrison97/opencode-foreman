"""Render the link-preview card. Requires Pillow: python3 scripts/docs/render-social-preview.py."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]


def font(size, bold=False):
    names = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"] if bold else ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for name in names:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)


image = Image.new("RGB", (1200, 630), "#f3f1e9")
draw = ImageDraw.Draw(image)
ink, orange, muted, line = "#252a25", "#c34520", "#62665e", "#c4ccb6"
draw.rounded_rectangle((58, 45, 110, 97), radius=6, fill="#e55b32")
draw.polygon([(72, 57), (101, 57), (101, 65), (81, 65), (81, 72), (96, 72), (96, 80), (81, 80), (81, 91), (72, 91)], fill="#fffaf0")
draw.text((125, 43), "foreman.", font=font(47, True), fill=ink)
draw.text((1142, 63), "A PLUGIN FOR OPENCODE", anchor="rt", font=font(17, True), fill=muted)
draw.text((58, 140), "Your agent codes.", font=font(66, True), fill=ink)
draw.text((58, 222), "Foreman keeps it on track.", font=font(66, True), fill=orange)
draw.text((60, 317), "One request. A plan, reviewed code, and a checked result.", font=font(25), fill=muted)
for i, title in enumerate(["Plan", "Build", "Review", "Deliver"]):
    x = 60 + i * 282
    draw.rounded_rectangle((x, 402, x + 236, 479), radius=7, fill="#fff0e5" if i == 2 else "#fffef8", outline=orange if i == 2 else line, width=2)
    draw.text((x + 118, 425), title, anchor="mt", font=font(27, True), fill=orange if i == 2 else ink)
    if i < 3:
        draw.line((x + 247, 441, x + 269, 441), fill=muted, width=3)
        draw.polygon([(x + 271, 441), (x + 263, 435), (x + 263, 447)], fill=muted)
draw.line([(742, 482), (742, 524), (460, 524), (460, 483)], fill=orange, width=2)
draw.polygon([(460, 481), (454, 490), (466, 490)], fill=orange)
draw.rectangle((491, 511, 715, 536), fill="#f3f1e9")
draw.text((601, 514), "Fix issues & check again", anchor="mt", font=font(18), fill=orange)
draw.line((60, 567, 1140, 567), fill=line)
draw.text((60, 588), "YOUR TOOLS. YOUR MODELS. A WORKFLOW YOU CONTROL.", font=font(13, True), fill=muted)
image.save(ROOT / "site/social-preview.png", optimize=True)
