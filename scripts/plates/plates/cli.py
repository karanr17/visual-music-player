"""plates: backdrop plates for visual-music-player's illustrated mode.

  uv run plates generate song.scene.json            # writes song.plates.json next to it
  uv run plates generate song.scene.json --dry-run  # just print the prompts
  uv run plates bench                               # load time, s/image, peak memory

The input is a scene script as the player's editor (E) exports it. Plates already in the output
file for the same prompt are kept, so re-running after editing one section regenerates only that
section's plate.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import resource
import sys
import time
from pathlib import Path

from PIL import Image

from .layers import PLATE_H, PLATE_W, split
from .prompts import INDOOR, plan, seed_for


def _png(img: Image.Image) -> str:
    # The player re-quantises to the song's palette, so 64 colours here only shrink the file.
    buf = io.BytesIO()
    img.quantize(colors=64, method=Image.Quantize.FASTOCTREE).save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _out_path(script_path: Path) -> Path:
    name = script_path.name
    for ext in (".scene.json", ".json"):
        if name.endswith(ext):
            return script_path.with_name(name[: -len(ext)] + ".plates.json")
    return script_path.with_name(name + ".plates.json")


def _rss_gb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9  # bytes on macOS


def generate(args: argparse.Namespace) -> None:
    script_path = Path(args.script)
    script = json.loads(script_path.read_text())
    out = Path(args.out) if args.out else _out_path(script_path)
    sections = plan(script)
    wanted: dict[str, str] = {}
    for s in sections:
        if s.key and s.prompt:
            # A returning section shares the first occurrence's picture; the player re-tones it
            # to each section's own time of day.
            wanted.setdefault(s.key, s.prompt)

    for s in sections:
        tag = "procedural" if not s.key else s.key
        print(f"[{s.index:2}] {s.setting:<12} {tag:<12} {s.prompt or ''}")
    print(f"{len(wanted)} plates for {len(sections)} sections")
    if args.dry_run:
        return

    old = json.loads(out.read_text()) if out.exists() else {}
    keep = old.get("plates", {}) if old.get("trackKey") == script["trackKey"] else {}
    plates = {k: keep[k] for k in wanted if k in keep and keep[k]["prompt"] == wanted[k]}
    todo = [k for k in wanted if k not in plates]
    print(f"{len(plates)} cached, {len(todo)} to generate")

    from .models import Depth, Flux

    images: dict[str, Image.Image] = {}
    timings: list[float] = []
    model_name = args.model
    if todo:
        flux = Flux(args.model)
        print(f"FLUX loaded in {flux.load_s:.1f}s")
        for k in todo:
            t = time.perf_counter()
            images[k] = flux.generate(wanted[k], seed_for(wanted[k]), steps=args.steps)
            timings.append(time.perf_counter() - t)
            print(f"  {k}: {timings[-1]:.1f}s")
            if args.keep_raw:
                images[k].save(out.with_name(f"{out.stem}.{k}.png"))
        print(f"FLUX peak memory {flux.peak_gb():.1f} GB")
        flux.close()

        depth = Depth()
        indoor = {s.key for s in sections if s.key and s.setting in INDOOR}
        for k, img in images.items():
            layers = split(img, depth(img), k in indoor)
            plates[k] = {"prompt": wanted[k], "seed": seed_for(wanted[k]), "layers": [_png(x) for x in layers]}

    doc = {
        "version": 1,
        "trackKey": script["trackKey"],
        "model": old.get("model") if not todo and old.get("model") else f"FLUX.1-schnell ({model_name}), {args.steps} steps",
        "width": PLATE_W,
        "height": PLATE_H,
        "plates": plates,
        "sections": [{"setting": s.setting, "prompt": s.script_prompt, "plate": s.key} for s in sections],
    }
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
    if timings:
        print(f"{len(timings)} images, {sum(timings) / len(timings):.1f}s each; process peak RSS {_rss_gb():.1f} GB")


def bench(args: argparse.Namespace) -> None:
    from .models import Depth, Flux

    prompt = "a sunflower field running to low hills, a farmhouse and a windmill on the horizon, warm late light. " "wide side-scrolling video game background, detailed 16-bit pixel art scenery, no people"
    flux = Flux(args.model)
    print(f"load: {flux.load_s:.1f}s (weights already downloaded)")
    sizes = [tuple(int(v) for v in s.split("x")) for s in args.sizes.split(",")]
    for w, h in sizes:
        flux.generate(prompt, 1, w, h, args.steps)  # warm-up: first call compiles kernels
        ts = []
        for seed in range(2, 2 + args.n):
            t = time.perf_counter()
            img = flux.generate(prompt, seed, w, h, args.steps)
            ts.append(time.perf_counter() - t)
        if args.save:
            img.save(f"bench-{w}x{h}.png")
        print(f"{w}x{h}, {args.steps} steps: {sum(ts) / len(ts):.1f}s per image (n={len(ts)}, min {min(ts):.1f}, max {max(ts):.1f}); MLX peak {flux.peak_gb():.1f} GB")
    flux.close()
    t = time.perf_counter()
    depth = Depth()
    load = time.perf_counter() - t
    t = time.perf_counter()
    for _ in range(3):
        split(img, depth(img), False)
    print(f"depth model load {load:.1f}s; depth + layer split {(time.perf_counter() - t) / 3:.2f}s per plate")
    print(f"process peak RSS {_rss_gb():.1f} GB")


def main(argv: list[str] | None = None) -> None:
    from .models import DEFAULT_MODEL

    p = argparse.ArgumentParser(prog="plates", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="make the plates for one scene script")
    g.add_argument("script", help="scene script JSON exported from the player")
    g.add_argument("-o", "--out", help="default: <script>.plates.json next to the script")
    g.add_argument("--model", default=DEFAULT_MODEL, help="mflux FLUX.1-schnell checkpoint (repo or path)")
    g.add_argument("--steps", type=int, default=4)
    g.add_argument("--dry-run", action="store_true", help="print the prompts and stop")
    g.add_argument("--keep-raw", action="store_true", help="also save each raw FLUX image as PNG")
    g.set_defaults(fn=generate)
    b = sub.add_parser("bench", help="time model load and generation")
    b.add_argument("--model", default=DEFAULT_MODEL)
    b.add_argument("--sizes", default="768x432,1024x576")
    b.add_argument("--steps", type=int, default=4)
    b.add_argument("-n", type=int, default=3)
    b.add_argument("--save", action="store_true")
    b.set_defaults(fn=bench)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
