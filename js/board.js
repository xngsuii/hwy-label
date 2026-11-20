// 판(보드) 배치 + 내보내기
import { layoutLabel, renderLabel } from './render.js';
import { fontById } from './fonts.js';

export const BOARD_SIZES = {
  '1080x1080': [1080, 1080, '1080 × 1080 (정방)'],
  '1080x1350': [1080, 1350, '1080 × 1350 (4:5)'],
  '1080x1920': [1080, 1920, '1080 × 1920 (스토리)'],
  '2480x3508': [2480, 3508, 'A4 · 300dpi'],
  'A5': [1748, 2480, 'A5 · 300dpi'],
  'B5': [2150, 3035, 'B5 · 300dpi'],
};
export function boardDims(size, landscape) {
  const [w, h] = BOARD_SIZES[size] || BOARD_SIZES['1080x1080'];
  return landscape ? { w: Math.max(w, h), h: Math.min(w, h) } : { w: Math.min(w, h), h: Math.max(w, h) };
}
const itemScale = (board, id) => (board.items.find(i => i.id === id)?.s) || 1;

export const BOARD_PPM = 300 / 25.4; // 판 위 라벨은 300dpi 기준 크기

export function labelPx(label, customFonts, scale = 1) {
  const f = fontById(label.fontId, customFonts);
  const Y = layoutLabel(label, f.family);
  const k = BOARD_PPM * scale;
  return { w: Y.wMm * k, h: Y.hMm * k };
}

export function autoLayout(labels, customFonts, board) {
  const { w: W, h: H } = board;
  const scale = board.scale || 1;
  const margin = W * 0.06, gap = W * 0.03;
  const rows = [];
  let row = { items: [], w: 0, h: 0 };
  for (const L of labels) {
    const s = labelPx(L, customFonts, scale * itemScale(board, L.id));
    if (row.items.length && row.w + gap + s.w > W - 2 * margin) { rows.push(row); row = { items: [], w: 0, h: 0 }; }
    row.items.push({ L, s });
    row.w += (row.items.length > 1 ? gap : 0) + s.w;
    row.h = Math.max(row.h, s.h);
  }
  if (row.items.length) rows.push(row);
  const totalH = rows.reduce((a, r) => a + r.h, 0) + Math.max(0, rows.length - 1) * gap;
  let y = Math.max(margin, (H - totalH) / 2);
  const items = [];
  for (const r of rows) {
    let x = (W - r.w) / 2;
    for (const { L, s } of r.items) {
      items.push({ id: L.id, x, y: y + (r.h - s.h) / 2, rot: 0, s: itemScale(board, L.id) });
      x += s.w + gap;
    }
    y += r.h + gap;
  }
  return items;
}

export function scatterLayout(labels, customFonts, board) {
  const { w: W, h: H } = board;
  const scale = board.scale || 1;
  const margin = W * 0.03;
  const placed = [];
  const items = [];
  for (const L of labels) {
    const sc = itemScale(board, L.id);
    const s = labelPx(L, customFonts, scale * sc);
    let best = null;
    for (let t = 0; t < 40; t++) {
      const x = margin + Math.random() * Math.max(1, W - 2 * margin - s.w);
      const y = margin + Math.random() * Math.max(1, H - 2 * margin - s.h);
      let ov = 0;
      for (const p of placed) {
        const ox = Math.max(0, Math.min(x + s.w, p.x + p.w) - Math.max(x, p.x));
        const oy = Math.max(0, Math.min(y + s.h, p.y + p.h) - Math.max(y, p.y));
        ov += ox * oy;
      }
      if (!best || ov < best.ov) best = { x, y, ov };
      if (ov === 0) break;
    }
    placed.push({ x: best.x, y: best.y, w: s.w, h: s.h });
    items.push({ id: L.id, x: best.x, y: best.y, rot: Math.round((Math.random() * 2 - 1) * 12), s: sc });
  }
  return items;
}

// 서랍 변경 후 판 아이템 동기화
export function syncBoard(state) {
  const { drawer, board, customFonts } = state;
  if (board.layout === 'auto') return { ...board, items: autoLayout(drawer, customFonts, board) };
  const ids = new Set(drawer.map(l => l.id));
  const items = board.items.filter(i => ids.has(i.id));
  const have = new Set(items.map(i => i.id));
  for (const L of drawer) {
    if (have.has(L.id)) continue;
    const s = labelPx(L, customFonts, board.scale || 1);
    items.push({ id: L.id, x: (board.w - s.w) / 2 + (Math.random() - .5) * board.w * .3, y: (board.h - s.h) / 2 + (Math.random() - .5) * board.h * .3, rot: 0 });
  }
  return { ...board, items };
}

export function drawBoardBg(ctx, board, img) {
  const { w: W, h: H } = board;
  const bg = board.bg;
  if (bg === 'trans') return;
  if (bg === 'mat') {
    ctx.fillStyle = '#252327'; ctx.fillRect(0, 0, W, H);
    const line = (step, a) => {
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      const lw = Math.max(1, Math.round(W / 1080));
      for (let x = 0; x <= W; x += step) ctx.fillRect(Math.round(x), 0, lw, H);
      for (let y = 0; y <= H; y += step) ctx.fillRect(0, Math.round(y), W, lw);
    };
    line(W / 40, 0.07); line(W / 10, 0.18);
  } else if (bg === 'grid') {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#cfd8e8';
    const step = W * 0.03, lw = Math.max(1, Math.round(W / 1080));
    for (let x = 0; x <= W; x += step) ctx.fillRect(Math.round(x), 0, lw, H);
    for (let y = 0; y <= H; y += step) ctx.fillRect(0, Math.round(y), W, lw);
  } else if (bg === 'image' && img) {
    const s = Math.max(W / img.width, H / img.height);
    ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
  } else {
    ctx.fillStyle = board.bgColor || '#ffffff'; ctx.fillRect(0, 0, W, H);
  }
}

export async function renderBoard(state, { transparent = false } = {}) {
  const { board, drawer, customFonts } = state;
  const cv = document.createElement('canvas');
  cv.width = board.w; cv.height = board.h;
  const ctx = cv.getContext('2d');
  if (!transparent) {
    let img = null;
    if (board.bg === 'image' && board.bgImage) img = await loadImg(board.bgImage);
    drawBoardBg(ctx, board, img);
  }
  const byId = Object.fromEntries(drawer.map(l => [l.id, l]));
  const scale = board.scale || 1;
  for (const it of board.items) {
    const L = byId[it.id];
    if (!L) continue;
    const f = fontById(L.fontId, customFonts);
    const { canvas } = renderLabel(L, f.family, BOARD_PPM * scale * (it.s || 1));
    ctx.save();
    ctx.translate(it.x + canvas.width / 2, it.y + canvas.height / 2);
    ctx.rotate((it.rot || 0) * Math.PI / 180);
    const k = board.w / 1080;
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowOffsetX = 1.5 * k; ctx.shadowOffsetY = 3 * k;
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    ctx.restore();
  }
  return cv;
}

export function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
