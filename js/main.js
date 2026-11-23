import { html, render, useState, useEffect, useRef, useMemo, useCallback } from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';
import { store, setLabel, setUi, setBoard, defaultLabel, uid, TAPE_WIDTHS, exportBackup, importBackup } from './store.js';
import { BUILTIN_FONTS, fontById, ensureFont, registerCustomFont, loadStoredFonts, saveStoredFonts } from './fonts.js';
import { renderLabel, layoutLabel, clearMeasureCache, canvasToBlob, isSpecialFrame, isTxtDeco } from './render.js';
import { ICON_GROUPS, iconSvg, iconSize, setCustomIcons } from './pixel.js';
import { BOARD_SIZES, BOARD_PPM, boardDims, autoLayout, scatterLayout, syncBoard, renderBoard } from './board.js';
import { loadImageFile, toBitmap, rowsToCanvas } from './bitmap.js';
import { idb } from './store.js';
import { covered, hasMarks, toggleMark, toggleAll, editText, LINE_SIZES } from './rich.js';

// ---------------- hooks ----------------
function useStore() {
  const [s, setS] = useState(store.get());
  useEffect(() => store.subscribe(setS), []);
  return s;
}
let fontsV = 0;
const fontSubs = new Set();
function bumpFonts() { fontsV++; clearMeasureCache(); thumbCache.clear(); fontSubs.forEach(f => f(fontsV)); }
function useFontsV() {
  const [v, setV] = useState(fontsV);
  useEffect(() => { fontSubs.add(setV); return () => fontSubs.delete(setV); }, []);
  return v;
}
document.fonts?.addEventListener?.('loadingdone', () => bumpFonts());

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2200);
}

// ---------------- 사이트 무드 확인/입력 창 (시스템 confirm/prompt 대신) ----------------
let dialogSetter = null;
function openDialog(o) {
  return new Promise(res => dialogSetter ? dialogSetter({ ...o, res }) : res(o.kind === 'prompt' ? null : false));
}
async function askConfirm(key, msg, { title = '확인', ok = '확인' } = {}) {
  if (key && store.get().ui.skipConfirm?.[key]) return true;
  return openDialog({ kind: 'confirm', key, title, msg, ok });
}
function askText(msg, def = '', { title = '입력', ok = '저장' } = {}) {
  return openDialog({ kind: 'prompt', title, msg, def, ok });
}
function Dialog() {
  const [d, setD] = useState(null);
  const [val, setVal] = useState('');
  const [skip, setSkip] = useState(false);
  const boxRef = useRef();
  useEffect(() => {
    dialogSetter = o => { setD(o); setVal(o.def || ''); setSkip(false); };
    return () => { dialogSetter = null; };
  }, []);
  useEffect(() => {
    if (!d) return;
    requestAnimationFrame(() => boxRef.current?.querySelector(d.kind === 'prompt' ? 'input.txt' : '.ok')?.focus());
  }, [d]);
  if (!d) return null;
  const close = result => {
    if (d.kind === 'confirm' && result && skip && d.key) setUi({ skipConfirm: { ...(store.get().ui.skipConfirm || {}), [d.key]: true } });
    d.res(result);
    setD(null);
  };
  const ok = () => close(d.kind === 'prompt' ? (val.trim() || null) : true);
  const cancel = () => close(d.kind === 'prompt' ? null : false);
  return html`
    <div class="dlg-back" onPointerDown=${e => { if (e.target === e.currentTarget) cancel(); }}>
      <div class="dlg" ref=${boxRef} role="dialog" aria-modal="true"
           onKeyDown=${e => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter' && d.kind === 'prompt') ok(); }}>
        <div class="h">${d.title} <i><button class="x" aria-label="닫기" onClick=${cancel}>✕</button></i></div>
        <div class="body">
          <div class="dlg-msg"><${Px} name="face" s=${3} c="#2F2C30" /><p>${d.msg}</p></div>
          ${d.kind === 'prompt' ? html`<div class="row"><input class="txt" value=${val} onInput=${e => setVal(e.target.value)} /></div>` : null}
          ${d.kind === 'confirm' && d.key ? html`<label class="check dlg-skip"><input type="checkbox" checked=${skip} onChange=${e => setSkip(e.target.checked)} /> 다음부터 묻지 않기</label>` : null}
          <div class="dlg-btns">
            <button class="btn" onClick=${cancel}>취소</button>
            <button class="btn on ok" onClick=${ok}>${d.ok}</button>
          </div>
        </div>
      </div>
    </div>`;
}

// 라벨 이미지 캐시 (썸네일 / 판)
const thumbCache = new Map();
function labelImage(L, customFonts, ppm) {
  const key = JSON.stringify(L) + '|' + ppm;
  let v = thumbCache.get(key);
  if (!v) {
    const f = fontById(L.fontId, customFonts);
    const { canvas } = renderLabel(L, f.family, ppm);
    v = { url: canvas.toDataURL(), w: canvas.width, h: canvas.height };
    if (thumbCache.size > 400) thumbCache.clear();
    thumbCache.set(key, v);
  }
  return v;
}

const download = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
const safeName = (t, i) => `${String(i + 1).padStart(2, '0')}_${(t || 'label').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 24) || 'label'}.png`;

// ---------------- small UI bits ----------------
const Sec = ({ title, sub, children, cls = '' }) => html`
  <div class=${'sec ' + cls}>
    <div class="h">${title} <i>${sub}</i></div>
    <div class="body">${children}</div>
  </div>`;

// 슬라이더 + 숫자 (숫자를 누르면 직접 입력)
function Range({ label, min, max, step = 1, value, onInput, fmt = v => v }) {
  const [edit, setEdit] = useState(false);
  const pct = max <= 2 && String(fmt(max)).includes('%'); // 0.62 → 62% 처럼 보이는 값은 % 숫자로 입력
  const commit = e => {
    const v = parseFloat(e.target.value) / (pct ? 100 : 1);
    if (!isNaN(v)) onInput(Math.min(max, Math.max(min, v)));
    setEdit(false);
  };
  return html`
  <div class="row"><span class="lbl">${label}</span>
    <input type="range" min=${min} max=${max} step=${step} value=${value} onInput=${e => onInput(+e.target.value)} />
    ${edit
      ? html`<input class="num val-in" type="number" value=${pct ? Math.round(value * 100) : value} ref=${el => el && !el.dataset.f && (el.dataset.f = 1, el.focus(), el.select())}
          onBlur=${commit} onKeyDown=${e => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') setEdit(false); }} />`
      : html`<span class="val edit" title="눌러서 숫자 입력" onClick=${() => setEdit(true)}>${fmt(value)}</span>`}</div>`;
}

const Toggle = ({ options, value, onChange }) => html`
  <span class="toggle">${options.map(([v, t]) => html`<button class=${value === v ? 'on' : ''} onClick=${() => onChange(v)}>${t}</button>`)}</span>`;

// 버튼용 픽셀 아이콘 (7×7, 'X' = 칠함)
const UI_ICONS = {
  bold:      ['XXXXX..', 'XX..XX.', 'XX..XX.', 'XXXXX..', 'XX..XX.', 'XX..XX.', 'XXXXX..'],
  italic:    ['...XXXX', '....XX.', '...XX..', '...XX..', '..XX...', '.XX....', 'XXXX...'],
  underline: ['XX...XX', 'XX...XX', 'XX...XX', 'XX...XX', '.XXXXX.', '.......', 'XXXXXXX'],
  strike:    ['.XXXXX.', 'XX.....', '.XXX...', 'XXXXXXX', '....XX.', 'X...XX.', '.XXXX..'],
  outline:   ['..XXX..', '.X...X.', 'X..X..X', 'X.X.X.X', 'X.XXX.X', 'X.X.X.X', 'XXX.XXX'],
  pt:        ['...X...', '..X.X..', '.X...X.', '.XXXXX.', '.X...X.', '.......', 'XXXXXXX'],
  hl:        ['XXXXXXX', 'XXX.XXX', 'XX.X.XX', 'XX.X.XX', 'XX...XX', 'XX.X.XX', 'XXXXXXX'],
  al_left:   ['XXXXXXX', '.......', 'XXXX...', '.......', 'XXXXXXX', '.......', 'XXXX...'],
  al_center: ['XXXXXXX', '.......', '.XXXXX.', '.......', 'XXXXXXX', '.......', '.XXXXX.'],
  al_right:  ['XXXXXXX', '.......', '...XXXX', '.......', 'XXXXXXX', '.......', '...XXXX'],
  al_justify:['XXXXXXX', '.......', 'XXXXXXX', '.......', 'XXXXXXX', '.......', 'XXXXXXX'],
};
const UiIcon = ({ name, s = 1.43 }) => {
  const g = UI_ICONS[name];
  let r = '';
  g.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'X') r += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
  return html`<span class="px" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: `<svg width="${7 * s}" height="${7 * s}" viewBox="0 0 7 7" fill="currentColor" shape-rendering="crispEdges">${r}</svg>` }}></span>`;
};

// fit: 아이콘의 긴 변을 이 px 이하로 맞춤 (큰 사용자 이미지용)
const Px = ({ name, s = 2, c, fit }) => {
  let sc = s;
  if (fit) { const { w, h } = iconSize(name); sc = Math.min(s, fit / Math.max(1, w, h)); }
  return html`<span class="px" dangerouslySetInnerHTML=${{ __html: iconSvg(name, sc, c) }}></span>`;
};

// ---------------- LEFT ----------------
function Preview({ s, fv }) {
  const ref = useRef();
  const L = s.label;
  const font = fontById(L.fontId, s.customFonts);
  const [dim, setDim] = useState('');
  useEffect(() => {
    const { canvas, wMm, hMm } = renderLabel(L, font.family, 300 / 25.4 * 1.5);
    const c = ref.current;
    c.width = canvas.width; c.height = canvas.height;
    c.getContext('2d').drawImage(canvas, 0, 0);
    setDim(`${wMm.toFixed(1)} × ${hMm.toFixed(1)}mm`);
  }, [L, fv, font.family]);
  const ori = { h: '가로형', v: '세로형', square: '정방형', free: '자유형' }[L.orientation];
  const editing = s.editingId && s.drawer.some(d => d.id === s.editingId);
  const put = () => {
    store.set(st => {
      let drawer;
      if (editing) drawer = st.drawer.map(d => d.id === st.editingId ? { ...st.label, id: st.editingId } : d);
      else drawer = [...st.drawer, { ...st.label, id: uid() }];
      const next = { ...st, drawer, editingId: null, label: { ...st.label, id: uid() } };
      return { ...next, board: syncBoard(next) };
    });
    toast(editing ? '서랍 라벨을 업데이트했어요' : '서랍에 넣었어요 ↘');
  };
  return html`
    <div class="fixed">
      <div class="h">Preview <i>${editing ? '서랍 라벨 편집 중' : '현재 라벨'}</i></div>
      <div class="pv">
        <span class="dim">${dim} · ${ori}</span>
        <canvas ref=${ref}></canvas>
        <div class="ruler"></div>
      </div>
      <div class="put">
        <button class="btn" onClick=${() => store.set(st => ({ ...st, editingId: null, label: { ...defaultLabel(), tapeColor: st.label.tapeColor, inkColor: st.label.inkColor, invColor: st.label.invColor || '#FFFFFF' } }))}>↺ 새로</button>
        <button class="btn main" onClick=${put}>${editing ? '서랍 업데이트 ↘' : 'PRINT!'}</button>
      </div>
    </div>`;
}

const CIRC = '⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇';
function TextSec({ s, taRef }) {
  const L = s.label;
  const custom = s.customFonts;
  const fileRef = useRef();
  const [url, setUrl] = useState('');
  const [fam, setFam] = useState('');
  const groups = {};
  BUILTIN_FONTS.forEach(f => (groups[f.group] ||= []).push(f));
  const addFile = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const id = 'u_' + uid();
    const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
    const entry = { id, name, family: 'U-' + id, kind: 'file', blob: file };
    try {
      await registerCustomFont(entry);
      const list = [...((await idb.get('fonts')) || []), entry];
      await saveStoredFonts(list);
      store.set(st => ({ ...st, customFonts: [...st.customFonts, { id, name, family: entry.family, kind: 'file' }], label: { ...st.label, fontId: id } }));
      bumpFonts();
      toast(`"${name}" 폰트를 추가했어요 (이 브라우저에만 저장)`);
    } catch { toast('폰트 파일을 읽지 못했어요'); }
  };
  const addUrl = async () => {
    if (!url.trim() || !fam.trim()) { toast('URL과 font-family 이름을 둘 다 넣어주세요'); return; }
    const id = 'w_' + uid();
    const entry = { id, name: fam.trim(), family: fam.trim(), kind: 'url', url: url.trim() };
    try {
      await registerCustomFont(entry);
      const list = [...((await idb.get('fonts')) || []), entry];
      await saveStoredFonts(list);
      store.set(st => ({ ...st, customFonts: [...st.customFonts, { id, name: entry.name, family: entry.family, kind: 'url' }], label: { ...st.label, fontId: id } }));
      setUrl(''); setFam('');
      bumpFonts();
      toast('웹폰트를 추가했어요');
    } catch { toast('웹폰트를 불러오지 못했어요'); }
  };
  const removeFont = async () => {
    const id = L.fontId;
    if (!custom.some(f => f.id === id)) return;
    if (!(await askConfirm('fontDelete', '이 폰트를 목록에서 지울까요?', { title: '폰트 삭제', ok: '지우기' }))) return;
    const list = ((await idb.get('fonts')) || []).filter(f => f.id !== id);
    await saveStoredFonts(list);
    store.set(st => ({ ...st, customFonts: st.customFonts.filter(f => f.id !== id), label: { ...st.label, fontId: 'galmuri11' } }));
  };
  // 드래그한 구간이 있으면 그 부분만, 없으면 전체
  const [sel, setSel] = useState(null);
  const [scroll, setScroll] = useState(0);
  const [curLine, setCurLine] = useState(0);
  useEffect(() => {
    const f = () => {
      const ta = taRef.current, focused = ta && document.activeElement === ta;
      setSel(focused ? [ta.selectionStart, ta.selectionEnd] : null);
      if (focused) setCurLine(ta.value.slice(0, ta.selectionStart).split('\n').length - 1); // 커서가 있는 줄
    };
    document.addEventListener('selectionchange', f);
    return () => document.removeEventListener('selectionchange', f);
  }, []);
  const ranged = sel && sel[1] > sel[0];
  const B = (k, t) => {
    const on = ranged ? covered(L, k, sel[0], sel[1]) : !!L[k];
    const part = !ranged && !L[k] && hasMarks(L, k);
    const tip = t + ' (드래그한 부분만 / 선택 없으면 전체)';
    return html`<button class=${'btn sq' + (on ? ' on' : '') + (part ? ' part' : '')} title=${tip} aria-label=${t}
      onMouseDown=${e => e.preventDefault()}
      onClick=${() => setLabel(l => ranged ? toggleMark(l, k, sel[0], sel[1]) : toggleAll(l, k))}><${UiIcon} name=${k} /></button>`;
  };
  const lines = (L.text || '').split('\n');
  const multi = lines.length > 1;
  const cur = Math.min(curLine, lines.length - 1);
  const setSize = (i, v) => setLabel(l => { const ls = [...(l.lineSizes || [])]; while (ls.length <= i) ls.push('l'); ls[i] = v; return { lineSizes: ls }; });
  const taH = Math.min(8, Math.max(3, lines.length)) * 20 + 15;
  const A = (v, t) => html`<button class=${'btn sq' + (L.align === v ? ' on' : '')} title=${t} aria-label=${t} onClick=${() => setLabel({ align: v })}><${UiIcon} name=${'al_' + v} /></button>`;
  return html`
    <${Sec} title="Text" sub="텍스트 · 폰트">
      <div class=${'ed' + (multi ? ' multi' : '')}>
        ${multi ? html`<div class="ed-no" style=${'height:' + taH + 'px'}><div style=${`transform:translateY(${-scroll}px)`}>
          ${lines.map((_, i) => html`<div class=${'ed-row ln' + (i === cur ? ' on' : '')} title=${`${i + 1}번째 줄 크기 바꾸기`} onMouseDown=${e => e.preventDefault()} onClick=${() => setCurLine(i)}>${CIRC[i] || `(${i + 1})`}</div>`)}</div></div>` : null}
        <textarea class="main" wrap="off" ref=${taRef} value=${L.text} style=${'height:' + taH + 'px'}
          onInput=${e => setLabel(l => editText(l, e.target.value))} onScroll=${e => setScroll(e.target.scrollTop)} placeholder="라벨에 넣을 글자"></textarea>
      </div>
      <div class="row" style="margin-top:10px">
        <span class="lbl">맞춤</span>
        <${Toggle} value=${L.sizeMode} onChange=${v => setLabel({ sizeMode: v })} options=${[['auto', '자동'], ['manual', '직접']]} />
        ${L.sizeMode === 'manual' ? html`<input class="num" type="number" min="3" max="200" step="0.5" value=${L.sizePt} onInput=${e => setLabel({ sizePt: +e.target.value || 14 })} /><span style="font-size:10px">pt</span>` : null}
      </div>
      ${multi ? html`
        <div class="row ln-row">
          <span class="lbl"><span class="ln-cur">${CIRC[cur] || `(${cur + 1})`}</span> 크기</span>
          <${Toggle} value=${L.lineSizes?.[cur] || 'l'} onChange=${v => setSize(cur, v)} options=${LINE_SIZES} />
        </div>` : null}
      <div class="row">
        <span class="lbl">스타일</span>
        ${B('bold', '굵게')}${B('italic', '기울임')}${B('underline', '밑줄')}${B('strike', '취소선')}${B('outline', '외곽선')}${B('hl', '텍스트 배경색')}${B('pt', '포인트색 글자')}
      </div>
      <div class="row">
        <span class="lbl">정렬</span>
        ${A('left', '왼쪽 정렬')}${A('center', '가운데 정렬')}${A('right', '오른쪽 정렬')}${A('justify', '양쪽 정렬')}
      </div>
      <div class="row" style="margin-top:20px">
        <select class="pill fontsel" value=${L.fontId} style=${'font-family:' + ffam(fontById(L.fontId, custom))} onPointerDown=${loadAllFonts} onFocus=${loadAllFonts} onChange=${e => setLabel({ fontId: e.target.value })}>
          ${Object.entries(groups).map(([g, fs]) => html`<optgroup label=${g}>${fs.map(f => html`<option value=${f.id} style=${'font-family:' + ffam(f)}>${f.name}</option>`)}</optgroup>`)}
          ${custom.length ? html`<optgroup label="내 폰트">${custom.map(f => html`<option value=${f.id} style=${'font-family:' + ffam(f)}>${f.name}</option>`)}</optgroup>` : null}
        </select>
        ${custom.some(f => f.id === L.fontId) ? html`<button class="btn" onClick=${removeFont} title="내 폰트 삭제">✕</button>` : null}
      </div>
      <div class="sub-h">내 폰트 추가</div>
      <div class="row">
        <button class="btn" onClick=${() => fileRef.current.click()}>📁 폰트 파일 (.ttf/.otf/.woff)</button>
        <input type="file" ref=${fileRef} accept=".ttf,.otf,.woff,.woff2" style="display:none" onChange=${addFile} />
      </div>
      <div class="row"><input class="txt" placeholder="웹폰트 CSS 또는 woff URL" value=${url} onInput=${e => setUrl(e.target.value)} /></div>
      <div class="row"><input class="txt" placeholder="font-family 이름" value=${fam} onInput=${e => setFam(e.target.value)} /><button class="btn" onClick=${addUrl}>임베드</button></div>
    <//>`;
}

// 폰트 목록에서 이름을 그 폰트로 보여주기
const ffam = f => `'${f.family}', var(--ui)`;
const loadAllFonts = () => BUILTIN_FONTS.forEach(f => ensureFont(f));
function SizeSec({ s }) {
  const L = s.label;
  // 가로↔세로 전환 시 장식 위치도 함께 회전 (좌우 양 끝 ↔ 위아래 양 끝)
  const setOri = v => setLabel(l => {
    const isV = o => o === 'v';
    if (isV(l.orientation) === isV(v)) return { orientation: v };
    const d = l.deco;
    const deco = isV(v) ? { top: d.left, bottom: d.right, left: d.top, right: d.bottom } : { left: d.top, right: d.bottom, top: d.left, bottom: d.right };
    return { orientation: v, deco };
  });
  const O = (v, t) => html`<button class=${'btn' + (L.orientation === v ? ' on' : '')} onClick=${() => setOri(v)}>${t}</button>`;
  const flowAuto = L.orientation === 'h' || L.orientation === 'v';
  return html`
    <${Sec} title="Size" sub="크기 · 방향">
      <div class="row"><span class="lbl">방향</span>${O('h', '가로')}${O('v', '세로')}${O('square', '정방')}${O('free', '자유')}</div>
      ${L.orientation !== 'free' ? html`
        <div class="row"><span class="lbl">테이프</span>
          ${TAPE_WIDTHS.map(w => html`<span class=${'chip' + (L.tapeMm === w ? ' on' : '')} onClick=${() => setLabel({ tapeMm: w, tapePrev: null })}>${w}</span>`)}
          <input class="num" type="number" min="3" max="200" step="0.5" value=${L.tapeMm} onInput=${e => setLabel({ tapeMm: +e.target.value || 12, tapePrev: null })} /><span style="font-size:10px">mm</span>
        </div>` : html`
        <div class="row"><span class="lbl">가로×세로</span>
          <input class="num" type="number" min="3" max="400" value=${L.freeW} onInput=${e => setLabel({ freeW: +e.target.value || 40 })} />×
          <input class="num" type="number" min="3" max="400" value=${L.freeH} onInput=${e => setLabel({ freeH: +e.target.value || 20 })} /><span style="font-size:10px">mm</span>
        </div>`}
      ${flowAuto ? html`
        <div class="row"><span class="lbl">길이</span>
          <${Toggle} value=${L.lengthMode} onChange=${v => setLabel({ lengthMode: v })} options=${[['auto', '자동'], ['fixed', '고정']]} />
          ${L.lengthMode === 'fixed' ? html`<input class="num" type="number" min="5" max="1000" value=${L.lengthMm} onInput=${e => setLabel({ lengthMm: +e.target.value || 50 })} /><span style="font-size:10px">mm</span>` : null}
        </div>
        <div class="row"><span class="lbl">줄바꿈</span>
          <${Toggle} value=${L.wrapMode} onChange=${v => setLabel({ wrapMode: v })} options=${[['shrink', '폭 고정·글자 축소'], ['grow', '높이 늘림']]} />
        </div>` : null}
      <${Range} label="여백 ↔" min=${0} max=${10} step=${0.5} value=${L.padX} onInput=${v => setLabel({ padX: v })} fmt=${v => v + 'mm'} />
      <${Range} label="여백 ↕" min=${0} max=${6} step=${0.25} value=${L.padY} onInput=${v => setLabel({ padY: v })} fmt=${v => v + 'mm'} />
    <//>`;
}

function TypeSec({ s }) {
  const L = s.label;
  const save = async () => {
    const name = await askText('타이포 프리셋 이름을 정해주세요', `${fontById(L.fontId, s.customFonts).name} 프리셋`, { title: '타이포 프리셋' });
    if (!name) return;
    const p = { id: uid(), name, fontId: L.fontId, sizeMode: L.sizeMode, sizePt: L.sizePt, tracking: L.tracking, leading: L.leading, widthScale: L.widthScale };
    store.set(st => ({ ...st, typePresets: [...st.typePresets, p] }));
    toast('타이포 프리셋을 저장했어요');
  };
  const apply = id => {
    if (id === 'default') { setLabel({ tracking: 0, leading: 1.2, widthScale: 100 }); return; }
    const p = s.typePresets.find(x => x.id === id);
    if (p) { const { id: _, name, ...rest } = p; setLabel(rest); }
  };
  const del = () => {
    const sel = document.getElementById('tp-sel').value;
    if (sel === 'default') return;
    store.set(st => ({ ...st, typePresets: st.typePresets.filter(p => p.id !== sel) }));
  };
  return html`
    <${Sec} title="Type" sub="자간 · 행간 · 장평">
      <${Range} label="자간" min=${-30} max=${100} value=${L.tracking} onInput=${v => setLabel({ tracking: v })} />
      <${Range} label="행간" min=${0.6} max=${2.5} step=${0.05} value=${L.leading} onInput=${v => setLabel({ leading: v })} fmt=${v => v.toFixed(2)} />
      <${Range} label="장평" min=${50} max=${200} value=${L.widthScale} onInput=${v => setLabel({ widthScale: v })} fmt=${v => v + '%'} />
      <div class="row">
        <select id="tp-sel" class="pill" onChange=${e => apply(e.target.value)}>
          <option value="default">기본값</option>
          ${s.typePresets.map(p => html`<option value=${p.id}>${p.name}</option>`)}
        </select>
        <button class="btn" onClick=${save}>+ 저장</button>
        ${s.typePresets.length ? html`<button class="btn" onClick=${del} title="선택한 프리셋 삭제">✕</button>` : null}
      </div>
    <//>`;
}

const FRAMES = [['none', '없음', ''], ['solid', '실선', 'border:1px solid'], ['dotted', '점선', 'border:1px dotted'], ['double', '이중', 'border:3px double']];
// 순서: 자유롭게 변형되는 것(가로/세로·길이) → 형식이 정해진 것
const SPECIAL = [['dogtag', '◉▭', '군번줄'], ['wongoji', '▦', '원고지'], ['notebook', '⁘▭', '수첩'], ['lace', '⌒⌒', '레이스'], ['lace2', '⟋⟋', '사선 레이스'],
  ['messenger', '💬', '메신저'], ['bubble', '◖ ◗', '말풍선'], ['bubble2', '☺◖', '말풍선|(캐릭터)'], ['torn', '⋚▭⋛', '찢은 테이프'], ['burst', '✸', '강조 말풍선'],
  ['music', '▶❚❚', '뮤직'], ['music2', '♫ ━', '뮤직|(가사)'], ['omamori', '⛩', '오마모리'], ['virus', '▣↗', '믿어주세요...'],
  ['search', '( ⌕)', '검색창'], ['chalk', '▬▭', '칠판'], ['sms', '▯✉', '문자'], ['dialog', '▭☒', '확인창'],
  ['memo', '✿┆', '메모'],
  ['wanted', '$▣', '수배지'], ['sparkle', '—✦', '반짝 라인'], ['tv', '📺︎', 'TV'], ['halftone', '☆⁘', '하프톤 별'], ['wings', '𓆩♡𓆪', '날개'], ['mart', '▥₩', '마트 스티커']];
const SPECIAL_PER_PAGE = 8;
const VIRUS_TEXT = { ko: '절대\n바이러스\n아닙니다.\n믿어\n주세요... 전\n돌고래입니\n다', en: 'Totally not a\nvirus.Trust\nme...im a\ndolphin' };
const SPECIAL_DEFAULT_TEXT = {
  music: '노래 제목\n아티스트', messenger: '자도 자도\n계속 자고 싶어요…', dogtag: 'NAME : 콩이\nID : 0412-HWY',
  wongoji: '오늘의 일기', bubble: '소녀가 되…', bubble2: '자도 자도\n계속 자고 싶어요…', omamori: '행운가득', notebook: '내일 일은 난 몰라',
  lace: '오늘의 기록', virus: VIRUS_TEXT.ko, burst: '이겨낸다!!',
  lace2: '오늘의 기록', music2: '노래 제목\n아티스트\n세상 속에서 우리들도\n만남인 걸', search: '좋은 감자 만나는 법', chalk: '오늘의 할 일', sms: '좋은\n감자만나..', dialog: 'Do you want\nto be mine?', memo: 'Reminder:\nYou are enough.', torn: '오늘도 수고했어 ♡', wanted: '콩이', sparkle: 'クール', halftone: '오늘도 반짝', wings: '오늘도 행복', mart: '배가~ 불러베리 [국산]', tv: '▸ 1 PLAYER\n2 PLAYERS',
};
// 특수 프레임 때문에 테이프 폭을 키웠으면 일반 프레임으로 돌아갈 때 원래 폭으로
const leaveSpecial = l => l.tapePrev != null ? { frame: 'none', tapeMm: l.tapePrev, tapePrev: null } : { frame: 'none' };
const CAN_VERTICAL = { dogtag: true, wongoji: true, notebook: true, lace: true, lace2: true }; // 세로형 지원 특수 프레임
const BUBBLE_STYLES = [['round', '심플'], ['corner', '모서리 뾰족'], ['cloud', '구름']];
// '2:25' ↔ 145초
const secs = v => { const m = /^\s*-?\s*(\d+):(\d{1,2})\s*$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };
const mmss = n => `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`;
function FrameSec({ s }) {
  const L = s.label;
  const m = L.music || {};
  const setMusic = p => setLabel({ music: { ...m, ...p } });
  // 진행도 · 지난 시간 · 남은 시간 연동 (전체 길이 = 지난 + 남은)
  const total = (secs(m.cur) ?? 0) + Math.abs(secs(m.remain) ?? 0);
  const onCur = v => {
    const c = secs(v);
    if (c == null || !total) return setMusic({ cur: v });
    const t = Math.max(total, c);
    setMusic({ cur: v, remain: '-' + mmss(t - c), progress: t ? c / t : 0 });
  };
  const onRemain = v => {
    const r = secs(v), c = secs(m.cur);
    if (r == null || c == null) return setMusic({ remain: v });
    const t = c + Math.abs(r);
    setMusic({ remain: v, progress: t ? c / t : 0 });
  };
  const onProg = v => {
    if (!total) return setMusic({ progress: v });
    const c = Math.round(total * v);
    setMusic({ progress: v, cur: mmss(c), remain: '-' + mmss(total - c) });
  };
  const bub = L.bubble || {};
  const setBub = p => setLabel({ bubble: { ...bub, ...p } });
  const pickSpecial = async v => {
    // 믿어주세요...: 문구가 정해진 프레임이라 지금 텍스트를 덮어씀
    if (v === 'virus' && L.frame !== 'virus') {
      if (L.text.trim() && L.text !== VIRUS_TEXT.ko && L.text !== VIRUS_TEXT.en &&
        !(await askConfirm('virusText', '이 프레임은 정해진 문구를 써요.\n지금 입력한 텍스트는 사라져요. 계속할까요?', { title: '텍스트 덮어쓰기', ok: '덮어쓰기' }))) return;
      setLabel(l => ({ frame: 'virus', orientation: 'h', tapeMm: Math.max(l.tapeMm, 24), tapePrev: l.tapeMm < 24 ? l.tapeMm : l.tapePrev ?? null, text: VIRUS_TEXT.ko, marks: {}, lineSizes: [] }));
      return;
    }
    pickOther(v);
  };
  const pickOther = v => setLabel(l => {
    if (l.frame === v) return leaveSpecial(l);
    const patch = { frame: v, orientation: CAN_VERTICAL[v] && l.orientation === 'v' ? 'v' : 'h' };
    const minTape = { music: 24, dogtag: 18, bubble2: 18, bubble: 12, omamori: 12, virus: 24, burst: 12, lace: 12, lace2: 12, music2: 24, sms: 24, chalk: 12, dialog: 18, wanted: 24, tv: 18, mart: 18 }[v];
    if (minTape && l.tapeMm < minTape) { patch.tapeMm = minTape; patch.tapePrev = l.tapePrev ?? l.tapeMm; }
    // 기존 일반 라벨 텍스트면 프레임에 맞는 예시로 채움
    if (!SPECIAL_DEFAULT_TEXT[l.frame] && (v === 'music' || v === 'music2' || v === 'messenger' || v === 'dogtag' || v === 'sms' || v === 'dialog' || v === 'tv') && !l.text.includes('\n')) patch.text = SPECIAL_DEFAULT_TEXT[v];
    if (!l.text.trim()) patch.text = SPECIAL_DEFAULT_TEXT[v];
    if (patch.text) { patch.marks = {}; patch.lineSizes = []; }
    return patch;
  });
  const [page, setPage] = useState(() => Math.max(0, Math.floor(SPECIAL.findIndex(x => x[0] === L.frame) / SPECIAL_PER_PAGE)));
  const pages = Math.ceil(SPECIAL.length / SPECIAL_PER_PAGE);
  const shown = SPECIAL.slice(page * SPECIAL_PER_PAGE, (page + 1) * SPECIAL_PER_PAGE);
  const setText = t => setLabel({ text: t, marks: {}, lineSizes: [] });
  return html`
    <${Sec} title="Frame" sub="프레임">
      <div class="tiles" style="margin-bottom:6px">
        ${FRAMES.map(([v, t, st]) => html`<button class=${'tile' + (L.frame === v ? ' on' : '')} onClick=${() => setLabel(l => ({ ...leaveSpecial(l), frame: v }))}><span style=${st + ';padding:2px 6px'}>${t}</span></button>`)}
      </div>
      ${L.frame === 'solid' || L.frame === 'dotted' || L.frame === 'double' ? html`
        <${Range} label="두께" min=${0.5} max=${4} step=${0.5} value=${L.frameW || 1} onInput=${v => setLabel({ frameW: v })} fmt=${v => '×' + v} />` : null}
      <div class="sub-h">Special</div>
      <div class="tiles">
        ${shown.map(([v, i, t]) => html`<button class=${'tile' + (L.frame === v ? ' on' : '')} title=${t.replace('|', ' ')} onClick=${() => pickSpecial(v)}>${i}${t.split('|').map(x => html`<br/>${x}`)}</button>`)}
      </div>
      ${pages > 1 ? html`<div class="pager">
        <button disabled=${page === 0} onClick=${() => setPage(page - 1)}>‹</button>
        ${Array.from({ length: pages }, (_, i) => html`<button class=${i === page ? 'on' : ''} onClick=${() => setPage(i)}>${i + 1}</button>`)}
        <button disabled=${page === pages - 1} onClick=${() => setPage(page + 1)}>›</button>
      </div>` : null}
      ${L.frame === 'music' || L.frame === 'music2' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">시간</span>
            <input class="num" value=${m.cur} onInput=${e => onCur(e.target.value)} />
            <input class="num" value=${m.remain} onInput=${e => onRemain(e.target.value)} />
          </div>
          <${Range} label="진행" min=${0} max=${1} step=${0.01} value=${m.progress ?? 0.8} onInput=${onProg} fmt=${v => Math.round(v * 100) + '%'} />
          <div class="muted">${L.frame === 'music' ? '첫 줄 제목 · 둘째 줄 아티스트 · 커버는 DECO의 COVER' : '첫 줄 제목 · 둘째 줄 아티스트 · 셋째 줄부터 가사'}</div>
        </div>` : null}
      ${L.frame === 'bubble' || L.frame === 'bubble2' || L.frame === 'messenger' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">말풍선</span>
            <${Toggle} value=${bub.style || 'round'} onChange=${v => setBub({ style: v })} options=${BUBBLE_STYLES} />
          </div>
          ${L.frame === 'bubble' && (bub.style || 'round') === 'round' ? html`
            <div class="row"><span class="lbl">꼬리</span>
              <${Toggle} value=${bub.tail || 'corner'} onChange=${v => setBub({ tail: v })} options=${[['corner', '모서리'], ['center', '가운데']]} />
            </div>` : null}
          ${L.frame === 'bubble2' ? html`
            <div class="row"><span class="lbl">캐릭터</span>
              <${Toggle} value=${bub.charSide || 'left'} onChange=${v => setBub({ charSide: v })} options=${[['left', '왼쪽'], ['right', '오른쪽']]} />
            </div>
            <div class="row"><label class="check"><input type="checkbox" checked=${!!bub.bleed} onChange=${e => setBub({ bleed: e.target.checked })} /> 말풍선이 테두리 밖으로</label></div>
            <div class="muted">캐릭터는 DECO의 CHAR</div>` : null}
          ${L.frame === 'bubble' || L.frame === 'bubble2' ? html`
            <div class="row"><label class="check"><input type="checkbox" checked=${!!bub.fill} onChange=${e => setBub({ fill: e.target.checked })} /> 안쪽 채우기 (잉크색)</label></div>
            ${bub.fill ? html`<div class="muted">글자색은 COLOR의 포인트색</div>` : null}` : null}
        </div>` : null}
      ${L.frame === 'omamori' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">스타일</span>
            <${Toggle} value=${L.omamori?.style || 'vertical'} onChange=${v => setLabel({ omamori: { ...(L.omamori || {}), style: v } })}
              options=${[['vertical', '세로 글씨'], ['charm', '그림 + 가로 글씨']]} />
          </div>
          <div class="muted">${(L.omamori?.style || 'vertical') === 'charm' ? '가운데 그림은 DECO의 CHARM' : '줄마다 세로 한 줄 · 아래 장식은 DECO의 CHARM'}</div>
        </div>` : null}
      ${L.frame === 'virus' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">문구</span>
            <button class="btn" onClick=${() => setText(VIRUS_TEXT.ko)}>한국어</button>
            <button class="btn" onClick=${() => setText(VIRUS_TEXT.en)}>English</button>
          </div>
          <div class="muted">그림은 DECO의 ICON · 이름 칸 색은 잉크 + COLOR의 포인트색</div>
        </div>` : null}
      ${L.frame === 'mart' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">마트</span>
            <input class="txt" value=${L.mart?.name ?? '라벨마트'} onInput=${e => setLabel({ mart: { ...(L.mart || {}), name: e.target.value } })} /></div>
          <div class="row"><span class="lbl">바코드</span>
            <input class="txt" value=${L.mart?.code ?? '8 801234 567890'} onInput=${e => setLabel({ mart: { ...(L.mart || {}), code: e.target.value } })} /></div>
          <div class="row"><span class="lbl">가격(원)</span>
            <input class="txt" value=${L.mart?.price ?? '9,170'} onInput=${e => setLabel({ mart: { ...(L.mart || {}), price: e.target.value } })} /></div>
        </div>` : null}
      ${L.frame === 'wanted' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">현상금 $</span>
            <input class="num" style="width:110px" value=${L.wanted?.reward ?? '1,000,000'} onInput=${e => setLabel({ wanted: { ...(L.wanted || {}), reward: e.target.value } })} />
          </div>
          <div class="muted">그림은 DECO의 PHOTO 자리</div>
        </div>` : null}
      ${L.frame === 'sms' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">시간</span>
            <input class="num" value=${L.sms?.time ?? '12:34'} onInput=${e => setLabel({ sms: { ...(L.sms || {}), time: e.target.value } })} />
          </div>
          <div class="row"><label class="check"><input type="checkbox" checked=${!!L.sms?.fill} onChange=${e => setLabel({ sms: { ...(L.sms || {}), fill: e.target.checked } })} /> 화면을 포인트색으로 채우기</label></div>
        </div>` : null}
      ${L.frame === 'dialog' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">버튼</span>
            <input class="num" style="width:64px" value=${L.dialog?.yes ?? 'yes'} onInput=${e => setLabel({ dialog: { ...(L.dialog || {}), yes: e.target.value } })} />
            <input class="num" style="width:64px" value=${L.dialog?.no ?? 'always'} onInput=${e => setLabel({ dialog: { ...(L.dialog || {}), no: e.target.value } })} />
          </div>
          <div class="row"><label class="check"><input type="checkbox" checked=${L.dialog?.cursor !== false} onChange=${e => setLabel({ dialog: { ...(L.dialog || {}), cursor: e.target.checked } })} /> 마우스 커서</label></div>
          <div class="muted">버튼 칸을 비우면 그 버튼은 숨겨요</div>
        </div>` : null}
      ${L.frame === 'burst' ? html`<div class="opt-box"><div class="muted">색은 잉크 + COLOR의 포인트색</div></div>` : null}
      ${L.frame === 'messenger' ? html`
        <div class="opt-box">
          <div class="row"><span class="lbl">첫 말풍선</span>
            <${Toggle} value=${L.messenger?.start || 'left'} onChange=${v => setLabel({ messenger: { ...(L.messenger || {}), start: v } })} options=${[['left', '상대 (왼쪽)'], ['right', '나 (오른쪽)']]} />
          </div>
        </div>` : null}
    <//>`;
}

const PATTERNS = [['none', '없음', ''], ['check', '', 'background-image:linear-gradient(90deg,rgba(47,44,48,.08) 50%,transparent 50%),linear-gradient(rgba(47,44,48,.08) 50%,transparent 50%);background-size:8px 8px'],
  ['stripe', '', 'background-image:repeating-linear-gradient(90deg,transparent 0 5px,rgba(47,44,48,.1) 5px 7px)'],
  ['dot', '', 'background-image:radial-gradient(rgba(47,44,48,.35) 1px,transparent 1.3px);background-size:5px 5px'],
  ['diag', '', 'background-image:repeating-linear-gradient(45deg,transparent 0 4px,rgba(47,44,48,.2) 4px 5px)']];
function PatternSec({ s }) {
  return html`
    <${Sec} title="Pattern" sub="배경 무늬">
      <div class="tiles c5">
        ${PATTERNS.map(([v, t, st]) => html`<button class=${'tile' + (s.label.pattern === v ? ' on' : '')} style=${st} title=${v} onClick=${() => setLabel({ pattern: v })}>${t}</button>`)}
      </div>
    <//>`;
}

const BM_MODES = [['halftone', '하프톤 (점)'], ['dither', '디더 (오차확산)'], ['bayer', '디더 (격자)'], ['threshold', '흑백 (임계값)']];
function BitmapMaker({ onDone }) {
  const fileRef = useRef();
  const pvRef = useRef();
  const [img, setImg] = useState(null);
  const [o, setO] = useState({ cols: 48, mode: 'halftone', threshold: 128, contrast: 1.2, invert: false });
  const rows = useMemo(() => img ? toBitmap(img, o) : null, [img, o]);
  useEffect(() => {
    if (!rows || !pvRef.current) return;
    const cell = Math.max(1, Math.floor(240 / Math.max(rows[0].length, rows.length)));
    const cv = rowsToCanvas(rows, cell);
    const c = pvRef.current;
    c.width = cv.width; c.height = cv.height;
    c.getContext('2d').drawImage(cv, 0, 0);
  }, [rows]);
  const set = p => setO(x => ({ ...x, ...p }));
  const onFile = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { setImg(await loadImageFile(f)); } catch { toast('이미지를 읽지 못했어요'); }
  };
  return html`
    <div class="row" style="margin-top:8px">
      <button class="btn" onClick=${() => fileRef.current.click()}>📷 이미지 → 비트맵</button>
      <input type="file" accept="image/*" ref=${fileRef} style="display:none" onChange=${onFile} />
    </div>
    ${img ? html`
      <div class="opt-box">
        <div class="bm-pv"><canvas ref=${pvRef}></canvas></div>
        <div class="row"><span class="lbl">방식</span>
          <select class="pill" value=${o.mode} onChange=${e => set({ mode: e.target.value })}>
            ${BM_MODES.map(([v, t]) => html`<option value=${v}>${t}</option>`)}
          </select>
        </div>
        <${Range} label="해상도" min=${16} max=${128} step=${4} value=${o.cols} onInput=${v => set({ cols: v })} fmt=${v => v + 'px'} />
        <${Range} label="밝기" min=${40} max=${220} value=${o.threshold} onInput=${v => set({ threshold: v })} />
        <${Range} label="대비" min=${0.5} max=${3} step=${0.1} value=${o.contrast} onInput=${v => set({ contrast: v })} fmt=${v => v.toFixed(1)} />
        <div class="row">
          <label class="check"><input type="checkbox" checked=${o.invert} onChange=${e => set({ invert: e.target.checked })} /> 반전</label>
          <span style="flex:1"></span>
          <button class="btn" onClick=${() => setImg(null)}>취소</button>
          <button class="btn on" onClick=${() => { onDone(rows); setImg(null); }}>넣기</button>
        </div>
      </div>` : null}`;
}

// 내 이미지 썸네일: 점 1개 = 1px 로 그린 뒤 브라우저가 부드럽게 줄여서 사진처럼 보이게
const customThumbs = new Map();
function customThumb(ic) {
  let u = customThumbs.get(ic.id);
  if (u) return u;
  const h = ic.rows.length, w = ic.rows[0]?.length || 1;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  ic.rows.forEach((r, y) => { for (let x = 0; x < w; x++) if (r[x] === 'X') g.fillRect(x, y, 1, 1); });
  u = cv.toDataURL();
  customThumbs.set(ic.id, u);
  return u;
}

const TXT_GROUP = '직접 입력';
const DECO_TXT = ['♡', '♥', '✿', '☆', '⋆｡˚', '♪', '･ﾟ✧', '~', '- - -', '✂ - -', '⊹', '◡'];
function DecoSec({ s }) {
  const L = s.label;
  const hero = L.hero || { icon: null, textPos: 'bottom', size: 0.62 };
  const vert = L.orientation === 'v';
  // 특수 프레임: 가장자리 장식은 안 쓰고, 일부는 가운데 칸을 커버/캐릭터/부적으로 씀
  const HERO_SLOT = { music: ['COVER', '앨범 커버'], bubble2: ['CHAR', '캐릭터'], omamori: ['CHARM', '아래 장식'], virus: ['ICON', '아이콘 그림'], memo: ['ICON', '왼쪽 그림'], wanted: ['PHOTO', '수배 그림'] };
  const special = isSpecialFrame(L.frame);
  const heroSlot = HERO_SLOT[L.frame];
  const music = special; // (이름 유지) 특수 프레임이면 가장자리 장식 비활성
  const noHero = (special && !heroSlot) || (!special && vert);
  const slot = special ? 'hero' : (vert && s.ui.decoSlot === 'hero' ? 'left' : s.ui.decoSlot);
  const names = { top: '위', bottom: '아래', left: '왼쪽', right: '오른쪽', hero: heroSlot ? heroSlot[1] : '메인 그림' };
  const groups = { ...ICON_GROUPS, ...(s.customIcons.length ? { '내 이미지': s.customIcons.map(i => i.id) } : {}), [TXT_GROUP]: [] };
  // 방향 버튼을 누르면 그 자리에 들어 있는 아이콘의 탭을 바로 열어줌
  const goSlot = (k, icon) => {
    const g = icon && (isTxtDeco(icon) ? TXT_GROUP : Object.keys(groups).find(n => groups[n].includes(icon)));
    setUi(g ? { decoSlot: k, iconGroup: g } : { decoSlot: k });
  };
  const D = (k, ch) => html`<button class=${(L.deco[k] ? 'has' : '') + (slot === k ? ' cur' : '')} disabled=${music} onClick=${() => goSlot(k, L.deco[k])} title=${names[k]}>${ch}</button>`;
  const cur = slot === 'hero' ? hero.icon : L.deco[slot];
  const pick = n => setLabel(l => slot === 'hero'
    ? { hero: { ...hero, icon: hero.icon === n ? null : n } }
    : { deco: { ...l.deco, [slot]: l.deco[slot] === n ? null : n } });
  const setHero = p => setLabel({ hero: { ...hero, ...p } });
  const group = groups[s.ui.iconGroup] ? s.ui.iconGroup : '동물';
  const list = groups[group];
  const sideName = vert ? '좌/우' : '위/아래';
  const ds = L.decoScale || 1;
  const addBitmap = rows => {
    const id = 'img_' + uid();
    store.set(st => {
      const customIcons = [...st.customIcons, { id, name: `이미지 ${st.customIcons.length + 1}`, rows }];
      const label = slot === 'hero' ? { ...st.label, hero: { ...hero, icon: id } } : { ...st.label, deco: { ...st.label.deco, [slot]: id } };
      return { ...st, customIcons, label, ui: { ...st.ui, iconGroup: '내 이미지' } };
    });
  };
  const delCustom = async () => {
    if (!cur || !cur.startsWith('img_')) return;
    if (!(await askConfirm('imageDelete', '이 이미지를 목록에서 지울까요?\n이미 서랍에 넣은 라벨에서도 사라져요.', { title: '이미지 삭제', ok: '지우기' }))) return;
    store.set(st => ({ ...st, customIcons: st.customIcons.filter(i => i.id !== cur), label: { ...st.label, hero: st.label.hero?.icon === cur ? { ...st.label.hero, icon: null } : st.label.hero, deco: Object.fromEntries(Object.entries(st.label.deco).map(([k, v]) => [k, v === cur ? null : v])) } }));
  };
  return html`
    <${Sec} title="Deco" sub="장식 · 메인 그림">
      <div class="row" style="align-items:flex-start;gap:12px">
        <div class="dpad">
          <span></span>${D('top', '↑')}<span></span>
          ${D('left', '←')}
          <button class=${'c' + (hero.icon && !noHero ? ' has' : '') + (slot === 'hero' && !noHero ? ' cur' : '')} disabled=${noHero} title=${names.hero} onClick=${() => goSlot('hero', hero.icon)}>${heroSlot ? heroSlot[0] : 'MAIN'}</button>
          ${D('right', '→')}
          <span></span>${D('bottom', '↓')}<span></span>
        </div>
        <div style="flex:1;font-size:10px;line-height:1.6">
          ${special && !heroSlot ? html`<span class="muted">이 프레임은 장식 없음</span><br/>` : html`<b>${names[slot]}</b> → 아이콘 클릭<br/>`}
          ${!music ? html`
            <label class="check"><input type="checkbox" checked=${!!L.decoRepeat} onChange=${e => setLabel({ decoRepeat: e.target.checked })} /> ${sideName} 반복</label>
            <div class="row" style="margin:4px 0 0;gap:3px"><span>크기</span>
              <button class="btn sq" onClick=${() => setLabel({ decoScale: Math.max(0.4, +(ds - 0.1).toFixed(2)) })}>−</button>
              <span style="width:34px;text-align:center">${Math.round(ds * 100)}%</span>
              <button class="btn sq" onClick=${() => setLabel({ decoScale: Math.min(1.6, +(ds + 0.1).toFixed(2)) })}>+</button>
            </div>` : null}
          <div style="margin-top:4px"><button class="btn" onClick=${() => setLabel({ deco: { top: null, bottom: null, left: null, right: null }, hero: { ...hero, icon: null } })}>모두 빼기</button></div>
        </div>
      </div>
      ${slot === 'hero' && !music ? html`
        <div class="row"><span class="lbl">글자</span>
          <${Toggle} value=${hero.textPos} onChange=${v => setHero({ textPos: v })} options=${[['bottom', '그림 아래'], ['top', '그림 위']]} />
        </div>
        <${Range} label="그림 크기" min=${0.3} max=${0.85} step=${0.01} value=${hero.size} onInput=${v => setHero({ size: v })} fmt=${v => Math.round(v * 100) + '%'} />` : null}
      <div class="row">
        <select class="pill" value=${group} onChange=${e => setUi({ iconGroup: e.target.value })}>
          ${Object.keys(groups).map(g => html`<option value=${g}>${g}</option>`)}
        </select>
        ${group === '내 이미지' && cur && cur.startsWith('img_') ? html`<button class="btn" onClick=${delCustom}>✕ 선택 이미지 삭제</button>` : null}
      </div>
      ${group === TXT_GROUP ? (slot === 'hero' ? html`<div class="muted" style="font-size:10px">글자 장식은 위·아래·왼쪽·오른쪽 자리에만 넣을 수 있어요</div>` : html`
        <div class="row"><input class="txt" placeholder="장식 글자 (예: ♡ ⋆ ˚｡)" value=${isTxtDeco(cur) ? cur.slice(4) : ''}
          onInput=${e => setLabel(l => ({ deco: { ...l.deco, [slot]: e.target.value ? 'txt:' + e.target.value : null } }))} /></div>
        <div class="row" style="flex-wrap:wrap;gap:3px">
          ${DECO_TXT.map(t => html`<button class="btn" onClick=${() => setLabel(l => ({ deco: { ...l.deco, [slot]: 'txt:' + t } }))}>${t}</button>`)}
        </div>
        <div class="muted" style="font-size:10px">${sideName} 반복을 켜면 프레임처럼 이어져요</div>`) : group === '내 이미지' ? html`
        <div class="lib big">
          ${s.customIcons.map(ic => html`<button class=${cur === ic.id ? 'on' : ''} title=${ic.name} onClick=${() => pick(ic.id)}><img src=${customThumb(ic)} alt=${ic.name} /></button>`)}
        </div>` : html`
        <div class="lib">
          ${list.map(n => html`<button class=${cur === n ? 'on' : ''} title=${n} onClick=${() => pick(n)}><${Px} name=${n} s=${2} c="#fff" fit=${26} /></button>`)}
        </div>`}
      <${BitmapMaker} onDone=${addBitmap} />
    <//>`;
}

const KAOMOJI = ['ʕ•ᴥ•ʔ', '(｡•́︿•̀｡)', '(˘ω˘)', '( ˙꒳˙ )', '(*ᴗ͈ˬᴗ͈)ꕤ', '٩(ˊᗜˋ*)و', '(っ˘ڡ˘ς)', '♡', '♥', '☆', '★', '✿', '❀', '♪', '☁', '☾', '…', '⸝⸝', '→', '✧'];
function EmojiSec({ s, taRef }) {
  const L = s.label;
  const insert = t => {
    const ta = taRef.current;
    const a = ta ? ta.selectionStart : L.text.length, b = ta ? ta.selectionEnd : L.text.length;
    const text = L.text.slice(0, a) + t + L.text.slice(b);
    setLabel(l => editText(l, text));
    requestAnimationFrame(() => { if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = a + t.length; } });
  };
  const addFav = async () => {
    const t = await askText('내 이모지에 넣을 이모티콘이나 기호', '', { title: '내 이모지 추가', ok: '추가' });
    if (t) store.set(st => ({ ...st, kaomojiFav: [...st.kaomojiFav, t] }));
  };
  const onFav = (e, t, i) => {
    if (e.shiftKey) store.set(st => ({ ...st, kaomojiFav: st.kaomojiFav.filter((_, j) => j !== i) }));
    else insert(t);
  };
  const open = !!s.ui.emojiOpen;
  const btnRef = useRef();
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const side = document.querySelector('.side.l');
      const b = btnRef.current;
      if (!side || !b) return;
      const rs = side.getBoundingClientRect(), rb = b.getBoundingClientRect();
      setPos({ left: rs.right + 6, top: Math.max(8, Math.min(rb.top, window.innerHeight - 340)) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);
  return html`
    <div class="sec">
      <button class=${'flybtn' + (open ? ' on' : '')} ref=${btnRef} onClick=${() => setUi({ emojiOpen: !open })}>
        <span>Emoji <i>이모지 · 이모티콘</i></span><span>${open ? '◂' : '▸'}</span>
      </button>
    </div>
    ${open && pos ? html`
      <div class="fly" style=${`left:${pos.left}px;top:${pos.top}px`}>
        <div class="h">Emoji <i>이모지 · 이모티콘 <button class="x" onClick=${() => setUi({ emojiOpen: false })}>✕</button></i></div>
        <div class="body">
          <div class="row"><span class="lbl">이모지</span>
            <${Toggle} value=${L.emojiMono} onChange=${v => setLabel({ emojiMono: v })} options=${[[true, '흑백 변환'], [false, '컬러 유지']]} />
          </div>
          <div class="sub-h">기본</div>
          <div class="kao" style="margin-bottom:6px">${KAOMOJI.map(t => html`<button onClick=${() => insert(t)}>${t}</button>`)}</div>
          <div class="sub-h">내 이모지 ${s.kaomojiFav.length ? html`<span style="text-transform:none;letter-spacing:0">(shift+클릭 = 삭제)</span>` : null}</div>
          <div class="kao">
            ${s.kaomojiFav.map((t, i) => html`<button onClick=${e => onFav(e, t, i)}>${t}</button>`)}
            <button style="border-style:dashed" onClick=${addFav}>+ 추가</button>
          </div>
        </div>
      </div>` : null}`;
}

function Left({ s, fv }) {
  const taRef = useRef();
  return html`
    <aside class="side l">
      <${Preview} s=${s} fv=${fv} />
      <div class="scroll">
        <${EmojiSec} s=${s} taRef=${taRef} />
        <${TextSec} s=${s} taRef=${taRef} />
        <${SizeSec} s=${s} />
        <${TypeSec} s=${s} />
        <${FrameSec} s=${s} />
        <${PatternSec} s=${s} />
        <${DecoSec} s=${s} />
      </div>
    </aside>`;
}

// ---------------- CENTER ----------------
// 판 배치 되돌리기 기록 (메모리에만, 최대 50단계)
const boardHist = [];
function pushBoardHist() {
  const b = store.get().board;
  boardHist.push({ items: b.items, layout: b.layout });
  if (boardHist.length > 50) boardHist.shift();
}
// 드래그했는데 아무것도 안 바뀌었으면 방금 쌓은 기록 취소
function dropBoardHistIfSame() {
  const last = boardHist[boardHist.length - 1];
  if (last && last.items === store.get().board.items) boardHist.pop();
}
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
let nudgeAt = 0;
function undoBoard() {
  const last = boardHist.pop();
  if (!last) return;
  store.set(st => ({ ...st, board: { ...st.board, items: last.items, layout: last.layout } }));
}
function Center({ s, fv }) {
  const wrapRef = useRef();
  const [fit, setFit] = useState(0.5);
  const { board, drawer } = s;
  useEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setFit(Math.max(0.05, Math.min((r.width - 40) / board.w, (r.height - 70) / board.h)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [board.w, board.h]);
  const scale = s.ui.zoom ? fit * s.ui.zoom : fit;
  const byId = useMemo(() => Object.fromEntries(drawer.map(l => [l.id, l])), [drawer]);
  const sel = s.ui.boardSel;
  const picked = new Set(s.selected);
  const clearSel = () => store.set(st => ({ ...st, selected: [], ui: { ...st.ui, boardSel: null } }));
  // Delete 키: 판/서랍에서 선택한 라벨 지우기 / Ctrl+Z: 배치 되돌리기 (글자 입력 중엔 무시)
  useEffect(() => {
    const onKey = e => {
      const undoKey = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z');
      const arrow = ARROWS[e.key];
      if (e.key !== 'Delete' && !undoKey && !arrow) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.dlg-back')) return;
      if (undoKey) { e.preventDefault(); undoBoard(); return; }
      if (arrow) { // 방향키: 선택한 라벨 1px씩 (Shift: 10px)
        const st = store.get();
        const ids = new Set(st.selected.length ? st.selected : st.ui.boardSel ? [st.ui.boardSel] : []);
        if (!ids.size || !st.board.items.some(x => ids.has(x.id))) return;
        e.preventDefault();
        const k = e.shiftKey ? 10 : 1;
        // 연달아 누르는 동안은 되돌리기 한 번으로 묶음
        if (Date.now() - nudgeAt > 600) pushBoardHist();
        nudgeAt = Date.now();
        store.set(st2 => ({ ...st2, board: { ...st2.board, layout: 'free', items: st2.board.items.map(x => ids.has(x.id) ? { ...x, x: x.x + arrow[0] * k, y: x.y + arrow[1] * k } : x) } }));
        return;
      }
      const st = store.get();
      const ids = st.selected.length ? st.selected : st.ui.boardSel ? [st.ui.boardSel] : [];
      if (ids.length) { e.preventDefault(); removeLabels(ids); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const relayout = mode => {
    pushBoardHist();
    store.set(st => {
      const b = { ...st.board, layout: mode === 'auto' ? 'auto' : 'free' };
      b.items = mode === 'auto' ? autoLayout(st.drawer, st.customFonts, b) : scatterLayout(st.drawer, st.customFonts, b);
      return { ...st, board: b };
    });
  };
  const modItem = (fn) => {
    if (!sel) { toast('판에서 라벨을 먼저 클릭해 선택하세요'); return; }
    pushBoardHist();
    store.set(st => {
      let items = st.board.items.slice();
      const i = items.findIndex(x => x.id === sel);
      if (i < 0) return st;
      items = fn(items, i);
      return { ...st, board: { ...st.board, items, layout: 'free' } };
    });
  };
  const rotate = d => modItem((items, i) => { items[i] = { ...items[i], rot: (items[i].rot || 0) + d }; return items; });
  const front = () => modItem((items, i) => { const [x] = items.splice(i, 1); items.push(x); return items; });
  const back = () => modItem((items, i) => { const [x] = items.splice(i, 1); items.unshift(x); return items; });

  const drag = useRef(null);
  const [guides, setGuides] = useState(null); // 스마트 가이드 선 { x: [...], y: [...] } (판 좌표)
  const snapOn = s.ui.snap !== false;
  // 회전까지 반영한 겉 상자 (판 좌표)
  const aabb = (it, im) => {
    const w = im.w * (it.s || 1), h = im.h * (it.s || 1), a = (it.rot || 0) * Math.PI / 180;
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)), bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const cx = it.x + w / 2, cy = it.y + h / 2;
    return { l: cx - bw / 2, r: cx + bw / 2, t: cy - bh / 2, b: cy + bh / 2, cx, cy };
  };
  const dims = it => { const L = byId[it.id]; const im = L ? labelImage(L, s.customFonts, ppm) : { w: 0, h: 0 }; return im; };
  const startDrag = (e, it, mode) => {
    e.preventDefault();
    e.stopPropagation();
    pushBoardHist(); // 움직이지 않고 끝나면 onUp 에서 취소
    // 판에서 고른 라벨 = 서랍에서 선택한 라벨 (shift/ctrl: 여러 개)
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;
    store.set(st => {
      const has = st.selected.includes(it.id);
      const selected = multi ? (has && mode === 'move' ? st.selected.filter(x => x !== it.id) : has ? st.selected : [...st.selected, it.id]) : (has && mode !== 'move' ? st.selected : [it.id]);
      return { ...st, selected, ui: { ...st.ui, boardSel: it.id } };
    });
    const el = e.currentTarget.closest('.item');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const im = dims(it);
    drag.current = { mode, id: it.id, sx: e.clientX, sy: e.clientY, x: it.x, y: it.y, s: it.s || 1, rot: it.rot || 0, cx, cy, w: im.w, h: im.h,
      d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, a0: Math.atan2(e.clientY - cy, e.clientX - cx) };
    if (mode === 'move') {
      // 맞출 기준선: 판 가장자리·가운데 + 다른 라벨들의 가장자리·가운데
      const tx = [0, board.w / 2, board.w], ty = [0, board.h / 2, board.h], boxes = [];
      board.items.forEach(o => {
        if (o.id === it.id || !byId[o.id]) return;
        const bb = aabb(o, dims(o));
        boxes.push(bb);
        tx.push(bb.l, bb.cx, bb.r); ty.push(bb.t, bb.cy, bb.b);
      });
      drag.current.tx = tx; drag.current.ty = ty; drag.current.boxes = boxes;
      drag.current.it = it; drag.current.im = im;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = e => {
    const d = drag.current;
    if (!d) return;
    let patch;
    if (d.mode === 'move') {
      patch = { x: d.x + (e.clientX - d.sx) / scale, y: d.y + (e.clientY - d.sy) / scale };
      // 스마트 가이드: 가까운 기준선(화면 6px 이내)에 가장자리·가운데를 붙임. Alt 누르면 자유 이동
      if (snapOn && !e.altKey) {
        const bb = aabb({ ...d.it, ...patch }, d.im), thr = 6 / scale;
        const best = (cands, targets) => {
          let m = null;
          for (const c of cands) for (const t of targets) { const dd = t - c; if (Math.abs(dd) <= thr && (!m || Math.abs(dd) < Math.abs(m.dd))) m = { dd, t }; }
          return m;
        };
        let mx = best([bb.l, bb.cx, bb.r], d.tx), my = best([bb.t, bb.cy, bb.b], d.ty);
        // 간격 맞추기: 같은 줄(열)에 있는 두 라벨 사이 간격과 같아지는 자리
        const gx = gapSnap(bb, d.boxes, 'x', thr), gy = gapSnap(bb, d.boxes, 'y', thr);
        if (gx && (!mx || Math.abs(gx.dd) <= Math.abs(mx.dd))) mx = gx;
        if (gy && (!my || Math.abs(gy.dd) <= Math.abs(my.dd))) my = gy;
        if (mx) patch.x += mx.dd;
        if (my) patch.y += my.dd;
        const fb = aabb({ ...d.it, ...patch }, d.im); // 붙인 뒤 위치
        const gaps = [mx, my].filter(m => m && m.gap).flatMap(m => m.segs(fb));
        setGuides(mx || my ? { x: mx && !mx.gap ? [mx.t] : [], y: my && !my.gap ? [my.t] : [], gaps } : null);
      } else setGuides(null);
    } else if (d.mode === 'resize') {
      const ns = Math.min(5, Math.max(0.2, d.s * Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / d.d0));
      const bcx = d.x + d.w * d.s / 2, bcy = d.y + d.h * d.s / 2;
      patch = { s: ns, x: bcx - d.w * ns / 2, y: bcy - d.h * ns / 2 };
    } else {
      let rot = d.rot + (Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.a0) * 180 / Math.PI;
      if (snapOn ? !e.altKey : e.shiftKey) rot = Math.round(rot / 15) * 15; // SNAP 켜짐: 15°씩 (Alt: 자유)
      patch = { rot: Math.round(rot * 10) / 10 };
    }
    store.set(st => ({ ...st, board: { ...st.board, layout: 'free', items: st.board.items.map(x => x.id === d.id ? { ...x, ...patch } : x) } }));
  };
  const onUp = () => {
    if (drag.current) dropBoardHistIfSame();
    drag.current = null; setGuides(null);
  };

  const bgCls = { mat: 'bg-mat', grid: 'bg-grid', trans: 'bg-trans' }[board.bg] || '';
  // 판 비율과 상관없이 칸이 정사각형으로 보이도록 px 단위로 지정
  const sq = f => `${board.w * f * scale}px ${board.w * f * scale}px`;
  const bgStyle = board.bg === 'plain' ? `background:${board.bgColor}`
    : board.bg === 'image' && board.bgImage ? `background:url(${board.bgImage}) center/cover`
    : board.bg === 'mat' ? `background-size:${sq(0.1)},${sq(0.1)},${sq(0.025)},${sq(0.025)}`
    : board.bg === 'grid' ? `background-size:${sq(0.03)},${sq(0.03)}` : '';
  const ppm = BOARD_PPM * (board.scale || 1);
  return html`
    <main class="center">
      <div class="tb">
        <button class="btn sq" title="배치 되돌리기 (Ctrl+Z)" disabled=${!boardHist.length} onClick=${undoBoard}>↶</button>
        <button class=${'btn' + (board.layout === 'auto' ? ' on' : '')} onClick=${() => relayout('auto')}>자동배치</button>
        <button class="btn" onClick=${() => relayout('scatter')}>흩뿌리기</button>
        <span style="width:8px"></span>
        <button class="btn sq" title="왼쪽으로 5° 회전" onClick=${() => rotate(-5)}>⟲</button>
        <button class="btn sq" title="오른쪽으로 5° 회전" onClick=${() => rotate(5)}>⟳</button>
        <button class="btn sq" title="맨 앞으로" onClick=${front}>⤒</button>
        <button class="btn sq" title="맨 뒤로" onClick=${back}>⤓</button>
        <span class="sp"></span>
        <button class=${'btn' + (snapOn ? ' on' : '')} title="스마트 가이드: 판·다른 라벨의 가장자리·가운데에 맞춰 붙기 (Alt 누르고 끌면 자유 이동)" onClick=${() => setUi({ snap: !snapOn })}>SNAP</button>
        <span style="width:6px"></span>
        <span style="font-size:10px;letter-spacing:.1em">ZOOM</span>
        <button class="btn sq" onClick=${() => setUi({ zoom: Math.max(0.25, (s.ui.zoom || 1) - 0.25) })}>−</button>
        <button class="btn" onClick=${() => setUi({ zoom: 0 })}>${s.ui.zoom ? Math.round(s.ui.zoom * 100) + '%' : 'FIT'}</button>
        <button class="btn sq" onClick=${() => setUi({ zoom: Math.min(4, (s.ui.zoom || 1) + 0.25) })}>+</button>
      </div>
      <div class="board-wrap" ref=${wrapRef} onPointerDown=${e => { if (e.target === e.currentTarget) clearSel(); }}>
        <div class=${'board ' + bgCls} style=${`width:${board.w * scale}px;height:${board.h * scale}px;${bgStyle}`}
             onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onLostPointerCapture=${onUp} onPointerDown=${e => { if (e.target === e.currentTarget) clearSel(); }}>
          ${board.items.map(it => {
            const L = byId[it.id];
            if (!L) return null;
            const im = labelImage(L, s.customFonts, ppm);
            const k = (it.s || 1) * scale;
            return html`<div class=${'item' + (sel === it.id ? ' sel' : picked.has(it.id) ? ' picked' : '')} key=${it.id}
              style=${`left:${it.x * scale}px;top:${it.y * scale}px;width:${im.w * k}px;height:${im.h * k}px;transform:rotate(${it.rot || 0}deg)`}
              onPointerDown=${e => startDrag(e, it, 'move')}>
              <img src=${im.url} draggable="false" />
              ${sel === it.id ? html`
                <span class="hdl rt" title=${snapOn ? '회전 (15°씩 · Alt: 자유)' : '회전 (shift: 15°씩)'} onPointerDown=${e => startDrag(e, it, 'rotate')}></span>
                <span class="hdl rs" title="크기" onPointerDown=${e => startDrag(e, it, 'resize')}></span>` : null}
            </div>`;
          })}
          ${guides ? guides.gaps.map(g => html`<div class=${'gap gap-' + g.ax} style=${g.ax === 'x'
              ? `left:${g.a * scale}px;width:${(g.b - g.a) * scale}px;top:${g.c * scale}px`
              : `top:${g.a * scale}px;height:${(g.b - g.a) * scale}px;left:${g.c * scale}px`}><span>${Math.round(g.b - g.a)}</span></div>`) : null}
          ${guides ? html`${guides.x.map(x => html`<div class="guide gv" style=${`left:${x * scale}px`}></div>`)}${guides.y.map(y => html`<div class="guide gh" style=${`top:${y * scale}px`}></div>`)}` : null}
          ${!drawer.length ? html`<div class="empty">서랍이 비어 있어요<br/>왼쪽에서 라벨을 만들고 [PRINT!]</div>` : null}
        </div>
      </div>
    </main>`;
}

// 간격 맞추기 후보: 움직이는 상자 m 과 같은 줄에 있는 두 상자 A·B 의 간격 g 를 기준으로
// A-B-[m] (뒤에), [m]-A-B (앞에), A-[m]-B (가운데) 세 자리 중 가장 가까운 곳
function gapSnap(m, boxes, ax, thr) {
  const [lo, hi, plo, phi] = ax === 'x' ? ['l', 'r', 't', 'b'] : ['t', 'b', 'l', 'r'];
  const row = boxes.filter(o => o[plo] < m[phi] && o[phi] > m[plo]).sort((p, q) => p[lo] - q[lo]);
  const mid = (p, q) => (Math.max(p[plo], q[plo]) + Math.min(p[phi], q[phi])) / 2;
  const seg = (a, b, p, q) => ({ ax, a, b, c: mid(p, q) });
  const size = m[hi] - m[lo];
  let best = null;
  const take = (dd, segs) => { if (Math.abs(dd) <= thr && (!best || Math.abs(dd) < Math.abs(best.dd))) best = { dd, gap: true, segs }; };
  for (let i = 0; i < row.length; i++) for (let j = i + 1; j < row.length; j++) {
    const A = row[i], B = row[j], g = B[lo] - A[hi];
    if (g <= 0) continue;
    take(B[hi] + g - m[lo], f => [seg(A[hi], B[lo], A, B), seg(B[hi], f[lo], B, f)]);
    take(A[lo] - g - m[hi], f => [seg(f[hi], A[lo], f, A), seg(A[hi], B[lo], A, B)]);
    if (g > size) take(A[hi] + (g - size) / 2 - m[lo], f => [seg(A[hi], f[lo], A, f), seg(f[hi], B[lo], f, B)]);
  }
  return best;
}

// 서랍에서 라벨 빼기 (서랍 ✕ / 판에서 Delete 키 공통)
async function removeLabels(ids) {
  if (!ids.length) return;
  const msg = ids.length > 1 ? `라벨 ${ids.length}개를 서랍에서 뺄까요?` : '이 라벨을 서랍에서 뺄까요?';
  if (!(await askConfirm('drawerDelete', msg, { title: '라벨 삭제', ok: '빼기' }))) return;
  const gone = new Set(ids);
  store.set(st => {
    const next = { ...st, drawer: st.drawer.filter(d => !gone.has(d.id)), selected: st.selected.filter(x => !gone.has(x)), editingId: gone.has(st.editingId) ? null : st.editingId, ui: { ...st.ui, boardSel: gone.has(st.ui.boardSel) ? null : st.ui.boardSel } };
    return { ...next, board: syncBoard(next) };
  });
}

// ---------------- RIGHT ----------------
function Drawer({ s }) {
  const sel = new Set(s.selected);
  const toggle = id => store.set(st => ({ ...st, selected: sel.has(id) ? st.selected.filter(x => x !== id) : [...st.selected, id] }));
  const edit = L => { store.set(st => ({ ...st, label: { ...L }, editingId: L.id })); };
  const dup = L => store.set(st => {
    const i = st.drawer.findIndex(d => d.id === L.id);
    const drawer = st.drawer.slice(); drawer.splice(i + 1, 0, { ...L, id: uid() });
    const next = { ...st, drawer };
    return { ...next, board: syncBoard(next) };
  });
  const del = L => removeLabels([L.id]);
  // 드래그로 순서 바꾸기: 잡은 줄은 손가락을 따라오고, 나머지는 자리를 비켜주며 밀려남
  const [dg, setDg] = useState(null); // { id, from, to, y0, dy, step }
  const [settle, setSettle] = useState(false); // 놓는 순간엔 애니메이션 끄기 (자리 튐 방지)
  const moved = useRef(false);
  const onDown = (e, i) => {
    if (e.button !== 0 || e.target.closest('input,button')) return;
    const el = e.currentTarget;
    moved.current = false;
    const step = el.offsetHeight + 5; // 줄 높이 + 간격
    const y0 = e.clientY, id = s.drawer[i].id, n = s.drawer.length;
    const box = el.closest('.drawer'), st0 = box.scrollTop;
    let lastY = y0, raf = 0, t0 = performance.now();
    // 이동 거리 = 커서 이동 + 그동안 스크롤된 만큼
    const update = () => {
      const dy = lastY - y0 + box.scrollTop - st0;
      if (!moved.current && Math.abs(dy) < 4) return;
      moved.current = true;
      const to = Math.max(0, Math.min(n - 1, i + Math.round(dy / step)));
      setDg({ id, from: i, to, dy, step });
    };
    // 목록 위·아래 끝 근처(또는 바깥)로 끌면 자동 스크롤
    const tick = now => {
      const dt = Math.min(100, (now || performance.now()) - t0); t0 = now || performance.now(); // 프레임이 느려도 같은 속도
      const r = box.getBoundingClientRect(), edge = 28;
      let v = 0;
      if (lastY < r.top + edge) v = -Math.min(14, (r.top + edge - lastY) / 3);
      else if (lastY > r.bottom - edge) v = Math.min(14, (lastY - (r.bottom - edge)) / 3);
      if (v && moved.current) {
        const before = box.scrollTop;
        box.scrollTop += v * dt / 16;
        if (box.scrollTop !== before) update();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const mv = ev => { lastY = ev.clientY; update(); };
    const up = () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDg(d => {
        if (d && d.to !== d.from) {
          store.set(st => {
            const drawer = st.drawer.slice();
            const [x] = drawer.splice(d.from, 1);
            drawer.splice(d.to, 0, x);
            const next = { ...st, drawer };
            return { ...next, board: syncBoard(next) };
          });
        }
        return null;
      });
      setSettle(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettle(false)));
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const shift = i => {
    if (!dg) return 0;
    if (dg.from < dg.to && i > dg.from && i <= dg.to) return -dg.step;
    if (dg.to < dg.from && i >= dg.to && i < dg.from) return dg.step;
    return 0;
  };
  return html`
    <div class="sec">
      <div class="h">Drawer <i>서랍 · ${s.drawer.length}</i></div>
      <div class="body">
        <div class="row">
          <button class="btn" onClick=${() => store.set(st => ({ ...st, selected: st.drawer.map(d => d.id) }))}>전체선택</button>
          <button class="btn" onClick=${() => store.set(st => ({ ...st, selected: [] }))}>선택해제</button>
          <span style="font-size:10px;color:var(--ink-2)">${s.selected.length} 선택</span>
        </div>
        <div class=${'drawer' + (dg ? ' sorting' : '') + (settle ? ' settle' : '')}>
          ${s.drawer.map((L, i) => {
            const im = labelImage(L, s.customFonts, 6);
            const me = dg && dg.id === L.id;
            return html`<div class=${'dr' + (s.editingId === L.id ? ' editing' : '') + (me ? ' lifted' : '')} key=${L.id}
              style=${`transform:translateY(${me ? dg.dy : shift(i)}px)`} title="끌어서 순서 바꾸기" onPointerDown=${e => onDown(e, i)}>
              <input type="checkbox" checked=${sel.has(L.id)} onChange=${() => toggle(L.id)} />
              <span class="th" title="클릭해서 다시 편집" onClick=${() => { if (!moved.current) edit(L); }}><img src=${im.url} draggable="false" /></span>
              <em>${L.orientation === 'free' ? L.freeW + '×' + L.freeH : L.tapeMm + 'mm'}</em>
              <button class="x" title="복제" onClick=${() => dup(L)}>⧉</button>
              <button class="x" title="삭제" onClick=${() => del(L)}>✕</button>
            </div>`;
          })}
          ${!s.drawer.length ? html`<div class="muted">아직 비어 있어요.</div>` : null}
        </div>
      </div>
    </div>`;
}

function BoardSec({ s }) {
  const b = s.board;
  const fileRef = useRef();
  const setSize = (k, landscape = b.landscape) => {
    const { w, h } = boardDims(k, landscape);
    store.set(st => { const nb = { ...st.board, size: k, landscape, w, h, layout: 'auto' }; return { ...st, board: syncBoard({ ...st, board: nb }) }; });
  };
  const squareBoard = BOARD_SIZES[b.size] && BOARD_SIZES[b.size][0] === BOARD_SIZES[b.size][1];
  const onImg = e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setBoard({ bg: 'image', bgImage: r.result });
    r.readAsDataURL(f);
  };
  const BG = [['mat', 'bg-mat', '커팅매트'], ['plain', '', '단색'], ['grid', 'bg-grid', '모눈'], ['trans', 'bg-trans', '투명']];
  return html`
    <div class="sec">
      <div class="h">Board <i>판</i></div>
      <div class="body">
        <div class="row"><span class="lbl">크기</span>
          <select class="pill" value=${b.size} onChange=${e => setSize(e.target.value)}>
            ${Object.entries(BOARD_SIZES).map(([k, v]) => html`<option value=${k}>${v[2]}</option>`)}
          </select>
        </div>
        ${!squareBoard ? html`<div class="row"><span class="lbl">방향</span>
          <${Toggle} value=${!!b.landscape} onChange=${v => setSize(b.size, v)} options=${[[false, '세로'], [true, '가로']]} />
        </div>` : null}
        <div class="bgs">
          ${BG.map(([v, cls, t]) => html`<button class=${cls + (b.bg === v ? ' on' : '')} title=${t} style=${v === 'plain' ? 'background:' + b.bgColor : ''} onClick=${() => setBoard({ bg: v })}></button>`)}
          <button class=${b.bg === 'image' ? 'on' : ''} title="이미지 업로드" style=${b.bgImage ? `background:url(${b.bgImage}) center/cover` : 'border-style:dashed'} onClick=${() => fileRef.current.click()}>${b.bgImage ? '' : '⤒'}</button>
          <input type="file" accept="image/*" ref=${fileRef} style="display:none" onChange=${onImg} />
        </div>
        <div class="muted" style="margin-top:5px">커팅매트 · 단색 · 모눈 · 투명 · 업로드</div>
        ${b.bg === 'plain' ? html`<div class="row" style="margin-top:6px"><span class="lbl">판 색</span><input type="color" value=${b.bgColor} onInput=${e => setBoard({ bgColor: e.target.value })} /></div>` : null}
        <div style="margin-top:6px">
          <${Range} label="라벨 크기" min=${0.4} max=${2.5} step=${0.05} value=${b.scale || 0.6} fmt=${v => Math.round(v * 100) + '%'}
            onInput=${v => store.set(st => ({ ...st, board: syncBoard({ ...st, board: { ...st.board, scale: v } }) }))} />
        </div>
      </div>
    </div>`;
}

function PaletteSec({ s }) {
  const setColor = (i, c) => store.set(st => {
    const old = st.palette[i];
    const palette = st.palette.slice(); palette[i] = c;
    // 현재 라벨이 이 색을 쓰고 있으면 함께 변경
    const L = st.label;
    const label = { ...L, tapeColor: L.tapeColor === old ? c : L.tapeColor, inkColor: L.inkColor === old ? c : L.inkColor, invColor: L.invColor === old ? c : L.invColor };
    // 지금 보고 있는 프리셋(또는 커스텀)에 바로 저장
    if (st.palettePresetId === 'custom') return { ...st, palette, label, customPalette: palette };
    return { ...st, palette, label, palettePresets: st.palettePresets.map(p => p.id === st.palettePresetId ? { ...p, colors: palette } : p) };
  });
  const choose = id => store.set(st => {
    if (id === 'custom') return { ...st, palette: [...(st.customPalette || st.palette)], palettePresetId: 'custom' };
    const p = st.palettePresets.find(x => x.id === id);
    return p ? { ...st, palette: [...p.colors], palettePresetId: id } : st;
  });
  const register = async () => {
    const name = await askText('컬러 프리셋 이름을 정해주세요', `팔레트 ${s.palettePresets.length + 1}`, { title: '컬러 프리셋' });
    if (!name) return;
    const p = { id: uid(), name, colors: [...s.palette] };
    store.set(st => ({ ...st, palettePresets: [...st.palettePresets, p], palettePresetId: p.id }));
    toast('컬러 프리셋을 등록했어요');
  };
  const remove = async () => {
    if (s.palettePresetId === 'custom') return;
    if (!(await askConfirm('paletteDelete', '이 컬러 프리셋을 지울까요?', { title: '프리셋 삭제', ok: '지우기' }))) return;
    store.set(st => ({ ...st, palettePresets: st.palettePresets.filter(p => p.id !== st.palettePresetId), palettePresetId: 'custom', palette: [...(st.customPalette || st.palette)] }));
  };
  const L = s.label;
  const target0 = s.ui.colorTarget || 'tapeColor';
  const target = target0 === 'laceColor' ? 'tapeColor' : target0;
  const cval = k => L[k] || '#FFFFFF';
  const editing = !!s.ui.paletteEdit;
  const same = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
  const T = (k, t) => html`<button class=${'tgt' + (target === k ? ' on' : '')} onClick=${() => setUi({ colorTarget: k })}>
      <span class="mini" style=${'background:' + cval(k)}></span>${t}</button>`;
  return html`
    <div class="sec">
      <div class="h">Color <i>테이프 · 잉크 · 팔레트</i></div>
      <div class="body">
        <div class="row tgts">${T('tapeColor', '테이프')}${T('inkColor', '잉크')}${T('invColor', '포인트')}</div>
        <div class="row"><span class="pal">
          ${s.palette.map((c, i) => editing
            ? html`<label class="sw edit" style=${'background:' + c} title=${c + ' 바꾸기'}><input type="color" value=${c} onInput=${e => setColor(i, e.target.value)} /></label>`
            : html`<button class=${'sw' + (same(cval(target), c) ? ' on' : '')} style=${'background:' + c} title=${c} onClick=${() => setLabel({ [target]: c })}></button>`)}
          <button class=${'btn sq' + (editing ? ' on' : '')} title="팔레트 색 편집" onClick=${() => setUi({ paletteEdit: !editing })}>✎</button>
        </span></div>
        <div class="row">
          <select class="pill" value=${s.palettePresetId} onChange=${e => choose(e.target.value)}>
            <option value="custom">커스텀</option>
            ${s.palettePresets.map(p => html`<option value=${p.id}>${p.name}</option>`)}
          </select>
          <button class="btn" onClick=${register}>+ 프리셋 등록</button>
          ${s.palettePresetId !== 'custom' ? html`<button class="btn" onClick=${remove}>✕</button>` : null}
        </div>
      </div>
    </div>`;
}

const MOODS = ['I am only printing\nyour little labels.', 'ink is warm.\ntape is ready.', 'one more label?\njust one more.', 'cutting… cutting…\nok done!'];
function Status({ s }) {
  const msg = MOODS[s.drawer.length % MOODS.length];
  return html`
    <div class="sec grow">
      <div class="h">Printer status</div>
      <div class="status"><${Px} name="face" s=${4} c="#2F2C30" /><span style="white-space:pre-line">${msg}</span></div>
    </div>`;
}

function PrintBox({ s }) {
  const [busy, setBusy] = useState(false);
  const ui = s.ui;
  const go = async () => {
    const st = store.get();
    let labels = st.drawer.filter(l => st.selected.includes(l.id));
    if (ui.printMode !== 'board') {
      if (!st.drawer.length) { toast('서랍이 비어 있어요'); return; }
      if (!labels.length) { labels = st.drawer; toast('선택한 라벨이 없어서 전부 내보내요'); }
    } else if (!st.drawer.length) { toast('판이 비어 있어요'); return; }
    setBusy(true);
    try {
      const ppm = ui.dpi / 25.4;
      const render1 = L => renderLabel(L, fontById(L.fontId, st.customFonts).family, ppm).canvas;
      if (ui.printMode === 'board') {
        const cv = await renderBoard(st, { transparent: st.board.bg === 'trans' });
        download(await canvasToBlob(cv), `hwy-label_board_${st.board.w}x${st.board.h}.png`);
      } else if (ui.printMode === 'zip') {
        const zip = new window.JSZip();
        for (let i = 0; i < labels.length; i++) zip.file(safeName(labels[i].text, i), await canvasToBlob(render1(labels[i])));
        download(await zip.generateAsync({ type: 'blob' }), `hwy-label_${labels.length}labels_${ui.dpi}dpi.zip`);
      } else {
        for (let i = 0; i < labels.length; i++) {
          download(await canvasToBlob(render1(labels[i])), safeName(labels[i].text, i));
          await new Promise(r => setTimeout(r, 250));
        }
      }
      toast('CUT✂ 완료 ✧');
    } catch (e) {
      console.error(e);
      toast('내보내기에 실패했어요');
    }
    setBusy(false);
  };
  const R = (v, t) => html`<label><input type="radio" name="pm" checked=${ui.printMode === v} onChange=${() => setUi({ printMode: v })} /> ${t}</label>`;
  return html`
    <div class="printbox">
      <div class="opts">
        ${R('board', '판 이미지 1장 (PNG)')}
        ${R('zip', '선택 라벨 ZIP으로')}
        ${R('single', '선택 라벨 개별 PNG')}
        ${ui.printMode !== 'board' ? html`<div class="row" style="margin:6px 0 4px"><span class="lbl">해상도</span>
          ${[180, 300, 360].map(d => html`<span class=${'chip' + (ui.dpi === d ? ' on' : '')} onClick=${() => setUi({ dpi: d })}>${d}dpi</span>`)}</div>`
        : null}
      </div>
      <button class="print" disabled=${busy} onClick=${go} style="margin-top:6px">${busy ? 'CUTTING…' : 'CUT✂'}</button>
    </div>`;
}

function Right({ s }) {
  return html`
    <aside class="side r">
      <div class="scroll">
        <${Drawer} s=${s} />
        <${PaletteSec} s=${s} />
        <${BoardSec} s=${s} />
        <${Status} s=${s} />
      </div>
      <${PrintBox} s=${s} />
    </aside>`;
}

// ---------------- APP ----------------
function App() {
  const s = useStore();
  setCustomIcons(s.customIcons || []);
  const fv = useFontsV();
  const [saveState, setSaveState] = useState('saved');
  useEffect(() => store.onSave(setSaveState), []);
  useEffect(() => { window.addEventListener('label-img-loaded', bumpFonts); return () => window.removeEventListener('label-img-loaded', bumpFonts); }, []);
  // 사용 중인 폰트 로드
  useEffect(() => {
    const ids = new Set([s.label.fontId, ...s.drawer.map(d => d.fontId)]);
    Promise.all([...ids].map(id => ensureFont(fontById(id, s.customFonts)))).then(bumpFonts);
  }, [s.label.fontId, s.drawer.length, s.customFonts.length]);

  const backupRef = useRef();
  const doExport = () => download(new Blob([exportBackup()], { type: 'application/json' }), 'hwy-label-backup.json');
  const doImport = e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    f.text().then(t => { try { importBackup(t); toast('백업을 불러왔어요'); } catch (err) { toast(err.message); } });
  };
  const editingNo = s.editingId ? s.drawer.findIndex(d => d.id === s.editingId) + 1 : s.drawer.length + 1;
  return html`
    <div class="top"><b>LABEL MAKER</b><span>HWY · ALPHA 0.1</span></div>
    <div class="win">
      <div class="winbar">
        <span>Editor view · label #${String(editingNo).padStart(2, '0')} · ${s.editingId ? 'editing' : 'new'}</span>
        <span class=${'saved' + (saveState === 'busy' ? ' busy' : '')}>${saveState === 'busy' ? 'saving…' : saveState === 'error' ? 'save error' : 'autosaved'} · drawer ${s.drawer.length} · board ${s.board.w}×${s.board.h}</span>
      </div>
      <div class="grid">
        <${Left} s=${s} fv=${fv} />
        <${Center} s=${s} fv=${fv} />
        <${Right} s=${s} />
      </div>
    </div>
    <div class="nav">
      <a href="#" onClick=${e => { e.preventDefault(); doExport(); }}>BACKUP</a>
      <a href="#" onClick=${e => { e.preventDefault(); backupRef.current.click(); }}>RESTORE</a>
      <a href="https://github.com/xngsuii/hwy-label" target="_blank" rel="noopener">GITHUB</a>
      ${Object.keys(s.ui.skipConfirm || {}).length ? html`<a href="#" title="'다음부터 묻지 않기'로 끈 확인창을 다시 켜요" onClick=${e => { e.preventDefault(); setUi({ skipConfirm: {} }); toast('확인창을 다시 켰어요'); }}>ASK AGAIN</a>` : null}
      <input type="file" accept="application/json" ref=${backupRef} style="display:none" onChange=${doImport} />
    </div>
    <div class="foot">FONTS · GALMURI · LIMGUL · DUNGGEUNMO · DOSGOTHIC · CHOSUN · GMARKET SANS · PRETENDARD</div>
    <${Dialog} />`;
}

(async () => {
  await store.load();
  try {
    const fonts = await loadStoredFonts();
    // 메타데이터와 실제 저장된 폰트 동기화
    store.set(st => ({ ...st, customFonts: fonts.map(f => ({ id: f.id, name: f.name, family: f.family, kind: f.kind })) }));
  } catch { /* ignore */ }
  document.getElementById('app').innerHTML = '';
  render(html`<${App} />`, document.getElementById('app'));
})();
