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

**⚠️ 착수 전 반드시 먼저 풀어야 할 문제 (실제로 확인함)**: 지금 도감 등록은
"졸업(최종 진화 완료) = 도감 등록" 구조라, **151마리 중 81마리(최종형)만 도감에
등록 가능하고 나머지 70마리(코일처럼 "다음 단계가 있는" 기본/중간형)는 절대
도감에 못 들어감**(`evolvesTo.length > 0`인 종은 항상 진화해서 다음 종으로
넘어가버리고, 그 자체로 도감에 박히는 일이 없음). 그래서 지금 구조 그대로는
"151/151 채우기"가 애초에 불가능한 목표임.

사용자 결정: 목표를 81로 줄이지 말고 **151을 그대로 유지**하고, 코일 같은
중간/기본형도 도감에 등록될 수 있는 방법을 새로 만들 것. 구체적인 구현 방식은
미정 — 착수 시 고민할 것들:
- "졸업 안 하고 지금 단계에서 도감에 등록"하는 버튼/액션을 만들지
- 아니면 "그 종을 한 번이라도 companion으로 거쳐가면(꼭 최종형까지 안 가도)
  자동으로 도감에 표시"하는 식으로, 졸업과 도감 등록을 아예 분리할지
- 중간형을 도감에 등록하면 "N회 부화" 카운트나 이로치 여부는 어떻게 다룰지
  (졸업한 것도 아닌데 완전한 기록으로 칠지)
- 해금 판정 시점(151/151 채운 순간 즉시? 다음 tick에?)과 알림 방식도 고려

## 다음 단계 (2세대 이후 — 우선순위 낮음)

- 5시간/주간 한도 도달 시 "이상한 사탕" 보상
- 도감 UI — 지금은 "잡은 것만" 보여줌. 전체 마리를 다 보여주되 안 잡은 건
  실루엣/이미지 비공개 처리하는 것 추가
- 도감 항목 클릭 시 지금은 진화 라인만 펼쳐 보여줌 — 나중엔 클릭하면 팝업으로
  포켓몬 상세 정보(타입/설명 등) 보여주기
- 알 구매/퀘스트/보상 시스템 (상점) — 지금은 진화할 때마다 등급 알 1개
  알 보관함에 적립되는 것만 있음
- Windows 알림 (부화/진화/졸업 시)
- 트레이 아이콘에 스프라이트 표시 (지금은 고정 placeholder)
- Codex/Gemini 탭 실제 구현 (지금은 팝업에 탭만 있고 "다음 라운드 예정" 플레이스홀더)
- **설정 UI** — 지금 하드코딩된 값들을 사용자가 직접 고를 수 있게:
  - 새로고침 주기 (`POLL_INTERVAL_MS`, 지금 2분 고정)
  - 부화 확률 가중치(capture_rate 기반) on/off
- **Electron → 네이티브 전환 검토** — Tauri(Rust, popup.html 거의 그대로 재사용
  가능·OS 내장 웹뷰라 크로미움 번들 없음)가 WPF/WinUI 3보다 현실적. 지금
  Electron 구조의 문제(WSL에 `libnss3` 없어서 실행조차 안 됐던 것 등)가
  크로미움 번들 때문 — 급한 건 아님, 당장 안 할 예정.

## 튜닝 포인트

`src/growth.js` — 값들은 레퍼런스(PokeTokenBar) 실측 기반으로 맞춘 것도 있고
(`GRADUATION_TOTAL`의 common/uncommon/legendary, `HATCH_THRESHOLD`),
우리가 직접 정한 추정값도 있음(`GRADUATION_TOTAL.mythical`은 legendary의
2배로 임의 추정 — 레퍼런스엔 mythical 등급 자체가 없음, 전설/환상 안 나눠서
같이 취급함):
- `HATCH_THRESHOLD` (알 → 부화까지 필요 토큰, 500만)
- `GRADUATION_TOTAL` (등급별 졸업까지 총 토큰 — common 7.5억/uncommon 18.75억/
  epic 30억/legendary 60억/mythical 120억)
- `TIER_RANK` (등급 알의 "이 등급 이상 보장" 판정용 순위)

`scripts/build-gen1-data.js`의 `TIER_BOUNDS` — capture_rate 기준 희귀도
경계값(epic≤45, uncommon≤120, 그 이상 common). 전설/환상은 capture_rate가
아니라 PokéAPI `is_legendary`/`is_mythical` 플래그로 판정.
