# PokeTokenLite

Claude Code 토큰 사용량으로 1세대 포켓몬을 키우는 개인용 Windows 트레이 앱 MVP.

## 현재 상태: 뼈대만 있음 (동작 검증 안 됨)

이건 "돌아가는 완성품"이 아니라 **구조 설계 + 뼈대 코드**야. 실제로 쓰려면 아래
TODO들을 먼저 처리해야 함.

## 반드시 확인/수정해야 할 것

1. **`src/logParser.js`의 `extractUsage()` — Claude Code 실제 로그 스키마 검증 필수**
   - `%USERPROFILE%\.claude\projects\<프로젝트폴더>\*.jsonl` 파일 하나를 텍스트 에디터로 열어서
     실제 필드명이 `message.usage.input_tokens` 형태가 맞는지 확인
   - 안 맞으면 `extractUsage()` 함수만 고치면 됨 (나머지 로직엔 영향 없음)

2. **`renderer/popup.html` — IPC 연결 안 돼있음**
   - `contextIsolation: true`인데 `require`를 렌더러에서 직접 쓰고 있어서 이대로면 에러남
   - `preload.js` 만들어서 `contextBridge`로 `ipcRenderer.invoke('get-status')` 노출하고,
     `main.js`에 `ipcMain.handle('get-status', () => ({...}))` 추가해야 함

3. **트레이 아이콘 이미지 없음**
   - `assets/tray-icon.png` 파일이 없어서 빈 아이콘으로 뜸. 16x16 또는 32x32 PNG 아무거나 넣기
   - 나중엔 현재 포켓몬 스프라이트를 트레이 아이콘으로 동적 교체하면 원본 느낌 남

## 실행 순서

```bash
npm install
npm run build-data     # PokéAPI에서 1세대 151마리 데이터 fetch (인터넷 필요, 1회만)
npm start               # Electron 앱 실행
```

## 구조

```
src/
  logParser.js   Claude Code JSONL 로그 읽어서 누적 토큰 계산
  growth.js      희귀도별 임계치로 부화/진화/졸업 판정
  state.js       현재 컴패니언 + 도감을 로컬 JSON에 저장
  main.js        Electron 메인 프로세스, 트레이 아이콘, 5분 폴링
scripts/
  build-gen1-data.js   PokéAPI → data/gen1.json 빌드 스크립트
renderer/
  popup.html     트레이 클릭 시 뜨는 팝업 (IPC 미완성)
```

## 다음 단계 (2차 이후)

- 5시간/주간 한도 도달 시 "이상한 사탕" 보상
- 도감 UI — 지금은 "잡은 것만 로그처럼" 보여줌. 전체 151마리를 다 보여주되
  안 잡은 건 실루엣/이미지 비공개 처리하는 것 추가
- 알 구매/퀘스트/보상 시스템 (상점) — 지금은 진화할 때마다 알 티켓 1개
  적립하는 임시 방편만 있음
- **알 등급 차등화** — 지금은 티켓으로 도감의 정확한 종을 바로 골라 키움(등급
  개념 없음). 원본처럼 "등급이 매겨진 알"(커먼/레어/레전더리) 개념을 넣어서,
  등급 이상 범위에서 랜덤하게 나오게 하는 것도 고려 가능
- Windows 알림 (부화/진화/졸업 시)
- 트레이 아이콘에 스프라이트 표시
- Codex/Gemini 탭 실제 구현 (지금은 팝업에 탭만 있고 "다음 라운드 예정" 플레이스홀더)
- **설정 UI** — 지금 하드코딩된 값들을 사용자가 직접 고를 수 있게:
  - 새로고침 주기 (`POLL_INTERVAL_MS`, 지금 5분 고정 — 원본은 수동/1/2/5/15분 프리셋 제공, 기본 2분)
  - 부화 확률 가중치 on/off (지금은 capture_rate 가중치 항상 켜짐)
- **Electron → 네이티브 전환 검토** — 원본은 macOS 네이티브(AppKit+SwiftUI,
  `NSPopover`)라 웹뷰가 아예 없음. 우리는 Windows 타겟이라 SwiftUI는 못 쓰지만,
  후보로 WPF/WinUI 3(C#, 완전 네이티브·가장 가벼움·전체 재작성 필요) 또는
  Tauri(Rust, 백엔드 로직은 JS/TS 재사용 가능·OS 내장 웹뷰라 크로미움 번들 없음)
  검토. 지금 Electron 구조의 문제(예: WSL에 `libnss3` 없어서 아예 실행조차
  안 됐던 것)가 이 크로미움 번들 때문.

## 튜닝 포인트

`src/growth.js` 상단 상수들 — 전부 추정 기본값이니 실사용 데이터 보면서 조절:
- `HATCH_THRESHOLD` (부화까지 필요 토큰)
- `BASE_STAGE_GROWTH` (common 티어 기준 진화 1단계당 토큰)
- `TIER_MULTIPLIER` (rare=3x, legendary=8x)

`scripts/build-gen1-data.js`의 `TIER_BOUNDS` — capture_rate 기준 희귀도 경계값.
