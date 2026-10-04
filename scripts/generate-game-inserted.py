# Regenerate the transparent cartridge insertion animation: python3 scripts/generate-game-inserted.py
# Requires Pillow (python3 -m pip install pillow).
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'animations'
OUT.mkdir(parents=True, exist_ok=True)
cloud = Image.open(ROOT / 'public' / 'icons' / 'pocket-cloudy.png').convert('RGBA').resize((198, 198), Image.Resampling.NEAREST)

INK = '#2a2530'
SHELL = '#d9d4c7'
SHELL_HI = '#ece8de'
LCD_OFF = '#2f3b2c'
LCD_ON = '#a7b39a'
RED = '#d6384a'


def cloudy_expression(excited: bool) -> Image.Image:
    face = cloud.copy()
    d = ImageDraw.Draw(face)
    if not excited:
        # A glint gives the little eyes some life while the cartridge is falling.
        d.rectangle((73, 81, 76, 84), fill='#fff8e9')
        d.rectangle((118, 81, 121, 84), fill='#fff8e9')
        return face

    # Bigger eye glints and a small open grin give Cloudy a delighted expression.
    skin = '#f6ead6'
    d.rectangle((89, 89, 109, 102), fill=skin)
    d.rectangle((72, 80, 76, 84), fill='#fff8e9')
    d.rectangle((117, 80, 121, 84), fill='#fff8e9')
    d.rectangle((78, 86, 79, 87), fill='#fff8e9')
    d.rectangle((124, 86, 125, 87), fill='#fff8e9')
    d.rectangle((91, 92, 107, 97), fill=INK)
    d.rectangle((94, 98, 104, 101), fill=INK)
    d.rectangle((96, 99, 102, 101), fill='#ec9c9c')
    d.rectangle((58, 94, 62, 97), fill='#f7b2ad')
    d.rectangle((136, 94, 140, 97), fill='#f7b2ad')
    return face


waiting_cloud = cloudy_expression(False)
happy_cloud = cloudy_expression(True)

# Nine poses at 12 fps: cartridge descends, clicks in, LED powers on, Cloudy bounces.
cart_y = [7, 11, 18, 28, 38, 45, 48, 46, 46]
cloud_y = [28, 28, 28, 28, 28, 28, 22, 25, 28]
frames = []
for i in range(9):
    im = Image.new('RGBA', (384, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    y = cart_y[i]

    # Plain cartridge. The console is drawn after it to make the card enter its slot.
    d.rectangle((73, y + 4, 119, y + 59), fill=INK)
    d.rectangle((77, y, 115, y + 55), fill='#544d5c')
    d.rectangle((81, y + 14, 111, y + 36), fill='#f4eedc')
    d.rectangle((85, y + 19, 107, y + 23), fill=RED)
    d.rectangle((83, y + 46, 109, y + 50), fill=INK)

    # Warm plastic handheld, with a dark LCD while the cartridge is being inserted.
    d.rectangle((35, 88, 155, 228), fill=INK)
    d.rectangle((39, 92, 151, 224), fill=SHELL)
    d.rectangle((43, 96, 147, 99), fill=SHELL_HI)
    d.rectangle((70, 84, 122, 95), fill=INK)
    d.rectangle((74, 84, 118, 87), fill='#8a8478')
    d.rectangle((51, 107, 139, 168), fill=INK)
    d.rectangle((56, 112, 134, 163), fill=LCD_ON if i >= 6 else LCD_OFF)
    if i >= 6:
        d.rectangle((64, 121, 126, 124), fill='#c1cbb5')
        d.rectangle((64, 132, 110, 135), fill='#c1cbb5')
    d.rectangle((66, 181, 94, 191), fill=INK)
    d.rectangle((75, 172, 85, 201), fill=INK)
    d.rectangle((119, 181, 136, 198), fill=RED)
    d.rectangle((128, 101, 136, 109), fill=RED if i >= 6 else '#8c1f2d')
    if i == 6:
        d.rectangle((128, 93, 136, 96), fill=RED)
        d.rectangle((140, 101, 143, 109), fill=RED)

    # Cloudy moves only after the game has clicked into place.
    im.alpha_composite(happy_cloud if i >= 6 else waiting_cloud, (174, cloud_y[i]))
    frames.append(im)

sheet = Image.new('RGBA', (384 * len(frames), 256), (0, 0, 0, 0))
for i, frame in enumerate(frames):
    sheet.alpha_composite(frame, (384 * i, 0))
sheet.save(OUT / 'game-inserted-sprites.png', optimize=True)
frames[0].save(OUT / 'game-inserted.apng', save_all=True, append_images=frames[1:], duration=83, loop=1, disposal=0, blend=0, optimize=True)
frames[0].save(OUT / 'game-inserted.webp', save_all=True, append_images=frames[1:], duration=83, loop=1, lossless=True, method=6)
frames[-1].save(OUT / 'game-inserted-poster.png', optimize=True)
