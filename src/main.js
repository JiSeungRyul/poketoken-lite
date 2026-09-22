const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen, Notification } = require("electron");
const path = require("path");
const fs = require("fs");

const { getTotalTokens, getTotalTokensAsOf } = require("./logParser");
const {
  evaluate,
  newEgg,
  applyRareCandy,
  freezeProgress,
  HATCH_THRESHOLD,
  GRADUATION_TOTAL,
  SHINY_DENOMINATOR,
  stageThresholds,
  pickWeeklyTicketGrade,
} = require("./growth");
const { loadState, saveState } = require("./state");
const {
  RARE_CANDY_XP,
  RARE_CANDY_PRICE,
  SHINY_CHARM_PRICE,
  SHINY_CHARM_DENOMINATOR,
  eggPrice,
} = require("./shop");
const { BOOST_GAUGE_THRESHOLD, candiesFromBoost } = require("./boost");


// 알 상태일 때 보여줄 정적 스프라이트. PokéAPI엔 종별 데이터만 있어서 gen1.json엔
// 없고, PokeAPI/sprites 저장소에 있는 공용 알 이미지를 그대로 씀(움직이는 GIF는
// 없음 — 실제 게임도 알 자체는 프레임 애니메이션이 아니라 "흔들림" 연출이라, 흔들리는
// 정도는 popup.html에서 진행률(%) 기준으로 CSS 애니메이션으로 직접 구현함).
const EGG_SPRITE_URL = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/egg.png";

let tray = null;
let popup = null;
let widgetWindow = null;
let widgetMenuItem = null; // 트레이 체크박스 참조 — 코드에서 위젯을 껐다 켰다 할 때 체크 표시도 같이 맞추려고
let gen1Data = null;
let state = null;
let lastTotalTokens = 0; // tick()에서 갱신, 팝업이 열릴 때마다 로그 전체를 재파싱하지 않기 위한 캐시

// 한글 받침 유무에 따라 조사를 고른다("이/가", "을/를", "으로/로" 등). 한글
// 음절(U+AC00~U+D7A3)의 마지막 글자 코드에서 받침 유무를 계산 — 한글이 아니면
// (숫자/영문 등) 안전하게 받침 있는 쪽을 기본값으로 씀.
function josa(word, withBatchim, withoutBatchim) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return withBatchim;
  const hasBatchim = (code - 0xac00) % 28 !== 0;
  return hasBatchim ? withBatchim : withoutBatchim;
}

// Windows 알림. 지원 안 되는 환경(OS 설정으로 꺼둔 경우 등)이면 조용히 무시.
// 클릭하면 전체 창을 열어줌 — ensurePopupOpen()은 아래에서 선언되지만 함수
// 선언은 호이스팅되니 순서 문제 없음.
function notify(title, body) {
  if (!state.settings.notificationsEnabled) return; // 설정 화면 토글
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, "..", "assets", "icon.ico") });
  n.on("click", () => ensurePopupOpen());
  n.show();
}

// 부화/진화/졸업 이벤트에 맞는 알림 문구를 고른다.
function notifyForEvent(event, companion) {
  const species = gen1Data[companion.speciesId];
  if (!species) return;
  const name = species.nameKo;
  const shinyMark = companion.isShiny ? " ✨" : "";
  if (event === "hatch") {
    notify("🥚 부화!", `${name}${shinyMark}${josa(name, "이", "가")} 태어났어요!`);
  } else if (event === "evolve") {
    notify("✨ 진화!", `${name}${shinyMark}${josa(name, "으로", "로")} 진화했어요!`);
  } else if (event === "graduate") {
    notify("🎓 졸업!", `${name}${shinyMark}${josa(name, "이", "가")} 도감에 등록됐어요!`);
  }
}

// 변수명은 gen1Data 그대로 유지(growth.js/main.js 전역에 넓게 쓰여서 순수 리네이밍만
// 하기엔 위험도 대비 득이 적음) — 이제 실제로는 1~9세대(1~1025, 전 세대) 전부 들어있음.
function loadGen1Data() {
  const p = path.join(__dirname, "..", "data", "pokedex.json");
  if (!fs.existsSync(p)) {
    console.error(
      "data/pokedex.json not found. Run `npm run build-data` first to fetch PokeAPI data."
    );
    app.quit();
    return;
  }
  gen1Data = JSON.parse(fs.readFileSync(p, "utf-8"));
}

// 1세대 범위(1~151) 밖 진화형으로 잘못 흘러들어간 speciesId를 올바른 1세대 조상으로
// 되돌리는 표. 실제 PokeAPI 진화 체인을 스크립트로 직접 조회해서 만든 값(추측 아님) —
// 예전 build-gen1-data.js가 세대 구분 없이 진화 체인을 통째로 가져오면서, 1세대
// 포켓몬이 후속 세대에서 얻은 진화형(예: 마그네톤(82)→메탕그(462, 4세대))까지
// evolvesTo에 섞여 들어갔던 흔적. data/gen1.json은 이미 재빌드해서 더는 안 생기지만,
// 그 버그가 살아있던 동안 저장된 state.json엔 이 값들이 남아있을 수 있다.
const OUT_OF_RANGE_ANCESTOR = {
  169: 42, 182: 44, 186: 61, 196: 133, 197: 133, 199: 79, 208: 95, 212: 123,
  230: 117, 233: 137, 242: 113, 462: 82, 463: 108, 464: 112, 465: 114,
  466: 125, 467: 126, 470: 133, 471: 133, 474: 137, 700: 133, 863: 52,
  865: 83, 866: 122, 900: 123, 979: 57,
};

// speciesId가 gen1Data에 있으면 그대로, 없으면(범위 밖) 표에서 조상을 찾아 반환. 둘 다
// 없으면 복구 불가(null).
function resolveToGen1Id(speciesId) {
  if (gen1Data[speciesId]) return speciesId;
  const ancestor = OUT_OF_RANGE_ANCESTOR[speciesId];
  return gen1Data[ancestor] ? ancestor : null;
}

/**
 * 1회성 보정: 도감에 "제대로 안 키운" 기록이 두 가지 경로로 잘못 들어갈 수 있었다.
 * 1) speciesId가 진화해도 안 바뀌던 버그(2a2ab94 이전) — 부화 당시 기본형이 그대로 기록됨
 * 2) 진화 체인에 1세대 범위 밖 진화형이 섞여 들어가던 버그 — speciesId가 아예
 *    gen1Data에 없는 값(예: 462)으로 기록됨
 * 두 경우 다 "실제로 최종진화까지 정당하게 키운 게 아니다"인 게 핵심이라, 최종형이
 * 아닌 종으로 귀결되는 기록은 도감에서 빼서 보관함에 1단계부터 다시 키울 수 있는
 * 상태로 돌려놓는다(공짜로 도감에 등록해주지 않음). 복구했더니 이미 최종형이었던
 * 경우(예: 2번 버그였지만 조상이 이미 1세대 최종형)는 speciesId만 바로잡고 도감에 유지.
 */
function fixCorruptedPokedexEntries() {
  const stillValid = [];
  let movedToStorage = 0;
  let renamedInPlace = 0;
  const nowTotal = getTotalTokens();

  for (const entry of state.pokedex) {
    const resolvedId = resolveToGen1Id(entry.speciesId);
    if (resolvedId == null) {
      console.error(`Pokedex entry has unrecoverable speciesId, dropping: ${entry.speciesId}`, entry);
      continue;
    }

    const species = gen1Data[resolvedId];
    if (species.evolvesTo.length > 0) {
      state.storedCompanions.push({
        speciesId: resolvedId,
        stage: 1,
        tier: species.tier,
        hatchedAtTotal: nowTotal,
        frozenProgress: 0, // 방금 1단계로 리셋된 것이라 진행률 0부터 시작
        isShiny: !!entry.isShiny,
        storedAt: new Date().toISOString(),
      });
      movedToStorage += 1;
    } else {
      if (resolvedId !== entry.speciesId) renamedInPlace += 1;
      stillValid.push({ ...entry, speciesId: resolvedId, tier: entry.tier ?? species.tier });
    }
  }

  if (movedToStorage > 0 || renamedInPlace > 0) {
    state.pokedex = stillValid;
    console.log(
      `Pokedex fixup: ${movedToStorage} moved to storage (restart from stage 1), ${renamedInPlace} speciesId corrected in place`
    );
    saveState(app.getPath("userData"), state);
  }
}

// 지금 키우던 컴패니언의 speciesId도 같은 이유로 손상돼 있을 수 있음(성장 중 진화하며
// 범위 밖 값으로 샌 경우). 복구 가능하면 그 조상 종의 1단계로 리셋, 불가능하면 통째로
// 지워서 다음 tick에 새 알로 시작되게 한다.
function fixCorruptedCompanion() {
  const companion = state.companion;
  if (!companion || companion.state === "egg" || gen1Data[companion.speciesId]) return;

  const resolvedId = resolveToGen1Id(companion.speciesId);
  console.error(`Current companion's speciesId is corrupted: ${companion.speciesId} -> ${resolvedId ?? "unrecoverable, resetting to new egg"}`);
  if (resolvedId != null) {
    state.companion = {
      state: "growing",
      speciesId: resolvedId,
      stage: 1,
      tier: gen1Data[resolvedId].tier,
      hatchedAtTotal: getTotalTokens(),
      isShiny: !!companion.isShiny,
    };
  } else {
    state.companion = null;
  }
  saveState(app.getPath("userData"), state);
}

/**
 * 1회성 보정: tier를 부화 시점에 고정하는 기능(진화해도 등급 안 바뀌게 하는 것) 추가
 * 이전에 저장된 데이터는 companion/도감 항목/보관함 항목에 tier 필드 자체가 없다.
 * 손상 데이터는 아니라서 fixCorrupted*()로는 안 잡히므로, 현재 종의 tier로 채워넣는다
 * (원래 부화 시점에 어떤 등급이었는지는 알 방법이 없어서 최선의 근사치).
 */
function migrateMissingTier() {
  let changed = false;

  if (state.companion && state.companion.state !== "egg" && state.companion.tier == null) {
    const species = gen1Data[state.companion.speciesId];
    if (species) {
      state.companion.tier = species.tier;
      changed = true;
    }
  }

  for (const entry of state.pokedex) {
    if (entry.tier == null) {
      const species = gen1Data[entry.speciesId];
      if (species) {
        entry.tier = species.tier;
        changed = true;
      }
    }
  }

  for (const c of state.storedCompanions) {
    if (c.tier == null) {
      const species = gen1Data[c.speciesId];
      if (species) {
        c.tier = species.tier;
        changed = true;
      }
    }
  }

  if (changed) {
    console.log("Migrated: backfilled missing tier fields from current species tier (best-effort approximation)");
    saveState(app.getPath("userData"), state);
  }
}

/**
 * 1회성 보정: frozenProgress(보관 시점에 고정해둔 진행률) 필드 추가 전에 이미
 * 보관함에 들어가 있던 항목은 이 필드가 아예 없다. resumeStoredCompanion()은
 * 없으면 0으로 취급하는데, 그러면 실제로 쌓여있던 진행률이 통째로 날아가 보임
 * (사용자가 실제로 겪음 — 라프라스가 다시 키우니 0토큰으로 보임). storedAt
 * 시각까지의 누적 총량을 실제 로그에서 다시 계산해서(getTotalTokensAsOf) 복구한다
 * — storedAt이 없는 아주 오래된 저장분만 최후 수단으로 0 처리.
 */
function backfillMissingFrozenProgress() {
  let changed = false;
  for (const c of state.storedCompanions) {
    if (c.frozenProgress === undefined) {
      const totalAtStore = c.storedAt ? getTotalTokensAsOf(c.storedAt) : 0;
      c.frozenProgress = Math.max(0, totalAtStore - c.hatchedAtTotal);
      changed = true;
    }
  }
  if (changed) {
    console.log("Migrated: reconstructed frozenProgress for stored companions from historical log timestamps");
    saveState(app.getPath("userData"), state);
  }
}

// now 시점 기준으로 "이미 지난, 가장 최근 월요일 오전 10시" 시각을 반환(로컬 시간대 기준).
// 예: 지금이 이번 주 월요일 09시면 지난주 월요일 10시가 반환되고(이번 주 건 아직 안
// 지났으니까), 이번 주 월요일 11시면 이번 주 월요일 10시가 그대로 반환됨.
function mostRecentMondayTenAM(now) {
  const d = new Date(now);
  d.setHours(10, 0, 0, 0);
  const day = d.getDay(); // 0=일 ~ 6=토
  const diffFromMonday = (day + 6) % 7; // 월요일이면 0
  d.setDate(d.getDate() - diffFromMonday);
  if (d.getTime() > now.getTime()) {
    d.setDate(d.getDate() - 7); // 이번 주 월요일 10시가 아직 안 지났으면 지난주로
  }
  return d;
}

/**
 * 주간 무료 알 티켓 — 가장 최근 "월요일 10시" 경계를 이미 지급했는지 확인하고, 안
 * 지급했으면(마지막 지급 시각보다 새 경계가 더 나중이면) 알 보관함에 하나 적립.
 * 앱을 그 시각 전에 켜놨다가 그 시각이 지나도록 계속 켜두는 경우든, 꺼놨다가 그
 * 시각이 지난 뒤에 여는 경우든 tick()이 돌 때마다 이 함수가 체크하므로 둘 다 커버됨.
 */
function grantWeeklyTicketIfDue(now) {
  const boundary = mostRecentMondayTenAM(now);
  const lastGranted = state.lastWeeklyTicketAt ? new Date(state.lastWeeklyTicketAt) : null;
  if (lastGranted && boundary.getTime() <= lastGranted.getTime()) return;

  const grade = pickWeeklyTicketGrade();
  state.eggBox.push({
    id: `egg-weekly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    grade,
    createdAt: new Date().toISOString(),
  });
  state.lastWeeklyTicketAt = boundary.toISOString();
  console.log(`Weekly egg ticket granted: ${grade} (boundary: ${boundary.toISOString()})`);
  notify("🎁 주간 알 티켓 도착", `${grade.toUpperCase()} 등급 알이 알 보관함에 쌓였어요!`);
}

function tick() {
  const prevTotalTokens = lastTotalTokens; // 부스트 프리즈 델타 계산용(아래) — 덮어쓰기 전에 떠둠
  const totalTokens = getTotalTokens();
  lastTotalTokens = totalTokens;
  // prevTotalTokens가 0이면 이 프로세스의 첫 tick(모듈 최상단 초기값 그대로)이라 "직전
  // tick 대비 증가분"이라는 전제 자체가 성립 안 함 — 이 경우 델타를 totalTokens 전체로
  // 계산하면(부스팅 중이던 저장분을 재시작 후 불러온 경우 등) hatchedAtTotal이 통째로
  // 미래로 밀려버려 진행도가 음수로 깨지는 버그가 실제로 있었음. 첫 tick만 델타 0으로
  // 취급(다음 tick부터는 정상적으로 직전 tick 대비 증가분을 씀).
  const tokenDelta = prevTotalTokens > 0 ? totalTokens - prevTotalTokens : 0;

  // 지난 tick에서 막 졸업한 채로(state:"graduated") 남아있었다면 이번 tick에 새
  // 알로 넘긴다 — 졸업 이벤트 자체가 발생한 바로 그 tick에 곧장 새 알로 덮어써
  // 버리면, 팝업/위젯이 최종형을 볼 틈도 없이 알로 바뀌어버리는 문제가 있었음
  // (실제로 겪음: 나옹→페르시안처럼 "진화=바로 졸업"인 2단 라인에서 체감됨).
  // 한 틱 늦게 리셋해서 그 사이 최소 한 번은 최종형이 화면에 보이게 함.
  if (state.companion?.state === "graduated") {
    state.companion = newEgg(totalTokens);
  }

  if (!state.companion) {
    state.companion = newEgg(totalTokens);
  }

  // 부스트 기믹 — 부스팅 중이면 이번 tick의 토큰 증가분을 진행도 대신 게이지에
  // 쌓는다(freezeProgress로 hatchedAtTotal을 같이 밀어서 progress는 그대로 고정
  // — 그래서 아래 evaluate()가 이번 tick만큼은 진행이 안 된 것으로 봐서 부스팅
  // 중엔 자동으로 진화/졸업이 안 터짐). 게이지가 임계치를 넘으면 즉시 완료 —
  // 모은 양(×보너스)을 사탕으로 반올림 환전해서 가방에 적립하고 부스팅 해제
  // (해제 이후엔 hatchedAtTotal이 그 시점에 멈춰있던 값 그대로라 자연스럽게
  // 성장 재개 — 별도 "캐치업" 없음, BACKLOG.md 참고).
  if (state.companion.state === "growing" && state.companion.boosting) {
    state.companion = freezeProgress(state.companion, tokenDelta);
    const boostGauge = totalTokens - state.companion.boostStartTotal;
    if (boostGauge >= BOOST_GAUGE_THRESHOLD) {
      const candies = candiesFromBoost(boostGauge);
      state.rareCandyCount = (state.rareCandyCount || 0) + candies;
      delete state.companion.boosting;
      delete state.companion.boostStartTotal;
      console.log(`event: boost-complete +${candies} candy (gauge: ${boostGauge})`);
      notify("🔥 부스트 완료!", `이상한 사탕 ${candies}개를 얻었어요!`);
    }
  }

  // 진화/졸업으로 등급 알을 적립할 때 등급 기준으로 쓸, "진화하기 직전" 개체의 고정된
  // tier(부화 시점에 정해져서 진화해도 안 바뀌는 값 — gen1Data에서 현재 종의 tier를
  // 다시 찾으면 안 됨, 체인 내에서 실제로 등급이 바뀌는 경우가 있어서 그게 버그였음).
  const preTransitionTier = state.companion.state !== "egg" ? state.companion.tier : null;

  const ownedSpeciesIds = new Set(state.pokedex.map((e) => e.speciesId));
  const shinyDenominator = state.ownsShinyCharm ? SHINY_CHARM_DENOMINATOR : SHINY_DENOMINATOR;
  const result = evaluate(state.companion, gen1Data, totalTokens, ownedSpeciesIds, {
    firstHatch: !state.firstHatchDone,
    useWeighting: state.settings.hatchWeightingEnabled,
    difficulty: state.settings.difficulty,
    shinyDenominator,
  });
  state.companion = result.companion;

  if (result.event === "hatch") {
    state.firstHatchDone = true; // 딱 첫 부화만 common/uncommon 제한 — 이후론 다시 전체 랜덤
  }

  // 진화(중간 단계 포함)/졸업 할 때마다 등급 알 1개를 보관함에 적립. 등급은 그 개체의
  // 고정된 tier 그대로 씀.
  if ((result.event === "evolve" || result.event === "graduate") && preTransitionTier) {
    state.eggBox.push({
      id: `egg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      grade: preTransitionTier,
      createdAt: new Date().toISOString(),
    });
  }

  // 로그용으로 "무엇이 졸업했는지"를 companion을 새 알로 덮어쓰기 전에 미리 남겨둠 —
  // 안 그러면 아래 console.log에 졸업한 애 대신 그 자리의 새 알 정보가 찍힘.
  const graduatedCompanion = result.event === "graduate" ? state.companion : null;

  if (result.event === "graduate") {
    state.pokedex.push({
      speciesId: state.companion.speciesId, // 최종형 id(그 라인의 졸업 횟수 집계 키)
      chainOrder: reachedChainIds(state.companion.speciesId), // 기본형~최종형 전체(도감엔 라인 통째로 등록)
      tier: state.companion.tier,
      graduatedAt: new Date().toISOString(),
      isShiny: !!state.companion.isShiny,
    });
    // state.companion은 그대로 둔다 — evaluate()가 이미 state:"graduated"로
    // 갱신해둔 채라 최종형이 화면에 그대로 남고, 다음 tick 맨 위에서 새 알로 넘어감.
  }

  grantWeeklyTicketIfDue(new Date());

  saveState(app.getPath("userData"), state);
  updateTrayIcon(totalTokens);
  pushWidgetStatus();

  if (result.event !== "none") {
    console.log(`event: ${result.event}`, graduatedCompanion ?? state.companion, `(eggBox: ${state.eggBox.length})`);
    notifyForEvent(result.event, graduatedCompanion ?? state.companion);
  }
}

// 고정 setInterval 대신 자기재귀 setTimeout — 매번 state.settings.pollIntervalMinutes를
// 새로 읽어서 스케줄하니까 값이 바뀌어도 코드 재시작 없이 반영됨. 지금 대기 중인
// 타이머에도 바로 적용하려면(다음 tick까지 기다리지 않고) update-settings
// 핸들러에서 이 함수를 다시 호출해 재시작함.
let tickTimer = null;
function scheduleNextTick() {
  clearTimeout(tickTimer);
  const minutes = state.settings.pollIntervalMinutes || 2;
  tickTimer = setTimeout(() => {
    tick();
    scheduleNextTick();
  }, minutes * 60 * 1000);
}

// get-status IPC 응답 페이로드: 렌더러가 바로 그릴 수 있게 평이한 값으로 가공
function buildStatusPayload(totalTokens) {
  const companion = state.companion;

  if (!companion || companion.state === "egg") {
    const progress = totalTokens - (companion?.eggStartTotal ?? 0);
    const grade = companion?.guaranteedGrade ?? null;
    return {
      state: "egg",
      label: "🥚 알",
      tier: grade, // 등급 알이면 이미 있는 등급 뱃지 UI로 표시됨, 일반 알이면 등급 없음(null)
      sprite: EGG_SPRITE_URL,
      isShiny: false,
      progress,
      needed: HATCH_THRESHOLD,
      hasNextEvolution: false, // 알 자체가 이미 미스터리라 "다음 포켓몬???" 힌트는 안 보여줌
      pokedexCount: buildDexAggregate().size,
      pokedexTotal: totalSpeciesCount(),
      eggBoxCount: state.eggBox.length,
      storedCount: state.storedCompanions.length,
    };
  }

  const species = gen1Data[companion.speciesId];
  const thresholds = stageThresholds(companion.tier, species.maxStage, state.settings.difficulty);
  const needed = thresholds[companion.stage - 1] ?? null; // null이면 최종 진화(다음 tick에 졸업 처리)
  const progress = totalTokens - companion.hatchedAtTotal;
  const isShiny = !!companion.isShiny;

  return {
    state: companion.state,
    speciesId: companion.speciesId,
    label: species.nameKo,
    tier: companion.tier, // 고정된 등급(부화 시 정해짐) — 진화해도 안 바뀜
    sprite: isShiny ? species.spriteShiny : species.sprite,
    isShiny,
    progress,
    needed,
    // "다음 포켓몬: ???" 힌트는 이 종이 실제로 다음에 진화할 데가 있을 때만(evolvesTo
    // 비어있지 않을 때만) 보여야 함 — needed != null만 보면 안 됨. stageThresholds()가
    // 단일형 종(maxStage=1, 진화 자체가 없는 라프라스 같은 경우)도 졸업 판정용으로
    // 임계치를 최소 1개는 반환하게 돼있어서(그래야 졸업 자체가 되니까), needed가 항상
    // null이 아니게 나와 진화가 없는 종한테도 힌트가 잘못 뜨는 버그가 있었음(실제 확인됨).
    hasNextEvolution: needed != null && species.evolvesTo.length > 0,
    pokedexCount: buildDexAggregate().size,
    pokedexTotal: totalSpeciesCount(),
    eggBoxCount: state.eggBox.length,
    storedCount: state.storedCompanions.length,
    boosting: !!companion.boosting,
    boostProgress: companion.boosting ? totalTokens - companion.boostStartTotal : null,
    boostNeeded: companion.boosting ? BOOST_GAUGE_THRESHOLD : null,
  };
}

// speciesId의 기본형부터 시작해서 그 speciesId에 도달하면 멈추는 체인 id 목록.
// 졸업 시점엔 speciesId가 이미 그 라인의 1세대 기준 최종형이라(gen1Data 빌드 시점에
// 후속 세대 진화형은 이미 걸러져 있음 — build-gen1-data.js의 flattenChain), 이 함수
// 하나로 "졸업 시 라인 전체 기록"과 "지금 성장 중인 개체가 도달한 단계까지"를 둘 다
// 커버한다(레퍼런스 PokeTokenBar가 pathIDs 전체/prefix(stageIndex+1)로 나눠 쓰는 것을
// 우리는 stage가 항상 기본형부터 순차 진행이라 하나로 합친 것).
function reachedChainIds(speciesId) {
  const ids = [];
  const baseId = gen1Data[speciesId]?.baseFormId ?? speciesId;
  let current = gen1Data[baseId];
  while (current) {
    ids.push(current.id);
    if (current.id === speciesId) break;
    current = current.evolvesTo[0] != null ? gen1Data[current.evolvesTo[0]] : null;
  }
  return ids;
}

// speciesId(도감 행의 최종형 또는 발견된 중간형)의 기본형부터 진짜 끝까지 전체 진화
// 라인을 순서대로 나열 — reachedChainIds와 달리 speciesId에서 멈추지 않고 끝까지 감.
// discoveredIds에 없는 단계(아직 발견 못 한 다음 진화형)는 이름/스프라이트 없이
// discovered:false만 반환해서 팝업에서 ??로 가리게 한다(코일만 발견하고 레어코일은
// 아직인데 펼쳐보기 하면 레어코일 정보가 그대로 스포일러로 새는 걸 막기 위함).
function buildEvolutionChain(speciesId, discoveredIds, lineTier) {
  const chain = [];
  const baseId = gen1Data[speciesId]?.baseFormId ?? speciesId;
  let current = gen1Data[baseId];
  while (current) {
    chain.push(
      discoveredIds.has(current.id)
        ? { speciesId: current.id, nameKo: current.nameKo, sprite: current.sprite, tier: lineTier, discovered: true }
        : { speciesId: current.id, discovered: false }
    );
    current = current.evolvesTo[0] != null ? gen1Data[current.evolvesTo[0]] : null;
  }
  return chain;
}

/**
 * 발견한 종 전체(졸업한 라인들의 chainOrder ∪ 지금 성장 중인 개체의 도달분 ∪ 보관함
 * 개체들의 도달분) + 종별 졸업 통계를 한 번에 계산. 레퍼런스(PokeTokenBar)의
 * `dexSpecies`(state.dex의 chainOrder ∪ active.pathIDs.prefix(stageIndex+1))와
 * 동일한 방식 — 우리는 "놓아주기"가 없는 대신 storedCompanions가 그 역할(진행 상황을
 * 잃지 않고 보존)을 하므로 그것도 합친다.
 *
 * tier는 반드시 그 라인의 고정값을 체인 전체에 전파한다 — 종 개별 gen1Data.tier를
 * 쓰면 "미진화체는 common인데 최종형만 legendary로 보임" 버그가 도감 표시에서
 * 재발한다(예전에 growth.js에서 고쳤던 것과 같은 이유 — tier는 항상 부화 시점에
 * 라인 단위로 고정된 값).
 */
function buildDexAggregate() {
  const bySpecies = new Map(); // speciesId -> { tier, count, shinyCount, latestGraduatedAt, liveShiny, isLive }
  const ensure = (id) => {
    let e = bySpecies.get(id);
    if (!e) {
      e = { tier: null, count: 0, shinyCount: 0, latestGraduatedAt: null, liveShiny: false, isLive: false };
      bySpecies.set(id, e);
    }
    return e;
  };

  for (const entry of state.pokedex) {
    const chain = entry.chainOrder ?? reachedChainIds(entry.speciesId); // 옛 저장분(chainOrder 없음) 폴백
    for (const id of chain) {
      const e = ensure(id);
      e.tier = entry.tier;
      if (id === entry.speciesId) {
        // 그 라인의 최종형 자신에 대해서만 "졸업 횟수"로 집계(중간형은 항상 count: 0)
        e.count += 1;
        if (entry.isShiny) e.shinyCount += 1;
        if (!e.latestGraduatedAt || entry.graduatedAt > e.latestGraduatedAt) e.latestGraduatedAt = entry.graduatedAt;
      }
      // 주의: 여기서 isLive는 안 건드림 — 졸업 기록만으로 들어온 중간형(예: 나옹→
      // 페르시온 졸업 시 같이 딸려 들어오는 나옹)은 실제로 지금 키우는 개체가
      // 없는데도 "육성 중"으로 잘못 표시되던 버그가 있었음(사용자가 실제로 확인함:
      // 컴패니언도 보관함도 아닌데 도감엔 "나옹 육성 중"이라고 나옴). isLive는
      // 아래 applyLive(지금 살아있는 개체)에서만 true가 되게 분리함.
    }
  }

  const applyLive = (speciesId, tier, isShiny) => {
    for (const id of reachedChainIds(speciesId)) {
      const e = ensure(id);
      e.tier = tier;
      e.isLive = true; // 지금 실제로 키우는 중이거나 보관함에 있는 개체가 도달한 단계
      if (isShiny) e.liveShiny = true;
    }
  };
  if (state.companion && state.companion.state === "growing") {
    applyLive(state.companion.speciesId, state.companion.tier, !!state.companion.isShiny);
  }
  for (const c of state.storedCompanions) {
    applyLive(c.speciesId, c.tier ?? gen1Data[c.speciesId]?.tier, !!c.isShiny);
  }

  return bySpecies;
}

// 알려진 종 총 개수(1~9세대 전 세대) — 도감 "N/전체" 표시의 분모로 씀(gen1Data 크기를
// 그대로 쓰니 세대가 더 늘어도 이 함수는 안 건드려도 됨). 레퍼런스
// (PokeTokenBar) 확인 결과 세대별 단계적 잠금 없이 전체 범위를 처음부터 하나의
// 풀로 쓰는 방식이라, 우리도 "1세대 다 모아야 2세대" 잠금을 걷어내고 맞춤(사용자
// 확정) — 그래서 이 값은 항상 고정(세대별로 다시 안 나눔).
function totalSpeciesCount() {
  return Object.keys(gen1Data).length;
}

// 도감 목록 — 전체 종을 도감번호 오름차순으로 반환("전체 다 보여주고 안 잡은
// 건 실루엣" 요청으로 확장). 발견 못 한 종은 스포일러 없이 discovered:false만 반환
// (evo-chain의 ?? 처리와 같은 방식). gen1Data에 없는 speciesId(원인 불명의 손상
// 데이터)가 섞여 있어도 전체가 죽지 않게 그 항목만 건너뛴다.
function buildPokedexPayload() {
  const bySpecies = buildDexAggregate();
  const discoveredIds = new Set(bySpecies.keys());

  const allIds = Object.keys(gen1Data)
    .map(Number)
    .sort((a, b) => a - b);

  const rows = [];
  for (const id of allIds) {
    const species = gen1Data[id];
    if (!species) {
      console.error(`Pokedex entry has unknown speciesId: ${id}`);
      continue;
    }
    const agg = bySpecies.get(id);
    if (!agg) {
      rows.push({ speciesId: id, discovered: false });
      continue;
    }
    const isShiny = agg.shinyCount > 0 || agg.liveShiny;
    rows.push({
      speciesId: id,
      discovered: true,
      nameKo: species.nameKo,
      sprite: isShiny ? species.spriteShiny : species.sprite,
      isShiny,
      tier: agg.tier ?? species.tier,
      count: agg.count,
      isLive: agg.isLive, // 지금 실제로 키우는 중/보관 중인 개체가 있어야만 true("육성 중" 표시용)
      shinyCount: agg.shinyCount,
      graduatedAt: agg.latestGraduatedAt, // null이면 발견은 했지만 아직 졸업 전
      types: species.types,
      description: species.description,
      evolutionChain: buildEvolutionChain(id, discoveredIds, agg.tier ?? species.tier),
    });
  }

  return rows; // 이미 도감번호 오름차순
}

// 지금 알을 품고 있는 중이면(부화 전) 잃어버리지 않게 알 보관함으로 돌려보낸다 —
// eggStartTotal을 그대로 들고 가서 나중에 다시 "품기 시작"하면 지금까지 모은
// 부화 진행률이 이어진다. 버그로 실제로 확인됨: resumeStoredCompanion()이 이 처리
// 없이 알 상태에서도 그냥 state.companion을 덮어써서, 알을 품던 중 보관함에서 다른
// 애를 꺼내면 그 알(과 진행률)이 통째로 증발했었음. startIncubatingEgg()가 알끼리
// 바꿔치기할 때 진행률을 새 알로 "병합"하는 것과 원칙은 같은데, 여긴 병합할 대상
// (새 알)이 없으니 "보관함으로 복귀"시키는 방식으로 처리.
function boxCurrentEggIfIncubating() {
  if (state.companion && state.companion.state === "egg") {
    state.eggBox.push({
      id: `egg-resumed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      grade: state.companion.guaranteedGrade ?? "common", // 보장 없는 알은 "전체 랜덤"인 common과 동치
      createdAt: new Date().toISOString(),
      eggStartTotal: state.companion.eggStartTotal,
    });
  }
}

// 지금 키우던 애가 "성장 중"이면 잃어버리지 않게 보관함에 저장. 알 상태면 아직
// 특정 개체가 안 정해진 상태라 보관 없이 그냥 교체됨(부화 진행률은 호출부에서 별도 처리).
function boxCurrentCompanionIfGrowing() {
  // "graduated"(막 졸업해서 다음 tick에 새 알로 넘어가길 기다리는 중)는 제외 —
  // 이미 도감에 영구 등록됐으니 보관함에 또 넣을 필요가 없고, 넣어봤자 더 이상
  // 진행이 안 되는 죽은 개체만 하나 생김.
  if (state.companion && state.companion.state === "growing") {
    state.storedCompanions.push({
      speciesId: state.companion.speciesId,
      stage: state.companion.stage,
      tier: state.companion.tier,
      // hatchedAtTotal을 그대로 들고 있으면 안 됨 — 보관 중에도 totalTokens는
      // 전역으로 계속 늘어나서(다른 애 키우는 동안 벌어들인 토큰까지 포함),
      // 나중에 꺼낼 때 progress = totalTokens - hatchedAtTotal 계산이 보관
      // 기간 동안 쌓인 토큰까지 한꺼번에 반영해버리는 버그가 있었음(실제 확인함).
      // 그래서 "보관 시점까지의 진행률"을 고정값으로 따로 저장해두고, 꺼낼 때
      // 그 시점 기준으로 hatchedAtTotal을 다시 계산한다.
      frozenProgress: lastTotalTokens - state.companion.hatchedAtTotal,
      isShiny: !!state.companion.isShiny,
      storedAt: new Date().toISOString(),
    });
  }
}

// 알 보관함 목록 반환(등급/생성순).
function buildEggBoxPayload() {
  return state.eggBox.map((egg) => ({ id: egg.id, grade: egg.grade, createdAt: egg.createdAt }));
}

/**
 * 알 보관함에서 알 하나를 골라 "품기 시작"한다 — 즉시 포켓몬이 나오는 게 아니라,
 * 일반 알과 똑같이 HATCH_THRESHOLD만큼 토큰을 다시 모아야 부화하고, 그 등급 이상
 * 범위에서 capture_rate 가중치로 랜덤 종이 나온다(원본(PokeTokenBar)의 "등급 보증
 * 알"과 동일 — 등급 알도 재인큐베이션이 필요함, 즉시 안 나옴). 지금 뭔가 성장
 * 중이어도 가능 — 그 컴패니언은 버려지지 않고 보관함(storedCompanions)으로 들어가서
 * 나중에 다시 꺼내 키울 수 있다. 지금 알 상태였다면 그 알이 모아둔 부화 진행률은
 * 버리지 않고 새 등급 알의 진행률로 이어받는다. 고르는 알 자체가 예전에
 * boxCurrentEggIfIncubating()으로 보관함에 돌아갔던 알(자기 진행률을 들고 있음)이면
 * 그 진행률에서 이어서 시작(단, 지금 활성 알의 진행률이 있으면 그게 우선 — 여러
 * 알의 진행률을 동시에 따로 안 따라가는 기존 원칙 그대로).
 * 반환: { ok: boolean, reason?: string, status: buildStatusPayload() }
 */
function startIncubatingEgg(eggId) {
  const eggIndex = state.eggBox.findIndex((e) => e.id === eggId);
  if (eggIndex === -1) {
    return { ok: false, reason: "egg-not-found", status: buildStatusPayload(lastTotalTokens) };
  }

  const egg = state.eggBox[eggIndex];
  const wasEgg = state.companion?.state === "egg";
  const eggStartTotal = wasEgg
    ? state.companion.eggStartTotal
    : (egg.eggStartTotal ?? lastTotalTokens);

  boxCurrentCompanionIfGrowing();
  // 지금 품고 있던 알(부화 전)을 버리지 않고 보관함으로 되돌린다 — resumeStoredCompanion()과
  // 같은 처리. 이게 없으면 알 보관함에서 다른 알을 연달아 "품기 시작"할 때마다 그 전에
  // 품고 있던 알이 그냥 사라지는 버그가 있었음(실제 확인됨: 등급 알 4개를 사서 하나씩
  // 골라 품기 시작할 때마다 이전 알이 없어지고 마지막 알만 남음). eggIndex는 이 push보다
  // 앞서 이미 구했고 push는 배열 끝에 추가되니 인덱스가 안 밀려서 splice는 그대로 안전.
  boxCurrentEggIfIncubating();

  state.eggBox.splice(eggIndex, 1);
  state.companion = newEgg(eggStartTotal, egg.grade);
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);
  pushWidgetStatus();

  return { ok: true, status: buildStatusPayload(lastTotalTokens) };
}

// 보관함 목록을 종 정보와 합쳐서 반환. 도감과 동일하게 손상 데이터는 건너뜀.
function buildStoragePayload() {
  const result = [];
  state.storedCompanions.forEach((c, index) => {
    const species = gen1Data[c.speciesId];
    if (!species) {
      console.error(`Storage entry has unknown speciesId: ${c.speciesId}`, c);
      return;
    }
    const isShiny = !!c.isShiny;
    result.push({
      index,
      speciesId: c.speciesId,
      nameKo: species.nameKo,
      sprite: isShiny ? species.spriteShiny : species.sprite,
      isShiny,
      tier: c.tier ?? species.tier, // 고정 등급 우선, 예전 저장분(없음)은 현재 종 tier로 폴백
      stage: c.stage,
      storedAt: c.storedAt,
    });
  });
  return result;
}

/**
 * 보관함에서 꺼내서 다시 키우기 시작(티켓 소모 없음 — 이미 갖고 있던 애를 꺼내는 거라).
 * 지금 성장 중인 애가 있으면 그 애가 대신 보관함으로 들어가고(자리 교환), 지금 알을
 * 품고 있던 중이면 그 알은 진행률을 들고 알 보관함으로 돌아간다(boxCurrentEggIfIncubating()
 * 참고 — 예전엔 이 처리가 없어서 알이 통째로 사라지는 버그가 있었음).
 */
function resumeStoredCompanion(index) {
  if (index < 0 || index >= state.storedCompanions.length) {
    return { ok: false, reason: "invalid-index", status: buildStatusPayload(lastTotalTokens) };
  }

  boxCurrentCompanionIfGrowing();
  boxCurrentEggIfIncubating();

  const [resumed] = state.storedCompanions.splice(index, 1);
  // 보관 시점에 고정해둔 진행률(frozenProgress)을 지금 시점 기준으로 되살림 —
  // 옛 저장분(frozenProgress 없음)은 0으로 취급(보관 중 쌓인 걸 공짜로 얹어주면
  // 안 되니, 모르면 0부터).
  const frozenProgress = resumed.frozenProgress ?? 0;
  state.companion = {
    state: "growing",
    speciesId: resumed.speciesId,
    stage: resumed.stage,
    tier: resumed.tier ?? gen1Data[resumed.speciesId]?.tier, // 예전 저장분 호환 폴백
    hatchedAtTotal: lastTotalTokens - frozenProgress,
    isShiny: resumed.isShiny,
  };
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);
  pushWidgetStatus();

  return { ok: true, status: buildStatusPayload(lastTotalTokens) };
}

/**
 * 지금 성장 중인 애를 보관함으로 옮기고 그 자리에 새 알을 시작한다(진화 없는
 * 단일형 종을 뽑으면 졸업할 때까지 알 보관함에 알이 하나도 안 쌓여서 다른 애를
 * 시작할 방법이 아예 없었던 문제 — 사용자 요청으로 추가). 알 상태일 땐 보관할
 * 대상이 없으니 아무 일도 안 함.
 */
function boxAndStartNewEgg() {
  if (!state.companion || state.companion.state !== "growing") {
    return { ok: false, reason: "not-growing", status: buildStatusPayload(lastTotalTokens) };
  }

  boxCurrentCompanionIfGrowing();
  state.companion = newEgg(lastTotalTokens);
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);
  pushWidgetStatus();

  return { ok: true, status: buildStatusPayload(lastTotalTokens) };
}

function updateTrayIcon(totalTokens) {
  const label =
    state.companion?.state === "egg"
      ? "🥚 알"
      : gen1Data[state.companion.speciesId]?.nameKo ?? "?";
  tray.setToolTip(`${label} — 누적 ${totalTokens.toLocaleString()} 토큰`);
  // TODO: 실제 스프라이트로 트레이 아이콘 이미지 교체
}

const WIDGET_SIZE = { width: 108, height: 134 }; // 스프라이트 원을 키워달라는 요청으로 확대

/**
 * 항상 떠있는(always-on-top) 작은 위젯 창 — 지금 키우는 애를 팝업 안 열어도 한눈에
 * 보이게. 투명 배경 + 테두리 없음(frame:false, transparent:true)이라 사각형 창처럼
 * 안 보이고 스프라이트만 둥둥 떠있는 것처럼 보임. 위치/투명도는 state.widget에
 * 저장해서 껐다 켜도 유지됨.
 */
function createOrShowWidget() {
  if (widgetWindow) {
    widgetWindow.show();
    return;
  }

  const workArea = screen.getPrimaryDisplay().workArea;
  const posX = state.widget.x ?? workArea.x + workArea.width - WIDGET_SIZE.width - 24;
  const posY = state.widget.y ?? workArea.y + workArea.height - WIDGET_SIZE.height - 24;

  widgetWindow = new BrowserWindow({
    width: WIDGET_SIZE.width,
    height: WIDGET_SIZE.height,
    x: posX,
    y: posY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    opacity: state.widget.opacity,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
    },
  });
  widgetWindow.setAlwaysOnTop(true, "floating");

  widgetWindow.loadFile(path.join(__dirname, "..", "renderer", "widget.html"));

  // 드래그로 옮긴 위치를 저장 — 다음에 켤 때 같은 자리에 뜨게. "moved"는 macOS 전용
  // 이벤트라 Windows/Linux에선 안 터짐 — 크로스플랫폼인 "move"를 쓰고, 드래그 중
  // 연속으로 발생하니 디바운스해서 저장 빈도를 줄임.
  let moveSaveTimer = null;
  widgetWindow.on("move", () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (!widgetWindow) return;
      const [x, y] = widgetWindow.getPosition();
      state.widget.x = x;
      state.widget.y = y;
      saveState(app.getPath("userData"), state);
    }, 300);
  });
  widgetWindow.on("closed", () => {
    widgetWindow = null;
  });
}

function hideWidget() {
  if (widgetWindow) {
    widgetWindow.close(); // closed 핸들러가 widgetWindow = null 처리
  }
}

// 팝업과 위젯은 항상 둘 중 하나만 떠있게(동시에 안 뜨게) — 위젯 켤 땐 팝업을 닫는다.
function setWidgetEnabled(enabled) {
  state.widget.enabled = enabled;
  if (widgetMenuItem) widgetMenuItem.checked = enabled; // 코드로 껐을 때도 트레이 체크박스가 맞게 보이게
  saveState(app.getPath("userData"), state);
  if (enabled) {
    if (popup) {
      popup.close();
      popup = null;
    }
    createOrShowWidget();
  } else {
    hideWidget();
  }
}

function setWidgetOpacity(value) {
  state.widget.opacity = value;
  if (widgetWindow) widgetWindow.setOpacity(value);
  saveState(app.getPath("userData"), state);
}

// 팝업이 이미 떠있으면 그대로 두고, 없으면 새로 연다(토글이 아니라 "확실히 열기").
// 위젯에서 전체 창을 여는 유일한 경로 — 더블클릭은 Windows에서 이 작은 창
// 위에서 잘 안 먹는 경우가 있어(실제로 겪음) 아예 안 쓰고 우클릭 메뉴로만 제공.
// view를 넘기면("settings") 팝업이 열린 뒤(이미 열려 있었으면 바로) 렌더러에
// show-view IPC를 보내 해당 서브뷰로 전환시킨다 — 위젯 우클릭 메뉴에서 설정을
// 바로 열 때 씀. 새로 만든 창은 아직 로드 전이라 did-finish-load를 기다렸다 보냄.
function ensurePopupOpen(view) {
  if (!popup) {
    togglePopup(); // togglePopup 내부에서 위젯도 알아서 꺼짐
    if (view) popup.webContents.once("did-finish-load", () => popup.webContents.send("show-view", view));
  } else if (view) {
    popup.webContents.send("show-view", view);
  }
}

// 위젯 우클릭 시 뜨는 메뉴 — 전체 창 전환 + 설정 + 투명도 조절 + 숨기기.
function showWidgetContextMenu() {
  if (!widgetWindow) return;
  const menu = Menu.buildFromTemplate([
    { label: "전체 창 보기", click: () => ensurePopupOpen() },
    { label: "⚙️ 설정", click: () => ensurePopupOpen("settings") },
    { type: "separator" },
    { label: "투명도 25%", click: () => setWidgetOpacity(0.25) },
    { label: "투명도 50%", click: () => setWidgetOpacity(0.5) },
    { label: "투명도 75%", click: () => setWidgetOpacity(0.75) },
    { label: "투명도 100%", click: () => setWidgetOpacity(1.0) },
    { type: "separator" },
    { label: "위젯 숨기기", click: () => setWidgetEnabled(false) },
  ]);
  menu.popup({ window: widgetWindow });
}

// 위젯이 떠있으면 지금 상태를 즉시 밀어넣는다(포켓몬이 바뀌었는데 위젯은 다음
// 폴링 때까지 안 바뀌는 것처럼 보이는 문제 — 부화/진화/졸업/다시 키우기/보관 등
// companion이 바뀌는 지점마다 호출). 위젯이 안 떠있으면 그냥 아무 일도 안 함.
function pushWidgetStatus() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send("status-update", buildStatusPayload(lastTotalTokens));
  }
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "assets", "tray-icon.png");
  const image = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(image);
  const menu = Menu.buildFromTemplate([
    { label: "지금 새로고침", click: tick },
    {
      label: "항상 떠있는 위젯",
      type: "checkbox",
      checked: state.widget.enabled,
      click: (menuItem) => setWidgetEnabled(menuItem.checked),
    },
    { label: "종료", click: () => app.quit() },
  ]);
  widgetMenuItem = menu.items[1];
  tray.setContextMenu(menu);
  tray.on("click", togglePopup);
}

function togglePopup() {
  if (popup) {
    popup.close();
    popup = null;
    return;
  }
  // 팝업과 위젯은 항상 둘 중 하나만 떠있게 — 팝업 열 때 위젯은 닫음.
  if (state.widget.enabled) setWidgetEnabled(false);
  popup = new BrowserWindow({
    width: 380,
    height: 660,
    show: true,
    frame: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
    },
  });
  popup.loadFile(path.join(__dirname, "..", "renderer", "popup.html"));
  popup.on("closed", () => (popup = null));
}

// 설정 화면 응답 — openAtLogin은 state에 안 두고 OS/Electron이 들고 있는 값을
// 그대로 읽음(진실의 원천 하나로 유지).
function getSettingsPayload() {
  return { ...state.settings, openAtLogin: app.getLoginItemSettings().openAtLogin };
}

// 설정 변경. openAtLogin은 별도 처리(Electron API 호출), 나머지는 state.settings에
// 병합 후 저장. 새로고침 주기가 바뀌면 지금 대기 중인 타이머도 바로 재시작해서
// 다음 tick까지 기다리지 않고 반영되게 함.
function updateSettings(partial) {
  if ("openAtLogin" in partial) {
    app.setLoginItemSettings({ openAtLogin: !!partial.openAtLogin });
  }
  const { openAtLogin, ...rest } = partial;
  Object.assign(state.settings, rest);
  saveState(app.getPath("userData"), state);
  if ("pollIntervalMinutes" in rest) scheduleNextTick();
  return getSettingsPayload();
}

// 상점 — 재화(spendableTokens) = 누적 토큰 − 상점에서 이미 쓴 토큰. 이 값은 성장
// 진행도(hatchedAtTotal 기준 실시간 파생값)와 완전히 독립이라, 상점에서 아무리
// 사도 지금 키우는 개체의 진화 속도엔 영향이 없다.
function buildShopPayload() {
  const spendableTokens = Math.max(0, lastTotalTokens - (state.tokensSpent || 0));
  return {
    spendableTokens,
    rareCandy: { price: RARE_CANDY_PRICE, canBuy: spendableTokens >= RARE_CANDY_PRICE },
    shinyCharm: {
      price: SHINY_CHARM_PRICE,
      owned: !!state.ownsShinyCharm,
      canBuy: !state.ownsShinyCharm && spendableTokens >= SHINY_CHARM_PRICE,
    },
    eggs: Object.keys(GRADUATION_TOTAL).map((tier) => {
      const price = eggPrice(tier);
      return { tier, price, canBuy: spendableTokens >= price };
    }),
  };
}

function buildBagPayload() {
  const rareCandyCount = state.rareCandyCount || 0;
  return { rareCandyCount, canUseRareCandy: !!state.companion && rareCandyCount > 0 };
}

function buyRareCandy() {
  const spendableTokens = Math.max(0, lastTotalTokens - (state.tokensSpent || 0));
  if (spendableTokens < RARE_CANDY_PRICE) {
    return { ok: false, reason: "not-enough-tokens", shop: buildShopPayload() };
  }
  state.tokensSpent = (state.tokensSpent || 0) + RARE_CANDY_PRICE;
  state.rareCandyCount = (state.rareCandyCount || 0) + 1;
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);
  pushWidgetStatus();
  return { ok: true, status: buildStatusPayload(lastTotalTokens), shop: buildShopPayload(), bag: buildBagPayload() };
}

function buyShinyCharm() {
  const spendableTokens = Math.max(0, lastTotalTokens - (state.tokensSpent || 0));
  if (state.ownsShinyCharm) {
    return { ok: false, reason: "already-owned", shop: buildShopPayload() };
  }
  if (spendableTokens < SHINY_CHARM_PRICE) {
    return { ok: false, reason: "not-enough-tokens", shop: buildShopPayload() };
  }
  state.tokensSpent = (state.tokensSpent || 0) + SHINY_CHARM_PRICE;
  state.ownsShinyCharm = true;
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);
  pushWidgetStatus();
  return { ok: true, status: buildStatusPayload(lastTotalTokens), shop: buildShopPayload() };
}

// 등급 보장 알 구매 — 즉시 폐기+교체(레퍼런스 방식)가 아니라, 기존 "알 보관함 →
// 품기 시작" 플로우에 그대로 얹는다(진화/졸업 드롭·주간 무료 티켓과 완전히 같은
// eggBox 엔트리 모양).
function buyGuaranteedEgg(tier) {
  const price = GRADUATION_TOTAL[tier] ? eggPrice(tier) : null;
  if (price === null) {
    return { ok: false, reason: "invalid-tier", shop: buildShopPayload() };
  }
  const spendableTokens = Math.max(0, lastTotalTokens - (state.tokensSpent || 0));
  if (spendableTokens < price) {
    return { ok: false, reason: "not-enough-tokens", shop: buildShopPayload() };
  }
  state.tokensSpent = (state.tokensSpent || 0) + price;
  state.eggBox.push({
    id: `egg-shop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    grade: tier,
    createdAt: new Date().toISOString(),
  });
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);
  pushWidgetStatus();
  return { ok: true, status: buildStatusPayload(lastTotalTokens), shop: buildShopPayload() };
}

// 이상한 사탕 사용 — 진행도를 즉시 앞당긴 뒤 그 자리에서 tick()을 한 번 더 돌려서
// (refresh IPC 핸들러와 동일한 패턴) 부화/진화/졸업이 다음 폴링까지 안 기다리고
// 바로 반영되게 한다. eggBox 적립·알림 등 tick()의 부수효과도 자동으로 따라온다.
function useRareCandy() {
  if (!state.companion || (state.rareCandyCount || 0) <= 0) {
    return { ok: false, reason: "no-candy", bag: buildBagPayload() };
  }
  state.rareCandyCount -= 1;
  state.companion = applyRareCandy(state.companion, RARE_CANDY_XP);
  saveState(app.getPath("userData"), state);
  tick();
  return { ok: true, status: buildStatusPayload(lastTotalTokens), bag: buildBagPayload() };
}

// 부스트 토글 — 켜면 그 순간부터 진행도가 멈추고 게이지가 쌓이기 시작(tick() 참고),
// 다시 누르면(게이지 다 차기 전) 보상 없이 취소. 종 제한 없음 — 지금 성장 중인
// 컴패니언이면 누구나 가능(메가진화/기가맥스/테라스탈 종 목록은 코스메틱 전용,
// 이 토글 자체엔 안 씀 — BACKLOG.md 참고).
function toggleBoost() {
  if (!state.companion || state.companion.state !== "growing") {
    return { ok: false, reason: "not-growing", status: buildStatusPayload(lastTotalTokens) };
  }
  if (state.companion.boosting) {
    delete state.companion.boosting;
    delete state.companion.boostStartTotal;
  } else {
    state.companion.boosting = true;
    state.companion.boostStartTotal = lastTotalTokens;
  }
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);
  pushWidgetStatus();
  return { ok: true, status: buildStatusPayload(lastTotalTokens) };
}

app.whenReady().then(() => {
  loadGen1Data();
  state = loadState(app.getPath("userData"));
  fixCorruptedPokedexEntries();
  fixCorruptedCompanion();
  migrateMissingTier();
  backfillMissingFrozenProgress();
  createTray();
  ipcMain.handle("get-status", () => buildStatusPayload(lastTotalTokens));
  ipcMain.handle("get-pokedex", () => ({
    discovered: buildDexAggregate().size,
    total: totalSpeciesCount(),
    rows: buildPokedexPayload(),
  }));
  ipcMain.handle("get-egg-box", () => buildEggBoxPayload());
  ipcMain.handle("hatch-egg", (event, eggId) => startIncubatingEgg(eggId));
  ipcMain.handle("get-storage", () => buildStoragePayload());
  ipcMain.handle("resume-stored", (event, index) => resumeStoredCompanion(index));
  ipcMain.handle("box-and-new-egg", () => boxAndStartNewEgg());
  ipcMain.handle("widget-context-menu", () => showWidgetContextMenu());
  ipcMain.handle("enable-widget", () => setWidgetEnabled(true));
  ipcMain.handle("get-settings", () => getSettingsPayload());
  ipcMain.handle("update-settings", (event, partial) => updateSettings(partial || {}));
  ipcMain.handle("get-shop", () => buildShopPayload());
  ipcMain.handle("get-bag", () => buildBagPayload());
  ipcMain.handle("buy-rare-candy", () => buyRareCandy());
  ipcMain.handle("buy-shiny-charm", () => buyShinyCharm());
  ipcMain.handle("buy-egg", (event, tier) => buyGuaranteedEgg(tier));
  ipcMain.handle("use-rare-candy", () => useRareCandy());
  ipcMain.handle("toggle-boost", () => toggleBoost());
  ipcMain.handle("get-widget-position", () => (widgetWindow ? widgetWindow.getPosition() : [0, 0]));
  ipcMain.handle("move-widget-to", (event, x, y) => {
    if (widgetWindow) widgetWindow.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.handle("refresh", () => {
    tick(); // 로그 재스캔 + 상태 저장까지 즉시 수행
    return buildStatusPayload(lastTotalTokens);
  });
  tick();
  // 지난 세션에 위젯을 켜놨었으면 그대로 위젯으로 복원(팝업은 안 띄움 — 둘 다 뜨면
  // 위젯을 쓰는 의미가 없음), 아니었으면 기존처럼 exe 실행 직후 팝업이 바로 뜨게.
  if (state.widget.enabled) createOrShowWidget();
  else togglePopup();
  scheduleNextTick();
});

app.on("window-all-closed", (e) => e.preventDefault()); // 트레이 상주, 창 닫아도 종료 안 함
