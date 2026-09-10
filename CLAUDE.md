# PokeTokenLite — 프로젝트 스펙 (Claude Code 작업 지시서)

## 목표
Claude Code 사용 시 로컬에 쌓이는 토큰 사용량 로그를 읽어서, 1세대 포켓몬(151마리)을
부화 → 진화 → 졸업(도감 등록)시키는 개인용 Windows 트레이 앱을 완성한다.
원본 아이디어: macOS 전용 오픈소스 앱 [PokeTokenBar](https://github.com/chattymin/PokeTokenBar)
(11개 툴 지원, 6개 언어, 플로팅 펫 등 풀스펙) — 이번엔 **1인 개인용 MVP로 최소 스코프**만 간다.

## 현재 상태
뼈대 코드가 이미 있음 (첨부된 `poketoken-lite/` 폴더). **실행 검증은 안 된 상태.**
이 문서를 읽고 아래 "확인/완성해야 할 것"부터 순서대로 처리해줘.

## 스택
- Node.js + Electron (트레이 아이콘, 팝업 창)
- 데이터 소스: PokéAPI (빌드 시점 1회 fetch, 런타임엔 캐시된 JSON만 사용)
- 상태 저장: 로컬 JSON 파일 (Electron `userData` 경로)

## 파일 구조 (이미 존재)
```
poketoken-lite/
  package.json
  scripts/build-gen1-data.js   PokéAPI → data/gen1.json 빌드
  src/
    logParser.js   Claude Code JSONL 로그 → 누적 토큰 계산  ⚠️검증 필요
    growth.js       희귀도별 임계치로 부화/진화/졸업 판정
    state.js        현재 컴패니언 + 도감 로컬 저장
    main.js         Electron 메인, 트레이 아이콘, 5분 폴링
  renderer/
    popup.html      트레이 클릭 시 팝업 UI  ⚠️IPC 미완성
  data/
    gen1.json        (build-data 실행 후 생성됨, 현재 비어있음)
```

## 확인/완성해야 할 것 (우선순위 순)

### 1. Claude Code 로그 스키마 검증 — 제일 먼저
- 대상 파일: `%USERPROFILE%\.claude\projects\**\*.jsonl`
- `src/logParser.js`의 `extractUsage()` 함수가 `entry.message.usage.input_tokens` 등의
  필드명을 가정하고 있는데, **이게 실제 스키마와 맞는지 확인되지 않음.**
- 할 일: 실제 jsonl 파일 하나를 열어서 한 줄(JSON)의 실제 구조를 보고,
  `extractUsage()`를 맞게 고쳐라. 토큰 필드가 input/output/cache-creation/cache-read로
  나뉘어 있는지, 아니면 다른 구조인지 직접 확인해서 반영.
- 검증 방법: 수정 후 `getTotalTokens()`를 호출해서 나온 숫자가 실제 사용량과
  대략 맞는지(터미널에 `claude` 명령어의 `/usage` 같은 기능이 있다면 그것과 비교) 확인.

### 2. Electron IPC 연결
- `src/main.js`에 `ipcMain.handle('get-status', () => ({ companion, gen1Data, pokedex }))` 추가
- `renderer/preload.js` 새로 만들어서 `contextBridge.exposeInMainWorld('api', { getStatus: () => ipcRenderer.invoke('get-status') })`
- `renderer/popup.html`에서 `require` 직접 호출하는 부분 제거하고 `window.api.getStatus()`로 교체
- 포켓몬 이름/스프라이트/진행률 바를 실제로 화면에 렌더링

### 3. 트레이 아이콘
- `assets/tray-icon.png` 없어서 빈 아이콘으로 뜸 — 우선 아무 16x16/32x32 PNG로 채워넣고 실행되게만 만들기
- 이후 여유되면: 현재 포켓몬 스프라이트(`gen1.json`의 `sprite` URL)를 다운받아 트레이 아이콘으로 동적 교체

### 4. 동작 테스트
- `npm install` → `npm run build-data` (인터넷 필요, PokéAPI 151마리 fetch) → `npm start`
- 트레이에 아이콘 뜨는지, 클릭 시 팝업 뜨는지, 5분마다 폴링 도는지 확인
- 상태 파일(`%APPDATA%\PokeTokenLite\state.json`) 생성되는지, 내용이 그럴듯한지 확인

## 성장 로직 (이미 구현됨, 참고용)
- 알 상태에서 누적 토큰이 `HATCH_THRESHOLD`(기본 50만, `src/growth.js` 상수) 넘으면 부화
- 부화 시 1단 진화 종(species.stage===1) 중 랜덤으로 선택
- 부화 이후 누적 토큰이 희귀도별 임계치(`stageThresholds()`) 넘을 때마다 다음 단계로 진화
  - 티어: common(1x) / rare(3x) / legendary(8x) — `TIER_MULTIPLIER`
  - 티어 판정 기준: PokéAPI `capture_rate` (낮을수록 희귀) — `scripts/build-gen1-data.js`의 `TIER_BOUNDS`
- 최종 진화 단계 도달 → 도감(`pokedex`)에 등록, 새 알 시작

## 이번 라운드에서 하지 않는 것 (스코프 밖)
- 샤이니, 성격, 상점, 가방(사탕), 5시간/주간 한도 연동 — 전부 2차 이후
- 다국어 — 한국어만
- Codex/Gemini 등 다른 툴 지원 — **1인 개인용 MVP인 이번 라운드는 Claude Code만.**
  다음 라운드에서 추가할 계획으로 스코프 변경(원래는 완전히 제외였음). 실제 구현 시엔
  Claude Code 로그 스키마를 검증했던 것과 같은 방식으로 Codex/Gemini CLI가 로컬에 남기는
  로그 파일 구조부터 실제로 열어서 확인하고 반영할 것 — 추측으로 파서 만들지 말 것.

## 작업 방식 요청
- 위 1→2→3→4 순서대로 진행하고, 각 단계 끝날 때마다 뭘 바꿨는지 간단히 요약해줘
- 로그 스키마처럼 내가 직접 확인 안 한 부분은 추측으로 밀어붙이지 말고,
  실제 파일 열어서 구조 확인한 다음 반영해줘
- 임계치 상수(`HATCH_THRESHOLD`, `BASE_STAGE_GROWTH` 등)는 전부 추정값이니
  건드릴 땐 왜 바꾸는지 이유 남겨줘
