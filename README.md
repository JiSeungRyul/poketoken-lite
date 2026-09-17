# PokeTokenLite

Claude Code 토큰 사용량으로 포켓몬(1·2세대, 251마리)을 키우는 개인용 Windows
트레이 앱 MVP.

## 현재 상태: 동작 확인됨

부화 → 진화 → 졸업, 도감(251마리 전체 표시·미발견은 실루엣, 1·2세대 전부
처음부터 후보), 보관함(성장 중 교체), 알 보관함(등급별 부화 + 매주 무료 티켓), 이로치,
애니메이션 스프라이트, 항상 떠있는 위젯까지 Windows 실기에서 직접 확인 완료.
Windows 알림(부화/진화/졸업/알 티켓 시)도 코드는 붙였는데, 실제 토스트가
뜨는지는 아직 Windows 실기 확인 전.
`npm run dist`로 포터블 exe 빌드도 가능.

## 실행 순서

```bash
npm install
npm run build-data     # PokéAPI에서 1·2세대 251마리 데이터 fetch (인터넷 필요, 1회만, 좀 걸림)
npm start               # Electron 앱 실행 (개발용)
npm run dist            # 포터블 exe 빌드 (dist/ 폴더에 생성, 설치 없이 실행 가능)
```

## 구조

```
src/
  logParser.js   Claude Code JSONL 로그 읽어서 누적 토큰 계산 (WSL 로그 경로도 자동 탐색)
  growth.js      등급별(common/uncommon/epic/legendary/mythical) 임계치로 부화/진화/졸업 판정
  state.js       컴패니언/도감/보관함/알 보관함을 로컬 JSON에 저장
  main.js        Electron 메인 프로세스, 트레이 아이콘, IPC, 폴링
scripts/
  build-pokedex-data.js   PokéAPI → data/pokedex.json 빌드 스크립트(세대별 독립 범위)
renderer/
  popup.html     트레이 클릭 시 뜨는 팝업 (컴패니언/도감/보관함/알보관함 탭)
  widget.html    항상 떠있는 미니 위젯
  preload.js     contextBridge로 렌더러에 안전하게 IPC 노출
```

## 2세대 추가 — 완료

도감 등록 구조(졸업한 라인 전체 영구 등록 + 성장 중/보관함 진행분 실시간 발견)는
이전에 먼저 해결해서 151/151이 구조적으로 달성 가능해져 있었고, 실제 2세대
데이터를 붙였다.

**세대별 독립 범위 빌드**: PokéAPI의 evolution-chain은 세대 구분이 없어서(예:
이브이(1세대)의 진화형이 2·4·6세대에 걸쳐있음) 직접 확인 후 `flattenChain()`을
`(minId, maxId)` 범위를 받게 일반화해서, **1세대(1~151)와 2세대(152~251)를
서로 완전히 독립된 범위로 각각 클리핑**해 빌드한다(`scripts/build-pokedex-data.js`).
그래서 폴리곤(1세대)→폴리곤2(2세대)처럼 세대를 넘나드는 진화는 각 세대 파일에서
독립된 별개의 종으로 취급됨(폴짝몬(2세대 베이비)→얼음귀신(1세대) 같은 반대
방향도 동일 — 1세대 데이터의 피츄→피카츄 관계가 이미 이렇게 끊겨있던 것과
같은 패턴). 결과는 `data/pokedex.json` 하나에 1~251 전부, 각 항목에
`generation: 1|2` 필드로 구분(지금은 게임 로직에서 이 필드를 안 씀 — 아래 참고).

**해금 조건 → 폐기, 처음부터 전체 오픈으로 변경(사용자 확정)**: 처음엔 "1세대
151/151 채우면 2세대 해금" 단계적 잠금으로 구현했었는데, 레퍼런스(PokeTokenBar)
소스를 직접 확인해보니 그런 단계적 잠금이 아예 없었다 — `PokemonAssets
.animatedSpeciesIDs = 1...649`(1~5세대 전체)를 **처음부터 하나의 풀로** 써서
capture_rate 가중치로만 자연스럽게 희귀도를 조절함. 우리도 이 방식으로 맞춰서
`state.unlockedGen`/`checkGenUnlock()`/부화 풀의 `maxGen` 필터를 전부 제거 —
**1·2세대 251마리가 처음부터 전부 부화 후보**. 도감 분모(`pokedexTotal`)도 항상
251 고정. (판단 근거: 1세대 151/151엔 전설·환상까지 포함되는데, 그거 다 채울
때까지 2세대를 아예 구경도 못 하는 게 캐주얼한 개인용 앱치고 너무 늦게 열린다고
판단해서 레퍼런스 방식으로 되돌림.)

`gen1Data`라는 변수/전역명은 그대로 유지(20곳 넘게 쓰여서 순수 리네이밍 값어치가
없음) — 이제 1+2세대 다 담겨있다는 점만 로딩 부분 주석으로 남겨둠.

## 다음 단계 (우선순위 낮음)

- 5시간/주간 한도 도달 시 "이상한 사탕" 보상
- 도감 항목 클릭 시 지금은 진화 라인만 펼쳐 보여줌 — 나중엔 클릭하면 팝업으로
  포켓몬 상세 정보(타입/설명 등) 보여주기
- 알 구매/퀘스트/보상 시스템 (상점) — 지금은 진화/졸업할 때마다 등급 알 1개,
  매주 월요일 10시마다 무료 알 티켓 1개가 알 보관함에 적립되는 것만 있음
- Codex/Gemini 탭 실제 구현 (지금은 팝업에 탭만 있고 "다음 라운드 예정" 플레이스홀더)
- **설정 UI** — 지금 하드코딩된 값들을 사용자가 직접 고를 수 있게:
  - 새로고침 주기 (`POLL_INTERVAL_MS`, 지금 2분 고정)
  - 부화 확률 가중치(capture_rate 기반) on/off
- **Electron → 네이티브 전환 검토** — Tauri(Rust, popup.html 거의 그대로 재사용
  가능·OS 내장 웹뷰라 크로미움 번들 없음)가 WPF/WinUI 3보다 현실적. 지금
  Electron 구조의 문제(WSL에 `libnss3` 없어서 실행조차 안 됐던 것 등)가
  크로미움 번들 때문 — 급한 건 아님, 당장 안 할 예정.
  (참고: 항상 떠있는 위젯은 네이티브 전환 기다릴 필요 없이 Electron에서
  바로 구현 완료 — `renderer/widget.html`, 트레이 메뉴에서 on/off)
- **macOS 빌드 지원** — 지금 `package.json`의 `electron-builder` 설정엔
  `build.win`만 있고 `build.mac`이 없어서 `npm run dist`가 Windows exe만
  뽑음. 코드 자체는 Windows 종속적인 부분이 거의 없어서(WSL 로그 스캔만
  `win32`일 때만 타는 분기라 맥에선 그냥 안 걸림) 설정 추가 자체는 금방
  끝나지만, 트레이 아이콘 모양(다크모드 자동 틴트용 템플릿 이미지 필요할
  수 있음)·Dock 아이콘 노출 여부·코드사이닝 안 된 앱의 Gatekeeper 경고
  같은 건 실제 맥에서 띄워봐야 확인 가능 — 이 개발 환경엔 맥이 없어서
  검증은 사용자가 실제 맥에서 직접 해야 함.

## 튜닝 포인트

`src/growth.js`:
- `HATCH_THRESHOLD` (알 → 부화까지 필요 토큰, 500만 — 안 건드림)
- `GRADUATION_TOTAL` (등급별 졸업까지 총 토큰) — 레퍼런스(PokeTokenBar) 실측값
  (레퍼런스 "실측 평균 하루 2.53억 토큰" 기준)의 **정확히 1/5**로 축소해서 씀.
  처음엔 이 프로젝트 실측 사용 패턴(평일 활동일 평균 약 8,150만 토큰/일,
  2026-09-08~09-14 기준)으로 "에픽 = 평일 1주일"이 되게 1/7.5까지 낮췄었는데
  너무 빠르다는 피드백으로 1/5(에픽 = 대략 1.5~3주, 활동 페이스에 따라 다름)로
  다시 올림. 등급 간 비율(common:uncommon:epic:legendary:mythical =
  0.25:0.625:1:2:4)은 그대로 유지 — **common 1.5억 / uncommon 3.75억 /
  epic 6억 / legendary 12억 / mythical 24억**. 사용 패턴이 확 달라지면 이
  비율 기준으로 다시 스케일하면 됨.
- `TIER_RANK` (등급 알의 "이 등급 이상 보장" 판정용 순위)
- `WEEKLY_TICKET_GRADE_WEIGHTS` (매주 월요일 10시 무료 알 티켓의 등급 가중치 —
  직접 정한 값, common 55 > uncommon 25 > epic 12 > legendary 6 > mythical 2)

`scripts/build-pokedex-data.js`의 `TIER_BOUNDS` — capture_rate 기준 희귀도
경계값(epic≤45, uncommon≤120, 그 이상 common). 전설/환상은 capture_rate가
아니라 PokéAPI `is_legendary`/`is_mythical` 플래그로 판정.
