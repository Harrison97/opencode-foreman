"""Render the README workflow images: python3 -m pip install Pillow; python3 scripts/docs/render-workflow.py."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/assets"
OUT.mkdir(parents=True, exist_ok=True)
FONT_DIRS = [Path("/System/Library/Fonts/Supplemental"), Path("/usr/share/fonts/truetype/dejavu")]


def font(size, bold=False):
    names = ["Arial Bold.ttf", "DejaVuSans-Bold.ttf"] if bold else ["Arial.ttf", "DejaVuSans.ttf"]
    for directory in FONT_DIRS:
        for name in names:
            if (directory / name).exists():
                return ImageFont.truetype(str(directory / name), size)
    return ImageFont.load_default(size=size)


INK, MUTED, ORANGE, LINE = "#252a25", "#62665e", "#c34520", "#c4ccb6"
STAGES = ["Plan", "Build", "Review", "Deliver"]
CAPTIONS = ["Break down the work", "Work through the plan", "Run checks. Find issues.", "Hand over the result"]
FRAMES = [
    (0, False, "Make a plan before writing code."),
    (1, False, "Build one manageable piece at a time."),
    (2, False, "Run checks against the requested behavior."),
    (1, True, "Found an issue? Send it back for a fix."),
    (2, False, "Review the fix before moving on."),
    (3, False, "Verify the result, then hand it over."),
]


def render(active, repair, message):
    image = Image.new("RGB", (1000, 264), "#f3f1e9")
    draw = ImageDraw.Draw(image)
    draw.text((26, 18), "FOREMAN / ONE REQUEST. A PROCESS THAT FOLLOWS THROUGH.", font=font(12, True), fill=MUTED)
    for i, (title, caption) in enumerate(zip(STAGES, CAPTIONS)):
        x = 26 + i * 246
        draw.rounded_rectangle((x, 57, x + 210, 133), radius=6,
                               fill="#fff0e5" if active == i else "#fffef8",
                               outline=ORANGE if active == i else LINE, width=2)
        draw.text((x + 105, 70), title, anchor="mt", font=font(22, True), fill=ORANGE if active == i else INK)
        draw.text((x + 105, 105), caption, anchor="mt", font=font(13), fill=MUTED)
        if i < 3:
            color = ORANGE if active == i + 1 and not repair else LINE
            draw.line((x + 215, 95, x + 237, 95), fill=color, width=2)
            draw.polygon([(x + 238, 95), (x + 231, 90), (x + 231, 100)], fill=color)
    color = ORANGE if repair else LINE
    draw.line([(623, 136), (623, 170), (377, 170), (377, 136)], fill=color, width=2)
    draw.polygon([(377, 135), (372, 143), (382, 143)], fill=color)
    draw.rectangle((400, 158, 600, 181), fill="#f3f1e9")
    draw.text((500, 162), "Fix issues & check again", anchor="mt", font=font(14, repair), fill=ORANGE if repair else MUTED)
    draw.line((26, 203, 974, 203), fill=LINE)
    draw.ellipse((27, 229, 34, 236), fill=ORANGE)
    draw.text((45, 222), message, font=font(16), fill=INK)
    draw.text((974, 225), "EXAMPLE WORKFLOW", anchor="rt", font=font(11), fill=MUTED)
    return image


images = [render(*frame) for frame in FRAMES]
images[0].save(OUT / "workflow.png")
images[0].save(OUT / "workflow.gif", save_all=True, append_images=images[1:],
               duration=[1600, 1600, 1600, 1800, 1600, 2200], loop=0, optimize=True)
print(f"Rendered {OUT / 'workflow.gif'} and static alternative")
