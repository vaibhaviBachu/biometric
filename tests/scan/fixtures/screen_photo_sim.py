"""
Simulates a phone photo of an image shown on a screen. Deterministic per (seed, severity). Synthetic stand-in: it does
NOT replace real camera tests, but it exercises the distortions a real capture has and a plain blur+tilt does not:

  perspective (keystone), moire, the screen's pixel grid and its aliasing, glare, defocus and motion blur,
  colour cast / gamma / dimming, sensor noise, JPEG, and clutter (UI chrome, bezel, desk) around the picture.

Usage:  python screen_photo_sim.py <input_image> <output_jpg> <severity: mild|medium|severe> <seed>
The output is the centre 72% of the camera frame, like the scan page's framing guide.
"""
from __future__ import annotations

import sys
import numpy as np
import cv2

LEVELS = {
    #            tilt   rot   moire  grid   glare  defocus motion  gamma   dim    cast   noise  jpeg
    "mild":   dict(tilt=0.02, rot=2.0,  moire=0.03, grid=0.04, glare=0,  blur=0.8, motion=0, gamma=0.15, dim=0.85, cast=0.05, noise=3,  jpeg=85),
    "medium": dict(tilt=0.05, rot=5.0,  moire=0.07, grid=0.07, glare=25, blur=1.6, motion=3, gamma=0.25, dim=0.75, cast=0.08, noise=6,  jpeg=70),
    "severe": dict(tilt=0.09, rot=9.0,  moire=0.12, grid=0.10, glare=60, blur=2.8, motion=7, gamma=0.40, dim=0.65, cast=0.12, noise=10, jpeg=55),
}


def _fit(img: np.ndarray, w: int, h: int, frac: float) -> np.ndarray:
    ih, iw = img.shape[:2]
    s = min(w * frac / iw, h * frac / ih)
    return cv2.resize(img, (max(1, int(iw * s)), max(1, int(ih * s))), interpolation=cv2.INTER_AREA)


def _display(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """The image on a 1920x1080 screen: letterboxed in a window, with UI chrome around it."""
    W, H = 1920, 1080
    dark = rng.random() < 0.5
    bg = np.full((H, W, 3), 28 if dark else 238, np.uint8)
    # window title bar, side panel, a few UI blocks: structure that is NOT part of the picture
    cv2.rectangle(bg, (0, 0), (W, 56), (45, 45, 48) if dark else (225, 225, 228), -1)
    cv2.rectangle(bg, (0, 56), (260, H), (36, 36, 40) if dark else (214, 214, 220), -1)
    for i in range(14):
        y = 90 + i * 34
        cv2.rectangle(bg, (24, y), (24 + int(rng.integers(90, 200)), y + 12), (110, 110, 120) if dark else (140, 140, 150), -1)
    shown = _fit(img, W - 300, H - 140, 0.96)
    sh, sw = shown.shape[:2]
    x0 = 280 + (W - 300 - sw) // 2
    y0 = 70 + (H - 90 - sh) // 2
    bg[y0:y0 + sh, x0:x0 + sw] = shown
    return bg


def simulate(img_bgr: np.ndarray, severity: str, seed: int) -> np.ndarray:
    p = LEVELS[severity]
    rng = np.random.default_rng(seed)
    screen = _display(img_bgr, rng)
    H, W = screen.shape[:2]

    # 1. pixel grid of the display (3-px period) before the camera sees it
    gx = (np.arange(W) % 3 == 2).astype(np.float32)
    gy = (np.arange(H) % 3 == 2).astype(np.float32)
    grid = 1.0 - p["grid"] * np.maximum(gx[None, :], gy[:, None])
    screen = np.clip(screen.astype(np.float32) * grid[..., None], 0, 255)

    # 2. camera frame: screen seen at an angle, smaller than the frame, on a dark desk
    CW, CH = 1280, 960
    desk = np.clip(rng.normal(52, 9, (CH, CW, 3)), 0, 255).astype(np.float32)
    margin = rng.uniform(0.03, 0.10)
    quad_dst = np.array([[0, 0], [CW, 0], [CW, CH], [0, CH]], np.float32)
    inset = np.array([[margin * CW, margin * CH], [CW * (1 - margin), margin * CH],
                      [CW * (1 - margin), CH * (1 - margin)], [margin * CW, CH * (1 - margin)]], np.float32)
    jitter = rng.uniform(-p["tilt"], p["tilt"], (4, 2)).astype(np.float32) * np.array([CW, CH], np.float32)
    quad = inset + jitter
    ang = np.deg2rad(rng.uniform(-p["rot"], p["rot"]))
    c, s = np.cos(ang), np.sin(ang)
    centre = np.array([CW / 2, CH / 2], np.float32)
    quad = ((quad - centre) @ np.array([[c, -s], [s, c]], np.float32).T + centre).astype(np.float32)
    src = np.array([[0, 0], [W, 0], [W, H], [0, H]], np.float32)
    M = cv2.getPerspectiveTransform(src, quad)
    warped = cv2.warpPerspective(screen, M, (CW, CH), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT, dst=desk.copy())
    frame = warped

    # 3. moire: two interfering sinusoids, multiplicative
    yy, xx = np.mgrid[0:CH, 0:CW].astype(np.float32)
    f1, f2 = rng.uniform(0.12, 0.45, 2)
    th = rng.uniform(0, np.pi)
    m = np.sin(2 * np.pi * (f1 * (xx * np.cos(th) + yy * np.sin(th)))) * np.sin(2 * np.pi * (f2 * (xx * np.sin(th) - yy * np.cos(th))))
    frame *= (1.0 + p["moire"] * m)[..., None]

    # 4. glare: a soft highlight plus a faint diagonal gradient
    if p["glare"] > 0:
        gx0, gy0 = rng.uniform(0.2, 0.8) * CW, rng.uniform(0.15, 0.7) * CH
        sig = rng.uniform(0.15, 0.35) * CW
        glare = np.exp(-(((xx - gx0) ** 2 + (yy - gy0) ** 2) / (2 * sig ** 2)))
        frame += (p["glare"] * glare)[..., None] + 6.0 * ((xx / CW + yy / CH) - 1.0)[..., None]

    # 5. defocus + motion blur
    frame = cv2.GaussianBlur(frame, (0, 0), p["blur"])
    if p["motion"] > 0:
        k = np.zeros((p["motion"], p["motion"]), np.float32)
        k[p["motion"] // 2, :] = 1.0
        k /= k.sum()
        rot = cv2.getRotationMatrix2D((p["motion"] / 2 - 0.5, p["motion"] / 2 - 0.5), rng.uniform(0, 180), 1.0)
        k = cv2.warpAffine(k, rot, (p["motion"], p["motion"]))
        frame = cv2.filter2D(frame, -1, k / max(k.sum(), 1e-6))

    # 6. exposure / gamma / colour cast
    g = 1.0 + rng.uniform(-p["gamma"], p["gamma"])
    frame = 255.0 * np.power(np.clip(frame, 0, 255) / 255.0, g) * p["dim"]
    gains = 1.0 + rng.uniform(-p["cast"], p["cast"], 3).astype(np.float32)
    frame *= gains[None, None, :]

    # 7. sensor noise, then JPEG
    frame += rng.normal(0, p["noise"], frame.shape).astype(np.float32)
    frame = np.clip(frame, 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, p["jpeg"]])
    frame = cv2.imdecode(enc, cv2.IMREAD_COLOR)

    # 8. the scan page crops to the centre of the camera frame (its guide is inset 14% each side)
    x0, y0 = int(CW * 0.14), int(CH * 0.14)
    return frame[y0:CH - y0, x0:CW - x0]


if __name__ == "__main__":
    src_path, out_path, severity, seed = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    data = np.fromfile(src_path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        sys.exit("cannot read " + src_path)
    out = simulate(img, severity, seed)
    ok, enc = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 92])
    enc.tofile(out_path)
