# Regenerate the mascot feedback animations: python3 scripts/generate-feedback-animations.py
# Requires Pillow (python3 -m pip install pillow).
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'animations'
OUT.mkdir(parents=True, exist_ok=True)
SOURCE = Image.open(ROOT / 'public' / 'icons' / 'pocket-cloudy.png').convert('RGBA').resize((198, 198), Image.Resampling.NEAREST)

BG = '#16131c'
INK = '#2a2530'
SHELL = '#d9d4c7'
SHELL_HI = '#ece8de'
PAPER = '#f4eedc'
GREEN = '#a7b39a'
DARK_GREEN = '#2f3b2c'
RED = '#d6384a'
PINK = '#ec9c9c'
GOLD = '#f2c96d'


def cloudy_expression(happy=False):
    im = SOURCE.copy()
    d = ImageDraw.Draw(im)
    if happy:
        d.rectangle((89, 89, 109, 102), fill='#f6ead6')
        d.rectangle((72, 80, 76, 84), fill='#fff8e9')
        d.rectangle((117, 80, 121, 84), fill='#fff8e9')
        d.rectangle((78, 86, 79, 87), fill='#fff8e9')
        d.rectangle((124, 86, 125, 87), fill='#fff8e9')
        d.rectangle((91, 92, 107, 97), fill=INK)
        d.rectangle((94, 98, 104, 101), fill=INK)
        d.rectangle((96, 99, 102, 101), fill=PINK)
        d.rectangle((58, 94, 62, 97), fill='#f7b2ad')
        d.rectangle((136, 94, 140, 97), fill='#f7b2ad')
    else:
        d.rectangle((73, 81, 76, 84), fill='#fff8e9')
        d.rectangle((118, 81, 121, 84), fill='#fff8e9')
    return im

CLOUD = {False: cloudy_expression(False), True: cloudy_expression(True)}


def sleepy_expression():
    im = SOURCE.copy()
    d = ImageDraw.Draw(im)
    skin = '#f6ead6'
    d.rectangle((68, 78, 86, 95), fill=skin)
    d.rectangle((112, 78, 131, 95), fill=skin)
    d.rectangle((89, 89, 109, 102), fill=skin)
    for x in (71, 116):
        d.rectangle((x, 85, x + 12, 87), fill=INK)
        d.rectangle((x + 2, 88, x + 10, 89), fill=INK)
    d.rectangle((95, 92, 103, 100), fill=INK)
    d.rectangle((97, 98, 101, 100), fill=PINK)
    return im


SLEEPY_CLOUD = sleepy_expression()


def canvas():
    return Image.new('RGBA', (384, 256), (0, 0, 0, 0))


def cloud(im, x, y, size=198, happy=False, sleepy=False):
    art = (SLEEPY_CLOUD if sleepy else CLOUD[happy]).resize((size, size), Image.Resampling.NEAREST)
    im.alpha_composite(art, (x, y))


def pixel_z(d, x, y, color):
    d.rectangle((x, y, x + 11, y + 3), fill=color)
    d.rectangle((x + 8, y + 4, x + 11, y + 6), fill=color)
    d.rectangle((x + 4, y + 7, x + 7, y + 9), fill=color)
    d.rectangle((x, y + 10, x + 11, y + 13), fill=color)


def handheld(d, x=36, y=68, lit=False, sweep=0, check=False):
    d.rectangle((x, y, x + 120, y + 158), fill=INK)
    d.rectangle((x + 4, y + 4, x + 116, y + 154), fill=SHELL)
    d.rectangle((x + 8, y + 8, x + 112, y + 11), fill=SHELL_HI)
    d.rectangle((x + 16, y + 22, x + 103, y + 83), fill=INK)
    d.rectangle((x + 21, y + 27, x + 98, y + 78), fill=GREEN if lit else DARK_GREEN)
    if lit and sweep:
        for j in range(sweep):
            d.rectangle((x + 29, y + 32 + j * 8, x + 87, y + 35 + j * 8), fill='#c2ccb7')
    if check:
        d.rectangle((x + 43, y + 51, x + 50, y + 57), fill=DARK_GREEN)
        d.rectangle((x + 50, y + 58, x + 57, y + 64), fill=DARK_GREEN)
        d.rectangle((x + 57, y + 50, x + 64, y + 57), fill=DARK_GREEN)
        d.rectangle((x + 64, y + 43, x + 71, y + 50), fill=DARK_GREEN)
    d.rectangle((x + 30, y + 115, x + 59, y + 125), fill=INK)
    d.rectangle((x + 40, y + 105, x + 50, y + 135), fill=INK)
    d.rectangle((x + 82, y + 112, x + 98, y + 129), fill=RED)
    d.rectangle((x + 93, y + 12, x + 101, y + 20), fill=RED if lit else '#8c1f2d')


def save_tile(d, x, y, color=GREEN):
    d.rectangle((x, y, x + 27, y + 27), fill=INK)
    d.rectangle((x + 4, y + 4, x + 23, y + 23), fill=PAPER)
    d.rectangle((x + 9, y + 9, x + 18, y + 18), fill=color)


def sparkle(d, x, y, color=GOLD, size=5):
    d.rectangle((x - size, y - 2, x + size, y + 2), fill=color)
    d.rectangle((x - 2, y - size, x + 2, y + size), fill=color)
    d.rectangle((x - size + 2, y - size + 2, x - size + 4, y - size + 4), fill=color)
    d.rectangle((x + size - 4, y + size - 4, x + size - 2, y + size - 2), fill=color)


def write(name, frames, ms, loop=1):
    sheet = Image.new('RGBA', (384 * len(frames), 256), (0, 0, 0, 0))
    for i, frame in enumerate(frames):
        sheet.alpha_composite(frame, (384 * i, 0))
    sheet.save(OUT / f'{name}-sprites.png', optimize=True)
    frames[0].save(OUT / f'{name}.apng', save_all=True, append_images=frames[1:], duration=ms, loop=loop, disposal=0, blend=0, optimize=True)
    frames[0].save(OUT / f'{name}.webp', save_all=True, append_images=frames[1:], duration=ms, loop=loop, lossless=True, method=6)
    frames[-1].save(OUT / f'{name}-poster.png', optimize=True)


# A sent envelope, six code pixels, then a verified check and delighted Cloudy.
frames = []
for i in range(7):
    im = canvas(); d = ImageDraw.Draw(im)
    d.rectangle((34, 91, 122, 151), fill=INK)
    d.rectangle((39, 96, 117, 146), fill=PAPER)
    d.line((39, 96, 78, 126, 117, 96), fill=INK, width=4)
    if i < 3:
        d.polygon([(39, 96), (78, 65 - i * 7), (117, 96)], fill=SHELL_HI, outline=INK)
    if 2 <= i < 5:
        for j in range(6):
            x = 125 + j * 8 + min(2, i - 2) * 5
            d.rectangle((x, 112 - (j % 2) * 7, x + 4, 116 - (j % 2) * 7), fill=RED if j % 2 else DARK_GREEN)
    if i >= 5:
        d.rectangle((137, 96, 184, 143), fill=INK)
        d.rectangle((141, 100, 180, 139), fill=PAPER)
        d.rectangle((147, 118, 154, 125), fill=DARK_GREEN)
        d.rectangle((154, 125, 161, 132), fill=DARK_GREEN)
        d.rectangle((161, 117, 168, 124), fill=DARK_GREEN)
        d.rectangle((168, 110, 175, 117), fill=DARK_GREEN)
    cloud(im, 176, 30 if i != 5 else 24, happy=i >= 5)
    frames.append(im)
write('sign-in-complete', frames, 85)
frames[0].save(OUT / 'sign-in-prompt.png', optimize=True)

# A save tile clicks into the handheld; success is local, with no cloud transfer.
frames = []
for i, x in enumerate((174, 153, 135, 126)):
    im = canvas(); d = ImageDraw.Draw(im)
    handheld(d, 34, 68, lit=True, check=i == 3)
    save_tile(d, x, 172)
    if i == 3: sparkle(d, 153, 177, GREEN, 5)
    cloud(im, 176, 28 if i < 3 else 25, happy=i == 3)
    frames.append(im)
write('saved-on-device', frames, 75)

# The device stays busy throughout the actual upload; no check appears before success.
frames = []
spinner = [(0, -14), (10, -10), (14, 0), (10, 10), (0, 14), (-10, 10), (-14, 0), (-10, -10)]
for i in range(8):
    im = canvas(); d = ImageDraw.Draw(im)
    handheld(d, 25, 69, lit=True)
    for j in range(8):
        x, y = spinner[j]
        d.rectangle((91 + x, 125 + y, 95 + x, 129 + y), fill=PAPER if j == i else (GREEN if (j - i) % 8 < 3 else DARK_GREEN))
    save_tile(d, 158, 93)
    cloud(im, 179, 28, happy=False)
    frames.append(im)
write('cloud-backup-syncing', frames, 100, loop=0)

# The save tile travels from the device; the device check appears only after cloud success.
frames = []
for i in range(6):
    im = canvas(); d = ImageDraw.Draw(im)
    handheld(d, 25, 69, lit=True, check=i >= 4)
    x = 124 + i * 24
    y = 89 - min(i, 3) * 11
    save_tile(d, x, y, GREEN)
    for j in range(1, min(i, 4)):
        d.rectangle((129 + j * 24, 113 - j * 11, 133 + j * 24, 117 - j * 11), fill=GREEN)
    if i >= 4: sparkle(d, 208, 87, GOLD, 7)
    cloud(im, 179, 28 if i < 4 else 24, happy=i >= 4)
    if i >= 4: sparkle(ImageDraw.Draw(im), 213, 92, GOLD, 7)
    frames.append(im)
write('cloud-backup-complete', frames, 83)

# Two cable ends extend, meet, and light up when both players are linked.
frames = []
for i in range(11):
    im = canvas(); d = ImageDraw.Draw(im)
    left_end = 158 + min(i, 6) * 5
    right_start = 226 - min(i, 6) * 5
    d.rectangle((135, 185, left_end, 193), fill=INK)
    d.rectangle((right_start, 185, 251, 193), fill=INK)
    d.rectangle((left_end - 5, 181, left_end + 3, 197), fill='#544d5c')
    d.rectangle((right_start - 3, 181, right_start + 5, 197), fill='#544d5c')
    if i >= 6:
        d.rectangle((184, 185, 200, 193), fill=RED)
        if i in (6, 7): sparkle(d, 192, 177, GOLD, 9)
    cloud(im, 16, 48 if i != 7 else 43, 164, happy=i >= 6)
    cloud(im, 204, 48 if i != 7 else 43, 164, happy=i >= 6)
    frames.append(im)
write('link-connected', frames, 82)

# Cloudy dozes while the plug waits; a tiny LED still shows that the connection is active.
frames = []
pulse = [0,0,1,1,2,2,3,3,4,4,3,3,2,2,1,1,0,0]
for i, p in enumerate(pulse):
    im = canvas(); d = ImageDraw.Draw(im)
    d.rectangle((146, 182, 284, 190), fill=INK)
    d.rectangle((282, 176, 302, 196), fill='#544d5c')
    d.rectangle((302, 178, 310, 183), fill=INK)
    d.rectangle((302, 189, 310, 194), fill=INK)
    d.rectangle((264, 175, 270, 181), fill=RED if p >= 3 else '#8c1f2d')
    if p >= 2:
        d.rectangle((320, 183, 324, 187), fill=RED if p == 4 else PINK)
    cloud(im, 33, 37 + (1 if i in (5,6,7,8,9,10,11,12) else 0), 175, sleepy=True)
    pixel_z(ImageDraw.Draw(im), 196, 46, '#b3a9bf')
    if 5 <= i <= 12:
        pixel_z(ImageDraw.Draw(im), 219, 25 - ((i - 5) // 4) * 3, '#d4cddd')
    frames.append(im)
write('waiting-for-friend', frames, 83, loop=0)

# A star passes between two friends; both get a small happy bounce.
frames = []
for i in range(7):
    im = canvas(); d = ImageDraw.Draw(im)
    x = 153 + min(i, 3) * 13
    cloud(im, 16, 48 if i < 5 else 44, 164, happy=i >= 5)
    cloud(im, 204, 48 if i < 5 else 44, 164, happy=i >= 5)
    sparkle(ImageDraw.Draw(im), x, 99 - (i % 3) * 4, GOLD, 7)
    if i >= 5: sparkle(ImageDraw.Draw(im), 192, 71, PINK, 4)
    frames.append(im)
write('friend-added', frames, 85)

# The LCD wakes in horizontal pixel bands, then the game is ready to resume.
frames = []
for i in range(5):
    im = canvas(); d = ImageDraw.Draw(im)
    handheld(d, 34, 68, lit=i >= 1, sweep=min(i * 2, 5))
    if i >= 3:
        d.polygon([(95, 108), (95, 136), (117, 122)], fill=DARK_GREEN)
    cloud(im, 176, 30 if i < 4 else 26, happy=i == 4)
    frames.append(im)
write('resume-game', frames, 80)

# The console settles into pause and keeps the pause symbol visible until play resumes.
frames = []
for i in range(7):
    im = canvas(); d = ImageDraw.Draw(im)
    handheld(d, 34, 68, lit=True)
    d.rectangle((78, 110, 87, 117 + min(i, 3) * 8), fill=DARK_GREEN)
    d.rectangle((103, 110, 112, 117 + min(i, 3) * 8), fill=DARK_GREEN)
    cloud(im, 176, 28 + min(i, 3), sleepy=i >= 3)
    frames.append(im)
write('game-paused', frames, 100)
