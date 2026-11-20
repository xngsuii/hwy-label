// 라벨 렌더러: Label 객체 → canvas. 모든 레이아웃은 mm 단위로 계산 후 pxPerMm으로 그림.
import { drawIcon, iconSize } from './pixel.js';

const PT_MM = 0.3528;
const FRAME_LW = 0.35;     // mm
const FRAME_INSET = 0.7;   // mm

const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
export const graphemes = s => seg ? Array.from(seg.segment(s), x => x.segment) : Array.from(s);

const mctx = document.createElement('canvas').getContext('2d');
const mcache = new Map();
function m100(font, g) {
  const k = font + '\u0000' + g;
  let v = mcache.get(k);
  if (v === undefined) {
    mctx.font = font;
    v = mctx.measureText(g).width;
    if (mcache.size > 20000) mcache.clear();
    mcache.set(k, v);
  }
  return v;
}
export function clearMeasureCache() { mcache.clear(); }

function fontStack(family, mono) {
  const emoji = mono ? '"Noto Emoji"' : '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji"';
  return `"${family}", ${emoji}, sans-serif`;
}
function fontStr(L, family, px) {
  return `${L.italic ? 'italic ' : ''}${L.bold ? 700 : 400} ${px}px ${fontStack(family, L.emojiMono)}`;
}

function frameSpace(frame) {
  if (frame === 'none') return 0;
  return FRAME_INSET + (frame === 'double' ? FRAME_LW * 3 : FRAME_LW) + 0.3;
}

// ---------- 레이아웃 ----------
export function layoutLabel(L, family) {
  const vert = L.orientation === 'v';
  const lines = (L.text || ' ').split('\n').map(l => graphemes(l));
  const n = Math.max(1, lines.length);
  const lead = Math.max(0.5, L.leading);
  const tr = (L.tracking || 0) / 100;
  const ws = (L.widthScale || 100) / 100;
  const f100 = fontStr(L, family, 100);

  let crossSize, flowSize = null;
  const fixedFlow = L.orientation === 'square' || L.orientation === 'free' || L.lengthMode === 'fixed';
  if (L.orientation === 'square') { crossSize = L.tapeMm; flowSize = L.tapeMm; }
  else if (L.orientation === 'free') { crossSize = L.freeH; flowSize = L.freeW; }
  else { crossSize = L.tapeMm; if (L.lengthMode === 'fixed') flowSize = L.lengthMm; }

  const fs0 = frameSpace(L.frame);
  const padF = vert ? L.padY : L.padX;
  const padC = vert ? L.padX : L.padY;
  const deco = L.deco || {};
  const crossDecoKeys = vert ? ['right', 'left'] : ['top', 'bottom'];
  const flowDecoKeys = vert ? ['top', 'bottom'] : ['left', 'right'];
  const crossDecoCount = crossDecoKeys.filter(k => deco[k]).length;

  const baseC = Math.max(1, crossSize - 2 * (fs0 + padC));
  const cdSize = baseC * 0.2;          // 위/아래(가로형) 반복 장식 높이
  const cdGap = cdSize * 0.3;
  const crossDecoSpace = crossDecoCount * (cdSize + cdGap);
  let innerC = Math.max(0.5, baseC - crossDecoSpace);

  const blockFactor = 1 + (n - 1) * lead;
  let fs;
  if (L.sizeMode === 'manual') {
    fs = L.sizePt * PT_MM;
    if (L.wrapMode === 'shrink' && fs * blockFactor > innerC) fs = innerC / blockFactor;
  } else {
    fs = L.wrapMode === 'grow' ? innerC * 0.8 : (innerC / blockFactor) * 0.8;
  }
  // 높이 늘림 모드: 필요한 만큼 테이프 폭 증가
  if (L.wrapMode === 'grow' && L.orientation !== 'square' && L.orientation !== 'free') {
    const need = fs * blockFactor;
    if (need > innerC) {
      crossSize += need - innerC;
      innerC = need;
    }
  }

  const flowLen = (line, f) => {
    if (!line.length) return 0;
    if (vert) return line.length * f * (1 + tr) - tr * f;
    let w = 0;
    for (const g of line) w += m100(f100, g) / 100 * f * ws + tr * f;
    return w - tr * f;
  };

  // 흐름 방향 장식 (가로형 좌우 / 세로형 위아래): 단일 아이콘
  const flowDeco = flowDecoKeys.map(k => {
    const name = deco[k];
    if (!name) return null;
    const { w, h } = iconSize(name);
    if (!w) return null;
    // 아이콘을 (교차 길이 × 교차 길이) 상자 안에 비율 유지로 맞춤
    const box = Math.min(innerC, baseC) * 0.72;
    const cell = box / Math.max(w, h);
    const iw = w * cell, ih = h * cell;
    return { name, w: iw, h: ih, len: vert ? ih : iw };
  });
  const gap = innerC * 0.22;

  const compute = f => {
    const lens = lines.map(l => flowLen(l, f));
    const textFlow = Math.max(0.1, ...lens);
    const decoLen = flowDeco.reduce((s, d) => s + (d ? d.len + gap : 0), 0);
    return { lens, textFlow, need: 2 * (fs0 + padF) + decoLen + textFlow, decoLen };
  };
  let c = compute(fs);
  if (fixedFlow) {
    const avail = flowSize - 2 * (fs0 + padF) - c.decoLen;
    if (c.textFlow > avail && avail > 0) {
      fs *= avail / c.textFlow;
      c = compute(fs);
    }
  } else {
    flowSize = Math.max(c.need, crossSize * 0.9);
  }

  const wMm = vert ? crossSize : flowSize;
  const hMm = vert ? flowSize : crossSize;
  return { vert, lines, n, lead, tr, ws, fs, crossSize, flowSize, wMm, hMm, fs0, padF, padC, innerC, baseC,
    cdSize, cdGap, crossDecoKeys, flowDeco, gap, ...c, family };
}

// ---------- 그리기 ----------
export function renderLabel(L, family, pxPerMm = 10) {
  const Y = layoutLabel(L, family);
  const P = pxPerMm;
  const W = Math.max(2, Math.round(Y.wMm * P));
  const H = Math.max(2, Math.round(Y.hMm * P));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const ink = L.inkColor;

  // 테이프
  ctx.fillStyle = L.tapeColor;
  ctx.fillRect(0, 0, W, H);
  drawPattern(ctx, L.pattern, W, H, P, ink, Y.vert);
  drawFrame(ctx, L.frame, W, H, P, ink);

  // 좌표 변환 헬퍼 (flow, cross) mm → (x, y) px
  const xy = (f, c) => Y.vert ? [(Y.crossSize - c) * P, f * P] : [f * P, c * P];

  // 교차 방향 반복 장식
  let cStart = Y.fs0 + Y.padC;
  let cEnd = Y.crossSize - Y.fs0 - Y.padC;
  const flowA = Y.fs0 + Y.padF;
  const flowB = Y.flowSize - Y.fs0 - Y.padF;
  Y.crossDecoKeys.forEach((k, idx) => {
    const name = L.deco?.[k];
    if (!name) return;
    const { w, h } = iconSize(name);
    if (!w) return;
    const size = Y.cdSize; // 교차 방향 크기
    const along = Y.vert ? size * h / w : size * w / h; // 흐름 방향 길이
    const spacing = along * 0.7;
    const span = flowB - flowA;
    const count = Math.max(1, Math.floor((span + spacing) / (along + spacing)));
    const total = count * along + (count - 1) * spacing;
    let f = flowA + (span - total) / 2;
    const c0 = idx === 0 ? cStart : cEnd - size;
    for (let i = 0; i < count; i++) {
      const [x, y] = Y.vert ? xy(f, c0 + size) : xy(f, c0);
      const cellPx = (Y.vert ? size * P / w : size * P / h);
      drawIcon(ctx, name, x, y, snap(cellPx), ink);
      f += along + spacing;
    }
    if (idx === 0) cStart += size + Y.cdGap; else cEnd -= size + Y.cdGap;
  });

  // 텍스트 영역
  const innerC = cEnd - cStart;
  let fA = flowA, fB = flowB;
  const [dStart, dEnd] = Y.flowDeco;
  const drawFlowDeco = (d, f0) => {
    const cc = cStart + (innerC - (Y.vert ? d.w : d.h)) / 2;
    const { w, h } = iconSize(d.name);
    const cellPx = snap((Y.vert ? d.w : d.h) * P / (Y.vert ? w : h));
    const [x, y] = Y.vert ? xy(f0, cc + d.w) : xy(f0, cc);
    drawIcon(ctx, d.name, x, y, cellPx, ink);
  };
  // 장식은 텍스트 블록 옆에 붙도록: 흐름 고정이면 영역 양 끝, 자동이면 자연스럽게 양 끝
  if (dStart) { drawFlowDeco(dStart, fA); fA += dStart.len + Y.gap; }
  if (dEnd) { drawFlowDeco(dEnd, fB - dEnd.len); fB -= dEnd.len + Y.gap; }
  const areaLen = fB - fA;

  const fsPx = Y.fs * P;
  ctx.font = fontStr(L, family, fsPx);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  const blockC = Y.fs * (1 + (Y.n - 1) * Y.lead);
  const c0 = cStart + (innerC - blockC) / 2;
  const f100 = fontStr(L, family, 100);
  const deco = Math.max(1, Y.fs * 0.07 * P);

  Y.lines.forEach((line, i) => {
    const cMid = c0 + Y.fs / 2 + i * Y.fs * Y.lead;
    const len = Y.lens[i];
    let extra = 0, f = fA;
    if (L.align === 'left') f = fA;
    else if (L.align === 'right') f = fA + (areaLen - len);
    else if (L.align === 'justify' && line.length > 1) { extra = (areaLen - len) / (line.length - 1); f = fA; }
    else f = fA + (areaLen - len) / 2;
    const fStart = f;
    for (const g of line) {
      const adv = Y.vert ? Y.fs : m100(f100, g) / 100 * Y.fs * Y.ws;
      if (Y.vert) {
        const [x, y] = xy(f + Y.fs / 2, cMid);
        glyph(ctx, g, x, y, 'center', Y.ws, L, ink, fsPx);
      } else {
        const [x, y] = xy(f, cMid);
        glyph(ctx, g, x, y, 'left', Y.ws, L, ink, fsPx);
      }
      f += adv + Y.tr * Y.fs + extra;
    }
    const fEnd = f - Y.tr * Y.fs - extra;
    if (line.length && (L.underline || L.strike)) {
      ctx.fillStyle = ink;
      if (!Y.vert) {
        if (L.underline) ctx.fillRect(fStart * P, (cMid + Y.fs * 0.46) * P, (fEnd - fStart) * P, deco);
        if (L.strike) ctx.fillRect(fStart * P, cMid * P - deco / 2, (fEnd - fStart) * P, deco);
      } else {
        const [xc] = xy(0, cMid);
        if (L.underline) ctx.fillRect(xc - Y.fs * 0.56 * P, fStart * P, deco, (fEnd - fStart) * P);
        if (L.strike) ctx.fillRect(xc - deco / 2, fStart * P, deco, (fEnd - fStart) * P);
      }
    }
  });

  return { canvas: cv, wMm: Y.wMm, hMm: Y.hMm, layout: Y };
}

const snap = c => c >= 1.5 ? Math.round(c) : Math.max(1, c);

function glyph(ctx, g, x, y, align, ws, L, ink, fsPx) {
  ctx.save();
  ctx.translate(x, y);
  if (ws !== 1) ctx.scale(ws, 1);
  ctx.textAlign = align;
  if (L.outline) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, fsPx * 0.14);
    ctx.strokeStyle = ink;
    ctx.strokeText(g, 0, 0);
    ctx.fillStyle = L.tapeColor;
    ctx.fillText(g, 0, 0);
  } else {
    ctx.fillStyle = ink;
    ctx.fillText(g, 0, 0);
  }
  ctx.restore();
}

function drawFrame(ctx, type, W, H, P, ink) {
  if (type === 'none') return;
  const lw = Math.max(1, Math.round(FRAME_LW * P));
  const ins = FRAME_INSET * P;
  ctx.strokeStyle = ink;
  ctx.lineWidth = lw;
  const rect = d => ctx.strokeRect(Math.round(ins + d) + lw / 2, Math.round(ins + d) + lw / 2, Math.round(W - 2 * (ins + d)) - lw, Math.round(H - 2 * (ins + d)) - lw);
  if (type === 'dotted') { ctx.setLineDash([lw, lw * 1.4]); rect(0); ctx.setLineDash([]); }
  else if (type === 'double') { rect(0); rect(lw * 2); }
  else rect(0);
}

function drawPattern(ctx, type, W, H, P, ink, vert) {
  if (!type || type === 'none') return;
  const u = 1.4 * P;
  ctx.save();
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  if (type === 'check') {
    ctx.globalAlpha = 0.1;
    for (let x = 0; x < W; x += u * 2) ctx.fillRect(Math.round(x), 0, Math.round(u), H);
    for (let y = 0; y < H; y += u * 2) ctx.fillRect(0, Math.round(y), W, Math.round(u));
  } else if (type === 'stripe') {
    ctx.globalAlpha = 0.13;
    if (!vert) for (let x = 0; x < W; x += u) ctx.fillRect(Math.round(x), 0, Math.max(1, Math.round(u * 0.35)), H);
    else for (let y = 0; y < H; y += u) ctx.fillRect(0, Math.round(y), W, Math.max(1, Math.round(u * 0.35)));
  } else if (type === 'dot') {
    ctx.globalAlpha = 0.22;
    const s = u * 0.75, d = Math.max(1, Math.round(u * 0.16));
    let r = 0;
    for (let y = s / 2; y < H; y += s, r++)
      for (let x = (r % 2 ? s : s / 2); x < W; x += s) ctx.fillRect(Math.round(x), Math.round(y), d, d);
  } else if (type === 'diag') {
    ctx.globalAlpha = 0.14;
    ctx.lineWidth = Math.max(1, u * 0.16);
    ctx.beginPath();
    for (let x = -H; x < W; x += u * 0.8) { ctx.moveTo(x, H); ctx.lineTo(x + H, 0); }
    ctx.stroke();
  }
  ctx.restore();
}

// 내보내기용
export function canvasToBlob(cv) {
  return new Promise(res => cv.toBlob(res, 'image/png'));
}
