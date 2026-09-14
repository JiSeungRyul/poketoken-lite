# PokeTokenLite

Claude Code 토큰 사용량으로 1세대 포켓몬을 키우는 개인용 Windows 트레이 앱 MVP.

## 현재 상태: 동작 확인됨

부화 → 진화 → 졸업, 도감(종별 묶음+진화 라인 보기), 보관함(성장 중 교체),
알 보관함(등급별 부화), 이로치, 애니메이션 스프라이트까지 Windows 실기에서
직접 확인 완료. `npm run dist`로 포터블 exe 빌드도 가능.

## 실행 순서

```bash
npm install
npm run build-data     # PokéAPI에서 1세대 151마리 데이터 fetch (인터넷 필요, 1회만)
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
  build-gen1-data.js   PokéAPI → data/gen1.json 빌드 스크립트
renderer/
  popup.html     트레이 클릭 시 뜨는 팝업 (컴패니언/도감/보관함/알보관함 탭)
  preload.js     contextBridge로 렌더러에 안전하게 IPC 노출
```

## 다음 작업 — 2세대 추가

**우선순위 1순위.** 지금은 `GEN1_COUNT=151`로 1세대만 고정돼있음. 착수 전에
확인해야 할 것들(1세대 때 했던 것처럼 추측 말고 실제로 확인):

- PokéAPI에서 2세대(152~251번) evolution-chain이 1세대와 안 섞이는지,
  섞인다면(예: 1세대 포켓몬이 2세대에서 얻은 진화형 — 이미 겪어본 문제 패턴)
  `flattenChain()`의 범위 처리를 다시 점검해야 함
- 2세대 신규 타입/메카닉(강철·악 타입, 데이몬드/펄 진화 아이템 등)이 지금
  로직(진화 체인 stage/evolvesTo 기반)에 문제없이 들어맞는지
- `GEN1_COUNT` 이름 자체를 `GEN_COUNT`처럼 세대 무관하게 바꿔야 할 수도 있음
- `data/gen1.json` 파일명/변수명(`gen1Data`)도 세대 확장에 맞게 리네이밍 고려
- 도감 "N/151" 표시, 알 부화 풀(`pickHatchSpecies`의 `p.stage===1` 필터)도
  전체 마리수 늘어난 것에 맞게 자동으로 따라가는지 확인

**해금 조건(사용자 확정)**: 2세대는 처음부터 다 풀어두는 게 아니라, **1세대
도감을 151/151 다 채워야 2세대가 열리는** 구조로 간다. 즉:
- 알/알 보관함 부화 풀, 도감 카운트 등은 "지금 해금된 세대까지"만 대상으로
  제한해야 함 — 세대 잠금 상태를 어딘가(`state.json`?)에 들고 있어야 함
- 도감 UI에서 아직 안 열린 세대는 어떻게 보여줄지(아예 숨김 vs "🔒 2세대 —
  1세대 도감 완성 시 해금" 같은 안내)도 정해야 함

**⚠️ 착수 전 반드시 먼저 풀어야 할 문제 → 해결 완료.** 예전엔 "졸업(최종 진화
완료) = 도감 등록" 구조라 151마리 중 81마리(최종형)만 등록 가능하고 코일 같은
70마리(중간/기본형)는 절대 도감에 못 들어갔다. 레퍼런스(PokeTokenBar)의
`CompanionStore.swift`(`graduate()`, `dexSpecies`)를 직접 확인해서 그대로 옮겨왔음:

- **졸업 시 라인 전체를 영구 등록**: `state.pokedex`에 최종형 id뿐 아니라
  `chainOrder`(기본형~최종형 전체 배열)를 같이 저장(`src/main.js`
  `reachedChainIds()`). 코일 라인이 레어코일까지 완주되면 코일+레어코일이
  한 번에 영구 기록됨. `gen1Data`는 빌드 시점에 이미 4세대 메탕그 같은 후속
  세대 진화형을 걸러내므로(`build-gen1-data.js`) "1세대 기준 최종형"은 손댈
  필요 없이 이미 맞게 처리돼 있음.
- **지금 키우는 중/보관함에 있는 진행분도 실시간으로 발견 처리**: 별도 저장 없이
  읽을 때마다 계산(`buildDexAggregate()`) — 졸업 안 해도 코일 상태 그 자체로
  바로 도감에 잡힘. 레퍼런스의 `ownsSpecies()`/`dexSpecies`(졸업분 ∪ 현재 개체의
  도달 단계)와 동일한 방식. 우리는 "놓아주기" 기능이 없는 대신 보관함
  (`storedCompanions`)이 그 역할(진행 상황 보존)을 대신함.
- **아직 발견 못 한 다음 진화형은 `??`**: 도감 행을 펼쳐서 보는 진화 라인
  (`evo-chain`)에서, 발견 집합에 없는 단계는 이름/스프라이트를 안 보내고
  `discovered:false`만 반환 — 팝업에서 `?????` + 회색 물음표 박스로 표시
  (`renderer/popup.html` `.evo-unknown-img`). 코일만 발견하고 레어코일은
  아직인데 펼쳐봐도 스포일러가 안 새게 함.
- 등급(tier)은 항상 그 라인 고정값을 체인 전체에 전파함(개별 종 자신의
  `gen1Data.tier`를 쓰면 "미진화체 common인데 최종형만 legendary로 표시" 버그가
  도감에서 재발함 — `growth.js`에서 이미 한 번 고쳤던 것과 같은 규칙).

이걸로 151/151이 구조적으로 달성 가능해짐 — 2세대 해금 판정 자체(카운트를 보고
실제로 잠그고 푸는 로직)는 아직 구현 안 했고, 위 "착수 전 확인" 체크리스트와
함께 2세대 본작업에서 진행.

(참고: "전체 151마리를 다 보여주고 미보유는 실루엣 처리"하는 도감 그리드 UI는
이번에 안 건드림 — 레퍼런스도 그런 그리드는 없고 "보유 종만" 나열하는 방식이라,
그건 아래 백로그 항목으로 별도 유지)

## 다음 단계 (2세대 이후 — 우선순위 낮음)

- 5시간/주간 한도 도달 시 "이상한 사탕" 보상
- 도감 UI — 지금은 "잡은 것만" 보여줌. 전체 마리를 다 보여주되 안 잡은 건
  실루엣/이미지 비공개 처리하는 것 추가
- 도감 항목 클릭 시 지금은 진화 라인만 펼쳐 보여줌 — 나중엔 클릭하면 팝업으로
  포켓몬 상세 정보(타입/설명 등) 보여주기
- 알 구매/퀘스트/보상 시스템 (상점) — 지금은 진화/졸업할 때마다 등급 알 1개,
  매주 월요일 10시마다 무료 알 티켓 1개가 알 보관함에 적립되는 것만 있음
- **Windows 알림** — 부화/진화/졸업(레벨업) 시 + 매주 월요일 무료 알 티켓
  지급 시. 코드에 훅은 이미 있음(`src/main.js`의 `// TODO: 알림(Notification)
  붙이기` 두 군데 — tick()의 이벤트 로그 지점, `grantWeeklyTicketIfDue()`),
  Electron `Notification` API로 연결만 하면 됨 — 난이도 낮음
- 트레이 아이콘에 스프라이트 표시 (지금은 고정 placeholder)
- Codex/Gemini 탭 실제 구현 (지금은 팝업에 탭만 있고 "다음 라운드 예정" 플레이스홀더)
- **설정 UI** — 지금 하드코딩된 값들을 사용자가 직접 고를 수 있게:
  - 새로고침 주기 (`POLL_INTERVAL_MS`, 지금 2분 고정)
  - 부화 확률 가중치(capture_rate 기반) on/off
- **Electron → 네이티브 전환 검토** — Tauri(Rust, popup.html 거의 그대로 재사용
  가능·OS 내장 웹뷰라 크로미움 번들 없음)가 WPF/WinUI 3보다 현실적. 지금
  Electron 구조의 문제(WSL에 `libnss3` 없어서 실행조차 안 됐던 것 등)가
  크로미움 번들 때문 — 급한 건 아님, 당장 안 할 예정. **네이티브 전환 시
  같이 넣을 것(사용자 요청)**: 팝업이 아니라 항상 화면에 떠있는 미니
  위젯(레퍼런스의 "플로팅 펫"과 유사) — 투명도(opacity) 조절 가능, 항상
  위(always on top) 고정.

## 튜닝 포인트

`src/growth.js`:
- `HATCH_THRESHOLD` (알 → 부화까지 필요 토큰, 500만 — 안 건드림)
- `GRADUATION_TOTAL` (등급별 졸업까지 총 토큰) — 원래 레퍼런스(PokeTokenBar)
  실측값(레퍼런스 "실측 평균 하루 2.53억 토큰" 기준)을 그대로 썼었는데, 그건
  이 프로젝트 사용자보다 훨씬 헤비한 사용 패턴 기준이라 **실제 로그로 다시
  맞춤**: 평일 활동일 평균 약 8,150만 토큰/일(2026-09-08~09-14 실측) 기준으로
  "에픽이 평일 5일(1주일) 안에 졸업"하도록 역산해서 4억으로 잡고, 나머지
  등급은 원래 비율(common:uncommon:epic:legendary:mythical = 0.25:0.625:1:2:4)
  그대로 유지한 채 축소(2/15배) — **common 1억 / uncommon 2.5억 / epic 4억 /
  legendary 8억 / mythical 16억**. 사용 패턴이 확 달라지면 이 비율 기준으로
  다시 스케일하면 됨.
- `TIER_RANK` (등급 알의 "이 등급 이상 보장" 판정용 순위)
- `WEEKLY_TICKET_GRADE_WEIGHTS` (매주 월요일 10시 무료 알 티켓의 등급 가중치 —
  직접 정한 값, common 55 > uncommon 25 > epic 12 > legendary 6 > mythical 2)

`scripts/build-gen1-data.js`의 `TIER_BOUNDS` — capture_rate 기준 희귀도
경계값(epic≤45, uncommon≤120, 그 이상 common). 전설/환상은 capture_rate가
아니라 PokéAPI `is_legendary`/`is_mythical` 플래그로 판정.
