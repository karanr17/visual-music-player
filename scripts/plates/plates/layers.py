"""Splits a generated plate into parallax layers from a depth map.

Depth here is relative inverse depth scaled to 0-1 (1 = nearest), as Depth Anything returns it.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

# The player's plate size in logical pixels (src/render/plates.ts: PLATE_W, PLATE_H).
PLATE_W, PLATE_H = 384, 216

# Sky can only be this far away (0 = farthest in the picture, 1 = nearest).
SKY_DEPTH = 0.2
# Colour step between neighbouring pixels that a sky flood fill still crosses (0-255 per channel,
# after a blur): enough to follow a gradient sky, too little to climb a skyline's edge.
SKY_STEP = 2
# Canny thresholds for those edges: dithered sky gradients stay under them.
SKY_EDGES = (25, 75)
# Depth quantiles of the land that start the middle and near layers.
SPLITS = (0.45, 0.8)
# A disc brighter than this (0-255 grey) that touches the sky and ends within DISC_BELOW rows
# under the horizon is a moon or sun.
DISC_LUMA = 190
DISC_BELOW = 6
# Share of a row that must be land for it to count as the horizon.
HORIZON_COVER = 0.9


def sky_mask(rgb: np.ndarray, depth: np.ndarray) -> np.ndarray:
    """True for the sky: the smooth, far region reached from the top edge. Depth alone also takes
    distant mountains and skylines, which are the plate's best part, so the fill follows colour
    and depth only bounds it. Anything enclosed by sky (sun, moon, stars, clouds) is sky too: the
    player draws its own."""
    h, w = depth.shape
    img = cv2.GaussianBlur(rgb, (5, 5), 0)
    # Strong edges stop the fill too: a night skyline can be nearly the colour of the sky.
    edges = cv2.Canny(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), *SKY_EDGES) > 0
    # floodFill's mask is 2 px larger and blocks the fill wherever it is non-zero.
    block = np.pad(((depth > SKY_DEPTH) | edges).astype(np.uint8), 1, constant_values=1)
    step = (SKY_STEP,) * 3
    for x in range(0, w, 4):
        if block[1, x + 1] == 0:
            cv2.floodFill(img, block, (x, 0), 0, step, step, 4 | cv2.FLOODFILL_MASK_ONLY | (2 << 8))
    sky = block[1:-1, 1:-1] == 2
    sky = cv2.morphologyEx(sky.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)).astype(bool)
    # Land is what connects to the bottom edge; any other island is in the sky.
    n, labels = cv2.connectedComponents((~sky).astype(np.uint8), connectivity=4)
    ground = set(np.unique(labels[-1][~sky[-1]]).tolist())
    sky = ~np.isin(labels, list(ground))
    return sky | _discs(img, sky)


def _discs(img: np.ndarray, sky: np.ndarray) -> np.ndarray:
    """A moon or sun resting on the horizon touches the land, so the island rule keeps it. It is
    a bright patch against the sky that ends near the horizon: hand it to the sky."""
    bright = (cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) > DISC_LUMA).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bright, connectivity=8)
    edge = cv2.dilate(sky.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~sky
    hz = horizon(~sky)
    out = np.zeros_like(sky)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        # Round-ish: a bright snowy ridge along the horizon is not a moon.
        if area < 12 or y + h > hz + DISC_BELOW or not 0.6 <= w / h <= 1.6 or area < 0.5 * w * h:
            continue
        # Grown a little: the disc's anti-aliased rim is darker than DISC_LUMA.
        comp = cv2.dilate((labels == i).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        if (comp & edge).any():
            out |= comp
    return out


def _solid_below(mask: np.ndarray) -> np.ndarray:
    """Fills each column downward from its first set pixel. Landscapes get nearer toward the
    bottom, so this closes the speckled holes depth thresholds leave in grass and water."""
    return np.maximum.accumulate(mask.astype(np.uint8), axis=0).astype(bool)


def horizon(land: np.ndarray) -> int:
    """The first row that is land almost all the way across: below peaks, trees and towers, where
    the ground meets the sky. The player lines this row up with its own horizon."""
    rows = np.flatnonzero(land.mean(axis=1) >= HORIZON_COVER)
    return int(rows[0]) if rows.size else land.shape[0]


def split(rgb: Image.Image, depth: np.ndarray, indoor: bool) -> tuple[list[Image.Image], int | None]:
    """Far-to-near RGBA layers at PLATE_W x PLATE_H, and the plate's horizon row (None indoors).
    The far layer is opaque except for the sky (outdoors); each nearer layer holds only what is
    in front of its depth split. Where a nearer layer covers the one behind, the one behind is
    inpainted, so parallax never opens a hole."""
    img = np.asarray(rgb.convert("RGB").resize((PLATE_W, PLATE_H), Image.Resampling.BOX))
    d = cv2.resize(depth.astype(np.float32), (PLATE_W, PLATE_H), interpolation=cv2.INTER_AREA)
    d = (d - d.min()) / max(1e-6, float(d.max() - d.min()))
    d = cv2.medianBlur(d, 5)
    img = np.ascontiguousarray(img)

    sky = np.zeros(d.shape, bool) if indoor else sky_mask(img, d)
    land = ~sky
    vals = d[land]
    hz = None if indoor else horizon(land)
    # Indoors the depth bands cut walls and furniture apart; a room is one flat picture.
    if indoor or vals.size < 100:
        return [_rgba(img, land)], hz
    masks = [land]
    for q in SPLITS:
        m = _solid_below((d >= np.quantile(vals, q)) & land)
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)).astype(bool)
        masks.append(m & land)

    layers = []
    for i, m in enumerate(masks):
        layer = img
        if i + 1 < len(masks):
            cover = cv2.dilate(masks[i + 1].astype(np.uint8), np.ones((3, 3), np.uint8))
            layer = cv2.inpaint(np.ascontiguousarray(img), cover, 4, cv2.INPAINT_TELEA)
        layers.append(_rgba(layer, m))
    return layers, hz


def _rgba(img: np.ndarray, mask: np.ndarray) -> Image.Image:
    a = np.where(mask, 255, 0).astype(np.uint8)
    return Image.fromarray(np.dstack([img, a]), "RGBA")
