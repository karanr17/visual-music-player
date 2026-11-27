import numpy as np
from PIL import Image

from plates.layers import PLATE_H, PLATE_W, split
from plates.prompts import plan


def world(setting="field", plate="", time="dusk"):
    return {"setting": setting, "timeOfDay": time, "weather": "clear", "mood": "warm", "camera": "drift", "plate": plate}


def test_plan_shares_plates_for_returning_sections_and_skips_roads():
    script = {
        "trackKey": "k",
        "sections": [
            {"world": world(plate="a hill"), "recurrence": "A"},
            {"world": world("road")},
            {"world": world(plate="a hill, later", time="night"), "recurrence": "A"},
            {"world": world(plate="a hill")},
            {"world": world("beach")},
        ],
    }
    p = plan(script)
    assert p[1].key is None and p[1].prompt is None
    assert p[0].key == p[2].key
    assert p[3].key == p[0].key  # same prompt text, same plate
    assert p[2].script_prompt == "a hill, later"
    assert "sandy beach" in p[4].prompt  # no plate text: falls back to the setting
    assert p[0].prompt.startswith("Pixel art") and "no characters" in p[0].prompt


def landscape():
    """Sky above a horizon at y=120 (of 432), ground getting nearer toward the bottom."""
    h, w = 432, 768
    y = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1)
    depth = np.clip((y - 120) / (h - 120), 0, 1)
    rgb = np.zeros((h, w, 3), np.uint8)
    rgb[:120] = (120, 170, 230)
    rgb[120:] = (60, 130, 60)
    return Image.fromarray(rgb), depth


def test_split_cuts_the_sky_and_orders_layers_far_to_near():
    img, depth = landscape()
    layers, hz = split(img, depth, indoor=False)
    assert abs(hz - 60) <= 3  # row 120 of 432, at the plate's 216 rows
    assert len(layers) == 3
    alpha = [np.asarray(x)[..., 3] > 0 for x in layers]
    for a in alpha:
        assert a.shape == (PLATE_H, PLATE_W)
    assert not alpha[0][:50].any()  # sky is transparent
    assert alpha[0][-1].all()  # ground is opaque
    assert alpha[0].sum() > alpha[1].sum() > alpha[2].sum() > 0
    # Nearer layers are solid from their top edge down.
    for a in alpha[1:]:
        assert (np.diff(a.astype(int), axis=0) >= 0).all()


def test_split_indoors_keeps_the_whole_picture():
    img, depth = landscape()
    layers, hz = split(img, depth, indoor=True)
    assert hz is None and len(layers) == 1
    assert (np.asarray(layers[0])[..., 3] > 0).all()


def test_split_takes_a_banded_sky_the_segmenter_is_sure_of():
    """A sunset band whose colour step stops the fill stays in the far layer as a strip of
    generated sky, unless the segmenter says it is sky."""
    img, depth = landscape()
    rgb = np.asarray(img).copy()
    rgb[80:120] = (250, 105, 170)
    img = Image.fromarray(rgb)
    alpha = lambda layers: np.asarray(layers[0])[..., 3] > 0  # noqa: E731
    band = slice(42, 58)  # rows 84-116 of 432, at the plate's 216 rows

    plain, _ = split(img, depth, indoor=False)
    assert alpha(plain)[band].all()

    prob = np.zeros(depth.shape, np.float32)
    prob[:120] = 0.99
    layers, hz = split(img, depth, indoor=False, sky_prob=prob)
    assert not alpha(layers)[band].any()
    assert alpha(layers)[-1].all()
    assert abs(hz - 60) <= 3
