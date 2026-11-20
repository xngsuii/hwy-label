# hwy-label · LABEL MAKER

라벨 프린터(Epson LabelWorks)로 뽑은 듯한 라벨 스티커를 만들고, 서랍에 모아 한 판 이미지 / PNG / ZIP으로 내려받는 웹사이트.

## 구조

빌드 과정 없는 정적 사이트(ES 모듈). 저장소 루트가 그대로 사이트예요.

```
index.html        진입점
css/style.css     디자인 토큰 + 레이아웃
js/main.js        UI (Preact + htm, CDN)
js/store.js       상태 + IndexedDB 자동 저장
js/render.js      라벨 캔버스 렌더러 (mm 단위 레이아웃)
js/board.js       판 배치(자동/흩뿌리기) + 판 이미지 내보내기
js/fonts.js       폰트 레지스트리 + 내 폰트(파일/웹폰트 URL)
js/pixel.js       오리지널 픽셀 아이콘
docs/             계획서, 와이어프레임
```

## 로컬에서 보기

```powershell
python -m http.server 5173
```

→ http://localhost:5173

## GitHub Pages 배포

저장소 Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `(root)` → Save.

## 폰트

기본 탑재(웹 임베딩 허용): 갈무리 7·9·11, 림굴, 둥근모꼴, 도스고딕, DotGothic16, 조선궁서체·견고딕·굴림체, G마켓 산스, 프리텐다드.

재배포가 허용되지 않는 폰트(PF스타더스트, HY헤드라인 등)는 저장소에 넣지 않아요. 사이트의 **TEXT → 내 폰트 추가**로 각자 파일을 넣으면 그 브라우저에만 저장돼요.
