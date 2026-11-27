"""The two local models: FLUX.1-schnell on MLX (mflux) for the picture, Depth Anything V2 for depth."""

from __future__ import annotations

import gc
import os
import time
from pathlib import Path

import numpy as np
from PIL import Image

# black-forest-labs/FLUX.1-schnell is gated on Hugging Face (accept the terms, then log in); this
# is the same Apache-2.0 model pre-quantised to 4 bits for mflux, which needs no login and fits
# in about 9 GB. Pass --model to use another mflux-format checkpoint or a local path.
DEFAULT_MODEL = "dhairyashil/FLUX.1-schnell-mflux-4bit"
DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"

# FLUX wants multiples of 16; twice the plate size, so the box downsample cleans up FLUX's
# fine noise into solid pixels.
GEN_W, GEN_H = 768, 432


def _local(repo: str) -> str:
    if Path(repo).exists():
        return repo
    from huggingface_hub import snapshot_download

    return snapshot_download(repo)


class Flux:
    def __init__(self, model: str = DEFAULT_MODEL):
        import mlx.core as mx
        from mflux.models.flux.variants.txt2img.flux import Flux1

        self.mx = mx
        self.name = model
        path = _local(model)
        t = time.perf_counter()
        self.flux = Flux1(model_path=path)
        self.load_s = time.perf_counter() - t

    def generate(self, prompt: str, seed: int, width: int = GEN_W, height: int = GEN_H, steps: int = 4) -> Image.Image:
        return self.flux.generate_image(seed=seed, prompt=prompt, num_inference_steps=steps, width=width, height=height).image

    def peak_gb(self) -> float:
        return self.mx.get_peak_memory() / 1e9

    def close(self) -> None:
        del self.flux
        gc.collect()
        self.mx.clear_cache()


class Depth:
    def __init__(self):
        import torch
        from transformers import pipeline

        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.pipe = pipeline("depth-estimation", model=_local(DEPTH_MODEL), device=device)

    def __call__(self, img: Image.Image) -> np.ndarray:
        out = self.pipe(img)["predicted_depth"]
        d = out.squeeze().float().cpu().numpy()
        return np.asarray(Image.fromarray(d).resize(img.size, Image.Resampling.BILINEAR))
