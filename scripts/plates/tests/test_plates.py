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
    assert "no people" in p[0].prompt


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
    layers = split(img, depth, indoor=False)
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
    layers = split(img, depth, indoor=True)
    assert (np.asarray(layers[0])[..., 3] > 0).all()
