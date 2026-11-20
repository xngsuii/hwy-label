// 오리지널 픽셀 아이콘. 'X' = 잉크 픽셀.
export const ICONS = {
  bear:   ['.XXX...XXX.', 'X...XXX...X', 'X.........X', 'X..X...X..X', 'X....X....X', 'X...X.X...X', '.X.......X.', '..XXXXXXX..'],
  bunny:  ['.X...X.', '.X...X.', '.X...X.', 'X.....X', 'X.X.X.X', 'X..X..X', '.XXXXX.'],
  cat:    ['X.......X', 'XX.....XX', 'X.XXXXX.X', 'X.......X', 'X.X...X.X', 'X...X...X', '.X.....X.', '..XXXXX..'],
  heart:  ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'],
  heartO: ['.XX.XX.', 'X..X..X', 'X.....X', '.X...X.', '..X.X..', '...X...'],
  clover: ['.XX.XX.', 'XXXXXXX', '.XXXXX.', 'XXXXXXX', '.XX.XX.', '...X...', '..X....'],
  star:   ['...X...', '...X...', 'XXXXXXX', '.XXXXX.', '..XXX..', '.XX.XX.', 'X.....X'],
  bone:   ['XX.....XX', '.XXXXXXX.', 'XX.....XX'],
  note:   ['..XXXXX', '..X...X', '..X...X', 'XXX.XXX', 'XXX.XXX'],
  spark:  ['..X..', '..X..', 'XX.XX', '..X..', '..X..'],
  cherry: ['....XX', '...X..', '..X..X', '.X...X', 'XX..XX', 'XX..XX'],
  cloud:  ['..XXX...', '.X...XX.', 'X......X', 'X......X', '.XXXXXX.'],
  flower: ['.X.X.', 'XXXXX', '.X.X.', '..X..', '.XX..'],
  face:   ['..XXXXX..', '.X.....X.', 'X..X.X..X', 'X.......X', 'X.X...X.X', 'X..XXX..X', '.X.....X.', '..XXXXX..'],
  moon:   ['..XXX', '.XX..', 'XX...', 'XX...', 'XX...', '.XX..', '..XXX'],
  ribbon: ['XX...XX', 'X.X.X.X', 'X..X..X', 'X.X.X.X', 'XX.X.XX', '..X.X..'],
  arrow:  ['....X..', '....XX.', 'XXXXXXX', '....XX.', '....X..'],
  bubble: ['.XXXXX.', 'X.....X', 'X.X.X.X', 'X.....X', '.XXX.X.', '....XX.'],
};

export const ICON_GROUPS = {
  '동물': ['bear', 'bunny', 'cat', 'bone'],
  '하트·별': ['heart', 'heartO', 'star', 'spark', 'moon'],
  '자연': ['clover', 'flower', 'cherry', 'cloud'],
  '기호': ['note', 'ribbon', 'arrow', 'bubble', 'face'],
};
export const ALL_ICONS = Object.values(ICON_GROUPS).flat();

export function iconSize(name) {
  const g = ICONS[name];
  return g ? { w: g[0].length, h: g.length } : { w: 0, h: 0 };
}

// 캔버스에 아이콘을 그림. 픽셀 하나 = cell (정수 px로 스냅)
export function drawIcon(ctx, name, x, y, cell, color) {
  const g = ICONS[name];
  if (!g) return;
  ctx.fillStyle = color;
  const c = Math.max(1, cell);
  g.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] === 'X') ctx.fillRect(Math.round(x + i * c), Math.round(y + j * c), Math.ceil(c), Math.ceil(c));
    }
  });
}

export function iconSvg(name, scale = 2, color = 'currentColor') {
  const g = ICONS[name];
  if (!g) return '';
  const h = g.length, w = g[0].length;
  let r = '';
  g.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'X') r += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
  return `<svg width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" fill="${color}" shape-rendering="crispEdges">${r}</svg>`;
}

// ---- 사용자 이미지 아이콘 (이미지 → 비트맵) ----
let customKeys = [];
let customRef = null;
export function setCustomIcons(list = []) {
  if (list === customRef) return;
  customRef = list;
  customKeys.forEach(k => delete ICONS[k]);
  customKeys = list.map(ic => { ICONS[ic.id] = ic.rows; return ic.id; });
}
