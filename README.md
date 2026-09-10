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

- 샤이니 확률
- 5시간/주간 한도 도달 시 "이상한 사탕" 보상
- 도감 UI
- Windows 알림 (부화/진화/졸업 시)
- 트레이 아이콘에 스프라이트 표시
- Codex/Gemini 탭 실제 구현 (지금은 팝업에 탭만 있고 "다음 라운드 예정" 플레이스홀더)
- **설정 UI** — 지금 하드코딩된 값들을 사용자가 직접 고를 수 있게:
  - 새로고침 주기 (`POLL_INTERVAL_MS`, 지금 5분 고정 — 원본은 수동/1/2/5/15분 프리셋 제공, 기본 2분)
  - 부화 확률 가중치 on/off (지금은 capture_rate 가중치 항상 켜짐)

## 튜닝 포인트

`src/growth.js` 상단 상수들 — 전부 추정 기본값이니 실사용 데이터 보면서 조절:
- `HATCH_THRESHOLD` (부화까지 필요 토큰)
- `BASE_STAGE_GROWTH` (common 티어 기준 진화 1단계당 토큰)
- `TIER_MULTIPLIER` (rare=3x, legendary=8x)

`scripts/build-gen1-data.js`의 `TIER_BOUNDS` — capture_rate 기준 희귀도 경계값.
