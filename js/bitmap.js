// 이미지 → 1비트 비트맵 (하프톤 / 디더 / 임계값). 결과는 픽셀 아이콘 rows ('X' / '.')
export function loadImageFile(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

export function toBitmap(img, { cols = 48, mode = 'halftone', threshold = 128, contrast = 1, invert = false } = {}) {
  const w = Math.max(4, Math.round(cols));
  const h = Math.max(4, Math.min(160, Math.round(w * img.height / img.width)));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  // 밝기 0(검정)~255(흰색), 대비/임계값 반영
  const g = new Float32Array(w * h);
  const shift = 128 - threshold;
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255;
    let v = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a + 255 * (1 - a);
    v = (v - 128) * contrast + 128 + shift;
    g[i] = Math.max(0, Math.min(255, v));
  }
  const on = new Uint8Array(w * h);
  if (mode === 'threshold') {
    for (let i = 0; i < w * h; i++) on[i] = g[i] < 128 ? 1 : 0;
  } else if (mode === 'bayer') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = (BAYER4[y % 4][x % 4] + 0.5) * 16;
      on[y * w + x] = g[y * w + x] < t ? 1 : 0;
    }
  } else if (mode === 'dither') {
    const e = Float32Array.from(g);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = e[i] < 128 ? 0 : 255;
      on[i] = o === 0 ? 1 : 0;
      const err = e[i] - o;
      if (x + 1 < w) e[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) e[i + w - 1] += err * 3 / 16;
        e[i + w] += err * 5 / 16;
        if (x + 1 < w) e[i + w + 1] += err * 1 / 16;
      }
    }
  } else { // halftone: 4px 셀마다 어두운 만큼 큰 점
    const c = 4;
    for (let cy = 0; cy < h; cy += c) for (let cx = 0; cx < w; cx += c) {
      let sum = 0, cnt = 0;
      for (let y = cy; y < Math.min(h, cy + c); y++) for (let x = cx; x < Math.min(w, cx + c); x++) { sum += g[y * w + x]; cnt++; }
      const dark = 1 - sum / cnt / 255;
      const r = Math.sqrt(dark) * c * 0.75;
      const mx = cx + (c - 1) / 2, my = cy + (c - 1) / 2;
      for (let y = cy; y < Math.min(h, cy + c); y++) for (let x = cx; x < Math.min(w, cx + c); x++) {
        if (Math.hypot(x - mx, y - my) <= r) on[y * w + x] = 1;
      }
    }
  }
  if (invert) for (let i = 0; i < on.length; i++) on[i] ^= 1;
  // 빈 가장자리 잘라내기
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return ['.'];
  const rows = [];
  for (let y = y0; y <= y1; y++) {
    let r = '';
    for (let x = x0; x <= x1; x++) r += on[y * w + x] ? 'X' : '.';
    rows.push(r);
  }
  return rows;
}

export function rowsToCanvas(rows, cell = 3, color = '#2F2C30') {
  const h = rows.length, w = rows[0].length;
  const cv = document.createElement('canvas');
  cv.width = w * cell; cv.height = h * cell;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = color;
  rows.forEach((row, y) => { for (let x = 0; x < w; x++) if (row[x] === 'X') ctx.fillRect(x * cell, y * cell, cell, cell); });
  return cv;
}
