# PokeTokenLite

Claude Code 토큰 사용량으로 포켓몬(1~9세대, 1025마리)을 키우는 개인용 Windows
트레이 앱 MVP.

## 현재 상태: 동작 확인됨

부화 → 진화 → 졸업, 도감(1025마리 전체 표시·미발견은 실루엣, 1~9세대 전부
처음부터 후보, 행 펼치면 타입/설명까지), 보관함(성장 중 교체), 알 보관함(등급별
부화 + 매주 무료 티켓), 상점(이상한 사탕/이로치 부적/등급 보장 알을 토큰으로
구매) + 가방(사탕 보관 후 사용), 이로치, 애니메이션 스프라이트, 항상 떠있는
위젯, 설정 화면(새로고침 주기/부화 가중치/난이도 배율/알림/자동 실행)까지 Windows
실기에서 직접 확인 완료. Windows
알림·시작 시 자동 실행은 코드는 붙였는데, 실제 동작(토스트/로그인 자동실행)은
아직 Windows 실기 확인 전(WSL/Linux는 Electron이 이 두 API를 지원 안 함).
**부스트 기믹**(토글로 진행도 프리즈 → 게이지 → 완료 시 이상한 사탕으로
환전)도 구현·헤드리스 테스트 완료했지만 아직 Windows 실기 확인 전.
`npm run dist`로 포터블 exe 빌드도 가능.

## 실행 순서

```bash
npm install
npm run build-data     # PokéAPI에서 1~9세대 1025마리 데이터 fetch (인터넷 필요, 1회만, 좀 걸림)
npm start               # Electron 앱 실행 (개발용)
npm run dist            # 포터블 exe 빌드 (dist/ 폴더에 생성, 설치 없이 실행 가능)
```

## 구조

```
src/
  logParser.js   Claude Code JSONL 로그 읽어서 누적 토큰 계산 (WSL 로그 경로도 자동 탐색)
  growth.js      등급별(common/uncommon/epic/legendary/mythical) 임계치로 부화/진화/졸업 판정
  shop.js        상점 가격/효과량 상수(이상한 사탕/이로치 부적/등급 알)
  boost.js       부스트 기믹 상수(게이지 임계치/보너스 배율/사탕 환전 계산)
  state.js       컴패니언/도감/보관함/알 보관함/상점 재화·가방을 로컬 JSON에 저장
  main.js        Electron 메인 프로세스, 트레이 아이콘, IPC, 폴링
scripts/
  build-pokedex-data.js   PokéAPI → data/pokedex.json 빌드 스크립트(세대별 독립 범위)
renderer/
  popup.html     트레이 클릭 시 뜨는 팝업 (컴패니언/도감/보관함/알보관함 탭)
  widget.html    항상 떠있는 미니 위젯
  preload.js     contextBridge로 렌더러에 안전하게 IPC 노출
```

## 관련 문서

- **`HISTORY.md`** — 개발 이력(왜 이렇게 구현했는지, 어떤 버그를 어떻게
  찾고 고쳤는지 시간순 기록). 레퍼런스 소스 확인 결과나 설계 판단 근거가
  여기 다 있음 — 같은 조사를 다시 안 해도 되게.
- **`BACKLOG.md`** — 다음 단계/아이디어(부스트 기믹 설계 메모 포함).
- **`SUMMARY.md`** — 프로젝트 한 페이지 요약(빠르게 감 잡을 때).

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
  epic 6억 / legendary 12억 / mythical 24억**. 이 표 자체는 "배율 1.0 기준값"
  으로 고정해두고, 실제 페이스 조절은 이제 코드 수정 없이 **설정 화면의
  난이도 슬라이더(0.1~2.0)** 로 함 — `stageThresholds()`/`HATCH_THRESHOLD`
  둘 다 소비 지점에서 이 배율을 곱함(레퍼런스 `PokemonBalance.scaled()`와
  동일 원칙 — 상수표 자체를 건드리면 다른 파생값까지 같이 끌려가서).
- `TIER_RANK` (등급 알의 "이 등급 이상 보장" 판정용 순위)
- `WEEKLY_TICKET_GRADE_WEIGHTS` (매주 월요일 10시 무료 알 티켓의 등급 가중치 —
  직접 정한 값, common 55 > uncommon 25 > epic 12 > legendary 6 > mythical 2)

`scripts/build-pokedex-data.js`의 `TIER_BOUNDS` — capture_rate 기준 희귀도
경계값(epic≤45, uncommon≤120, 그 이상 common). 전설/환상은 capture_rate가
아니라 PokéAPI `is_legendary`/`is_mythical` 플래그로 판정.

`src/shop.js` (상점 가격/효과량 — growth.js 상수를 참조만 하고 growth.js는
이 파일을 모름, 단방향 의존성):
- `RARE_CANDY_XP`/`RARE_CANDY_PRICE` (이상한 사탕 효과량/가격, 둘 다
  `HATCH_THRESHOLD`와 동급인 500만 — 1:1, "지금 당겨쓰기"의 대가)
- `SHINY_CHARM_PRICE`/`SHINY_CHARM_DENOMINATOR` (이로치 부적 가격 = epic
  졸업 총량과 동급인 고가 럭셔리 아이템, 분모는 `SHINY_DENOMINATOR`의 절반 =
  확률 2배)
- `EGG_PRICE_RATIO` (등급 보장 알 가격 = 그 등급 `GRADUATION_TOTAL`의 20%)

`src/boost.js` (부스트 기믹 — growth.js/shop.js를 참조만 하는 단방향 의존성):
- `BOOST_GAUGE_THRESHOLD` (부스트 게이지 임계치, `HATCH_THRESHOLD`의 3배인
  1,500만 — 다 채우면 자동 완료)
- `BOOST_BONUS_MULTIPLIER` (완료 시 모은 양에 곱하는 보너스 배율, 1.3배 —
  실사용 페이스 보고 조절 여지 있음)
