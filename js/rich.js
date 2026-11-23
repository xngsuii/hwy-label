// 부분 스타일(드래그한 구간만 굵게 등) + 줄별 글자 크기
// marks: { bold: [[s,e],...], ... }  — L.text 의 문자 오프셋(코드 유닛) 범위 [s, e)
// L.bold 같은 전역 플래그가 켜져 있으면 전체에 적용

export const MARKS = ['bold', 'italic', 'underline', 'strike', 'outline', 'hl', 'pt']; // pt = 포인트색 글자
export const LINE_SIZES = [['xs', '아주 작게'], ['s', '작게'], ['m', '중간'], ['l', '크게'], ['xl', '아주 크게']];
const LINE_K = { xl: 1.3, l: 1, m: 0.78, s: 0.6, xs: 0.42 };
export const lineK = (L, i) => LINE_K[L.lineSizes?.[i]] || 1;

const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
export const graphemes = s => seg ? Array.from(seg.segment(s), x => x.segment) : Array.from(s);

function norm(rs) {
  const a = rs.filter(r => r[1] > r[0]).map(r => [r[0], r[1]]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of a) {
    const l = out[out.length - 1];
    if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else out.push(r);
  }
  return out;
}
function subtract(rs, s, e) {
  const out = [];
  for (const [a, b] of rs) {
    if (b <= s || a >= e) out.push([a, b]);
    else { if (a < s) out.push([a, s]); if (b > e) out.push([e, b]); }
  }
  return out;
}

// [s,e) 구간이 전부 해당 스타일인지
export function covered(L, k, s, e) {
  if (L[k]) return true;
  let pos = s;
  for (const [a, b] of norm(L.marks?.[k] || [])) {
    if (a <= pos && b > pos) pos = b;
    if (pos >= e) return true;
  }
  return pos >= e;
}
export const hasMarks = (L, k) => (L.marks?.[k] || []).length > 0;

// 선택 구간 스타일 토글 → setLabel 에 넘길 patch
export function toggleMark(L, k, s, e) {
  let rs = L.marks?.[k] || [];
  if (L[k]) rs = [[0, (L.text || '').length]]; // 전체 적용 중이면 구간 단위로 풀어서
  const tmp = { marks: { [k]: rs } };
  rs = covered(tmp, k, s, e) ? subtract(norm(rs), s, e) : norm([...rs, [s, e]]);
  return { [k]: false, marks: { ...(L.marks || {}), [k]: rs } };
}
// 전체 토글 (선택 없음): 구간 스타일은 지움
export function toggleAll(L, k) {
  const on = !(L[k] || hasMarks(L, k));
  return { [k]: on, marks: { ...(L.marks || {}), [k]: [] } };
}

const nl = s => (s.match(/\n/g) || []).length;
// 텍스트 수정 시 구간 스타일 / 줄별 크기를 따라 옮김
export function editText(L, text) {
  const old = L.text || '';
  const max = Math.min(old.length, text.length);
  let p = 0;
  while (p < max && old[p] === text[p]) p++;
  let q = 0;
  while (q < max - p && old[old.length - 1 - q] === text[text.length - 1 - q]) q++;
  const delEnd = old.length - q, ins = text.length - p - q, delta = text.length - old.length;
  const map = x => x < p ? x : x >= delEnd ? x + delta : p;
  const marks = {};
  for (const [k, rs] of Object.entries(L.marks || {})) marks[k] = norm(rs.map(([a, b]) => [map(a), map(b)]));
  const ls = L.lineSizes || [];
  let lineSizes = ls;
  const li = nl(old.slice(0, p)), rem = nl(old.slice(p, delEnd)), add = nl(text.slice(p, p + ins));
  if (rem || add) {
    lineSizes = [...ls];
    while (lineSizes.length < li + 1 + rem) lineSizes.push('l');
    lineSizes.splice(li + 1, rem, ...Array(add).fill(ls[li] || 'l'));
  }
  return { text, marks, lineSizes };
}

function styler(L) {
  const sets = {};
  for (const k of MARKS) sets[k] = L[k] ? [] : norm(L.marks?.[k] || []);
  return off => {
    const st = {};
    for (const k of MARKS) st[k] = !!L[k] || sets[k].some(([a, b]) => off >= a && off < b);
    return st;
  };
}

// 줄 단위 + 글자별 스타일: [{ text, k, gs: [{ g, st }] }]
export function richLines(L, text = L.text || '') {
  const sty = styler(L);
  let off = 0;
  return text.split('\n').map((line, i) => {
    const gs = [];
    let o = off;
    for (const g of graphemes(line)) { gs.push({ g, st: sty(o) }); o += g.length; }
    off += line.length + 1;
    return { text: line, k: lineK(L, i), gs };
  });
}
