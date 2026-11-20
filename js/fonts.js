// 폰트 레지스트리. 모두 웹 임베딩이 허용된 무료 폰트만 기본 탑재.
// 재배포 불가 폰트(예: PF스타더스트, HY헤드라인)는 사용자가 "내 폰트 불러오기"로 직접 추가 → 브라우저에만 저장.
import { idb } from './store.js';

const NOONNU = 'https://fastly.jsdelivr.net/gh/projectnoonnu';
const LIMGUL_CSS = 'https://cdn.jsdelivr.net/gh/MonadABXY/limgul-font@1.1.0/limgul.css';

export const BUILTIN_FONTS = [
  { id: 'galmuri11', name: '갈무리11', family: 'Galmuri11', group: '픽셀' },
  { id: 'galmuri9', name: '갈무리9', family: 'Galmuri9', group: '픽셀' },
  { id: 'galmuri7', name: '갈무리7', family: 'Galmuri7', group: '픽셀' },
  { id: 'limgul12', name: '림굴12', family: 'Limgul12', css: LIMGUL_CSS, group: '픽셀' },
  { id: 'limgul16', name: '림굴16', family: 'Limgul16', css: LIMGUL_CSS, group: '픽셀' },
  { id: 'dunggeunmo', name: '둥근모꼴', family: 'DungGeunMo', faces: [{ src: `${NOONNU}/noonfonts_six@1.2/DungGeunMo.woff` }], group: '픽셀' },
  { id: 'dosgothic', name: '도스고딕', family: 'DOSGothic', faces: [{ src: `${NOONNU}/noonfonts_eight@1.0/DOSGothic.woff` }], group: '픽셀' },
  { id: 'dotgothic16', name: 'DotGothic16', family: 'DotGothic16', group: '픽셀' },
  { id: 'chosungs', name: '조선궁서체', family: 'ChosunGs', faces: [{ src: `${NOONNU}/noonfonts_20-04@1.0/ChosunGs.woff` }], group: '일반' },
  { id: 'chosunkg', name: '조선견고딕', family: 'ChosunKg', faces: [{ src: `${NOONNU}/noonfonts_20-04@1.0/ChosunKg.woff` }], group: '일반' },
  { id: 'chosungu', name: '조선굴림체', family: 'ChosunGu', faces: [{ src: `${NOONNU}/noonfonts_20-04@1.0/ChosunGu.woff` }], group: '일반' },
  { id: 'gmarket', name: 'G마켓 산스', family: 'GmarketSans', faces: [
      { src: `${NOONNU}/noonfonts_2001@1.1/GmarketSansMedium.woff`, weight: '400' },
      { src: `${NOONNU}/noonfonts_2001@1.1/GmarketSansBold.woff`, weight: '700' }], group: '일반' },
  { id: 'pretendard', name: '프리텐다드', family: 'Pretendard', css: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css', group: '일반' },
];

const loaded = new Map(); // id -> Promise
const cssLinks = new Set();

function addCss(href) {
  if (cssLinks.has(href)) return;
  cssLinks.add(href);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

export function fontById(id, customFonts = []) {
  return BUILTIN_FONTS.find(f => f.id === id) || customFonts.find(f => f.id === id) || BUILTIN_FONTS[0];
}

export function ensureFont(font) {
  if (!font) return Promise.resolve();
  if (loaded.has(font.id)) return loaded.get(font.id);
  const p = (async () => {
    try {
      if (font.css) addCss(font.css);
      if (font.faces) {
        await Promise.all(font.faces.map(async f => {
          const ff = new FontFace(font.family, `url(${f.src})`, { weight: f.weight || '400' });
          document.fonts.add(ff);
          await ff.load();
        }));
      }
      await document.fonts.load(`16px "${font.family}"`, '가A');
      await document.fonts.load(`bold 16px "${font.family}"`, '가A').catch(() => {});
    } catch (e) {
      console.warn('font load failed', font.family, e);
    }
  })();
  loaded.set(font.id, p);
  return p;
}

// ---------- 사용자 폰트 (파일 업로드 / 웹폰트 URL) ----------
export async function registerCustomFont(entry) {
  // entry: {id, name, family, kind:'file', blob} | {id, name, family, kind:'url', url}
  if (loaded.has(entry.id)) return loaded.get(entry.id);
  const p = (async () => {
    try {
      if (entry.kind === 'file') {
        const buf = await entry.blob.arrayBuffer();
        const ff = new FontFace(entry.family, buf);
        document.fonts.add(ff);
        await ff.load();
      } else if (entry.kind === 'url') {
        if (/\.css(\?|$)/i.test(entry.url) || entry.url.includes('fonts.googleapis.com')) {
          addCss(entry.url);
          await document.fonts.load(`16px "${entry.family}"`, '가A');
        } else {
          const ff = new FontFace(entry.family, `url(${entry.url})`);
          document.fonts.add(ff);
          await ff.load();
        }
      }
    } catch (e) {
      console.warn('custom font failed', entry, e);
      throw e;
    }
  })();
  loaded.set(entry.id, p);
  return p;
}

export async function loadStoredFonts() {
  const list = (await idb.get('fonts')) || [];
  const ok = [];
  for (const f of list) {
    try { await registerCustomFont(f); ok.push(f); } catch { /* skip broken */ }
  }
  return ok;
}

export async function saveStoredFonts(list) {
  await idb.set('fonts', list);
}
