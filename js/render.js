// 라벨 렌더러: Label 객체 → canvas. 모든 레이아웃은 mm 단위로 계산 후 pxPerMm으로 그림.
import { drawIcon, iconSize } from './pixel.js';
import { richLines, graphemes } from './rich.js';
export { graphemes };

const PT_MM = 0.3528;
const FRAME_LW = 0.17;     // mm (300dpi ≈ 2px, 180dpi ≈ 1px)
const FRAME_INSET = 0.7;   // mm


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
// 글자별 스타일 st 기준 폰트
function fontStrS(st, L, family, px) {
  return `${st.italic ? 'italic ' : ''}${st.bold ? 700 : 400} ${px}px ${fontStack(family, L.emojiMono)}`;
}
// 사진(데이터 URL) 캐시: 로드되면 다시 그리도록 알림
const imgCache = new Map();
function getImg(src) {
  let im = imgCache.get(src);
  if (!im) {
    im = new Image();
    im.onload = () => window.dispatchEvent(new Event('label-img-loaded'));
    im.src = src;
    imgCache.set(src, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

function frameSpace(frame) {
  if (frame === 'none') return 0;
  return FRAME_INSET + (frame === 'double' ? FRAME_LW * 3.5 : FRAME_LW) + 0.3;
}

// ---------- 레이아웃 ----------
export function layoutLabel(L, family) {
  if (SPECIAL[L.frame]) return SPECIAL[L.frame].layout(L, family);
  const vert = L.orientation === 'v';
  const lines = richLines(L, L.text || ' ');
  const n = Math.max(1, lines.length);
  const lead = Math.max(0.5, L.leading);
  const tr = (L.tracking || 0) / 100;
  const ws = (L.widthScale || 100) / 100;

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
  const cdSize = baseC * 0.153 * (L.decoScale || 1); // 가장자리 장식 높이
  const cdGap = cdSize * 0.3;
  const crossDecoSpace = crossDecoCount * (cdSize + cdGap);
  let innerC = Math.max(0.5, baseC - crossDecoSpace);

  // 메인 그림 (큰 그림 + 작은 텍스트 위/아래). 세로형은 미지원
  const hero = !vert && L.hero && L.hero.icon && iconSize(L.hero.icon).w ? L.hero : null;
  const hasText = (L.text || '').trim().length > 0;
  let heroH = 0, heroGap = 0, heroW = 0;
  const heroRatio = hero ? iconSize(hero.icon).w / iconSize(hero.icon).h : 1;
  if (hero) {
    heroH = hasText ? innerC * (hero.size || 0.62) : innerC;
    heroGap = hasText ? innerC * 0.06 : 0;
    heroW = heroH * heroRatio;
  }
  let textC = Math.max(0.3, innerC - heroH - heroGap);

  // 줄별 크기(작게/중간/크게) 반영한 블록 높이 배율
  const blockFactor = lines.reduce((a, l, i) => a + l.k * (i < n - 1 ? lead : 1), 0);
  let fs;
  if (L.sizeMode === 'manual') {
    fs = L.sizePt * PT_MM;
    if (L.wrapMode === 'shrink' && fs * blockFactor > textC) fs = textC / blockFactor;
  } else {
    fs = L.wrapMode === 'grow' ? textC * 0.64 : (textC / blockFactor) * 0.64;
  }
  // 높이 늘림 모드: 필요한 만큼 테이프 폭 증가
  if (L.wrapMode === 'grow' && L.orientation !== 'square' && L.orientation !== 'free') {
    const need = fs * blockFactor;
    if (need > textC) {
      crossSize += need - textC;
      innerC += need - textC;
      textC = need;
    }
  }
  if (!hasText && hero) fs = 0.01;

  const flowLen = (line, f0) => {
    const gs = line.gs, f = f0 * line.k;
    if (!gs.length) return 0;
    if (vert) return gs.length * f * (1 + tr) - tr * f;
    let w = 0;
    for (const { g, st } of gs) w += m100(fontStrS(st, L, family, 100), g) / 100 * f * ws + tr * f;
    return w - tr * f;
  };

  // 흐름 방향 장식 (가로형 좌우 / 세로형 위아래): 단일 아이콘
  let flowDeco = flowDecoKeys.map(k => {
    const name = deco[k];
    if (!name) return null;
    const { w, h } = decoDims(L, family, name, vert);
    if (!w) return null;
    // 아이콘을 (교차 길이 × 교차 길이) 상자 안에 비율 유지로 맞춤. 글자는 높이 기준
    const box = (hero ? Math.min(heroH, innerC) : Math.min(innerC, baseC)) * 0.54 * (L.decoScale || 1);
    const cell = isTxtDeco(name) ? box * 0.75 / (vert ? w : h) : box / Math.max(w, h);
    const iw = w * cell, ih = h * cell;
    return { name, w: iw, h: ih, len: vert ? ih : iw };
  });
  const gap = (hero ? Math.min(heroH, innerC) : innerC) * 0.22;

  const compute = f => {
    const lens = lines.map(l => hasText || !hero ? flowLen(l, f) : 0);
    const textFlow = Math.max(0.1, ...lens);
    const decoLen = flowDeco.reduce((s, d) => s + (d ? d.len + gap : 0), 0);
    return { lens, textFlow, need: 2 * (fs0 + padF) + decoLen + Math.max(textFlow, heroW), decoLen };
  };
  let c = compute(fs);
  // 메인 그림 모드에서 양옆 장식이 들어갈 자리가 없으면 생략
  if (hero && fixedFlow && flowSize - 2 * (fs0 + padF) - c.decoLen < heroW * 0.8) {
    flowDeco = [null, null];
    c = compute(fs);
  }
  if (fixedFlow) {
    const avail = flowSize - 2 * (fs0 + padF) - c.decoLen;
    if (heroW > avail && avail > 0) { heroH *= avail / heroW; heroW = avail; }
    if (c.textFlow > avail && avail > 0) {
      fs *= avail / c.textFlow;
      c = compute(fs);
    }
  } else {
    flowSize = Math.max(c.need, crossSize * 0.9);
  }

  const wMm = vert ? crossSize : flowSize;
  const hMm = vert ? flowSize : crossSize;
  return { vert, lines, n, lead, tr, ws, fs, blockFactor, crossSize, flowSize, wMm, hMm, fs0, padF, padC, innerC, baseC,
    cdSize, cdGap, crossDecoKeys, flowDeco, gap, hero, heroH, heroW, heroGap, hasText, ...c, family };
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
  if (SPECIAL[L.frame]) {
    ctx.fillStyle = L.tapeColor;
    ctx.fillRect(0, 0, W, H);
    drawPattern(ctx, L.pattern, W, H, P, ink, false);
    ctx.save();
    ctx.scale(P, P); // 이후 mm 좌표로 그림
    SPECIAL[L.frame].draw(ctx, L, family, Y, P);
    ctx.restore();
    return { canvas: cv, wMm: Y.wMm, hMm: Y.hMm, layout: Y };
  }

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
    const { w, h } = decoDims(L, family, name, Y.vert);
    if (!w) return;
    const size = Y.cdSize; // 교차 방향 크기
    const along = Y.vert ? size * h / w : size * w / h; // 흐름 방향 길이
    const spacing = isTxtDeco(name) ? size * 0.35 : along * 0.7;
    const span = flowB - flowA;
    const count = L.decoRepeat ? Math.max(1, Math.floor((span + spacing) / (along + spacing))) : 1;
    const total = count * along + (count - 1) * spacing;
    let f = flowA + (span - total) / 2;
    const c0 = idx === 0 ? cStart : cEnd - size;
    for (let i = 0; i < count; i++) {
      const [x, y] = Y.vert ? xy(f, c0 + size) : xy(f, c0);
      const cellPx = (Y.vert ? size * P / w : size * P / h);
      drawDeco(ctx, L, family, name, x, y, cellPx, ink, Y.vert);
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
    const { w, h } = decoDims(L, family, d.name, Y.vert);
    const cellPx = (Y.vert ? d.w : d.h) * P / (Y.vert ? w : h);
    const [x, y] = Y.vert ? xy(f0, cc + d.w) : xy(f0, cc);
    drawDeco(ctx, L, family, d.name, x, y, cellPx, ink, Y.vert);
  };
  // 장식은 텍스트 블록 옆에 붙도록: 흐름 고정이면 영역 양 끝, 자동이면 자연스럽게 양 끝
  if (dStart) { drawFlowDeco(dStart, fA); fA += dStart.len + Y.gap; }
  if (dEnd) { drawFlowDeco(dEnd, fB - dEnd.len); fB -= dEnd.len + Y.gap; }
  const areaLen = fB - fA;

  // 메인 그림
  let tStart = cStart, tLen = innerC;
  if (Y.hero) {
    const { w, h } = iconSize(Y.hero.icon);
    const cellPx = snap(Y.heroH * P / h);
    const realW = w * cellPx / P, realH = h * cellPx / P;
    const top = Y.hero.textPos === 'top' && Y.hasText ? cEnd - Y.heroH : cStart;
    drawIcon(ctx, Y.hero.icon, (fA + (areaLen - realW) / 2) * P, (top + (Y.heroH - realH) / 2) * P, cellPx, ink);
    if (Y.hero.textPos === 'top') { tStart = cStart; tLen = top - Y.heroGap - cStart; }
    else { tStart = top + Y.heroH + Y.heroGap; tLen = cEnd - tStart; }
  }
  if (Y.hero && !Y.hasText) return { canvas: cv, wMm: Y.wMm, hMm: Y.hMm, layout: Y };

  const blockC = Y.fs * Y.blockFactor;
  const c0 = tStart + (tLen - blockC) / 2;
  ctx.textBaseline = 'middle';
  // 흐름(f)·교차(c) 좌표 사각형 채우기
  const rectFC = (f0, f1, ca, cb) => {
    if (Y.vert) ctx.fillRect((Y.crossSize - cb) * P, f0 * P, (cb - ca) * P, (f1 - f0) * P);
    else ctx.fillRect(f0 * P, ca * P, (f1 - f0) * P, (cb - ca) * P);
  };
  let acc = 0;
  Y.lines.forEach((line, i) => {
    const fsk = Y.fs * line.k, pxk = fsk * P;
    const cMid = c0 + acc + fsk / 2;
    acc += fsk * Y.lead;
    const gs = line.gs, len = Y.lens[i];
    let extra = 0, f;
    if (L.align === 'left') f = fA;
    else if (L.align === 'right') f = fA + (areaLen - len);
    else if (L.align === 'justify' && gs.length > 1) { extra = (areaLen - len) / (gs.length - 1); f = fA; }
    else f = fA + (areaLen - len) / 2;
    // 글자 위치 계산
    const pos = gs.map(({ g, st }, j) => {
      const adv = Y.vert ? fsk : m100(fontStrS(st, L, family, 100), g) / 100 * fsk * Y.ws;
      const step = j < gs.length - 1 ? Y.tr * fsk + extra : 0;
      const r = [f, adv, step];
      f += adv + Y.tr * fsk + extra;
      return r;
    });
    // 1) 텍스트 배경색
    ctx.fillStyle = ink;
    // 이어진 글자들은 사각형 하나로 칠함 (글자마다 따로 칠하면 경계에 흰 줄이 생김)
    for (let j = 0; j < gs.length; j++) {
      if (!gs[j].st.hl) continue;
      let e = j;
      while (e + 1 < gs.length && gs[e + 1].st.hl) e++;
      rectFC(pos[j][0] - fsk * 0.14, pos[e][0] + pos[e][1] + fsk * 0.14, cMid - fsk * 0.62, cMid + fsk * 0.62);
      j = e;
    }
    // 2) 글자
    let curFont = '';
    gs.forEach(({ g, st }, j) => {
      const fnt = fontStrS(st, L, family, pxk);
      if (fnt !== curFont) { ctx.font = fnt; curFont = fnt; }
      const col = st.pt || st.hl ? L.invColor || '#ffffff' : ink; // 포인트색 지정 글자 / 배경색 위 글자
      const hollow = st.hl ? ink : L.tapeColor;
      const [f0] = pos[j];
      if (Y.vert) { const [x, y] = xy(f0 + fsk / 2, cMid); glyph(ctx, g, x, y, 'center', Y.ws, st, col, hollow, pxk); }
      else { const [x, y] = xy(f0, cMid); glyph(ctx, g, x, y, 'left', Y.ws, st, col, hollow, pxk); }
    });
    // 3) 밑줄 / 취소선
    const th = Math.max(1, fsk * 0.07 * P) / P;
    gs.forEach(({ st }, j) => {
      if (!st.underline && !st.strike) return;
      const [f0, adv, step] = pos[j];
      ctx.fillStyle = st.pt || st.hl ? L.invColor || '#ffffff' : ink;
      const w = adv + (j < gs.length - 1 && (gs[j + 1].st.underline || gs[j + 1].st.strike) ? step : 0);
      if (!Y.vert) {
        if (st.underline) rectFC(f0, f0 + w, cMid + fsk * 0.46, cMid + fsk * 0.46 + th);
        if (st.strike) rectFC(f0, f0 + w, cMid - th / 2, cMid + th / 2);
      } else {
        if (st.underline) rectFC(f0, f0 + w, cMid - fsk * 0.56 - th, cMid - fsk * 0.56);
        if (st.strike) rectFC(f0, f0 + w, cMid - th / 2, cMid + th / 2);
      }
    });
  });

  return { canvas: cv, wMm: Y.wMm, hMm: Y.hMm, layout: Y };
}

const snap = c => c >= 1.5 ? Math.round(c) : Math.max(1, c);

// DECO 항목: 아이콘 이름 또는 'txt:글자' (직접 입력). 글자는 높이 100 단위로 잼 (세로형은 90° 눕힘)
export const isTxtDeco = n => typeof n === 'string' && n.startsWith('txt:');
function decoDims(L, family, name, vert) {
  if (!isTxtDeco(name)) return iconSize(name);
  const t = name.slice(4);
  if (!t.trim()) return { w: 0, h: 0 };
  if (vert) return { w: 100, h: 100 * graphemes(t).length }; // 세로형: 글자를 세워서 위→아래로
  return { w: Math.max(1, textW(boldStr(L, family, 100, 400), t, 100)), h: 100 };
}
function drawDeco(ctx, L, family, name, x, y, cellPx, color, vert) {
  if (!isTxtDeco(name)) return drawIcon(ctx, name, x, y, snap(cellPx), color);
  const fpx = 100 * cellPx;
  ctx.save();
  ctx.fillStyle = color; ctx.font = boldStr(L, family, fpx, 400);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if (vert) { ctx.textAlign = 'center'; graphemes(name.slice(4)).forEach((g, i) => ctx.fillText(g, x + fpx / 2, y + (i + 0.5) * fpx)); }
  else ctx.fillText(name.slice(4), x, y + fpx / 2);
  ctx.restore();
}

function glyph(ctx, g, x, y, align, ws, st, ink, hollow, fsPx) {
  ctx.save();
  ctx.translate(x, y);
  if (ws !== 1) ctx.scale(ws, 1);
  ctx.textAlign = align;
  if (st.outline) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, fsPx * 0.14);
    ctx.strokeStyle = ink;
    ctx.strokeText(g, 0, 0);
    ctx.fillStyle = hollow;
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
  else if (type === 'double') { rect(0); rect(lw * 2.5); }
  else rect(0);
}

function drawPattern(ctx, type, W, H, P, ink, vert) {
  if (!type || type === 'none') return;
  const u = 1.4 * P;
  ctx.save();
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  if (type === 'check') {
    ctx.globalAlpha = 0.055;
    for (let x = 0; x < W; x += u * 2) ctx.fillRect(Math.round(x), 0, Math.round(u), H);
    for (let y = 0; y < H; y += u * 2) ctx.fillRect(0, Math.round(y), W, Math.round(u));
  } else if (type === 'stripe') {
    ctx.globalAlpha = 0.07;
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

// =====================================================================
// 특수 프레임 (뮤직 플레이어 / 메신저). draw()는 mm 좌표계(ctx.scale(P))에서 그림.
// =====================================================================
function boldStr(L, family, size, weight = 700) {
  return `${L.italic ? 'italic ' : ''}${weight} ${size}px ${fontStack(family, L.emojiMono)}`;
}
function textW(font100, s, size) {
  let w = 0;
  for (const g of graphemes(s)) w += m100(font100, g);
  return w / 100 * size;
}
function iconAt(ctx, P, name, x, y, boxW, boxH, color) {
  const { w, h } = iconSize(name);
  if (!w) return;
  const cell = Math.min(boxW / w, boxH / h);
  const c0 = cell * P, c = c0 >= 2 ? Math.floor(c0) : c0; // 내림: 상자보다 커지지 않게
  const rw = w * c / P, rh = h * c / P;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawIcon(ctx, name, (x + (boxW - rw) / 2) * P, (y + (boxH - rh) / 2) * P, c, color);
  ctx.restore();
}
function rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fitText(ctx, s, x, y, maxW, font, size, align = 'left') {
  // maxW를 넘으면 가로로 눌러서 맞춤
  ctx.font = font;
  const w = ctx.measureText(s).width;
  ctx.save();
  ctx.translate(x, y);
  const k = w > maxW && w > 0 ? maxW / w : 1;
  ctx.scale(k, 1);
  ctx.textAlign = align;
  ctx.fillText(s, 0, 0);
  ctx.restore();
}

const MUSIC = {
  layout(L, family) {
    const H = L.tapeMm;
    const [title = '', artist = ''] = (L.text || '').split('\n');
    const pad = H * 0.09, cover = H * 0.36;
    const fT = H * 0.13, fA = H * 0.105;
    const textX = pad + cover + H * 0.07;
    const tw = Math.max(textW(boldStr(L, family, 100), title, fT), textW(boldStr(L, family, 100, 400), artist, fA));
    const need = textX + tw + H * 0.1 + H * 0.14 + pad;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(H * 2.3, need);
    return { special: 'music', wMm: W, hMm: H, title, artist, pad, cover, fT, fA, textX };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, pad, cover, fT, fA, textX } = Y;
    const ink = L.inkColor;
    const m = L.music || {};
    const lw = Math.max(1 / P, H * 0.012);
    ctx.fillStyle = ink; ctx.strokeStyle = ink;
    // 커버
    rrect(ctx, pad, pad, cover, cover, H * 0.035);
    ctx.save(); ctx.globalAlpha = 0.12; ctx.fill(); ctx.restore();
    ctx.lineWidth = lw; ctx.stroke();
    const icon = L.hero?.icon;
    if (icon) iconAt(ctx, P, icon, pad + cover * 0.1, pad + cover * 0.1, cover * 0.8, cover * 0.8, ink);
    else iconAt(ctx, P, 'note', pad + cover * 0.3, pad + cover * 0.3, cover * 0.4, cover * 0.4, ink);
    // 제목 / 아티스트
    const rightIcon = H * 0.14;
    const maxW = W - textX - pad - rightIcon - H * 0.06;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    fitText(ctx, Y.title, textX, pad + cover * 0.3, maxW, boldStr(L, family, fT), fT);
    ctx.save(); ctx.globalAlpha = 0.72;
    fitText(ctx, Y.artist, textX, pad + cover * 0.72, maxW, boldStr(L, family, fA, 400), fA);
    ctx.restore();
    // 음량 막대
    const bx = W - pad - rightIcon, by = pad + cover * 0.3;
    [0.35, 0.7, 1, 0.55, 0.8].forEach((v, i) => {
      const bh = rightIcon * 0.7 * v, bw = rightIcon / 9;
      ctx.save(); ctx.globalAlpha = 0.6;
      ctx.fillRect(bx + i * bw * 1.9, by - bh / 2, bw, bh);
      ctx.restore();
    });
    // 진행 바
    const py = H * 0.6, th = Math.max(1.2 / P, H * 0.028);
    const prog = Math.min(1, Math.max(0, m.progress ?? 0.8));
    ctx.save(); ctx.globalAlpha = 0.25; rrect(ctx, pad, py - th / 2, W - 2 * pad, th, th / 2); ctx.fill(); ctx.restore();
    rrect(ctx, pad, py - th / 2, (W - 2 * pad) * prog, th, th / 2); ctx.fill();
    // 시간
    const fTime = H * 0.075;
    ctx.save(); ctx.globalAlpha = 0.72;
    ctx.font = boldStr(L, family, fTime, 400);
    ctx.textAlign = 'left'; ctx.fillText(m.cur ?? '', pad, py + H * 0.085);
    ctx.textAlign = 'right'; ctx.fillText(m.remain ?? '', W - pad, py + H * 0.085);
    ctx.restore();
    // 컨트롤 ⏪ ❚❚ ⏩
    const cy = H * 0.84, cx = W / 2, s = H * 0.11;
    const bw = s * 0.32;
    ctx.fillRect(cx - bw * 1.4, cy - s * 0.62, bw, s * 1.24);
    ctx.fillRect(cx + bw * 0.4, cy - s * 0.62, bw, s * 1.24);
    const tri = (x, dir) => {
      ctx.beginPath();
      ctx.moveTo(x, cy - s / 2); ctx.lineTo(x + dir * s * 0.8, cy); ctx.lineTo(x, cy + s / 2); ctx.closePath(); ctx.fill();
    };
    const off = H * 0.42;
    tri(cx - off + s * 0.8, -1); tri(cx - off + s * 1.5, -1);
    tri(cx + off - s * 0.8, 1); tri(cx + off - s * 1.5, 1);
    // 오른쪽 아래 작은 아이콘
    iconAt(ctx, P, 'note', W - pad - H * 0.1, cy - H * 0.05, H * 0.1, H * 0.1, ink);
  },
};

// ---------- 공통 헬퍼 ----------
// 특수 프레임용 줄: { text, k(줄별 크기), gs: [{ g, st }] }
const linesOf = L => richLines(L);
const autoFs = (L, fit) => L.sizeMode === 'manual' ? L.sizePt * PT_MM : fit;
function lineW(L, family, line, fs) {
  const ws = (L.widthScale || 100) / 100, f = fs * line.k;
  let w = 0;
  for (const { g, st } of line.gs) w += m100(fontStrS(st, L, family, 100), g) / 100 * f * ws;
  return w;
}
function maxLineW(L, family, lines, fs) {
  return Math.max(0, ...lines.map(l => lineW(L, family, l, fs)));
}
// 배경색(hl) 위 글자색: 기본은 포인트색, 이미 포인트색으로 쓰는 중이면 잉크색. 포인트색 지정(pt) 글자는 항상 포인트색
const hlText = (L, base) => (base || '').toLowerCase() === (L.invColor || '#ffffff').toLowerCase() ? L.inkColor : (L.invColor || '#ffffff');
// 가로 한 줄 (글자별 스타일). 현재 ctx.fillStyle 을 글자색으로 씀. maxW 넘으면 가로로 눌러 맞춤
function txt(ctx, L, family, line, x, y, fs, align = 'left', maxW = Infinity) {
  const base = ctx.fillStyle, fsk = fs * line.k, gs = line.gs;
  const ws = (L.widthScale || 100) / 100;
  const advs = gs.map(({ g, st }) => m100(fontStrS(st, L, family, 100), g) / 100 * fsk * ws);
  const w = advs.reduce((a, b) => a + b, 0);
  const k = w > maxW && w > 0 ? maxW / w : 1;
  const x0 = align === 'center' ? x - w * k / 2 : align === 'right' ? x - w * k : x;
  const hc = hlText(L, base);
  ctx.save();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let f = x0;
  // 이어진 배경색 구간은 사각형 하나로 (경계 흰 줄 방지)
  ctx.fillStyle = base;
  let runStart = null;
  gs.forEach(({ st }, j) => {
    const a = advs[j] * k;
    if (st.hl && runStart == null) runStart = f;
    f += a;
    if (st.hl && (j === gs.length - 1 || !gs[j + 1].st.hl)) {
      ctx.fillRect(runStart - fsk * 0.14, y - fsk * 0.62, f - runStart + fsk * 0.28, fsk * 1.24);
      runStart = null;
    }
  });
  f = x0;
  gs.forEach(({ g, st }, j) => {
    const a = advs[j] * k, col = st.pt ? L.invColor || '#ffffff' : st.hl ? hc : base;
    ctx.font = fontStrS(st, L, family, fsk);
    ctx.save(); ctx.translate(f, y); ctx.scale(ws * k, 1);
    if (st.outline) {
      ctx.lineJoin = 'round'; ctx.lineWidth = fsk * 0.14; ctx.strokeStyle = col; ctx.strokeText(g, 0, 0);
      ctx.fillStyle = st.hl ? base : L.tapeColor; ctx.fillText(g, 0, 0);
    } else { ctx.fillStyle = col; ctx.fillText(g, 0, 0); }
    ctx.restore();
    if (st.underline || st.strike) {
      ctx.fillStyle = col;
      const t = fsk * 0.07, nx = j < gs.length - 1 && (gs[j + 1].st.underline || gs[j + 1].st.strike);
      if (st.underline) ctx.fillRect(f, y + fsk * 0.46, a + (nx ? 0.01 : 0), t);
      if (st.strike) ctx.fillRect(f, y - t / 2, a + (nx ? 0.01 : 0), t);
    }
    f += a;
  });
  ctx.restore();
  ctx.fillStyle = base;
}
// 세로쓰기 한 글자 (가운데 기준). step = 글자 간격
function vChar(ctx, L, family, { g, st }, x, y, fs, step = fs * 1.06, noBg = false) {
  const base = ctx.fillStyle;
  if (st.hl && !noBg) ctx.fillRect(x - fs * 0.62, y - step / 2 - 0.01, fs * 1.24, step + 0.02);
  ctx.font = fontStrS(st, L, family, fs);
  const col = st.pt ? L.invColor || '#ffffff' : st.hl ? hlText(L, base) : base;
  if (st.outline) {
    ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.14; ctx.strokeStyle = col; ctx.strokeText(g, x, y);
    ctx.fillStyle = st.hl ? base : L.tapeColor; ctx.fillText(g, x, y);
  } else { ctx.fillStyle = col; ctx.fillText(g, x, y); }
  ctx.fillStyle = col;
  if (st.underline) ctx.fillRect(x + fs * 0.56, y - step / 2, fs * 0.07, step);
  if (st.strike) ctx.fillRect(x - fs * 0.035, y - step / 2, fs * 0.07, step);
  ctx.fillStyle = base;
}
// 세로쓰기 여러 줄: 오른쪽 줄부터. cx = 가운데, top = 첫 글자 위
function vCols(ctx, L, family, cols, cx, top, fs, colStep, charStep) {
  const n = cols.length;
  const startX = cx + (n - 1) * colStep / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  cols.forEach((col, i) => {
    const f = fs * col.k, st = charStep * col.k, x = startX - i * colStep, gs = col.gs;
    // 배경색: 이어진 글자들은 사각형 하나로 먼저 칠함 (경계 흰 줄 방지)
    for (let a = 0; a < gs.length; a++) {
      if (!gs[a].st.hl) continue;
      let b = a;
      while (b + 1 < gs.length && gs[b + 1].st.hl) b++;
      ctx.fillRect(x - f * 0.62, top + a * st, f * 1.24, (b - a + 1) * st);
      a = b;
    }
    gs.forEach((ch, k) => vChar(ctx, L, family, ch, x, top + k * st + st / 2, f, st, true));
  });
}
function alignedX(L, x, w) {
  return L.align === 'left' ? [x, 'left'] : L.align === 'right' ? [x + w, 'right'] : [x + w / 2, 'center'];
}
function cloudPath(ctx, x, y, w, h, bump) {
  const nx = Math.max(2, Math.round(w / bump)), ny = Math.max(1, Math.round(h / bump));
  const dx = w / nx, dy = h / ny;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let i = 0; i < nx; i++) ctx.arc(x + (i + 0.5) * dx, y, dx / 2, Math.PI, Math.PI * 2);
  for (let j = 0; j < ny; j++) ctx.arc(x + w, y + (j + 0.5) * dy, dy / 2, -Math.PI / 2, Math.PI / 2);
  for (let i = 0; i < nx; i++) ctx.arc(x + w - (i + 0.5) * dx, y + h, dx / 2, 0, Math.PI);
  for (let j = 0; j < ny; j++) ctx.arc(x, y + h - (j + 0.5) * dy, dy / 2, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}
function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

/**
 * 말풍선 하나 그리기 (메신저/말풍선/캐릭터 말풍선 공통)
 *  st:   round(메신저형 심플) | corner(한쪽 모서리 뾰족) | cloud(구름)
 *  side: left(꼬리가 왼쪽) | right(좌우 반전)
 *  tail: corner(아래 모서리 뿔) | center(아래 가운데) | edge(옆면 가운데) | none
 */
function drawBubble(ctx, st, x, y, w, h, { side = 'left', tail = 'corner', tl, fill = '#ffffff', ink, lw, outline = true, radius }) {
  ctx.save();
  if (side === 'right') { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }
  const paint = () => {
    ctx.fillStyle = fill; ctx.fill();
    if (outline) { ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke(); }
  };
  if (st === 'cloud') {
    cloudPath(ctx, x, y, w, h, Math.max(h / 3, tl * 1.4));
    paint();
    const b = h / 6; // 구름 볼록한 정도
    if (tail === 'edge') {
      circle(ctx, x - b - tl * 0.3, y + h * 0.62, tl * 0.26); paint();
      circle(ctx, x - b - tl * 0.85, y + h * 0.72, tl * 0.15); paint();
    } else if (tail !== 'none') {
      const cx0 = tail === 'center' ? x + w * 0.45 : x + Math.min(w * 0.14, h * 0.5);
      circle(ctx, cx0, y + h + b + tl * 0.35, tl * 0.28); paint();
      circle(ctx, cx0 - tl * 0.5, y + h + b + tl * 0.9, tl * 0.16); paint();
    }
  } else {
    const r = Math.min(radius ?? (st === 'corner' ? h * 0.32 : h * 0.31), w / 2);
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    if (tail === 'center') {
      const c = x + w / 2;
      ctx.lineTo(c + tl * 0.55, y + h); ctx.lineTo(c - tl * 0.35, y + h + tl); ctx.lineTo(c - tl * 0.2, y + h);
    }
    if (st === 'corner') {
      ctx.lineTo(x, y + h);
    } else if (tail === 'corner') {
      // 레퍼런스 이미지 외곽선을 그대로 따라 그린 꼬리 (말풍선 높이 h 비율)
      ctx.lineTo(x + h * 0.24, y + h);
      ctx.quadraticCurveTo(x + h * 0.13, y + h, x + h * 0.11, y + h * 0.93);         // 작은 둥근 모서리 → 파인 곳 꼭대기
      ctx.quadraticCurveTo(x + h * 0.07, y + h, x - h * 0.02, y + h);                // 파인 곳 → 꼬리 아랫면
      ctx.quadraticCurveTo(x - h * 0.09, y + h, x - h * 0.13, y + h * 0.99);         // 꼬리 끝
      ctx.quadraticCurveTo(x - h * 0.02, y + h * 0.93, x, y + h * 0.8);              // 바깥 곡선 (얇게)
    } else {
      ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    }
    if (tail === 'edge') {
      ctx.lineTo(x, cy + tl * 0.4); ctx.lineTo(x - tl, cy + tl * 0.15); ctx.lineTo(x, cy - tl * 0.25);
    }
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    paint();
  }
  ctx.restore();
}

// ---------- 메신저 ----------
const MESSENGER = {
  layout(L, family) {
    const fs = L.sizeMode === 'manual' ? L.sizePt * PT_MM : L.tapeMm * 0.26;
    const st = L.bubble?.style || 'round';
    const lines = linesOf(L).filter(l => l.text.trim().length);
    const bpx = fs * 0.6, bpy = fs * 0.36, tail = fs * 0.4, padM = fs * 0.55;
    const gap = fs * (st === 'cloud' ? 0.85 : 0.35);
    const bh = fs + 2 * bpy;
    const widths = lines.map(l => lineW(L, family, l, fs) + 2 * bpx);
    const maxB = Math.max(fs * 2, ...widths);
    const n = Math.max(1, lines.length);
    const extra = st === 'cloud' ? bh / 6 : 0;
    const contentH = n * bh + (n - 1) * gap + 2 * extra;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(L.tapeMm * 2, 2 * padM + 2 * tail + maxB + fs * 2.2);
    const H = Math.max(L.tapeMm, contentH + 2 * padM + (st === 'cloud' ? tail : 0));
    return { special: 'messenger', wMm: W, hMm: H, fs, st, lines, widths, bpx, bpy, tail, gap, padM, bh, contentH, extra };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, fs, st, lines, widths, bpx, tail, gap, padM, bh, contentH, extra } = Y;
    const ink = L.inkColor;
    const startRight = L.messenger?.start === 'right';
    const lw = Math.max(1 / P, fs * 0.07);
    let y = (H - contentH) / 2 + extra;
    lines.forEach((line, i) => {
      const right = (i % 2 === 1) !== startRight;
      const bw = Math.min(widths[i], W - 2 * padM - 2 * tail);
      const x = right ? W - padM - tail - bw - extra : padM + tail + extra;
      drawBubble(ctx, st, x, y, bw, bh, {
        side: right ? 'right' : 'left', tail: st === 'corner' ? 'none' : 'corner', tl: tail,
        fill: right ? ink : '#ffffff', ink, lw, outline: !right,
      });
      ctx.fillStyle = right ? L.tapeColor : ink;
      txt(ctx, L, family, line, x + bpx, y + bh / 2, fs, 'left', bw - 2 * bpx);
      y += bh + gap;
    });
  },
};

// ---------- 도그태그 (가로 / 세로) ----------
const DOGTAG = {
  layout(L, family) {
    const vert = L.orientation === 'v';
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, pad = T * 0.12, hole = T * 0.11;
    if (vert) {
      const maxC = Math.max(1, ...lines.map(c => c.gs.length * c.k));
      let fs = autoFs(L, (T - 2 * pad - T * 0.1) / (1 + (n - 1) * lead) * 0.75);
      fs = Math.min(fs, (T - 2 * pad) / (1 + (n - 1) * lead));
      const textTop = pad + hole + T * 0.24;
      const charStep = fs * (1.05 + (L.tracking || 0) / 100);
      const H = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.8, textTop + maxC * charStep + pad * 1.8);
      return { special: 'dogtag', vert, wMm: T, hMm: H, cols: lines, n, fs, lead, pad, hole, textTop, charStep, T };
    }
    let fs = autoFs(L, Math.min((T - 2 * pad - T * 0.08) / (n * lead), T * 0.24) * 0.85);
    if (L.wrapMode !== 'grow') fs = Math.min(fs, (T - 2 * pad) / (n * lead));
    const H = Math.max(T, n * fs * lead + 2 * pad + T * 0.08);
    const textX = pad + hole + T * 0.24;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.8, textX + maxLineW(L, family, lines, fs) + pad * 1.8);
    return { special: 'dogtag', vert, wMm: W, hMm: H, lines, n, fs, lead, pad, hole, textX, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, n, fs, lead, pad, hole, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.016), d = T * 0.05;
    // 도그태그 외곽: 위아래 직선 + 양옆이 볼록한 곡선 (세로형은 90° 회전)
    const tagPath = (x, y, w, h) => {
      const c = h * 0.2;
      ctx.beginPath();
      ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y);
      ctx.bezierCurveTo(x + w - c * 0.15, y, x + w, y + h * 0.22, x + w, y + h / 2);
      ctx.bezierCurveTo(x + w, y + h * 0.78, x + w - c * 0.15, y + h, x + w - c, y + h);
      ctx.lineTo(x + c, y + h);
      ctx.bezierCurveTo(x + c * 0.15, y + h, x, y + h * 0.78, x, y + h / 2);
      ctx.bezierCurveTo(x, y + h * 0.22, x + c * 0.15, y, x + c, y);
      ctx.closePath();
    };
    ctx.save();
    if (Y.vert) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); tagPath(d, d, H - 2 * d, W - 2 * d); }
    else tagPath(d, d, W - 2 * d, H - 2 * d);
    ctx.restore();
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke();
    const hx = Y.vert ? W / 2 : pad + hole / 2 + T * 0.07;
    const hy = Y.vert ? pad + hole / 2 + T * 0.07 : H / 2;
    circle(ctx, hx, hy, hole / 2);
    ctx.lineWidth = lw; ctx.stroke();
    const emboss = (draw) => {
      ctx.save(); ctx.globalAlpha = 0.6; ctx.fillStyle = '#ffffff'; draw(fs * 0.06); ctx.restore();
      ctx.fillStyle = ink; draw(0);
    };
    if (Y.vert) {
      emboss(o => vCols(ctx, L, family, Y.cols, W / 2 + o, Y.textTop + o, fs, fs * lead, Y.charStep));
      return;
    }
    const y0 = (H - n * fs * lead) / 2 + fs * lead / 2, maxW = W - Y.textX - pad;
    emboss(o => Y.lines.forEach((l, i) => txt(ctx, L, family, l, Y.textX + o, y0 + i * fs * lead + o, fs, 'left', maxW)));
  },
};

// ---------- 원고지 (가로 / 세로) ----------
const WONGOJI = {
  layout(L) {
    const vert = L.orientation === 'v';
    const lines = linesOf(L), n = Math.max(1, lines.length);
    const cols = Math.max(1, ...lines.map(l => l.gs.length));
    const T = L.tapeMm, pad = T * 0.07, g = 0.3;
    let cell = L.wrapMode === 'grow' ? (T - 2 * pad) / (1 + 2 * g) : (T - 2 * pad) / (n + (n + 1) * g);
    if (L.lengthMode === 'fixed') cell = Math.min(cell, (L.lengthMm - 2 * pad) / (cols + 2 * g));
    const cross = L.wrapMode === 'grow' ? Math.max(T, 2 * pad + cell * (n + (n + 1) * g)) : T;
    const flow = L.lengthMode === 'fixed' ? L.lengthMm : 2 * pad + cell * (cols + 2 * g);
    return { special: 'wongoji', vert, wMm: vert ? cross : flow, hMm: vert ? flow : cross, lines, n, cols, cell, g };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, cols, cell, g, vert } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, cell * 0.035);
    // 가로: 줄 = 행, 세로: 줄 = 오른쪽부터 열
    const along = cols * cell, across = n * cell + (n + 1) * g * cell;
    const gw = vert ? across : along, gh = vert ? along : across;
    const x0 = (W - gw) / 2, y0 = (H - gh) / 2;
    const cellXY = (i, c) => vert
      ? [x0 + gw - g * cell - (i + 1) * cell - i * g * cell, y0 + c * cell]
      : [x0 + c * cell, y0 + g * cell + i * cell * (1 + g)];
    // 배경색 칸 먼저
    ctx.fillStyle = ink;
    lines.forEach((l, i) => l.gs.forEach(({ st }, c) => { if (st.hl) { const [cx, cy] = cellXY(i, c); ctx.fillRect(cx, cy, cell, cell); } }));
    ctx.strokeStyle = ink;
    ctx.lineWidth = lw * 1.7;
    if (vert) ctx.strokeRect(x0, y0 - g * cell, gw, gh + 2 * g * cell);
    else ctx.strokeRect(x0 - g * cell, y0, gw + 2 * g * cell, gh);
    ctx.save(); ctx.globalAlpha = 0.75; ctx.lineWidth = lw;
    for (let i = 0; i < n; i++) {
      const [sx, sy] = cellXY(i, 0);
      ctx.strokeRect(sx, sy, vert ? cell : along, vert ? along : cell);
      ctx.beginPath();
      for (let c = 1; c < cols; c++) {
        if (vert) { ctx.moveTo(sx, sy + c * cell); ctx.lineTo(sx + cell, sy + c * cell); }
        else { ctx.moveTo(sx + c * cell, sy); ctx.lineTo(sx + c * cell, sy + cell); }
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    lines.forEach((l, i) => l.gs.forEach(({ g: ch, st }, c) => {
      const [cx, cy] = cellXY(i, c);
      ctx.fillStyle = ink;
      vChar(ctx, L, family, { g: ch, st: { ...st, hl: false } }, cx + cell / 2, cy + cell * 0.53, cell * 0.68 * l.k, cell * 0.9);
      if (st.hl) { // 칠한 칸 위 글자
        ctx.fillStyle = L.invColor || '#ffffff';
        ctx.font = fontStrS(st, L, family, cell * 0.68 * l.k);
        ctx.fillText(ch, cx + cell / 2, cy + cell * 0.53);
      }
    }));
  },
};

// 말풍선 채우기 옵션: 안쪽을 잉크색으로 칠하면 글자는 반전 글씨색
const bubbleColors = L => L.bubble?.fill
  ? { fill: L.inkColor, text: L.invColor || '#ffffff' }
  : { fill: '#ffffff', text: L.inkColor };

// ---------- 말풍선 (일반) ----------
const BUBBLE = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, st = L.bubble?.style || 'round';
    const tailMode = st === 'corner' ? 'none' : (st === 'round' && L.bubble?.tail === 'center' ? 'center' : 'corner');
    const tl = T * 0.17;
    const tailH = tailMode === 'center' || (st === 'cloud' && tailMode !== 'none') ? tl : 0; // 아래로 튀어나오는 꼬리만 여백
    const pad = T * 0.08, m = st === 'cloud' ? T * 0.07 : 0;
    const bodyH0 = T - 2 * pad - tailH - 2 * m;
    let fs = autoFs(L, bodyH0 / (n * lead + 0.8) * 0.9);
    if (L.wrapMode !== 'grow') fs = Math.min(fs, bodyH0 / (n * lead + 0.8));
    const bodyH = Math.max(bodyH0, fs * (n * lead + 0.8));
    const H = bodyH + 2 * pad + tailH + 2 * m;
    const bx = fs * 0.8;
    const sideRoom = tailMode === 'corner' && st === 'round' ? tl * 0.6 : 0;
    const bodyW = L.lengthMode === 'fixed' ? L.lengthMm - 2 * pad - 2 * m - sideRoom : Math.max(maxLineW(L, family, lines, fs) + 2 * bx, bodyH * 1.2);
    return { special: 'bubble', wMm: bodyW + 2 * pad + 2 * m + sideRoom, hMm: H, lines, n, lead, fs, pad, tl, m, bodyW, bodyH, bx, st, tailMode, sideRoom, T };
  },
  draw(ctx, L, family, Y, P) {
    const { lines, n, lead, fs, pad, tl, m, bodyW, bodyH, bx, st, tailMode, sideRoom, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.014), c = bubbleColors(L);
    const x = pad + m + sideRoom, y = pad + m;
    drawBubble(ctx, st, x, y, bodyW, bodyH, { tail: tailMode, tl, ink, lw, fill: c.fill });
    ctx.fillStyle = c.text;
    const y0 = y + (bodyH - n * fs * lead) / 2 + fs * lead / 2;
    const [tx, al] = alignedX(L, x + bx, bodyW - 2 * bx);
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, bodyW - 2 * bx));
  },
};

// ---------- 말풍선 (캐릭터가 말하는) ----------
const BUBBLE2 = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, st = L.bubble?.style || 'round';
    const bleed = !!L.bubble?.bleed;
    const pad = T * 0.08, m = st === 'cloud' ? T * 0.07 : 0, tail = st === 'corner' ? T * 0.05 : T * 0.14;
    const icon = L.hero?.icon || 'bear';
    const { w, h } = iconSize(icon);
    const box = T * (bleed ? 0.62 : 0.58);
    const cell = Math.min(box / (w || 1), box / (h || 1));
    const iconW = (w || 1) * cell, iconH = (h || 1) * cell;
    const bodyH0 = bleed ? T - 2 * pad : T - 2 * pad - 2 * m - T * 0.1;
    let fs = autoFs(L, bodyH0 / (n * lead + 0.8) * 0.9);
    if (L.wrapMode !== 'grow') fs = Math.min(fs, bodyH0 / (n * lead + 0.8));
    const bodyH = Math.max(bodyH0, fs * (n * lead + 0.8));
    const H = bleed ? bodyH + 2 * pad : bodyH + 2 * pad + 2 * m + T * 0.1;
    const bx = fs * 0.8;
    const near = pad + iconW + T * 0.05 + tail + m; // 캐릭터 쪽 말풍선 가장자리 위치
    const textW_ = maxLineW(L, family, lines, fs) + 2 * bx;
    const bodyW = L.lengthMode === 'fixed' ? L.lengthMm - near - m - pad : Math.max(textW_, bodyH * 1.2);
    const W = bleed ? near + bodyW : near + bodyW + m + pad;
    return { special: 'bubble2', wMm: W, hMm: H, lines, n, lead, fs, pad, m, tail, icon, iconW, iconH, near, bodyW, bodyH, bx, st, bleed, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, pad, m, tail, icon, iconW, iconH, near, bodyW, bodyH, bx, st, bleed, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.014), c = bubbleColors(L);
    const right = L.bubble?.charSide === 'right';
    const mx = (x, w) => right ? W - x - w : x; // 캐릭터 오른쪽이면 좌우 반전
    const iy = bleed ? (H - iconH) / 2 : H - pad - iconH;
    iconAt(ctx, P, icon, mx(pad, iconW), iy, iconW, iconH, ink);
    if (bleed) {
      // 말풍선이 라벨 위·아래·바깥쪽 끝 밖으로 빠져나가 잘린 모양 (캐릭터 쪽 가장자리와 꼬리만 보임)
      const over = T * 0.35;
      const drawW = bodyW + T;
      drawBubble(ctx, st, mx(near, drawW), -over, drawW, H + 2 * over, {
        side: right ? 'right' : 'left', tail: st === 'corner' ? 'none' : 'edge', tl: tail, ink, lw, radius: (H + 2 * over) * 0.32, fill: c.fill,
      });
    } else {
      drawBubble(ctx, st, mx(near, bodyW), pad + m, bodyW, bodyH, {
        side: right ? 'right' : 'left', tail: st === 'corner' ? 'none' : 'corner', tl: tail, ink, lw, fill: c.fill,
      });
    }
    ctx.fillStyle = c.text;
    const y = bleed ? pad : pad + m;
    const y0 = y + (bodyH - n * fs * lead) / 2 + fs * lead / 2;
    const [tx, al] = alignedX(L, mx(near, bodyW) + bx, bodyW - 2 * bx);
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, bodyW - 2 * bx));
  },
};

// ---------- 수첩 (가로: 위쪽 스프링 / 세로: 오른쪽 스프링 + 세로쓰기) ----------
const NOTEBOOK = {
  layout(L, family) {
    const vert = L.orientation === 'v';
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, pad = T * 0.08, ring = T * 0.16;
    const area0 = T - pad - ring - pad * 1.2;
    if (vert) {
      let fs = autoFs(L, area0 / (1 + (n - 1) * lead) * 0.78);
      if (L.wrapMode !== 'grow') fs = Math.min(fs, area0 / (1 + (n - 1) * lead));
      const charStep = fs * (1.05 + (L.tracking || 0) / 100);
      const maxC = Math.max(1, ...lines.map(c => c.gs.length * c.k));
      const by = Math.max(fs * 0.9, T * 0.12);
      const H = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.6, 2 * pad + 2 * by + maxC * charStep);
      return { special: 'notebook', vert, wMm: T, hMm: H, lines, n, lead, fs, pad, ring, by, charStep, maxC, T };
    }
    let fs = autoFs(L, area0 / (n * lead) * 0.78);
    if (L.wrapMode !== 'grow') fs = Math.min(fs, area0 / (n * lead));
    const areaH = Math.max(area0, n * fs * lead / 0.9);
    const H = areaH + pad + ring + pad * 1.2;
    const bx = Math.max(fs * 0.9, T * 0.12);
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.6, 2 * pad + 2 * bx + maxLineW(L, family, lines, fs));
    return { special: 'notebook', vert, wMm: W, hMm: H, lines, n, lead, fs, pad, ring, areaH, bx, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, pad, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.016);
    ctx.strokeStyle = ink; ctx.lineWidth = lw;
    ctx.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
    // 스프링 구멍 + 고리 (가로: 위쪽 / 세로: 오른쪽)
    const len = Y.vert ? H : W;
    const step = T * 0.16;
    const count = Math.max(2, Math.floor((len - 2 * pad - step * 0.6) / step));
    const span = (count - 1) * step;
    ctx.fillStyle = ink;
    for (let i = 0; i < count; i++) {
      const r = len / 2 - span / 2 + i * step;
      if (Y.vert) {
        circle(ctx, W - pad - T * 0.1, r, T * 0.034); ctx.fill();
        ctx.fillRect(W - pad - T * 0.1, r - lw / 2, T * 0.1, lw);
      } else {
        circle(ctx, r, pad + T * 0.1, T * 0.034); ctx.fill();
        ctx.fillRect(r - lw / 2, pad, lw, T * 0.1);
      }
    }
    ctx.fillStyle = ink;
    if (Y.vert) {
      const left = pad, right = W - pad - T * 0.16;
      const textH = Y.maxC * Y.charStep;
      vCols(ctx, L, family, lines, (left + right) / 2, (H - textH) / 2, fs, fs * lead, Y.charStep);
      return;
    }
    const bx = Y.bx;
    const areaTop = pad + T * 0.16, areaBot = H - pad;
    const y0 = areaTop + (areaBot - areaTop - n * fs * lead) / 2 + fs * lead / 2;
    const [tx, al] = alignedX(L, pad + bx, W - 2 * pad - 2 * bx);
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, W - 2 * pad - 2 * bx));
  },
};

// ---------- 레이스 (가로: 위아래 / 세로: 좌우 + 세로쓰기) ----------
// 가장자리(y=0)에서 안쪽(y=band)으로 레이스 한 줄. x = 길이 방향
// 바깥은 곧은 띠, 안쪽은 둥근 물결. 물결마다 하트 구멍 + 테두리 따라 작은 구멍
function heartPath(p, cx, cy, s) {
  const w = s / 2, h = s * 0.88, t = cy - h * 0.45;
  p.moveTo(cx, t + h * 0.25);
  p.bezierCurveTo(cx, t, cx - w, t, cx - w, t + h * 0.3);
  p.bezierCurveTo(cx - w, t + h * 0.6, cx, t + h * 0.75, cx, t + h);
  p.bezierCurveTo(cx, t + h * 0.75, cx + w, t + h * 0.6, cx + w, t + h * 0.3);
  p.bezierCurveTo(cx + w, t, cx, t, cx, t + h * 0.25);
  p.closePath();
}
function laceBand(ctx, len, band, color) {
  const st = band * 0.3; // 바깥 띠 두께
  const depth = band - st;
  const cnt = Math.max(2, Math.round(len / (2 * depth)));
  const r = len / cnt / 2, k = depth / r; // k: 물결 세로/가로 비율
  const p = new Path2D();
  p.moveTo(0, 0); p.lineTo(len, 0); p.lineTo(len, st);
  for (let i = cnt - 1; i >= 0; i--) p.ellipse((2 * i + 1) * r, st, r, r * k, 0, 0, Math.PI);
  p.closePath();
  const dr = r * 0.075;
  for (let i = 0; i < cnt; i++) {
    const cx = (2 * i + 1) * r;
    for (let j = 0; j < 7; j++) {
      const a = Math.PI * (0.08 + 0.84 * j / 6);
      const x = cx + Math.cos(a) * r * 0.78, y = st + Math.sin(a) * r * k * 0.78;
      p.moveTo(x + dr, y); p.arc(x, y, dr, 0, Math.PI * 2);
    }
    heartPath(p, cx, st + r * k * 0.3, r * 0.46);
  }
  ctx.fillStyle = color;
  ctx.fill(p, 'evenodd');
}
const LACE = {
  layout(L, family) {
    const vert = L.orientation === 'v';
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, band = T * 0.2, pad = T * 0.05;
    const area0 = T - 2 * band - 2 * pad;
    if (vert) {
      let fs = autoFs(L, area0 / (1 + (n - 1) * lead) * 0.8);
      if (L.wrapMode !== 'grow') fs = Math.min(fs, area0 / (1 + (n - 1) * lead));
      const charStep = fs * (1.05 + (L.tracking || 0) / 100);
      const maxC = Math.max(1, ...lines.map(c => c.gs.length * c.k));
      const H = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.5, maxC * charStep + T * 0.3);
      return { special: 'lace', vert, wMm: T, hMm: H, lines, n, lead, fs, band, charStep, maxC, T };
    }
    let fs = autoFs(L, area0 / (n * lead) * 0.85);
    if (L.wrapMode !== 'grow') fs = Math.min(fs, area0 / (n * lead));
    const areaH = Math.max(area0, n * fs * lead);
    const H = areaH + 2 * band + 2 * pad;
    const bx = T * 0.15;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.5, maxLineW(L, family, lines, fs) + 2 * bx);
    return { special: 'lace', vert, wMm: W, hMm: H, lines, n, lead, fs, band, bx, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, band, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.012);
    const sides = Y.vert
      ? [[0, 1, 1, 0, 0, 0], [0, 1, -1, 0, W, 0]] // 왼쪽 / 오른쪽
      : [[1, 0, 0, 1, 0, 0], [1, 0, 0, -1, 0, H]]; // 위 / 아래
    sides.forEach(m => { ctx.save(); ctx.transform(...m); laceBand(ctx, Y.vert ? H : W, band, ink); ctx.restore(); });
    ctx.fillStyle = ink;
    if (Y.vert) {
      const textH = Y.maxC * Y.charStep;
      vCols(ctx, L, family, lines, W / 2, (H - textH) / 2, fs, fs * lead, Y.charStep);
      return;
    }
    const y0 = (H - n * fs * lead) / 2 + fs * lead / 2;
    const [tx, al] = alignedX(L, Y.bx, W - 2 * Y.bx);
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, W - 2 * Y.bx));
  },
};

// ---------- 바탕화면 아이콘 ("절대 바이러스 아닙니다") ----------
const VIRUS = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, pad = T * 0.07;
    const ic = T * 0.42, gap = T * 0.035;
    let fs = autoFs(L, T * 0.1);
    const bx = fs * 0.35, by = fs * 0.25;
    const maxBox = T * 1.6 - 2 * pad;
    let tw = maxLineW(L, family, lines, fs);
    if (L.sizeMode !== 'manual' && tw + 2 * bx > maxBox) { fs *= (maxBox - 2 * bx) / tw; tw = maxLineW(L, family, lines, fs); }
    const boxW = Math.max(ic * 1.2, tw + 2 * bx), boxH = n * fs * lead + 2 * by;
    const W = Math.max(T, boxW + 2 * pad);
    const H = pad + ic + gap + boxH + pad;
    return { special: 'virus', wMm: W, hMm: H, lines, n, lead, fs, pad, ic, gap, bx, by, boxW, boxH, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, lines, n, lead, fs, pad, ic, gap, boxW, boxH, T } = Y;
    const ink = L.inkColor, inv = L.invColor || '#ffffff';
    const ix = (W - ic) / 2, iy = pad;
    // 아이콘 그림: 사진 > DECO 아이콘 > 기본
    const im = L.photo ? getImg(L.photo) : null;
    if (im) {
      const s = Math.max(ic / im.naturalWidth, ic / im.naturalHeight);
      const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
      ctx.save(); ctx.beginPath(); ctx.rect(ix, iy, ic, ic); ctx.clip();
      ctx.drawImage(im, ix + (ic - dw) / 2, iy + (ic - dh) / 2, dw, dh);
      ctx.restore();
    } else {
      iconAt(ctx, P, L.hero?.icon || 'face', ix, iy, ic, ic, ink);
    }
    // 바로가기 화살표 배지
    const b = ic * 0.3, bx0 = ix - b * 0.05, by0 = iy + ic - b * 0.95;
    const lw = Math.max(1 / P, b * 0.07);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(bx0, by0, b, b);
    ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = lw * 0.8; ctx.strokeRect(bx0, by0, b, b);
    ctx.strokeStyle = '#111111'; ctx.lineWidth = lw * 1.5; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx0 + b * 0.28, by0 + b * 0.8);
    ctx.quadraticCurveTo(bx0 + b * 0.3, by0 + b * 0.35, bx0 + b * 0.68, by0 + b * 0.32);
    ctx.stroke();
    ctx.fillStyle = '#111111';
    ctx.beginPath();
    ctx.moveTo(bx0 + b * 0.82, by0 + b * 0.3); ctx.lineTo(bx0 + b * 0.56, by0 + b * 0.14); ctx.lineTo(bx0 + b * 0.58, by0 + b * 0.5);
    ctx.closePath(); ctx.fill();
    ctx.lineCap = 'butt';
    // 이름 칸 (선택된 아이콘처럼 칠해진 상자)
    const tx0 = (W - boxW) / 2, ty0 = iy + ic + gap;
    ctx.fillStyle = ink; ctx.fillRect(tx0, ty0, boxW, boxH);
    ctx.fillStyle = inv;
    const y0 = ty0 + (boxH - n * fs * lead) / 2 + fs * lead / 2;
    lines.forEach((l, i) => txt(ctx, L, family, l, W / 2, y0 + i * fs * lead, fs, 'center', boxW - Y.bx * 2));
  },
};

// ---------- 강조 말풍선 (삐죽삐죽) ----------
const BURST = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, pad = T * 0.05;
    let ryO = (T / 2 - pad) / 1.12;
    let fs = autoFs(L, ryO * 0.72 * 1.5 / (n * lead));
    const blockH = n * fs * lead;
    ryO = Math.max(ryO, blockH / 2 / 0.72 / 0.75);
    const tw = maxLineW(L, family, lines, fs);
    const rxO = Math.max((tw / 2 + fs * 0.6) / 0.72, ryO * 1.5);
    const H = Math.max(T, 2 * ryO * 1.12 + 2 * pad);
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.4, 2 * rxO * 1.12 + 2 * pad);
    return { special: 'burst', wMm: W, hMm: H, lines, n, lead, fs, rxO, ryO, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, ryO, T } = Y;
    const rxO = Math.min(Y.rxO, (W / 2 - T * 0.05) / 1.12);
    const cx = W / 2, cy = H / 2;
    const per = Math.PI * (rxO + ryO);
    const N = Math.max(14, Math.min(40, Math.round(per / (T * 0.13))));
    const rnd = i => { const v = Math.sin(i * 12.9898 + 4.1) * 43758.5453; return v - Math.floor(v); };
    ctx.beginPath();
    for (let i = 0; i < N * 2; i++) {
      const a = (i + (rnd(i + 99) - 0.5) * 0.35) / (N * 2) * Math.PI * 2 - Math.PI / 2;
      const f = i % 2 === 0 ? 1 + (rnd(i) - 0.5) * 0.22 : 0.74 + (rnd(i) - 0.5) * 0.06;
      const x = cx + Math.cos(a) * rxO * f, y = cy + Math.sin(a) * ryO * f;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = L.inkColor; ctx.fill();
    ctx.lineJoin = 'miter';
    ctx.fillStyle = L.invColor || '#ffffff';
    const y0 = cy - n * fs * lead / 2 + fs * lead / 2;
    const maxW = rxO * 0.72 * 2 - fs * 0.6;
    lines.forEach((l, i) => txt(ctx, L, family, l, cx, y0 + i * fs * lead, fs, 'center', maxW));
  },
};

// ---------- 오마모리 (세로) ----------
const OMAMORI = {
  layout(L, family) {
    if (L.omamori?.style === 'charm') return OMAMORI2.layout(L, family);
    const cols = linesOf(L), n = Math.max(1, cols.length);
    const maxC = Math.max(1, ...cols.map(c => c.gs.length * c.k));
    const T = L.tapeMm, pad = T * 0.1, knot = T * 0.42, inset = T * 0.1;
    const innerW = T - 2 * pad - 2 * inset;
    const lead = Math.max(1, L.leading);
    let fs = autoFs(L, innerW / (1 + (n - 1) * lead) * 0.78);
    fs = Math.min(fs, innerW * 0.8 / (1 + (n - 1) * lead));
    const colStep = fs * lead;
    const charStep = fs * (1.06 + (L.tracking || 0) / 100);
    const charm = T * 0.3;
    const bodyTop = pad + knot;
    const textH = maxC * charStep;
    const H = L.lengthMode === 'fixed' ? L.lengthMm : bodyTop + inset + T * 0.14 + textH + T * 0.12 + charm + inset + pad;
    return { special: 'omamori', wMm: T, hMm: H, cols, n, fs, colStep, charStep, pad, knot, inset, charm, bodyTop, textH, T };
  },
  draw(ctx, L, family, Y, P) {
    if (Y.style2) return OMAMORI2.draw(ctx, L, family, Y, P);
    const { wMm: W, hMm: H, cols, n, fs, colStep, charStep, pad, knot, inset, charm, bodyTop, textH, T } = Y;
    const ink = L.inkColor;
    const { x, y, h, cx } = omamoriShell(ctx, W, H, pad, knot, bodyTop, T, ink, P);
    // 세로 글자 (오른쪽 줄부터)
    const top = y + inset + T * 0.14;
    const avail = h - inset * 2 - T * 0.26 - charm;
    const off = Math.max(0, (avail - textH) / 2);
    ctx.fillStyle = ink;
    vCols(ctx, L, family, cols, cx, top + off, fs, colStep, charStep);
    // 아래 부적 장식
    const icon = L.hero?.icon || 'clover';
    iconAt(ctx, P, icon, cx - charm / 2, y + h - inset - T * 0.06 - charm, charm, charm, ink);
  },
};

// 오마모리 공통: 주머니 + 매듭
function omamoriShell(ctx, W, H, pad, knot, bodyTop, T, ink, P) {
  const lw = Math.max(1 / P, T * 0.016);
  const x = pad, y = bodyTop, w = W - 2 * pad, h = H - pad - bodyTop, c = w * 0.22;
  const pouch = d => {
    ctx.beginPath();
    ctx.moveTo(x + d + c, y + d); ctx.lineTo(x + w - d - c, y + d); ctx.lineTo(x + w - d, y + d + c);
    ctx.lineTo(x + w - d, y + h - d); ctx.lineTo(x + d, y + h - d); ctx.lineTo(x + d, y + d + c); ctx.closePath();
  };
  ctx.strokeStyle = ink; ctx.lineJoin = 'round';
  pouch(0); ctx.lineWidth = lw * 1.4; ctx.stroke();
  pouch(T * 0.06); ctx.lineWidth = lw; ctx.stroke();
  const cx = W / 2, ky = pad + knot * 0.42;
  ctx.lineWidth = lw * 1.2;
  ctx.beginPath(); ctx.ellipse(cx - T * 0.11, ky, T * 0.1, T * 0.06, -0.3, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(cx + T * 0.11, ky, T * 0.1, T * 0.06, 0.3, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - T * 0.02, ky); ctx.lineTo(cx - T * 0.06, y + T * 0.02);
  ctx.moveTo(cx + T * 0.02, ky); ctx.lineTo(cx + T * 0.06, y + T * 0.02);
  ctx.stroke();
  circle(ctx, cx, ky, T * 0.045); ctx.fillStyle = ink; ctx.fill();
  return { x, y, w, h, cx };
}

// 오마모리 2: 가운데 큰 그림 + 아래 가로 글씨
const OMAMORI2 = {
  layout(L, family) {
    const lines = linesOf(L).filter((l, i, a) => l.text.length || a.length === 1), n = Math.max(1, lines.length);
    const T = L.tapeMm, pad = T * 0.1, knot = T * 0.42, inset = T * 0.12;
    const innerW = T - 2 * pad - 2 * inset;
    const lead = Math.max(1, L.leading);
    const hasText = lines.some(l => l.text.trim());
    const icon = L.hero?.icon || 'clover';
    const { w, h } = iconSize(icon);
    const imgW = innerW * 0.9, imgH = (w && h) ? Math.min(imgW * h / w, innerW * 1.3) : imgW;
    let fs = autoFs(L, innerW * 0.26);
    const tw = maxLineW(L, family, lines, fs);
    if (tw > innerW) fs *= innerW / tw;
    const textH = hasText ? n * fs * lead : 0;
    const bodyTop = pad + knot;
    const gap = hasText ? T * 0.1 : 0;
    const H = L.lengthMode === 'fixed' ? L.lengthMm : bodyTop + inset + T * 0.16 + imgH + gap + textH + inset + T * 0.06 + pad;
    return { special: 'omamori', style2: true, wMm: T, hMm: H, lines, n, fs, lead, pad, knot, inset, bodyTop, icon, imgW, imgH, gap, textH, hasText, innerW, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, fs, lead, pad, knot, inset, bodyTop, icon, imgW, imgH, gap, textH, hasText, innerW, T } = Y;
    const ink = L.inkColor;
    const { y, h, cx } = omamoriShell(ctx, W, H, pad, knot, bodyTop, T, ink, P);
    const top = y + inset + T * 0.16;
    const avail = h - inset * 2 - T * 0.22;
    const off = Math.max(0, (avail - (imgH + gap + textH)) / 2);
    iconAt(ctx, P, icon, cx - imgW / 2, top + off, imgW, imgH, ink);
    if (!hasText) return;
    ctx.fillStyle = ink;
    const ty = top + off + imgH + gap + fs * lead / 2;
    lines.forEach((l, i) => txt(ctx, L, family, l, cx, ty + i * fs * lead, fs, 'center', innerW));
  },
};


// ---------- 공통: 플레이 바 (진행 바 + 시간 + ⏪ ❚❚ ⏩) ----------
// y = 진행 바 위치, u = 기준 크기(mm). 아래 끝 y 반환
function playerBar(ctx, L, family, x, w, y, u, P) {
  const m = L.music || {};
  const ink = L.inkColor;
  ctx.fillStyle = ink;
  const th = Math.max(1.2 / P, u * 0.028);
  const prog = Math.min(1, Math.max(0, m.progress ?? 0.8));
  ctx.save(); ctx.globalAlpha = 0.25; rrect(ctx, x, y - th / 2, w, th, th / 2); ctx.fill(); ctx.restore();
  rrect(ctx, x, y - th / 2, w * prog, th, th / 2); ctx.fill();
  const fTime = u * 0.075;
  ctx.save(); ctx.globalAlpha = 0.72;
  ctx.font = boldStr(L, family, fTime, 400); ctx.textBaseline = 'middle';
  ctx.textAlign = 'left'; ctx.fillText(m.cur ?? '', x, y + u * 0.085);
  ctx.textAlign = 'right'; ctx.fillText(m.remain ?? '', x + w, y + u * 0.085);
  ctx.restore();
  const cy = y + u * 0.24, cx = x + w / 2, s = u * 0.11;
  const bw = s * 0.32;
  ctx.fillRect(cx - bw * 1.4, cy - s * 0.62, bw, s * 1.24);
  ctx.fillRect(cx + bw * 0.4, cy - s * 0.62, bw, s * 1.24);
  const tri = (tx, dir) => {
    ctx.beginPath();
    ctx.moveTo(tx, cy - s / 2); ctx.lineTo(tx + dir * s * 0.8, cy); ctx.lineTo(tx, cy + s / 2); ctx.closePath(); ctx.fill();
  };
  const off = u * 0.42;
  tri(cx - off + s * 0.8, -1); tri(cx - off + s * 1.5, -1);
  tri(cx + off - s * 0.8, 1); tri(cx + off - s * 1.5, 1);
  return cy + s * 0.62;
}

// ---------- 뮤직 (가사) : 커버 없이 제목 / 아티스트 / 가사 / 플레이 바 ----------
const MUSIC2 = {
  layout(L, family) {
    const all = linesOf(L);
    const [title = { text: '', k: 1, gs: [] }, artist = { text: '', k: 1, gs: [] }] = all;
    const lyrics = all.slice(2);
    const T = L.tapeMm, pad = T * 0.09, lead = Math.max(1, L.leading);
    const W = L.lengthMode === 'fixed' && L.orientation !== 'v' ? Math.max(T, L.lengthMm) : T;
    const inner = W - 2 * pad;
    const fT = T * 0.085, fA = T * 0.065;
    let fL = autoFs(L, T * 0.068);
    const lw = maxLineW(L, family, lyrics, fL);
    if (L.sizeMode !== 'manual' && lw > inner) fL *= inner / lw;
    const u = inner * 1.05;
    const top = pad;
    const yT = top + fT * 0.6, yA = yT + fT * 0.6 + fA * 0.85;
    const yL0 = yA + fA * 0.5 + (lyrics.length ? T * 0.07 : 0);
    const lyH = lyrics.length * fL * lead;
    const yBar = yL0 + lyH + T * 0.08;
    const H = yBar + u * 0.3 + pad;
    return { special: 'music2', wMm: W, hMm: H, title, artist, lyrics, fT, fA, fL, lead, pad, inner, u, yT, yA, yL0, yBar };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, title, artist, lyrics, fT, fA, fL, lead, pad, inner, u, yT, yA, yL0, yBar } = Y;
    const ink = L.inkColor;
    ctx.fillStyle = ink;
    txt(ctx, L, family, { ...title, gs: title.gs.map(g => ({ ...g, st: { ...g.st, bold: true } })) }, W / 2, yT, fT, 'center', inner);
    ctx.save(); ctx.globalAlpha = 0.72;
    txt(ctx, L, family, artist, W / 2, yA, fA, 'center', inner);
    ctx.restore();
    ctx.fillStyle = ink;
    lyrics.forEach((l, i) => txt(ctx, L, family, l, W / 2, yL0 + i * fL * lead + fL * lead / 2, fL, 'center', inner));
    playerBar(ctx, L, family, pad, inner, yBar, u, P);
  },
};

// ---------- 사선 레이스: 모서리에 레이스 테이프가 비스듬히 붙은 모양 ----------
const LACE2 = {
  layout(L, family) {
    const vert = L.orientation === 'v';
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, pad = T * 0.14;
    const area0 = T - 2 * pad;
    if (vert) {
      let fs = autoFs(L, area0 / (1 + (n - 1) * lead) * 0.8);
      if (L.wrapMode !== 'grow') fs = Math.min(fs, area0 / (1 + (n - 1) * lead));
      const charStep = fs * (1.05 + (L.tracking || 0) / 100);
      const maxC = Math.max(1, ...lines.map(c => c.gs.length * c.k));
      const H = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.6, maxC * charStep + T * 1.0);
      return { special: 'lace2', vert, wMm: T, hMm: H, lines, n, lead, fs, charStep, maxC, T };
    }
    let fs = autoFs(L, area0 / (n * lead) * 0.85);
    if (L.wrapMode !== 'grow') fs = Math.min(fs, area0 / (n * lead));
    const H = Math.max(T, n * fs * lead + 2 * pad);
    const bx = T * 0.5;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.8, maxLineW(L, family, lines, fs) + 2 * bx);
    return { special: 'lace2', vert, wMm: W, hMm: H, lines, n, lead, fs, bx, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.012);
    const band = T * 0.2, d = T * 0.55; // 띠 폭, 모서리에서 띠 중심까지
    const strip = () => {
      // 왼쪽 위 모서리를 가로지르는 띠 (라벨 밖은 잘림)
      const len = d * Math.SQRT2 + band * 2;
      ctx.save();
      ctx.translate(0, d); ctx.rotate(-Math.PI / 4);
      ctx.translate(-band, -band / 2);
      laceBand(ctx, len, band, ink);
      ctx.restore();
    };
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    strip();
    ctx.save(); ctx.translate(W, H); ctx.rotate(Math.PI); strip(); ctx.restore();
    ctx.restore();
    ctx.fillStyle = ink;
    if (Y.vert) {
      const textH = Y.maxC * Y.charStep;
      vCols(ctx, L, family, lines, W / 2, (H - textH) / 2, fs, fs * lead, Y.charStep);
      return;
    }
    const y0 = (H - n * fs * lead) / 2 + fs * lead / 2;
    const [tx, al] = alignedX(L, Y.bx, W - 2 * Y.bx);
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, W - 2 * Y.bx));
  },
};

// ---------- 검색창 ----------
const SEARCH = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, pad = T * 0.12;
    const h0 = T - 2 * pad;
    let fs = autoFs(L, Math.min(h0 * 0.42, h0 * 0.7 / (n * lead)));
    const h = Math.max(h0, n * fs * lead / 0.7);
    const H = h + 2 * pad;
    const tx = pad + h * 0.42, iconW = h * 0.95;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 2.5, tx + maxLineW(L, family, lines, fs) + fs * 0.5 + iconW + pad);
    return { special: 'search', wMm: W, hMm: H, lines, n, lead, fs, pad, h, tx, iconW, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, lines, n, lead, fs, pad, h, tx, iconW, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.03);
    rrect(ctx, pad, pad, W - 2 * pad, h, h / 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.stroke();
    // 돋보기
    const cx = W - pad - iconW * 0.55, cy = pad + h / 2 - h * 0.05, r = h * 0.17;
    circle(ctx, cx, cy, r); ctx.lineWidth = lw * 0.9; ctx.stroke();
    ctx.lineCap = 'round'; ctx.lineWidth = lw * 1.1;
    ctx.beginPath(); ctx.moveTo(cx + r * 0.72, cy + r * 0.72); ctx.lineTo(cx + r * 1.6, cy + r * 1.6); ctx.stroke();
    ctx.lineCap = 'butt';
    // 글자 + 입력 커서
    ctx.fillStyle = ink;
    const maxW = W - tx - iconW - pad;
    const y0 = pad + (h - n * fs * lead) / 2 + fs * lead / 2;
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, 'left', maxW));
    const last = lines[lines.length - 1];
    const cxr = tx + Math.min(maxW, lineW(L, family, last, fs)) + fs * 0.18;
    const cyr = y0 + (n - 1) * fs * lead;
    ctx.fillRect(cxr, cyr - fs * last.k * 0.55, Math.max(1 / P, fs * 0.06), fs * last.k * 1.1);
  },
};

// ---------- 칠판 ----------
const CHALK = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, fw = T * 0.08, tray = T * 0.13, ip = T * 0.08;
    const area0 = T - fw - tray - 2 * ip;
    let fs = autoFs(L, area0 / (n * lead) * 0.85);
    if (L.wrapMode !== 'grow') fs = Math.min(fs, area0 / (n * lead));
    const H = Math.max(T, n * fs * lead + fw + tray + 2 * ip);
    const bx = T * 0.18;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.8, maxLineW(L, family, lines, fs) + 2 * fw + 2 * bx);
    return { special: 'chalk', wMm: W, hMm: H, lines, n, lead, fs, fw, tray, bx, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, fw, tray, bx, T } = Y;
    const ink = L.inkColor, chalk = L.invColor || '#ffffff', lw = Math.max(1 / P, T * 0.012);
    // 나무 틀 (테이프색) + 칠판 면 (잉크색)
    ctx.strokeStyle = ink; ctx.lineWidth = lw;
    ctx.strokeRect(lw / 2, lw / 2, W - lw, H - lw);
    ctx.fillStyle = ink; ctx.fillRect(fw, fw, W - 2 * fw, H - fw - tray);
    // 나뭇결
    ctx.save(); ctx.globalAlpha = 0.35; ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    ctx.moveTo(fw * 1.5, fw * 0.5); ctx.lineTo(W * 0.4, fw * 0.5);
    ctx.moveTo(W * 0.6, fw * 0.45); ctx.lineTo(W - fw * 1.5, fw * 0.45);
    ctx.stroke(); ctx.restore();
    // 분필 받침 + 분필 두 개 + 지우개
    const ty = H - tray;
    ctx.beginPath(); ctx.moveTo(fw * 0.6, ty + tray * 0.35); ctx.lineTo(W - fw * 0.6, ty + tray * 0.35); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    const ch = tray * 0.26;
    [[W * 0.62, T * 0.16], [W * 0.62 + T * 0.2, T * 0.1]].forEach(([x, w]) => { ctx.fillRect(x, ty + tray * 0.35 - ch, w, ch); ctx.strokeRect(x, ty + tray * 0.35 - ch, w, ch); });
    ctx.fillStyle = ink; ctx.fillRect(W * 0.22, ty + tray * 0.35 - tray * 0.32, T * 0.26, tray * 0.32);
    // 분필 글씨
    ctx.fillStyle = chalk;
    const top = fw, bot = H - tray;
    const y0 = top + (bot - top - n * fs * lead) / 2 + fs * lead / 2;
    const [tx, al] = alignedX(L, fw + bx, W - 2 * fw - 2 * bx);
    ctx.save(); ctx.globalAlpha = 0.93;
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, W - 2 * fw - 2 * bx));
    ctx.restore();
  },
};

// ---------- 문자메시지 (폴더폰 화면) ----------
const SMS = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, pad = T * 0.07;
    const W = T;
    const sb = T * 0.12, gap = T * 0.05, keys = T * 0.11;
    const boxW = W - 2 * pad - T * 0.06, bx = T * 0.06, by = T * 0.06;
    let fs = autoFs(L, T * 0.11);
    const tw = maxLineW(L, family, lines, fs);
    if (L.sizeMode !== 'manual' && tw > boxW - 2 * bx) fs *= (boxW - 2 * bx) / tw;
    const boxH = Math.max(T * 0.42, n * fs * lead + 2 * by);
    const H = pad + sb + gap + boxH + gap + keys + pad;
    return { special: 'sms', wMm: W, hMm: H, lines, n, lead, fs, pad, sb, gap, keys, boxW, boxH, bx, by, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, fs, lead, pad, sb, gap, keys, boxW, boxH, bx, by, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.012);
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round';
    // 화면 테두리 (+ 반전색 채우기)
    rrect(ctx, pad * 0.5, pad * 0.5, W - pad, H - pad, T * 0.07);
    if (L.sms?.fill) { ctx.fillStyle = L.invColor || '#ffffff'; ctx.fill(); ctx.fillStyle = ink; }
    ctx.stroke();
    // 상태 표시줄: 안테나 / 시간 / 배터리
    const sy = pad + sb / 2, u = sb * 0.7;
    for (let i = 0; i < 4; i++) { const bh = u * (0.3 + i * 0.23); ctx.fillRect(pad + i * u * 0.28, sy + u / 2 - bh, u * 0.18, bh); }
    ctx.font = boldStr(L, family, u * 0.8, 400); ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(L.sms?.time ?? '12:34', W / 2, sy);
    const bw = u * 1.1, bxx = W - pad - bw - u * 0.12;
    ctx.strokeRect(bxx, sy - u * 0.3, bw, u * 0.6);
    ctx.fillRect(bxx + bw, sy - u * 0.14, u * 0.12, u * 0.28);
    for (let i = 0; i < 3; i++) ctx.fillRect(bxx + u * 0.1 + i * bw * 0.3, sy - u * 0.18, bw * 0.22, u * 0.36);
    ctx.beginPath(); ctx.moveTo(pad, pad + sb); ctx.lineTo(W - pad, pad + sb); ctx.stroke();
    // 메시지 상자
    const bx0 = (W - boxW) / 2, by0 = pad + sb + gap;
    rrect(ctx, bx0, by0, boxW, boxH, T * 0.05); ctx.stroke();
    ctx.fillStyle = ink;
    const y0 = by0 + by + fs * lead / 2;
    const [tx, al] = alignedX(L.align === 'center' || L.align === 'right' ? L : { ...L, align: 'left' }, bx0 + bx, boxW - 2 * bx);
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, boxW - 2 * bx));
    // 전송 버튼
    const ky = by0 + boxH + gap, kw = W * 0.3, kh = keys * 0.75, kx = W - pad - kw;
    ctx.font = boldStr(L, family, kh * 0.62, 400); ctx.textAlign = 'center';
    rrect(ctx, kx, ky, kw, kh, kh * 0.3); ctx.stroke();
    ctx.fillText('전송', kx + kw / 2, ky + kh / 2);
  },
};

// ---------- 확인창 (옛날 운영체제 대화상자) ----------
const DIALOG = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, o = T * 0.04;            // 바깥 여백
    const tb = T * 0.15;                          // 제목 줄 높이
    let fs = autoFs(L, T * 0.12);
    const fb = T * 0.085, bh = T * 0.16, bgap = T * 0.08;
    const labels = [L.dialog?.yes ?? 'yes', L.dialog?.no ?? 'always'].filter(t => t.trim());
    const f100 = boldStr(L, family, 100, 400);
    const bws = labels.map(t => Math.max(T * 0.42, textW(f100, t, fb) + T * 0.16));
    const btnRow = bws.reduce((a, b) => a + b, 0) + bgap * Math.max(0, bws.length - 1);
    const px = T * 0.16;
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 1.5, maxLineW(L, family, lines, fs) + 2 * px + 2 * o, btnRow + 2 * px + 2 * o);
    const textTop = o + tb + T * 0.1;
    const textH = n * fs * lead;
    const btnY = textTop + textH + T * 0.09;
    const H = btnY + (labels.length ? bh + T * 0.1 : 0) + o + T * 0.02;
    return { special: 'dialog', wMm: W, hMm: H, lines, n, lead, fs, o, tb, fb, bh, bgap, labels, bws, btnRow, px, textTop, btnY, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, lead, fs, o, tb, fb, bh, bgap, labels, bws, btnRow, px, textTop, btnY, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.013);
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round';
    // 창 + 제목 줄
    rrect(ctx, o, o, W - 2 * o, H - 2 * o, T * 0.02); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
    // 제목 줄: 테이프색을 조금 진하게
    ctx.save(); ctx.clip();
    ctx.fillStyle = L.tapeColor; ctx.fillRect(o, o, W - 2 * o, tb);
    ctx.globalAlpha = 0.16; ctx.fillStyle = ink; ctx.fillRect(o, o, W - 2 * o, tb);
    ctx.restore();
    rrect(ctx, o, o, W - 2 * o, H - 2 * o, T * 0.02); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o, o + tb); ctx.lineTo(W - o, o + tb); ctx.stroke();
    // _ □ ×
    const s = tb * 0.62, gy = o + (tb - s) / 2;
    for (let i = 0; i < 3; i++) {
      const gx = W - o - tb * 0.2 - (3 - i) * (s + tb * 0.12) + tb * 0.12;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(gx, gy, s, s); ctx.strokeRect(gx, gy, s, s);
      ctx.beginPath();
      if (i === 0) { ctx.moveTo(gx + s * 0.25, gy + s * 0.7); ctx.lineTo(gx + s * 0.75, gy + s * 0.7); }
      else if (i === 1) { ctx.rect(gx + s * 0.28, gy + s * 0.28, s * 0.44, s * 0.44); }
      else { ctx.moveTo(gx + s * 0.28, gy + s * 0.28); ctx.lineTo(gx + s * 0.72, gy + s * 0.72); ctx.moveTo(gx + s * 0.72, gy + s * 0.28); ctx.lineTo(gx + s * 0.28, gy + s * 0.72); }
      ctx.stroke();
    }
    // 본문
    ctx.fillStyle = ink;
    const [tx, al] = alignedX(L, o + px, W - 2 * o - 2 * px);
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, textTop + fs * lead / 2 + i * fs * lead, fs, al, W - 2 * o - 2 * px));
    // 버튼
    let bx = (W - btnRow) / 2;
    let last = null;
    ctx.font = boldStr(L, family, fb, 400); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    labels.forEach((t, i) => {
      rrect(ctx, bx, btnY, bws[i], bh, bh * 0.22); ctx.stroke();
      ctx.fillText(t, bx + bws[i] / 2, btnY + bh / 2);
      last = [bx, bws[i]];
      bx += bws[i] + bgap;
    });
    // 마우스 커서 (마지막 버튼 오른쪽 아래)
    if (last && L.dialog?.cursor !== false) {
      const c = T * 0.15, cx = last[0] + last[1] * 0.82, cy = btnY + bh * 0.45;
      const pts = [[0, 0], [0, 1], [0.27, 0.76], [0.45, 1.12], [0.6, 1.05], [0.42, 0.7], [0.75, 0.7]];
      ctx.beginPath();
      pts.forEach(([a, b], i) => i ? ctx.lineTo(cx + a * c, cy + b * c) : ctx.moveTo(cx + a * c, cy + b * c));
      ctx.closePath();
      ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = lw * 0.9; ctx.stroke();
    }
  },
};

// ---------- 메모 (둥근 테두리 + 왼쪽 그림 + 점선 구분선) ----------
const MEMO = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, o = T * 0.07, ip = T * 0.12, ipY = T * 0.05; // ipY: 글자 위아래 여백
    const iconZ = T * 0.6; // 왼쪽 그림 칸
    const fs = autoFs(L, Math.min((T - 2 * o - 2 * ipY) / (n * lead), T * 0.28));
    const tw = maxLineW(L, family, lines, fs);
    const H = Math.max(T, n * fs * lead + 2 * o + 2 * ipY);
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 2, o + iconZ + ip + tw + ip * 1.4 + o);
    return { special: 'memo', wMm: W, hMm: H, lines, n, lead, fs, o, ip, iconZ, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, o, ip, iconZ, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.014);
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round';
    rrect(ctx, o, o, W - 2 * o, H - 2 * o, T * 0.1); ctx.stroke();
    // 왼쪽 그림
    const box = Math.min(iconZ, H) * 0.56;
    iconAt(ctx, P, L.hero?.icon || 'flower', o + (iconZ - box) / 2, (H - box) / 2, box, box, ink);
    // 점선 구분선
    const dx = o + iconZ;
    ctx.save();
    ctx.setLineDash([T * 0.03, T * 0.03]); ctx.lineWidth = lw * 0.9;
    ctx.beginPath(); ctx.moveTo(dx, o); ctx.lineTo(dx, H - o); ctx.stroke();
    ctx.restore();
    // 글
    ctx.fillStyle = ink;
    const x0 = dx + ip, w = W - o - ip - x0;
    const [tx, al] = alignedX(L, x0, w);
    const y0 = (H - n * fs * lead) / 2 + fs * lead / 2;
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, w));
  },
};

// ---------- 찢은 테이프 (양 끝이 들쭉날쭉) ----------
const TEAR_A = [0.95, 0.45, 1, 0.3, 0.8, 0.6, 1, 0.4, 0.7, 0.55, 0.9, 0.35];
const TORN = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, my = T * 0.17, z = T * 0.09, mx = T * 0.04, px = T * 0.1;
    const fs = autoFs(L, Math.min((T - 2 * my - T * 0.1) / (n * lead), T * 0.26));
    const tw = maxLineW(L, family, lines, fs);
    const H = Math.max(T, n * fs * lead + T * 0.1 + 2 * my);
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 2, tw + 2 * (mx + z + px));
    return { special: 'torn', wMm: W, hMm: H, lines, n, lead, fs, my, z, mx, px, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, my, z, mx, px, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.014);
    const top = my, bot = H - my, xl = mx + z, xr = W - mx - z;
    const m = Math.max(5, Math.round((bot - top) / (T * 0.075)));
    const edge = (x0, dir, off) => {
      const pts = [];
      for (let j = 0; j <= m; j++) {
        const a = TEAR_A[(j + off) % TEAR_A.length];
        const jy = j > 0 && j < m ? ((j * 7 + off) % 3 - 1) * (bot - top) / m * 0.18 : 0;
        const x = x0 + dir * z * (j % 2 ? a : (j === 0 || j === m ? 0 : -0.15 * a));
        pts.push([x, top + (bot - top) * j / m + jy]);
      }
      return pts;
    };
    ctx.beginPath();
    ctx.moveTo(xl, top); ctx.lineTo(xr, top);
    edge(xr, 1, 0).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(xl, bot);
    edge(xl, -1, 5).reverse().forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'miter'; ctx.miterLimit = 6; ctx.stroke();
    ctx.fillStyle = ink;
    const x0 = xl + px, w = xr - px - x0;
    const [tx, al] = alignedX(L, x0, w);
    const y0 = (H - n * fs * lead) / 2 + fs * lead / 2;
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, w));
  },
};

// ---------- 수배지 (WANTED / 그림 / DEAD OR ALIVE / 글 / $ 현상금) ----------
const SERIF = "'Times New Roman', 'Batang', serif";
const WANTED = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, W = T, pad = T * 0.07, inW = W - 2 * pad - T * 0.08;
    const tSize = Math.min(T * 0.19, inW / (textW(`900 100px ${SERIF}`, 'WANTED', 100) / 100));
    const dSize = Math.min(T * 0.075, inW / (textW(`700 100px ${SERIF}`, 'DEAD OR ALIVE', 100) / 100));
    const reward = '$ ' + (L.wanted?.reward ?? '1,000,000');
    const rSize = Math.min(T * 0.1, inW / Math.max(0.1, textW(`700 100px ${SERIF}`, reward, 100) / 100));
    const fs = autoFs(L, T * 0.095);
    const yT = pad + T * 0.04 + tSize * 0.5;
    const img = T * 0.44, yI = yT + tSize * 0.55 + T * 0.04;
    const yD = yI + img + T * 0.03 + dSize * 0.5;
    const yTx = yD + dSize * 0.5 + T * 0.05 + fs * lead / 2;
    const yR = yTx + (n - 1) * fs * lead + fs * lead / 2 + T * 0.05 + rSize * 0.5;
    const H = yR + rSize * 0.5 + T * 0.05 + pad;
    return { special: 'wanted', wMm: W, hMm: H, lines, n, lead, fs, pad, inW, tSize, dSize, rSize, reward, yT, img, yI, yD, yTx, yR, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, lead, fs, pad, inW, tSize, dSize, rSize, reward, yT, img, yI, yD, yTx, yR, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.012);
    ctx.strokeStyle = ink; ctx.fillStyle = ink;
    // 이중 테두리
    ctx.lineWidth = lw * 1.8; ctx.strokeRect(pad * 0.5, pad * 0.5, W - pad, H - pad);
    ctx.lineWidth = lw * 0.8; ctx.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `900 ${tSize}px ${SERIF}`; ctx.fillText('WANTED', W / 2, yT);
    // 그림 칸
    const ix = (W - img) / 2;
    ctx.lineWidth = lw; ctx.strokeRect(ix, yI, img, img);
    iconAt(ctx, P, L.hero?.icon || 'face', ix + img * 0.12, yI + img * 0.12, img * 0.76, img * 0.76, ink);
    ctx.font = `700 ${dSize}px ${SERIF}`; ctx.fillText('DEAD OR ALIVE', W / 2, yD);
    // 구분선
    const ly = yD + dSize * 0.5 + T * 0.025;
    ctx.lineWidth = lw * 0.8;
    ctx.beginPath(); ctx.moveTo(W / 2 - inW * 0.4, ly); ctx.lineTo(W / 2 + inW * 0.4, ly); ctx.stroke();
    lines.forEach((l, i) => txt(ctx, L, family, l, W / 2, yTx + i * fs * lead, fs, 'center', inW));
    ctx.fillStyle = ink; ctx.textAlign = 'center';
    ctx.font = `700 ${rSize}px ${SERIF}`; ctx.fillText(reward, W / 2, yR);
  },
};

// ---------- 반짝 라인 (위 왼쪽·아래 오른쪽 선 + 반짝이 무리) ----------
function star5(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}
function twinkle(ctx, cx, cy, r) { // 4갈래 반짝이 (오목한 별)
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx, cy, cx + r, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy + r);
  ctx.quadraticCurveTo(cx, cy, cx - r, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy - r);
  ctx.closePath();
}
function asterisk(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 4;
    ctx.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}
const SPARKLE = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, m = T * 0.15, u = T * 0.14;
    const padY = m + u * 0.85, px = m + u * 1.5;
    const fs = autoFs(L, Math.min((T - 2 * padY) / (n * lead), T * 0.3));
    const tw = maxLineW(L, family, lines, fs);
    const H = Math.max(T, n * fs * lead + 2 * padY);
    const W = L.lengthMode === 'fixed' ? L.lengthMm : Math.max(T * 2, tw + 2 * px);
    return { special: 'sparkle', wMm: W, hMm: H, lines, n, lead, fs, m, u, px, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, m, u, px, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.011);
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const el = (k, x, y) => {
      if (k === 'dot') { circle(ctx, x, y, u * 0.12); ctx.fill(); }
      else if (k === 'ring') { circle(ctx, x, y, u * 0.24); ctx.stroke(); }
      else if (k === 'ast') { asterisk(ctx, x, y, u * 0.34); ctx.stroke(); }
    };
    const sr = u * 0.62; // 모서리 별 크기
    // 위 + 오른쪽 반쪽을 그리고, 가운데 기준 180° 돌려서 아래 + 왼쪽도 똑같이
    const half = flip => {
      // 오른쪽 위 모서리 별
      const sx = W - m, sy = m;
      ctx.save(); ctx.translate(sx, sy); if (flip) ctx.rotate(Math.PI); star5(ctx, 0, 0, sr); ctx.stroke(); ctx.restore();
      // 별 왼쪽으로: · ✳ ○ · 그다음 선
      const seq = ['dot', 'ast', 'ring', 'dot'];
      let x = sx - sr - u * 0.4;
      seq.forEach(k => { el(k, x, sy + (k === 'dot' ? -u * 0.15 : 0)); x -= u * 0.85; });
      ctx.beginPath(); ctx.moveTo(m * 0.6, sy); ctx.lineTo(x + u * 0.3, sy); ctx.stroke();
      // 별 아래로 오른쪽 세로줄: ✳ · ○ · … 빈틈 없이 고르게
      const y1 = sy + sr + u * 0.5, y2 = H - m - u * 0.7;
      const cnt = Math.max(2, Math.round((y2 - y1) / (u * 0.95)) + 1);
      const vseq = ['ast', 'dot', 'ring', 'dot'];
      for (let i = 0; i < cnt; i++) el(vseq[i % 4], sx, y1 + (y2 - y1) * i / (cnt - 1));
    };
    half();
    ctx.save(); ctx.translate(W, H); ctx.rotate(Math.PI); half(true); ctx.restore();
    ctx.lineCap = 'butt';
    const [tx, al] = alignedX(L, px, W - 2 * px);
    const y0 = (H - n * fs * lead) / 2 + fs * lead / 2;
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, W - 2 * px));
  },
};

// ---------- 레트로 TV (화면 + 아래 패널 + 받침) ----------
const TV = {
  layout(L, family) {
    const lines = linesOf(L), n = Math.max(1, lines.length), lead = Math.max(1, L.leading);
    const T = L.tapeMm, o = T * 0.04, bz = T * 0.06, stand = T * 0.06;
    const bodyH = T - 2 * o - stand, scrH = bodyH * 0.75 - bz, band = T * 0.03;
    // 기본은 정방형 (길이 고정이면 그 길이). 글자가 화면보다 넓으면 줄여서 맞춤
    const W = L.lengthMode === 'fixed' ? L.lengthMm : T;
    let fs = autoFs(L, Math.min((scrH - 2 * band - T * 0.04) / (n * lead), T * 0.16));
    const room = W - 2 * (o + bz) - T * 0.2, tw = maxLineW(L, family, lines, fs);
    if (L.sizeMode !== 'manual' && tw > room && tw > 0) fs *= room / tw;
    return { special: 'tv', wMm: W, hMm: T, lines, n, lead, fs, o, bz, stand, bodyH, scrH, band, T };
  },
  draw(ctx, L, family, Y, P) {
    const { wMm: W, hMm: H, lines, n, lead, fs, o, bz, stand, bodyH, scrH, band, T } = Y;
    const ink = L.inkColor, lw = Math.max(1 / P, T * 0.012);
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round';
    // 받침
    const sw = W * 0.6;
    ctx.beginPath();
    ctx.moveTo((W - sw) / 2, o + bodyH); ctx.lineTo((W + sw) / 2, o + bodyH);
    ctx.lineTo((W + sw) / 2 - T * 0.02, H - o); ctx.lineTo((W - sw) / 2 + T * 0.02, H - o); ctx.closePath(); ctx.stroke();
    // 본체
    rrect(ctx, o, o, W - 2 * o, bodyH, T * 0.07); ctx.stroke();
    // 화면 테두리 + 화면
    const sx = o + bz, sy = o + bz, sW = W - 2 * (o + bz);
    rrect(ctx, sx - bz * 0.35, sy - bz * 0.35, sW + bz * 0.7, scrH + bz * 0.7, T * 0.05); ctx.stroke();
    // 볼록한 브라운관: 네 변이 바깥으로 살짝 부푼 ( ) 모양, 잉크색으로 채움
    const bs = T * 0.03, bt = T * 0.012, r = T * 0.05;
    const x0 = sx + bs, y0s = sy + bt, x1 = sx + sW - bs, y1 = sy + scrH - bt;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0s);
    ctx.quadraticCurveTo((x0 + x1) / 2, y0s - 2 * bt, x1 - r, y0s);
    ctx.quadraticCurveTo(x1, y0s, x1, y0s + r);
    ctx.quadraticCurveTo(x1 + 2 * bs, (y0s + y1) / 2, x1, y1 - r);
    ctx.quadraticCurveTo(x1, y1, x1 - r, y1);
    ctx.quadraticCurveTo((x0 + x1) / 2, y1 + 2 * bt, x0 + r, y1);
    ctx.quadraticCurveTo(x0, y1, x0, y1 - r);
    ctx.quadraticCurveTo(x0 - 2 * bs, (y0s + y1) / 2, x0, y0s + r);
    ctx.quadraticCurveTo(x0, y0s, x0 + r, y0s);
    ctx.closePath();
    ctx.fillStyle = ink; ctx.fill(); ctx.stroke();
    // 글 (포인트색)
    ctx.fillStyle = L.invColor || '#ffffff';
    const [tx, al] = alignedX(L, sx + T * 0.1, sW - T * 0.2);
    const y0 = sy + scrH / 2 - n * fs * lead / 2 + fs * lead / 2;
    lines.forEach((l, i) => txt(ctx, L, family, l, tx, y0 + i * fs * lead, fs, al, sW - T * 0.2));
    // 아래 패널: 슬롯 · 통풍구 · 버튼 두 개
    const py = sy + scrH + bz * 0.35, ph = o + bodyH - py, cy = py + ph * 0.45;
    ctx.fillStyle = ink; ctx.lineWidth = lw * 0.9;
    const slW = sW * 0.32, slH = ph * 0.22;
    rrect(ctx, W / 2 - slW / 2, cy - slH / 2, slW, slH, slH * 0.3); ctx.stroke();
    ctx.beginPath();
    for (let k = 0; k < 2; k++) { const vy = cy - ph * 0.08 + k * ph * 0.16; ctx.moveTo(sx, vy); ctx.lineTo(sx + sW * 0.14, vy); }
    ctx.stroke();
    const kr = Math.min(ph * 0.17, T * 0.035), kx = sx + sW - kr;
    circle(ctx, kx, cy, kr); ctx.stroke();
    circle(ctx, kx - kr * 2.8, cy, kr); ctx.fillStyle = ink; ctx.fill();
  },
};

const SPECIAL = { music: MUSIC, messenger: MESSENGER, dogtag: DOGTAG, wongoji: WONGOJI, bubble: BUBBLE, bubble2: BUBBLE2, omamori: OMAMORI, notebook: NOTEBOOK, lace: LACE, virus: VIRUS, burst: BURST, music2: MUSIC2, lace2: LACE2, search: SEARCH, chalk: CHALK, sms: SMS, dialog: DIALOG, memo: MEMO, torn: TORN, wanted: WANTED, sparkle: SPARKLE, tv: TV };
export const isSpecialFrame = f => !!SPECIAL[f];
