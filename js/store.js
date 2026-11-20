// 상태 저장소 + IndexedDB 자동 저장
const DB_NAME = 'hwy-label';
const STORE = 'kv';
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
export const idb = {
  async get(key) {
    try {
      const d = await db();
      return await new Promise((res, rej) => {
        const q = d.transaction(STORE).objectStore(STORE).get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    } catch { return undefined; }
  },
  async set(key, val) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(val, key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  },
};

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export const DEFAULT_PALETTE = ['#FFFEFB', '#F6EBA6', '#F5CFDD', '#CFE6B8', '#D5E6F3', '#2F2C30'];

export const TAPE_WIDTHS = [4, 6, 9, 12, 18, 24, 36, 50];

export function defaultLabel() {
  return {
    id: uid(),
    text: '오늘도 수고했어',
    orientation: 'h',      // h | v | square | free
    tapeMm: 12,
    lengthMode: 'auto',    // auto | fixed
    lengthMm: 50,
    freeW: 40, freeH: 20,
    wrapMode: 'shrink',    // shrink(폭 고정, 글자 축소) | grow(높이 늘림)
    padX: 2.5, padY: 1.5,  // mm
    fontId: 'galmuri11',
    sizeMode: 'auto',      // auto | manual
    sizePt: 14,
    tracking: 0,           // em의 1/100
    leading: 1.2,
    widthScale: 100,       // %
    bold: false, italic: false, underline: false, strike: false, outline: false,
    align: 'center',       // left | center | right | justify
    frame: 'none',         // none | solid | dotted | double
    pattern: 'none',       // none | check | stripe | dot | diag
    deco: { left: 'bear', right: 'bone', top: null, bottom: null },
    decoRepeat: false,     // 가장자리 장식 반복
    hero: { icon: null, textPos: 'bottom', size: 0.62 }, // 메인 그림
    tapeColor: '#F6EBA6',
    inkColor: '#2F2C30',
    emojiMono: true,
  };
}

export function defaultState() {
  return {
    v: 1,
    label: defaultLabel(),
    editingId: null,          // 서랍에서 불러와 편집 중인 라벨 id
    drawer: [],               // Label[]
    selected: [],             // 선택된 라벨 id
    board: { size: '1080x1080', w: 1080, h: 1080, bg: 'mat', bgColor: '#ffffff', bgImage: null, scale: 0.6, items: [], layout: 'auto' },
    palette: [...DEFAULT_PALETTE],
    palettePresetId: 'custom',
    palettePresets: [],       // {id,name,colors}
    typePresets: [],          // {id,name,fontId,sizeMode,sizePt,tracking,leading,widthScale}
    kaomojiFav: [],
    customFonts: [],          // 메타데이터만 (blob은 idb 'fonts')
    ui: { decoSlot: 'left', iconGroup: '동물', printMode: 'board', dpi: 300, transparent: false, zoom: 0, emojiOpen: false, colorTarget: 'tapeColor', paletteEdit: false },
  };
}

// ---- 아주 작은 store ----
let state = defaultState();
const subs = new Set();
let saveTimer = null;
let saveListeners = new Set();

export const store = {
  get: () => state,
  set(updater) {
    const next = typeof updater === 'function' ? updater(state) : { ...state, ...updater };
    if (next === state) return;
    state = next;
    subs.forEach(f => f(state));
    scheduleSave();
  },
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  onSave(f) { saveListeners.add(f); return () => saveListeners.delete(f); },
  async load() {
    const saved = await idb.get('state');
    if (saved && saved.v === 1) {
      const d = defaultState();
      state = {
        ...d, ...saved,
        label: { ...d.label, ...saved.label, deco: { ...d.label.deco, ...(saved.label?.deco || {}) }, hero: { ...d.label.hero, ...(saved.label?.hero || {}) } },
        board: { ...d.board, ...saved.board },
        ui: { ...d.ui, ...saved.ui },
      };
    }
    subs.forEach(f => f(state));
  },
};

function scheduleSave() {
  saveListeners.forEach(f => f('busy'));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await idb.set('state', state);
      saveListeners.forEach(f => f('saved'));
    } catch (e) {
      console.warn('save failed', e);
      saveListeners.forEach(f => f('error'));
    }
  }, 400);
}

export function setLabel(patch) {
  store.set(s => ({ ...s, label: { ...s.label, ...(typeof patch === 'function' ? patch(s.label) : patch) } }));
}
export function setUi(patch) {
  store.set(s => ({ ...s, ui: { ...s.ui, ...patch } }));
}
export function setBoard(patch) {
  store.set(s => ({ ...s, board: { ...s.board, ...patch } }));
}

// 백업용 JSON
export function exportBackup() {
  return JSON.stringify(state, null, 1);
}
export function importBackup(json) {
  const obj = JSON.parse(json);
  if (!obj || obj.v !== 1) throw new Error('지원하지 않는 백업 파일');
  const d = defaultState();
  store.set({ ...d, ...obj, ui: { ...d.ui, ...obj.ui }, board: { ...d.board, ...obj.board } });
}
