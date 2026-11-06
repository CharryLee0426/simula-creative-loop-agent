"""Fast deterministic renderer: render job (manifest + localized plan + 2 keyframes) -> silent H.264 video.

Adapted from rk-pipeline. Changes: a single --job JSON carries everything (localized text, keyframe paths, timeline),
text auto-fits/wraps (English lines are longer than Chinese ones), and a third style "warm" for daylight scenes.

Speedups vs v1: static layers (glow text, button) rendered once and composited
only inside their bounding boxes; motes are a pre-blurred sprite stamped with
numpy; frames are rendered in a process pool and piped raw into ffmpeg (no PNGs).

Usage: python render.py --job job.json [--workers N]
job.style: "rune" (moonlit cyan/gold), "warm" (golden daylight, amber pill) or "western" (warm dust, wooden sign)
"""
import argparse, json, math, os, subprocess
from multiprocessing import Pool, cpu_count
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
FONT = os.environ.get("RK_FONT") or os.path.join(ROOT, "assets/fonts/NotoSerifCJKsc-Bold.otf")
EMOJI_DIR = os.path.join(ROOT, "assets/emoji")
FPS = 30
HEADROOM = 1.18
SIZES = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}

STYLES = {
    "rune": dict(mote=(170, 225, 255), flash=(150, 215, 255), flash_amt=0.95, pulse_amt=0.06, pulse_hz=5.0,
                 line=((240, 250, 255), (90, 190, 255)), title=((255, 238, 200), (255, 180, 80)),
                 tag=((205, 230, 255), (90, 190, 255)), button="rune"),
    "warm": dict(mote=(255, 226, 170), flash=(255, 228, 170), flash_amt=0.7, pulse_amt=0.04, pulse_hz=3.0,
                 line=((255, 250, 236), (255, 160, 70)), title=((255, 242, 210), (255, 170, 60)),
                 tag=((255, 236, 205), (230, 130, 50)), button="warm"),
    "western": dict(mote=(255, 214, 160), flash=(255, 205, 140), flash_amt=0.55, pulse_amt=0.03, pulse_hz=2.2,
                    line=((255, 244, 222), (255, 150, 60)), title=((255, 238, 200), (255, 180, 80)),
                    tag=((255, 222, 180), (200, 110, 40)), button="western"),
}


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


# ---------- static layer builders (run once) ----------

def _bbox_crop(img):
    """RGBA PIL -> (x, y, premultiplied rgb float32, alpha float32) cropped to content."""
    bb = img.getbbox()
    if not bb:
        return None
    c = np.asarray(img.crop(bb)).astype(np.float32) / 255.0
    a = c[..., 3:4]
    return (bb[0], bb[1], c[..., :3] * a * 255.0, a)


def _wrap(d, f, txt, spacing, maxw):
    """Greedy word wrap (falls back to per-character for CJK) into lines that fit maxw."""
    def width(s):
        return sum(d.textlength(c, font=f) for c in s) + spacing * max(len(s) - 1, 0)
    if width(txt) <= maxw:
        return [txt]
    tokens = txt.split(" ") if " " in txt else list(txt)
    joiner = " " if " " in txt else ""
    lines, cur = [], ""
    for tok in tokens:
        cand = (cur + joiner + tok) if cur else tok
        if width(cand) <= maxw or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = tok
    if cur:
        lines.append(cur)
    return lines


def glow_text(W, H, txt, size, y, color, glow, spacing, max_lines=2, min_size=None):
    """Centered glowing text. Shrinks the font (down to min_size) and wraps to max_lines so it fits 88% of W."""
    maxw = W * 0.88
    min_size = min_size or int(size * 0.6)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    s = size
    while True:
        f = ImageFont.truetype(FONT, s)
        lines = _wrap(probe, f, txt, spacing, maxw)
        if (len(lines) <= max_lines and all(sum(probe.textlength(c, font=f) for c in ln) + spacing * (len(ln) - 1) <= maxw for ln in lines)) or s <= min_size:
            break
        s = max(min_size, int(s * 0.92))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d, gd = ImageDraw.Draw(layer), ImageDraw.Draw(g)
    lh = int(s * 1.22)
    y0 = y - (len(lines) - 1) * lh  # grow upward so the last line keeps its slot
    for li, ln in enumerate(lines):
        bw = sum(d.textlength(c, font=f) for c in ln) + spacing * (len(ln) - 1)
        x = (W - bw) / 2
        yy = y0 + li * lh
        for c in ln:
            gd.text((x, yy), c, font=f, fill=glow + (255,))
            d.text((x, yy), c, font=f, fill=color + (255,), stroke_width=max(1, s // 30), stroke_fill=(10, 10, 20, 200))
            x += d.textlength(c, font=f) + spacing
    return Image.alpha_composite(g.filter(ImageFilter.GaussianBlur(14)), layer)


def _split_emoji(label):
    """Return (text, [emoji codepoint hex]) for emoji we have PNGs for."""
    txt, emo = "", []
    for ch in label:
        cp = f"{ord(ch):x}"
        if ord(ch) > 0x2000 and os.path.exists(os.path.join(EMOJI_DIR, cp + ".png")):
            emo.append(cp)
        elif ord(ch) not in (0xFE0F,):
            txt += ch
    return txt.strip(), emo


def button_sprite(W, label, kind):
    """Button at pulse=1 on its own canvas with margin for glow. Returns (RGBA PIL, body mask PIL, body box)."""
    bw, bh = int(W * (0.80 if kind == "western" else 0.76)), 150
    m = 60
    cw, ch = bw + 2 * m, bh + 2 * m
    img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    x0, y0, x1, y1 = m, m, m + bw, m + bh
    rad = 22 if kind == "western" else bh // 2
    glowc = (255, 170, 70, 190) if kind in ("western", "warm") else (80, 190, 255, 200)
    g = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    ImageDraw.Draw(g).rounded_rectangle((x0 - 7, y0 - 7, x1 + 7, y1 + 7), radius=rad, fill=glowc)
    img = Image.alpha_composite(img, g.filter(ImageFilter.GaussianBlur(26)))
    yy = np.linspace(0, 1, bh)[:, None]
    xx = np.linspace(0, 1, bw)[None, :]
    if kind == "western":
        grain = 0.5 + 0.5 * np.sin(xx * 9 + 6 * np.sin(yy * 7 + xx * 3) + 1.3)
        base = np.stack([110 + 40 * grain, 66 + 26 * grain, 34 + 14 * grain], -1) * (0.85 + 0.15 * (1 - yy))[..., None]
    elif kind == "warm":
        base = np.stack([np.broadcast_to(190 + 50 * (1 - yy), (bh, bw)),
                         np.broadcast_to(96 + 60 * (1 - yy), (bh, bw)),
                         np.broadcast_to(30 + 30 * (1 - yy), (bh, bw))], -1)
    else:
        base = np.stack([np.broadcast_to(18 + 30 * (1 - yy), (bh, bw)),
                         np.broadcast_to(40 + 60 * (1 - yy), (bh, bw)),
                         np.broadcast_to(80 + 90 * (1 - yy), (bh, bw))], -1)
    body = np.concatenate([base, np.full((bh, bw, 1), 240.0)], -1).astype(np.uint8)
    mask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=rad, fill=255)
    img.paste(Image.fromarray(body, "RGBA"), (x0, y0), mask)
    d = ImageDraw.Draw(img)
    cy = y0 + bh // 2
    if kind == "western":
        d.rounded_rectangle((x0, y0, x1, y1), radius=rad, outline=(60, 34, 16, 255), width=6)
        d.rounded_rectangle((x0 + 12, y0 + 12, x1 - 12, y1 - 12), radius=14, outline=(214, 168, 88, 230), width=3)
        for px, py in ((x0 + 30, y0 + 30), (x1 - 30, y0 + 30), (x0 + 30, y1 - 30), (x1 - 30, y1 - 30)):
            d.ellipse((px - 9, py - 9, px + 9, py + 9), fill=(196, 150, 72, 255), outline=(90, 60, 25, 255), width=2)
            d.ellipse((px - 4, py - 5, px + 1, py), fill=(255, 230, 170, 255))
    else:
        d.rounded_rectangle((x0, y0, x1, y1), radius=rad, outline=(232, 196, 120, 255), width=5)
        d.rounded_rectangle((x0 + 12, y0 + 12, x1 - 12, y1 - 12), radius=(bh - 24) // 2, outline=(140, 210, 255, 200), width=2)
        for px in (x0 + 52, x1 - 52):
            d.polygon([(px, cy - 14), (px + 14, cy), (px, cy + 14), (px - 14, cy)], fill=(232, 196, 120, 255))
            d.polygon([(px, cy - 6), (px + 6, cy), (px, cy + 6), (px - 6, cy)], fill=(160, 225, 255, 255))
    txt, emo = _split_emoji(label)
    fs = int(58 if kind == "western" else 54 * min(1.0, 11 / max(len(txt), 1)))
    f = ImageFont.truetype(FONT, fs)
    tw = d.textlength(txt, font=f)
    while tw > bw - 150 and fs > 30:  # keep long labels inside the pill
        fs -= 2
        f = ImageFont.truetype(FONT, fs)
        tw = d.textlength(txt, font=f)
    em = int(fs * 1.05)
    gap = 14 if emo else 0
    tx = (cw - (tw + len(emo) * (gap + em))) / 2
    ty = cy - fs * 0.62
    if kind == "western":
        d.text((tx, ty), txt, font=f, fill=(255, 238, 196, 255), stroke_width=4, stroke_fill=(52, 28, 12, 255))
    else:
        t2 = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        g2 = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        ImageDraw.Draw(g2).text((tx, ty), txt, font=f, fill=(255, 190, 90, 255))
        ImageDraw.Draw(t2).text((tx, ty), txt, font=f, fill=(255, 240, 205, 255))
        img = Image.alpha_composite(img, Image.alpha_composite(g2.filter(ImageFilter.GaussianBlur(10)), t2))
    ex = tx + tw + gap
    for cp in emo:
        e = Image.open(os.path.join(EMOJI_DIR, cp + ".png")).convert("RGBA").resize((em, em), Image.LANCZOS)
        img.alpha_composite(e, (int(ex), int(cy - em / 2)))
        ex += em + gap
    full_mask = Image.new("L", (cw, ch), 0)
    full_mask.paste(mask, (x0, y0))
    return img, full_mask


def mote_sprite(color, r=9):
    s = 4 * r
    yy, xx = np.mgrid[-s:s + 1, -s:s + 1]
    a = np.exp(-(xx ** 2 + yy ** 2) / (2 * (r * 0.55) ** 2)).astype(np.float32)
    return a[..., None] * np.array(color, np.float32)[None, None, :]


# ---------- per-process state ----------
G = {}


def init_worker(job):
    W, H = SIZES[job["format"]["aspect"]]
    st = STYLES[job.get("style", "rune")]
    k = H / 1920

    def load(p):
        im = Image.open(p).convert("RGB")
        s = max(W / im.width, H / im.height) * HEADROOM
        im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
        l = (im.width - int(W * HEADROOM)) // 2
        t = (im.height - int(H * HEADROOM)) // 2
        return im.crop((l, t, l + int(W * HEADROOM), t + int(H * HEADROOM)))

    yy, xx = np.mgrid[0:H, 0:W]
    v = np.clip(1 - 0.55 * (((xx - W / 2) / (W * 0.75)) ** 2 + ((yy - H / 2) / (H * 0.62)) ** 2), 0.3, 1)
    band = np.clip(1 - 0.45 * np.exp(-(yy / (H * 0.2)) ** 2) - 0.55 * np.exp(-((yy - H) / (H * 0.27)) ** 2), 0, 1)
    tl = job["timeline"]
    btn, bmask = button_sprite(W, job["cta_label"], st["button"])
    G.update(
        W=W, H=H, k=k, st=st, tl=tl, dur=float(job["format"]["duration_s"]),
        A=load(job["keyframes"][0]),
        B=load(job["keyframes"][1]),
        vig=(v * band)[..., None].astype(np.float32),
        line=_bbox_crop(glow_text(W, H, job["line"], int(70 * k), int(1500 * k), *st["line"], 4)),
        title=_bbox_crop(glow_text(W, H, job["title"], int(120 * k), int(1240 * k), *st["title"], 18, max_lines=1)),
        tag=_bbox_crop(glow_text(W, H, job["tagline"], int(46 * k), int(1395 * k), *st["tag"], 8, max_lines=1)),
        btn=btn, bmask=bmask, btn_cy=int(1560 * k),
        mote=mote_sprite(st["mote"]), motes=np.random.default_rng(7).random((70, 4)),
    )


def crop_zoom(im, z, dx=0, dy=0):
    W, H = G["W"], G["H"]
    cw, ch = im.width / z, im.height / z
    cx = min(max(im.width / 2 + dx, cw / 2), im.width - cw / 2)
    cy = min(max(im.height / 2 + dy, ch / 2), im.height - ch / 2)
    return im.resize((W, H), Image.BILINEAR, box=(cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2))


def comp(arr, layer, alpha):
    """Composite a cached (x, y, premult rgb, a) layer into float arr in place."""
    if layer is None or alpha <= 0:
        return
    x, y, rgb, a = layer
    h, w = a.shape[:2]
    reg = arr[y:y + h, x:x + w]
    reg *= 1 - a * alpha
    reg += rgb * alpha


def render_frame(i):
    W, H, st, tl, dur = G["W"], G["H"], G["st"], G["tl"], G["dur"]
    t = i / FPS
    cut, endc = tl["cut_s"], tl["endcard_s"]
    if t < cut:
        frame = crop_zoom(G["A"], 1.04 + 0.08 * ease(t / cut), 0, -15 * t)
    else:
        tb = t - cut
        shake = 10 * math.exp(-tb * 4) * math.sin(tb * 60)
        frame = crop_zoom(G["B"], 1.06 + 0.08 * ease(tb / (dur - cut)), shake, -10 * tb + shake * 0.5)
        if tb < 0.6:
            frame = Image.blend(crop_zoom(G["A"], 1.12 + 0.05 * tb, 0, -15 * cut), frame, ease(tb / 0.6))
    arr = np.asarray(frame, dtype=np.float32)
    gain = G["vig"]
    if t >= cut:
        gain = gain * (1 + st["pulse_amt"] * math.sin(t * st["pulse_hz"]))
    if t > endc - 0.1:
        gain = gain * (1 - 0.45 * ease((t - endc + 0.1) / 0.7))
    arr = arr * gain
    flash = math.exp(-((t - cut - 0.05) / 0.18) ** 2) if cut - 0.15 < t < cut + 0.9 else 0.0
    if flash > 0.003:
        arr += flash * st["flash_amt"] * np.array(st["flash"], np.float32)
    # motes: additive pre-blurred sprite
    spr = G["mote"]
    s = spr.shape[0] // 2
    strength = 0.6 if t < cut else 1.0
    for x, y, sp, ph in G["motes"]:
        px = int((x * W + 30 * math.sin(t * 1.3 + ph * 6)) % W)
        py = int((y * H - t * (40 + 90 * sp)) % H)
        a = strength * (0.4 + 0.6 * (0.5 + 0.5 * math.sin(t * 3 + ph * 10))) * (0.35 + 0.65 * sp)
        x0, y0, x1, y1 = max(px - s, 0), max(py - s, 0), min(px + s + 1, W), min(py + s + 1, H)
        if x1 > x0 and y1 > y0:
            arr[y0:y1, x0:x1] += a * spr[y0 - py + s:y1 - py + s, x0 - px + s:x1 - px + s]
    np.clip(arr, 0, 255, out=arr)
    comp(arr, G["line"], ease((t - tl["line_in_s"]) / 0.5) * (1 - ease((t - tl["line_out_s"]) / 0.35)))
    a4 = ease((t - endc) / 0.5)
    comp(arr, G["title"], a4)
    comp(arr, G["tag"], a4 * 0.95)
    ab = ease((t - endc - 0.25) / 0.45)
    if ab > 0:
        tl_ = t - endc - 0.2
        pulse = 1 + 0.03 * math.sin(tl_ * 2 * math.pi * 1.5)
        btn, bm = G["btn"], G["bmask"]
        bw, bh = int(btn.width * pulse), int(btn.height * pulse)
        b = btn.resize((bw, bh), Image.BILINEAR)
        m = np.asarray(bm.resize((bw, bh), Image.BILINEAR), np.float32) / 255.0
        ba = np.asarray(b, np.float32) / 255.0
        # moving sheen across the body only
        xx = np.arange(bw)[None, :] - np.arange(bh)[:, None] * 0.5
        sx = ((tl_ * 0.85) % 1.4 - 0.2) * bw
        sheen = (np.exp(-((xx - sx) / 30.0) ** 2) * m * 0.35)[..., None]
        rgb = ba[..., :3] * (1 - sheen) + sheen * np.array([1.0, 0.92, 0.75])
        a = ba[..., 3:4]
        x, y = W // 2 - bw // 2, G["btn_cy"] - bh // 2
        comp(arr, (x, y, rgb * a * 255.0, a), ab)
    if t < 0.35:
        arr *= t / 0.35
    return np.clip(arr, 0, 255).astype(np.uint8).tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--workers", type=int, default=cpu_count())
    a = ap.parse_args()
    job = json.load(open(a.job, encoding="utf-8"))
    W, H = SIZES[job["format"]["aspect"]]
    n = int(FPS * float(job["format"]["duration_s"]))
    out = job["video_out"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    ff = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                           "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    with Pool(max(1, a.workers), initializer=init_worker, initargs=(job,)) as pool:
        for buf in pool.imap(render_frame, range(n), chunksize=4):
            ff.stdin.write(buf)
    ff.stdin.close()
    if ff.wait() != 0:
        raise SystemExit("ffmpeg failed")
    print(f"rendered {n} frames -> {out}")


if __name__ == "__main__":
    main()
