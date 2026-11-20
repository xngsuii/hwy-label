import { html, render, useState, useEffect, useRef, useMemo, useCallback } from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';
import { store, setLabel, setUi, setBoard, defaultLabel, uid, TAPE_WIDTHS, exportBackup, importBackup } from './store.js';
import { BUILTIN_FONTS, fontById, ensureFont, registerCustomFont, loadStoredFonts, saveStoredFonts } from './fonts.js';
import { renderLabel, layoutLabel, clearMeasureCache, canvasToBlob } from './render.js';
import { ICON_GROUPS, iconSvg } from './pixel.js';
import { BOARD_SIZES, BOARD_PPM, autoLayout, scatterLayout, syncBoard, renderBoard } from './board.js';
import { idb } from './store.js';

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

const Range = ({ label, min, max, step = 1, value, onInput, fmt = v => v }) => html`
  <div class="row"><span class="lbl">${label}</span>
    <input type="range" min=${min} max=${max} step=${step} value=${value} onInput=${e => onInput(+e.target.value)} />
    <span class="val">${fmt(value)}</span></div>`;

const Toggle = ({ options, value, onChange }) => html`
  <span class="toggle">${options.map(([v, t]) => html`<button class=${value === v ? 'on' : ''} onClick=${() => onChange(v)}>${t}</button>`)}</span>`;

const Px = ({ name, s = 2, c }) => html`<span class="px" dangerouslySetInnerHTML=${{ __html: iconSvg(name, s, c) }}></span>`;

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
        <button class="btn" onClick=${() => store.set(st => ({ ...st, editingId: null, label: { ...defaultLabel(), tapeColor: st.label.tapeColor, inkColor: st.label.inkColor, fontId: st.label.fontId } }))}>↺ 새로</button>
        <button class="btn main" onClick=${put}>${editing ? '서랍 업데이트 ↘' : '서랍에 넣기 ↘'}</button>
      </div>
    </div>`;
}

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
    if (!confirm('이 폰트를 목록에서 지울까요?')) return;
    const list = ((await idb.get('fonts')) || []).filter(f => f.id !== id);
    await saveStoredFonts(list);
    store.set(st => ({ ...st, customFonts: st.customFonts.filter(f => f.id !== id), label: { ...st.label, fontId: 'galmuri11' } }));
  };
  const B = (k, ch, style = '') => html`<button class=${'btn sq' + (L[k] ? ' on' : '')} style=${style} title=${k} onClick=${() => setLabel({ [k]: !L[k] })}>${ch}</button>`;
  const A = (v, ch, t) => html`<button class=${'btn sq' + (L.align === v ? ' on' : '')} title=${t} onClick=${() => setLabel({ align: v })}>${ch}</button>`;
  return html`
    <${Sec} title="Text" sub="텍스트 · 폰트">
      <textarea class="main" ref=${taRef} value=${L.text} onInput=${e => setLabel({ text: e.target.value })} placeholder="라벨에 넣을 글자"></textarea>
      <div class="row" style="margin-top:8px">
        <select class="pill" value=${L.fontId} onChange=${e => setLabel({ fontId: e.target.value })}>
          ${Object.entries(groups).map(([g, fs]) => html`<optgroup label=${g}>${fs.map(f => html`<option value=${f.id}>${f.name}</option>`)}</optgroup>`)}
          ${custom.length ? html`<optgroup label="내 폰트">${custom.map(f => html`<option value=${f.id}>${f.name}</option>`)}</optgroup>` : null}
        </select>
        ${custom.some(f => f.id === L.fontId) ? html`<button class="btn" onClick=${removeFont} title="내 폰트 삭제">✕</button>` : null}
      </div>
      <div class="row">
        <span class="lbl">크기</span>
        <${Toggle} value=${L.sizeMode} onChange=${v => setLabel({ sizeMode: v })} options=${[['auto', '자동 맞춤'], ['manual', '직접']]} />
        ${L.sizeMode === 'manual' ? html`<input class="num" type="number" min="3" max="200" step="0.5" value=${L.sizePt} onInput=${e => setLabel({ sizePt: +e.target.value || 14 })} /><span style="font-size:10px">pt</span>` : null}
      </div>
      <div class="row">
        ${B('bold', html`<b>B</b>`)}${B('italic', html`<i>I</i>`)}${B('underline', html`<u>U</u>`)}${B('strike', html`<s>S</s>`)}${B('outline', 'O', '-webkit-text-stroke:1px currentColor;color:transparent;font-weight:700')}
        <span style="width:6px"></span>
        ${A('left', '⇤', '왼쪽')}${A('center', '≡', '가운데')}${A('right', '⇥', '오른쪽')}${A('justify', '☰', '양쪽')}
      </div>
      <div class="sub-h">내 폰트 추가</div>
      <div class="row">
        <button class="btn" onClick=${() => fileRef.current.click()}>📁 폰트 파일 (.ttf/.otf/.woff)</button>
        <input type="file" ref=${fileRef} accept=".ttf,.otf,.woff,.woff2" style="display:none" onChange=${addFile} />
      </div>
      <div class="row"><input class="txt" placeholder="웹폰트 CSS 또는 woff URL" value=${url} onInput=${e => setUrl(e.target.value)} /></div>
      <div class="row"><input class="txt" placeholder="font-family 이름" value=${fam} onInput=${e => setFam(e.target.value)} /><button class="btn" onClick=${addUrl}>임베드</button></div>
      <div class="muted">추가한 폰트는 이 브라우저에만 저장돼요. 재배포가 안 되는 폰트(PF스타더스트, HY헤드라인 등)는 여기로 넣어 쓰세요.</div>
    <//>`;
}

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
          ${TAPE_WIDTHS.map(w => html`<span class=${'chip' + (L.tapeMm === w ? ' on' : '')} onClick=${() => setLabel({ tapeMm: w })}>${w}</span>`)}
          <input class="num" type="number" min="3" max="200" step="0.5" value=${L.tapeMm} onInput=${e => setLabel({ tapeMm: +e.target.value || 12 })} /><span style="font-size:10px">mm</span>
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
  const save = () => {
    const name = prompt('타이포 프리셋 이름', `${fontById(L.fontId, s.customFonts).name} 프리셋`);
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

const FRAMES = [['none', '없음', ''], ['solid', '실선', 'border:1.5px solid'], ['dotted', '점선', 'border:1.5px dotted'], ['double', '이중', 'border:3px double']];
const SPECIAL = [['▶❚❚', '뮤직'], ['💬', '메신저'], ['◉▭', '도그태그'], ['▦', '원고지'], ['◖ ◗', '말풍선'], ['☺◖', '말풍선(캐릭터)'], ['⛩', '오마모리']];
function FrameSec({ s }) {
  const L = s.label;
  return html`
    <${Sec} title="Frame" sub="프레임">
      <div class="tiles" style="margin-bottom:6px">
        ${FRAMES.map(([v, t, st]) => html`<button class=${'tile' + (L.frame === v ? ' on' : '')} onClick=${() => setLabel({ frame: v })}><span style=${st + ';padding:2px 6px'}>${t}</span></button>`)}
      </div>
      <div class="sub-h">Special · 준비 중</div>
      <div class="tiles">
        ${SPECIAL.map(([i, t]) => html`<button class="tile" disabled title="곧 추가돼요">${i}<br/>${t}</button>`)}
      </div>
    <//>`;
}

const PATTERNS = [['none', '없음', ''], ['check', '', 'background-image:linear-gradient(90deg,rgba(47,44,48,.15) 50%,transparent 50%),linear-gradient(rgba(47,44,48,.15) 50%,transparent 50%);background-size:8px 8px'],
  ['stripe', '', 'background-image:repeating-linear-gradient(90deg,transparent 0 5px,rgba(47,44,48,.18) 5px 7px)'],
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

function DecoSec({ s }) {
  const L = s.label;
  const slot = s.ui.decoSlot;
  const names = { top: '위', bottom: '아래', left: '왼쪽', right: '오른쪽' };
  const D = (k, ch) => html`<button class=${(L.deco[k] ? 'has' : '') + (slot === k ? ' cur' : '')} onClick=${() => setUi({ decoSlot: k })} title=${names[k]}>${ch}</button>`;
  const pick = n => setLabel(l => ({ deco: { ...l.deco, [slot]: l.deco[slot] === n ? null : n } }));
  const list = ICON_GROUPS[s.ui.iconGroup] || ICON_GROUPS['동물'];
  const desc = Object.entries(L.deco).filter(([, v]) => v).map(([k, v]) => `${names[k]} ${v}`).join(' · ') || '없음';
  const vertNote = L.orientation === 'v' ? '세로형: 위/아래 = 글줄 양 끝, 좌/우 = 반복 장식' : '가로형: 좌/우 = 양 끝, 위/아래 = 반복 장식';
  return html`
    <${Sec} title="Deco" sub="장식 · 상하좌우">
      <div class="row" style="align-items:flex-start;gap:12px">
        <div class="dpad">
          <span></span>${D('top', '↑')}<span></span>
          ${D('left', '←')}<span class="c">TEXT</span>${D('right', '→')}
          <span></span>${D('bottom', '↓')}<span></span>
        </div>
        <div style="flex:1;font-size:10px;line-height:1.5">
          <b>${names[slot]}</b> 슬롯 선택됨 → 아이콘 클릭 (다시 누르면 빼기)<br/>
          <span class="muted">${desc}</span><br/>
          <span class="muted">${vertNote}</span>
          <div style="margin-top:4px"><button class="btn" onClick=${() => setLabel({ deco: { top: null, bottom: null, left: null, right: null } })}>모두 빼기</button></div>
        </div>
      </div>
      <div class="row">
        <select class="pill" value=${s.ui.iconGroup} onChange=${e => setUi({ iconGroup: e.target.value })}>
          ${Object.keys(ICON_GROUPS).map(g => html`<option value=${g}>${g}</option>`)}
        </select>
      </div>
      <div class="lib">
        ${list.map(n => html`<button class=${L.deco[slot] === n ? 'on' : ''} title=${n} onClick=${() => pick(n)}><${Px} name=${n} s=${2} c="#fff" /></button>`)}
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn" disabled title="곧 추가돼요">📷 이미지 → 비트맵 (준비 중)</button>
      </div>
    <//>`;
}

const KAOMOJI = ['ʕ•ᴥ•ʔ', '(｡•́︿•̀｡)', '(˘ω˘)', '( ˙꒳˙ )', '(*ᴗ͈ˬᴗ͈)ꕤ', '٩(ˊᗜˋ*)و', '(っ˘ڡ˘ς)', '♡', '♥', '☆', '★', '✿', '❀', '♪', '☁', '☾', '…', '⸝⸝', '→', '✧'];
function EmojiSec({ s, taRef }) {
  const L = s.label;
  const insert = t => {
    const ta = taRef.current;
    const a = ta ? ta.selectionStart : L.text.length, b = ta ? ta.selectionEnd : L.text.length;
    const text = L.text.slice(0, a) + t + L.text.slice(b);
    setLabel({ text });
    requestAnimationFrame(() => { if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = a + t.length; } });
  };
  const addFav = () => {
    const t = prompt('즐겨찾기에 넣을 이모티콘/기호');
    if (t) store.set(st => ({ ...st, kaomojiFav: [...st.kaomojiFav, t] }));
  };
  const onFav = (e, t, i) => {
    if (e.shiftKey) store.set(st => ({ ...st, kaomojiFav: st.kaomojiFav.filter((_, j) => j !== i) }));
    else insert(t);
  };
  return html`
    <${Sec} title="Emoji" sub="이모지 · 이모티콘">
      <div class="row"><span class="lbl">이모지</span>
        <${Toggle} value=${L.emojiMono} onChange=${v => setLabel({ emojiMono: v })} options=${[[true, '흑백 변환'], [false, '컬러 유지']]} />
      </div>
      ${s.kaomojiFav.length ? html`<div class="sub-h">즐겨찾기 <span style="text-transform:none;letter-spacing:0">(shift+클릭 = 삭제)</span></div>
        <div class="kao" style="margin-bottom:6px">${s.kaomojiFav.map((t, i) => html`<button onClick=${e => onFav(e, t, i)}>${t}</button>`)}</div>` : null}
      <div class="kao">
        ${KAOMOJI.map(t => html`<button onClick=${() => insert(t)}>${t}</button>`)}
        <button style="border-style:dashed" onClick=${addFav}>+ 즐겨찾기</button>
      </div>
    <//>`;
}

function ColorSec({ s }) {
  const L = s.label;
  const row = (k) => html`<span class="pal">${s.palette.map(c => html`<button class=${'sw' + (L[k].toLowerCase() === c.toLowerCase() ? ' on' : '')} style=${'background:' + c} title=${c} onClick=${() => setLabel({ [k]: c })}></button>`)}</span>`;
  return html`
    <${Sec} title="Color" sub="판 팔레트에서" cls="last">
      <div class="row"><span class="lbl">테이프</span>${row('tapeColor')}</div>
      <div class="row"><span class="lbl">잉크</span>${row('inkColor')}</div>
      <div class="muted">팔레트 색은 오른쪽 PALETTE에서 바꿔요.</div>
    <//>`;
}

function Left({ s, fv }) {
  const taRef = useRef();
  return html`
    <aside class="side l">
      <${Preview} s=${s} fv=${fv} />
      <div class="scroll">
        <${TextSec} s=${s} taRef=${taRef} />
        <${SizeSec} s=${s} />
        <${TypeSec} s=${s} />
        <${FrameSec} s=${s} />
        <${PatternSec} s=${s} />
        <${DecoSec} s=${s} />
        <${EmojiSec} s=${s} taRef=${taRef} />
        <${ColorSec} s=${s} />
      </div>
    </aside>`;
}

// ---------------- CENTER ----------------
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

  const relayout = mode => {
    store.set(st => {
      const b = { ...st.board, layout: mode === 'auto' ? 'auto' : 'free' };
      b.items = mode === 'auto' ? autoLayout(st.drawer, st.customFonts, b) : scatterLayout(st.drawer, st.customFonts, b);
      return { ...st, board: b };
    });
  };
  const modItem = (fn) => {
    if (!sel) { toast('판에서 라벨을 먼저 클릭해 선택하세요'); return; }
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
  const onDown = (e, it) => {
    e.preventDefault();
    setUi({ boardSel: it.id });
    drag.current = { id: it.id, sx: e.clientX, sy: e.clientY, x: it.x, y: it.y };
    e.target.setPointerCapture(e.pointerId);
  };
  const onMove = e => {
    const d = drag.current;
    if (!d) return;
    const nx = d.x + (e.clientX - d.sx) / scale, ny = d.y + (e.clientY - d.sy) / scale;
    store.set(st => ({ ...st, board: { ...st.board, layout: 'free', items: st.board.items.map(x => x.id === d.id ? { ...x, x: nx, y: ny } : x) } }));
  };
  const onUp = () => { drag.current = null; };

  const bgCls = { mat: 'bg-mat', grid: 'bg-grid', trans: 'bg-trans' }[board.bg] || '';
  const bgStyle = board.bg === 'plain' ? `background:${board.bgColor}` : board.bg === 'image' && board.bgImage ? `background:url(${board.bgImage}) center/cover` : '';
  const ppm = BOARD_PPM * (board.scale || 1);
  return html`
    <main class="center">
      <div class="tb">
        <button class=${'btn' + (board.layout === 'auto' ? ' on' : '')} onClick=${() => relayout('auto')}>자동배치</button>
        <button class="btn" onClick=${() => relayout('scatter')}>흩뿌리기</button>
        <span style="width:8px"></span>
        <button class="btn sq" title="왼쪽으로 5° 회전" onClick=${() => rotate(-5)}>⟲</button>
        <button class="btn sq" title="오른쪽으로 5° 회전" onClick=${() => rotate(5)}>⟳</button>
        <button class="btn sq" title="맨 앞으로" onClick=${front}>⤒</button>
        <button class="btn sq" title="맨 뒤로" onClick=${back}>⤓</button>
        <span class="sp"></span>
        <span style="font-size:10px;letter-spacing:.1em">ZOOM</span>
        <button class="btn sq" onClick=${() => setUi({ zoom: Math.max(0.25, (s.ui.zoom || 1) - 0.25) })}>−</button>
        <button class="btn" onClick=${() => setUi({ zoom: 0 })}>${s.ui.zoom ? Math.round(s.ui.zoom * 100) + '%' : 'FIT'}</button>
        <button class="btn sq" onClick=${() => setUi({ zoom: Math.min(4, (s.ui.zoom || 1) + 0.25) })}>+</button>
      </div>
      <div class="board-wrap" ref=${wrapRef} onPointerDown=${e => { if (e.target === e.currentTarget) setUi({ boardSel: null }); }}>
        <div class="hint">board · ${board.w}×${board.h} — 드래그로 이동, 선택 후 툴바로 회전·순서</div>
        <div class=${'board ' + bgCls} style=${`width:${board.w * scale}px;height:${board.h * scale}px;${bgStyle}`}
             onPointerMove=${onMove} onPointerUp=${onUp} onPointerDown=${e => { if (e.target === e.currentTarget) setUi({ boardSel: null }); }}>
          ${board.items.map(it => {
            const L = byId[it.id];
            if (!L) return null;
            const im = labelImage(L, s.customFonts, ppm);
            return html`<img class="item" key=${it.id} src=${im.url} draggable="false"
              style=${`left:${it.x * scale}px;top:${it.y * scale}px;width:${im.w * scale}px;height:${im.h * scale}px;transform:rotate(${it.rot || 0}deg);${sel === it.id ? 'outline:1.5px dashed #fff;outline-offset:4px;' : ''}`}
              onPointerDown=${e => onDown(e, it)} />`;
          })}
          ${!drawer.length ? html`<div class="empty">서랍이 비어 있어요<br/>왼쪽에서 라벨을 만들고 [서랍에 넣기]</div>` : null}
        </div>
      </div>
    </main>`;
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
  const del = L => {
    if (!confirm('이 라벨을 서랍에서 뺄까요?')) return;
    store.set(st => {
      const next = { ...st, drawer: st.drawer.filter(d => d.id !== L.id), selected: st.selected.filter(x => x !== L.id), editingId: st.editingId === L.id ? null : st.editingId };
      return { ...next, board: syncBoard(next) };
    });
  };
  const move = (L, d) => store.set(st => {
    const drawer = st.drawer.slice();
    const i = drawer.findIndex(x => x.id === L.id), j = i + d;
    if (j < 0 || j >= drawer.length) return st;
    [drawer[i], drawer[j]] = [drawer[j], drawer[i]];
    const next = { ...st, drawer };
    return { ...next, board: syncBoard(next) };
  });
  return html`
    <div class="sec">
      <div class="h">Drawer <i>서랍 · ${s.drawer.length}</i></div>
      <div class="body">
        <div class="row">
          <button class="btn" onClick=${() => store.set(st => ({ ...st, selected: st.drawer.map(d => d.id) }))}>전체선택</button>
          <button class="btn" onClick=${() => store.set(st => ({ ...st, selected: [] }))}>선택해제</button>
          <span style="font-size:10px;color:var(--ink-2)">${s.selected.length} 선택</span>
        </div>
        <div class="drawer">
          ${s.drawer.map(L => {
            const im = labelImage(L, s.customFonts, 6);
            return html`<div class=${'dr' + (s.editingId === L.id ? ' editing' : '')} key=${L.id}>
              <input type="checkbox" checked=${sel.has(L.id)} onChange=${() => toggle(L.id)} />
              <span class="th" title="클릭해서 다시 편집" onClick=${() => edit(L)}><img src=${im.url} /></span>
              <em>${L.orientation === 'free' ? L.freeW + '×' + L.freeH : L.tapeMm + 'mm'}</em>
              <button class="x" title="위로" onClick=${() => move(L, -1)}>▲</button>
              <button class="x" title="복제" onClick=${() => dup(L)}>⧉</button>
              <button class="x" title="삭제" onClick=${() => del(L)}>✕</button>
            </div>`;
          })}
          ${!s.drawer.length ? html`<div class="muted">아직 비어 있어요.</div>` : null}
        </div>
        <div class="muted" style="margin-top:6px">썸네일 클릭 = 다시 편집 · ▲ 순서 · ⧉ 복제 · ✕ 삭제</div>
      </div>
    </div>`;
}

function BoardSec({ s }) {
  const b = s.board;
  const fileRef = useRef();
  const setSize = k => {
    const [w, h] = BOARD_SIZES[k];
    store.set(st => { const nb = { ...st.board, size: k, w, h }; return { ...st, board: syncBoard({ ...st, board: nb.layout === 'auto' ? nb : { ...nb, layout: 'auto' } }) }; });
  };
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
    const label = { ...L, tapeColor: L.tapeColor === old ? c : L.tapeColor, inkColor: L.inkColor === old ? c : L.inkColor };
    return { ...st, palette, label, palettePresetId: 'custom' };
  });
  const choose = id => {
    if (id === 'custom') { store.set(st => ({ ...st, palettePresetId: 'custom' })); return; }
    const p = s.palettePresets.find(x => x.id === id);
    if (p) store.set(st => ({ ...st, palette: [...p.colors], palettePresetId: id }));
  };
  const register = () => {
    const name = prompt('컬러 프리셋 이름', `팔레트 ${s.palettePresets.length + 1}`);
    if (!name) return;
    const p = { id: uid(), name, colors: [...s.palette] };
    store.set(st => ({ ...st, palettePresets: [...st.palettePresets, p], palettePresetId: p.id }));
    toast('컬러 프리셋을 등록했어요');
  };
  const remove = () => {
    if (s.palettePresetId === 'custom') return;
    if (!confirm('이 컬러 프리셋을 지울까요?')) return;
    store.set(st => ({ ...st, palettePresets: st.palettePresets.filter(p => p.id !== st.palettePresetId), palettePresetId: 'custom' }));
  };
  return html`
    <div class="sec">
      <div class="h">Palette <i>컬러 프리셋 · 6색</i></div>
      <div class="body">
        <div class="row"><span class="pal">
          ${s.palette.map((c, i) => html`<label class="sw" style=${'background:' + c} title=${c + ' (클릭해서 변경)'}><input type="color" value=${c} onInput=${e => setColor(i, e.target.value)} /></label>`)}
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
    <div class="sec">
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
        const cv = await renderBoard(st, { transparent: ui.transparent || st.board.bg === 'trans' });
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
      toast('PRINT! 완료 ✧');
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
        : html`<div class="row" style="margin:6px 0 4px"><label class="check" style="margin:0"><input type="checkbox" checked=${ui.transparent} onChange=${e => setUi({ transparent: e.target.checked })} /> 배경 없이 (투명)</label></div>`}
      </div>
      <button class="print" disabled=${busy} onClick=${go} style="margin-top:6px">${busy ? 'PRINTING…' : 'PRINT!'}</button>
      <div class="muted" style="text-align:center;margin-top:8px">서랍·판·프리셋은 이 브라우저에 자동 저장돼요</div>
    </div>`;
}

function Right({ s }) {
  return html`
    <aside class="side r">
      <${Drawer} s=${s} />
      <${BoardSec} s=${s} />
      <${PaletteSec} s=${s} />
      <${Status} s=${s} />
      <${PrintBox} s=${s} />
    </aside>`;
}

// ---------------- APP ----------------
function App() {
  const s = useStore();
  const fv = useFontsV();
  const [saveState, setSaveState] = useState('saved');
  useEffect(() => store.onSave(setSaveState), []);
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
      <input type="file" accept="application/json" ref=${backupRef} style="display:none" onChange=${doImport} />
    </div>
    <div class="foot">FONTS · GALMURI · LIMGUL · DUNGGEUNMO · DOSGOTHIC · CHOSUN · GMARKET SANS · PRETENDARD</div>`;
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
