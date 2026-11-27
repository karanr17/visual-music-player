"""Splits a generated plate into parallax layers from a depth map.

Depth here is relative inverse depth scaled to 0-1 (1 = nearest), as Depth Anything returns it.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

# The player's plate size in logical pixels (src/render/plates.ts: PLATE_W, PLATE_H).
PLATE_W, PLATE_H = 384, 216

# Anything this far away and connected to the top edge is sky.
SKY_DEPTH = 0.06
# Depth quantiles of the land that start the middle and near layers.
SPLITS = (0.45, 0.8)


def sky_mask(depth: np.ndarray) -> np.ndarray:
    """True for the sky: far pixels in regions that touch the top edge."""
    far = (depth < SKY_DEPTH).astype(np.uint8)
    far = cv2.morphologyEx(far, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, labels = cv2.connectedComponents(far, connectivity=4)
    top = set(np.unique(labels[0][far[0] > 0]).tolist())
    return np.isin(labels, list(top)) if top else np.zeros_like(far, dtype=bool)


def _solid_below(mask: np.ndarray) -> np.ndarray:
    """Fills each column downward from its first set pixel. Landscapes get nearer toward the
    bottom, so this closes the speckled holes depth thresholds leave in grass and water."""
    return np.maximum.accumulate(mask.astype(np.uint8), axis=0).astype(bool)


def split(rgb: Image.Image, depth: np.ndarray, indoor: bool) -> list[Image.Image]:
    """Far-to-near RGBA layers at PLATE_W x PLATE_H. The far layer is opaque except for the sky
    (outdoors); each nearer layer holds only what is in front of its depth split. Where a nearer
    layer covers the one behind, the one behind is inpainted, so parallax never opens a hole."""
    img = np.asarray(rgb.convert("RGB").resize((PLATE_W, PLATE_H), Image.Resampling.BOX))
    d = cv2.resize(depth.astype(np.float32), (PLATE_W, PLATE_H), interpolation=cv2.INTER_AREA)
    d = (d - d.min()) / max(1e-6, float(d.max() - d.min()))
    d = cv2.medianBlur(d, 5)

    sky = np.zeros(d.shape, bool) if indoor else sky_mask(d)
    land = ~sky
    vals = d[land]
    if vals.size < 100:
        return [_rgba(img, land)]
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
    return layers


def _rgba(img: np.ndarray, mask: np.ndarray) -> Image.Image:
    a = np.where(mask, 255, 0).astype(np.uint8)
    return Image.fromarray(np.dstack([img, a]), "RGBA")
