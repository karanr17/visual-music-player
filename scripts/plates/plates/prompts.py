"""Turns a scene script's section worlds into FLUX prompts, and decides which sections share a plate."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

# Road and river scroll toward the viewer in the player, which a still plate can't do.
PROCEDURAL_ONLY = {"road", "river"}
# Indoors: the plate is the whole picture, with no sky to cut out.
INDOOR = {"room", "club"}

# Used when a script has no world.plate (written before illustrated mode, or by hand).
SETTING_SCENE = {
    "city": "a city street of low brick buildings and lit shopfronts, a skyline behind",
    "ocean": "open sea stretching to the horizon, rolling waves",
    "beach": "a sandy beach with gentle surf, dunes and beach grass",
    "forest": "a clearing in a pine forest with a grassy path",
    "mountains": "a grassy valley below snowy mountain peaks",
    "desert": "sand dunes and red rock mesas",
    "field": "rolling green meadows with a few trees and a distant farmhouse",
    "sky": "a sea of clouds high above the world",
    "space": "a rocky moon surface with craters",
    "room": "a cozy bedroom interior seen from the side, a window, a bed and shelves",
    "snowfield": "a snowy plain with frosted pine trees",
    "lake": "a calm lake ringed by pine-covered hills",
    "flower_field": "a meadow full of wildflowers below rolling hills",
    "club": "a nightclub dance floor with a stage and coloured lights",
    "rooftop": "a flat city rooftop with a water tank, the skyline behind",
}

TIME_LIGHT = {
    "dawn": "at dawn, soft pink light",
    "day": "in daylight",
    "dusk": "at dusk, warm orange light",
    "night": "at night, moonlit, dark blue tones",
}

WEATHER_LOOK = {
    "clear": "",
    "cloudy": "overcast",
    "rain": "wet after rain",
    "storm": "dark and stormy",
    "snow": "covered in snow",
    "fog": "misty",
    "wind": "windswept",
}

# Asks for what the player needs: a side-on landscape with open ground near the bottom, where the
# sprite characters stand, and nothing alive in it, since those are drawn on top.
STYLE = (
    "wide side-scrolling video game background, detailed 16-bit pixel art scenery, flat shading, "
    "clear horizon, open empty ground across the foreground, no people, no animals, no text"
)


@dataclass(frozen=True)
class SectionPlate:
    index: int
    setting: str
    # world.plate as written in the script ("" if it has none); the player matches on it.
    script_prompt: str
    # The full FLUX prompt, or None for settings that stay procedural.
    prompt: str | None
    # Sections with the same key share one plate.
    key: str | None


def flux_prompt(world: dict) -> str:
    subject = (world.get("plate") or "").strip() or SETTING_SCENE.get(world["setting"], SETTING_SCENE["field"])
    light = TIME_LIGHT.get(world.get("timeOfDay", ""), "")
    weather = WEATHER_LOOK.get(world.get("weather", ""), "")
    mood = world.get("mood", "")
    parts = [subject.rstrip("."), ", ".join(p for p in (light, weather, f"{mood} mood" if mood else "") if p), STYLE]
    return ". ".join(p for p in parts if p)


def seed_for(prompt: str) -> int:
    return int(hashlib.sha1(prompt.encode()).hexdigest()[:8], 16) & 0x7FFFFFFF


def plan(script: dict) -> list[SectionPlate]:
    """One entry per section. A section that returns (same recurrence group and setting) reuses
    the first occurrence's plate even if its plate text drifted."""
    out: list[SectionPlate] = []
    first: dict[tuple[str, str], str] = {}
    for i, s in enumerate(script["sections"]):
        w = s["world"]
        script_prompt = w.get("plate") or ""
        if w["setting"] in PROCEDURAL_ONLY:
            out.append(SectionPlate(i, w["setting"], script_prompt, None, None))
            continue
        prompt = flux_prompt(w)
        key = hashlib.sha1(prompt.encode()).hexdigest()[:12]
        rec = s.get("recurrence")
        if rec:
            key = first.setdefault((rec, w["setting"]), key)
        out.append(SectionPlate(i, w["setting"], script_prompt, prompt, key))
    return out
