import { dbGet, dbPut } from "../db";
import { PLATE_H, PLATE_W, PlateSet, type DecodedPlates, type PlateImage } from "../render/plates";

export const PLATES_EXT = /\.plates\.json$/i;

function parse(data: unknown, from: string): PlateSet | null {
  const r = PlateSet.safeParse(data);
  if (r.success) return r.data;
  console.warn(`[plates] ${from} is not a plate set`, r.error.issues.slice(0, 3));
  return null;
}

const decoded = new Map<string, Promise<DecodedPlates | null>>();

// Keeps each plate set from scripts/plates in IndexedDB by the script's trackKey, so a song's
// plates come back with it next time. Returns how many sets were stored.
export async function addPlateFiles(files: File[]): Promise<number> {
  let n = 0;
  for (const f of files.filter((x) => PLATES_EXT.test(x.name))) {
    try {
      const set = parse(JSON.parse(await f.text()), f.name);
      if (!set) continue;
      await dbPut("plates", set.trackKey, set);
      decoded.delete(set.trackKey);
      n++;
    } catch (err) {
      console.warn("[plates] couldn't read", f.name, err);
    }
  }
  return n;
}

// Plates shipped with the static build (public/plates/) for the demo songs.
async function fromBundle(trackKey: string): Promise<PlateSet | null> {
  const base = import.meta.env.BASE_URL;
  try {
    const res = await fetch(`${base}plates/index.json`);
    if (!res.ok) return null;
    const name = ((await res.json()) as Record<string, string>)[trackKey];
    if (!name) return null;
    const file = await fetch(`${base}plates/${name}`);
    return file.ok ? parse(await file.json(), name) : null;
  } catch {
    return null;
  }
}

async function decodeLayer(url: string): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(PLATE_W, PLATE_H);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, PLATE_W, PLATE_H).data;
}

export async function decode(set: PlateSet): Promise<DecodedPlates> {
  const images = new Map<string, PlateImage>();
  for (const [id, p] of Object.entries(set.plates)) images.set(id, { horizon: p.horizon, layers: await Promise.all(p.layers.map(decodeLayer)) });
  return { set, images };
}

// A song's plates from IndexedDB or the bundle, decoded; null if it has none. Never throws:
// illustrated mode just falls back to the procedural backdrops.
export function loadPlates(trackKey: string): Promise<DecodedPlates | null> {
  let p = decoded.get(trackKey);
  if (!p) {
    p = (async () => {
      try {
        const stored = await dbGet<unknown>("plates", trackKey);
        const set = (stored ? parse(stored, "cache") : null) ?? (await fromBundle(trackKey));
        return set ? await decode(set) : null;
      } catch (err) {
        console.warn("[plates] unavailable", err);
        return null;
      }
    })();
    decoded.set(trackKey, p);
  }
  return p;
}
