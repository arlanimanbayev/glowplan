/**
 * Photo intake: decode a selfie, let the person zoom/pan it into the arch, and
 * export a JPEG that meets YouCam's requirements.
 *
 * YouCam AI Skin Analysis wants the face to fill at least ~60% of the image
 * width, a short side of 1080 px for HD (480 px for SD), and files under 10 MB.
 * The export keeps the long side at or under 2048 px (YouCam resizes anything
 * over 2560 anyway) so the upload stays well under Vercel's 4.5 MB body limit.
 * The photo never leaves memory except for the one upload to /api/analyze.
 */

export const HD_MIN = 1080;
export const SD_MIN = 480;
const MAX_LONG = 2048;
const ASPECT = 3 / 4;

export class PhotoError extends Error {}

export async function decodeFile(file) {
  if (!file) throw new PhotoError('Choose a photo first.');
  if (file.type && !file.type.startsWith('image/')) throw new PhotoError('Choose an image file (JPG or PNG).');
  if (file.size > 30 * 1024 * 1024) throw new PhotoError('That photo is over 30 MB. Choose a smaller one.');
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, name: file.name || 'selfie.jpg' };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, name: file.name || 'selfie.jpg' };
    } catch {
      throw new PhotoError('This photo format could not be opened. Use a JPG or PNG.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Interactive 3:4 crop drawn into a canvas (drag to move, slider or arrow keys to zoom/pan). */
export class Cropper {
  constructor(canvas, photo, { onChange } = {}) {
    this.canvas = canvas;
    this.photo = photo;
    this.onChange = onChange || (() => {});
    const { width: w, height: h } = photo;
    if (w / h > ASPECT) {
      this.baseH = h;
      this.baseW = h * ASPECT;
    } else {
      this.baseW = w;
      this.baseH = w / ASPECT;
    }
    this.zoom = 1;
    this.cx = w / 2;
    this.cy = h / 2;
    this.bind();
    this.draw();
  }

  crop() {
    const { width: W, height: H } = this.photo;
    const w = this.baseW / this.zoom;
    const h = this.baseH / this.zoom;
    const x = Math.min(Math.max(this.cx - w / 2, 0), W - w);
    const y = Math.min(Math.max(this.cy - h / 2, 0), H - h);
    this.cx = x + w / 2;
    this.cy = y + h / 2;
    return { x, y, w, h };
  }

  /** Pixel size of the exported image and the YouCam tier it qualifies for. */
  output() {
    const { w, h } = this.crop();
    const scale = Math.min(1, MAX_LONG / h);
    const width = Math.round(w * scale);
    const height = Math.round(h * scale);
    const tier = width >= HD_MIN ? 'hd' : width >= SD_MIN ? 'sd' : null;
    return { width, height, tier };
  }

  setZoom(z) {
    this.zoom = Math.min(Math.max(z, 1), 4);
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const { x, y, w, h } = this.crop();
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.photo.source, x, y, w, h, 0, 0, cw, ch);
    this.onChange(this.output());
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    c.tabIndex = 0;
    c.onpointerdown = (e) => {
      drag = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
    };
    c.onpointermove = (e) => {
      if (!drag) return;
      const { w } = this.crop();
      const k = w / c.clientWidth;
      this.cx -= (e.clientX - drag.x) * k;
      this.cy -= (e.clientY - drag.y) * k;
      drag = { x: e.clientX, y: e.clientY };
      this.draw();
    };
    c.onpointerup = () => {
      drag = null;
    };
    c.onpointercancel = c.onpointerup;
    c.onkeydown = (e) => {
      const step = this.crop().w * 0.04;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        this.cx += moves[e.key][0];
        this.cy += moves[e.key][1];
        this.draw();
        e.preventDefault();
      }
    };
  }

  /** JPEG data URL of the current crop, kept under ~3 MB. */
  async export() {
    const { x, y, w, h } = this.crop();
    const { width, height, tier } = this.output();
    if (!tier) throw new PhotoError(`This crop is ${width}×${height} pixels. Zoom out or use a sharper photo: YouCam needs at least ${SD_MIN} pixels across.`);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.photo.source, x, y, w, h, 0, 0, width, height);
    let quality = 0.9;
    let blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', quality));
    while (blob && blob.size > 3_000_000 && quality > 0.6) {
      quality -= 0.1;
      blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', quality));
    }
    if (!blob) throw new PhotoError('The photo could not be prepared. Try another one.');
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new PhotoError('The photo could not be read.'));
      fr.readAsDataURL(blob);
    });
    return { dataUrl, width, height, tier, bytes: blob.size, previewUrl: URL.createObjectURL(blob) };
  }
}

/** Full-frame export for a "before" photo (no crop UI): centre 3:4 crop. */
export async function exportFull(photo) {
  const canvas = document.createElement('canvas');
  canvas.style.width = '300px';
  canvas.style.height = '400px';
  const cropper = new Cropper(canvas, photo);
  return cropper.export();
}
