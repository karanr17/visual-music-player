import { dbGet, dbPut } from "./db";
import type { RGB } from "./render/fb";
import { setReference, type Reference } from "./render/style";

// The listener's reference artwork: its palette and colour cast drive the "reference" look,
// and a downscaled copy can be shown to Claude when it writes scenes.
export interface StoredReference extends Reference {
  id: string;
  name: string;
  // JPEG data URL, at most 768px on the long side (plenty for Claude to read the style, small for storage).
  image: string;
}

let current: StoredReference | null = null;

export const currentReference = () => current;

export async function loadReference(): Promise<StoredReference | null> {
  current = (await dbGet<StoredReference>("kv", "reference")) ?? null;
  setReference(current);
  return current;
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`Couldn't read ${file.name} as an image`);
  }
}

function draw(img: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Median cut: split the colour box with the widest channel range until there are n boxes.
function medianCut(px: RGB[], n: number): RGB[] {
  let boxes: RGB[][] = [px];
  while (boxes.length < n) {
    let bi = -1;
    let bestRange = 0;
    let bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255;
        let hi = 0;
        for (const p of b) {
          lo = Math.min(lo, p[ch]);
          hi = Math.max(hi, p[ch]);
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          bi = i;
          bestCh = ch;
        }
      }
    });
    if (bi < 0) break;
    const box = boxes[bi].sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    boxes = [...boxes.slice(0, bi), box.slice(0, mid), box.slice(mid), ...boxes.slice(bi + 1)];
  }
  return boxes.map((b) => {
    const s = [0, 0, 0];
    for (const p of b) for (let ch = 0; ch < 3; ch++) s[ch] += p[ch];
    return s.map((v) => Math.round(v / b.length)) as RGB;
  });
}

export async function setReferenceImage(file: File): Promise<StoredReference> {
  const img = await decode(file);
  const small = draw(img, 96).getContext("2d")!;
  const { data } = small.getImageData(0, 0, small.canvas.width, small.canvas.height);
  const px: RGB[] = [];
  let cb = 0;
  let cr = 0;
  let chroma = 0;
  for (let i = 0; i < data.length; i += 4) {
    const p: RGB = [data[i], data[i + 1], data[i + 2]];
    px.push(p);
    const y = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
    cb += p[2] - y;
    cr += p[0] - y;
    chroma += Math.hypot(p[2] - y, p[0] - y);
  }
  const n = Math.max(1, px.length);
  const palette = medianCut(px, 14);
  // The scene needs somewhere to put deep shadow and bright light even if the artwork is mid-toned.
  const lum = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const darkest = palette.reduce((a, b) => (lum(a) < lum(b) ? a : b));
  const lightest = palette.reduce((a, b) => (lum(a) > lum(b) ? a : b));
  palette.push(darkest.map((v) => Math.round(v * 0.45)) as RGB, lightest.map((v) => Math.round(v + (255 - v) * 0.5)) as RGB);
  // ~28 is the average chroma of a typical rendered scene; scale scene colour toward the artwork's.
  const ref: StoredReference = {
    id: `${file.name}:${file.size}:${file.lastModified}`,
    name: file.name,
    palette,
    cb: cb / n,
    cr: cr / n,
    chroma: Math.min(1.8, Math.max(0.3, chroma / n / 28)),
    image: draw(img, 768).toDataURL("image/jpeg", 0.85),
  };
  await dbPut("kv", "reference", ref);
  current = ref;
  setReference(ref);
  return ref;
}

export function referenceImagePart(): { mediaType: "image/jpeg"; data: string } | null {
  if (!current) return null;
  return { mediaType: "image/jpeg", data: current.image.slice(current.image.indexOf(",") + 1) };
}
