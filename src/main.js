const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const { getTotalTokens } = require("./logParser");
const { evaluate, newEgg, HATCH_THRESHOLD, stageThresholds, pickWeeklyTicketGrade } = require("./growth");
const { loadState, saveState } = require("./state");

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2분 (원본 PokeTokenBar 기본값과 동일)

// 알 상태일 때 보여줄 정적 스프라이트. PokéAPI엔 종별 데이터만 있어서 gen1.json엔
// 없고, PokeAPI/sprites 저장소에 있는 공용 알 이미지를 그대로 씀(움직이는 GIF는
// 없음 — 실제 게임도 알 자체는 프레임 애니메이션이 아니라 "흔들림" 연출이라, 흔들리는
// 정도는 popup.html에서 진행률(%) 기준으로 CSS 애니메이션으로 직접 구현함).
const EGG_SPRITE_URL = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/egg.png";

let tray = null;
let popup = null;
let widgetWindow = null;
let gen1Data = null;
let state = null;
let lastTotalTokens = 0; // tick()에서 갱신, 팝업이 열릴 때마다 로그 전체를 재파싱하지 않기 위한 캐시

function loadGen1Data() {
  const p = path.join(__dirname, "..", "data", "gen1.json");
  if (!fs.existsSync(p)) {
    console.error(
      "data/gen1.json not found. Run `npm run build-data` first to fetch PokeAPI data."
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
  // TODO: 알림(Notification) 붙이기 — 부화/진화/졸업이랑 같이 처리 (README 백로그 참고)
}

function tick() {
  const totalTokens = getTotalTokens();
  lastTotalTokens = totalTokens;

  if (!state.companion) {
    state.companion = newEgg(totalTokens);
  }

  // 진화/졸업으로 등급 알을 적립할 때 등급 기준으로 쓸, "진화하기 직전" 개체의 고정된
  // tier(부화 시점에 정해져서 진화해도 안 바뀌는 값 — gen1Data에서 현재 종의 tier를
  // 다시 찾으면 안 됨, 체인 내에서 실제로 등급이 바뀌는 경우가 있어서 그게 버그였음).
  const preTransitionTier = state.companion.state !== "egg" ? state.companion.tier : null;

  const ownedSpeciesIds = new Set(state.pokedex.map((e) => e.speciesId));
  const result = evaluate(state.companion, gen1Data, totalTokens, ownedSpeciesIds, !state.firstHatchDone);
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
    state.companion = newEgg(totalTokens); // 새 알 시작
  }

  grantWeeklyTicketIfDue(new Date());

  saveState(app.getPath("userData"), state);
  updateTrayIcon(totalTokens);

  if (result.event !== "none") {
    console.log(`event: ${result.event}`, graduatedCompanion ?? state.companion, `(eggBox: ${state.eggBox.length})`);
    // TODO: 알림(Notification) 붙이기
  }
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
      eggBoxCount: state.eggBox.length,
      storedCount: state.storedCompanions.length,
    };
  }

  const species = gen1Data[companion.speciesId];
  const thresholds = stageThresholds(companion.tier, species.maxStage);
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
    hasNextEvolution: needed != null, // true면 다음 진화가 남아있음 (팝업에서 "다음 포켓몬: ???" 힌트)
    pokedexCount: buildDexAggregate().size,
    eggBoxCount: state.eggBox.length,
    storedCount: state.storedCompanions.length,
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
  const bySpecies = new Map(); // speciesId -> { tier, count, shinyCount, latestGraduatedAt, liveShiny }
  const ensure = (id) => {
    let e = bySpecies.get(id);
    if (!e) {
      e = { tier: null, count: 0, shinyCount: 0, latestGraduatedAt: null, liveShiny: false };
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
    }
  }

  const applyLive = (speciesId, tier, isShiny) => {
    for (const id of reachedChainIds(speciesId)) {
      const e = ensure(id);
      e.tier = tier;
      if (isShiny) e.liveShiny = true;
    }
  };
  if (state.companion && state.companion.state !== "egg") {
    applyLive(state.companion.speciesId, state.companion.tier, !!state.companion.isShiny);
  }
  for (const c of state.storedCompanions) {
    applyLive(c.speciesId, c.tier ?? gen1Data[c.speciesId]?.tier, !!c.isShiny);
  }

  return bySpecies;
}

// 도감 목록 — 발견한 종(buildDexAggregate 기준)만, 졸업한 것부터 최근 졸업순으로,
// 아직 졸업 전(발견만 한) 것들은 그 뒤에 도감번호순으로. gen1Data에 없는 speciesId
// (원인 불명의 손상 데이터)가 섞여 있어도 전체가 죽지 않게 그 항목만 건너뛴다.
function buildPokedexPayload() {
  const bySpecies = buildDexAggregate();
  const discoveredIds = new Set(bySpecies.keys());

  const rows = [];
  for (const [id, agg] of bySpecies) {
    const species = gen1Data[id];
    if (!species) {
      console.error(`Pokedex entry has unknown speciesId: ${id}`);
      continue;
    }
    const isShiny = agg.shinyCount > 0 || agg.liveShiny;
    rows.push({
      speciesId: id,
      nameKo: species.nameKo,
      sprite: isShiny ? species.spriteShiny : species.sprite,
      isShiny,
      tier: agg.tier ?? species.tier,
      count: agg.count,
      shinyCount: agg.shinyCount,
      graduatedAt: agg.latestGraduatedAt, // null이면 발견은 했지만 아직 졸업 전
      evolutionChain: buildEvolutionChain(id, discoveredIds, agg.tier ?? species.tier),
    });
  }

  return rows.sort((a, b) => {
    if (a.graduatedAt && b.graduatedAt) return a.graduatedAt < b.graduatedAt ? 1 : -1;
    if (a.graduatedAt) return -1;
    if (b.graduatedAt) return 1;
    return a.speciesId - b.speciesId; // 둘 다 졸업 전이면 도감번호순
  });
}

// 지금 키우던 애가 "성장 중"이면 잃어버리지 않게 보관함에 저장. 알 상태면 아직
// 특정 개체가 안 정해진 상태라 보관 없이 그냥 교체됨(부화 진행률은 호출부에서 별도 처리).
function boxCurrentCompanionIfGrowing() {
  if (state.companion && state.companion.state !== "egg") {
    state.storedCompanions.push({
      speciesId: state.companion.speciesId,
      stage: state.companion.stage,
      tier: state.companion.tier,
      hatchedAtTotal: state.companion.hatchedAtTotal,
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
 * 버리지 않고 새 등급 알의 진행률로 이어받는다.
 * 반환: { ok: boolean, reason?: string, status: buildStatusPayload() }
 */
function startIncubatingEgg(eggId) {
  const eggIndex = state.eggBox.findIndex((e) => e.id === eggId);
  if (eggIndex === -1) {
    return { ok: false, reason: "egg-not-found", status: buildStatusPayload(lastTotalTokens) };
  }

  const egg = state.eggBox[eggIndex];
  const wasEgg = state.companion?.state === "egg";
  const eggStartTotal = wasEgg ? state.companion.eggStartTotal : lastTotalTokens;

  boxCurrentCompanionIfGrowing();

  state.eggBox.splice(eggIndex, 1);
  state.companion = newEgg(eggStartTotal, egg.grade);
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);

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
 * 지금 성장 중인 애가 있으면 그 애가 대신 보관함으로 들어간다(자리 교환).
 */
function resumeStoredCompanion(index) {
  if (index < 0 || index >= state.storedCompanions.length) {
    return { ok: false, reason: "invalid-index", status: buildStatusPayload(lastTotalTokens) };
  }

  boxCurrentCompanionIfGrowing();

  const [resumed] = state.storedCompanions.splice(index, 1);
  state.companion = {
    state: "growing",
    speciesId: resumed.speciesId,
    stage: resumed.stage,
    tier: resumed.tier ?? gen1Data[resumed.speciesId]?.tier, // 예전 저장분 호환 폴백
    hatchedAtTotal: resumed.hatchedAtTotal,
    isShiny: resumed.isShiny,
  };
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);

  return { ok: true, status: buildStatusPayload(lastTotalTokens) };
}

/**
 * 지금 성장 중인 애를 보관함으로 옮기고 그 자리에 새 알을 시작한다(진화 없는
 * 단일형 종을 뽑으면 졸업할 때까지 알 보관함에 알이 하나도 안 쌓여서 다른 애를
 * 시작할 방법이 아예 없었던 문제 — 사용자 요청으로 추가). 알 상태일 땐 보관할
 * 대상이 없으니 아무 일도 안 함.
 */
function boxAndStartNewEgg() {
  if (!state.companion || state.companion.state === "egg") {
    return { ok: false, reason: "not-growing", status: buildStatusPayload(lastTotalTokens) };
  }

  boxCurrentCompanionIfGrowing();
  state.companion = newEgg(lastTotalTokens);
  saveState(app.getPath("userData"), state);
  updateTrayIcon(lastTotalTokens);

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

const WIDGET_SIZE = { width: 90, height: 110 };

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

function setWidgetEnabled(enabled) {
  state.widget.enabled = enabled;
  saveState(app.getPath("userData"), state);
  if (enabled) createOrShowWidget();
  else hideWidget();
}

function setWidgetOpacity(value) {
  state.widget.opacity = value;
  if (widgetWindow) widgetWindow.setOpacity(value);
  saveState(app.getPath("userData"), state);
}

// 위젯 우클릭 시 뜨는 투명도 조절 + 숨기기 메뉴.
function showWidgetContextMenu() {
  if (!widgetWindow) return;
  const menu = Menu.buildFromTemplate([
    { label: "투명도 25%", click: () => setWidgetOpacity(0.25) },
    { label: "투명도 50%", click: () => setWidgetOpacity(0.5) },
    { label: "투명도 75%", click: () => setWidgetOpacity(0.75) },
    { label: "투명도 100%", click: () => setWidgetOpacity(1.0) },
    { type: "separator" },
    { label: "위젯 숨기기", click: () => setWidgetEnabled(false) },
  ]);
  menu.popup({ window: widgetWindow });
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
  tray.setContextMenu(menu);
  tray.on("click", togglePopup);
}

function togglePopup() {
  if (popup) {
    popup.close();
    popup = null;
    return;
  }
  popup = new BrowserWindow({
    width: 380,
    height: 560,
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

app.whenReady().then(() => {
  loadGen1Data();
  state = loadState(app.getPath("userData"));
  fixCorruptedPokedexEntries();
  fixCorruptedCompanion();
  migrateMissingTier();
  createTray();
  ipcMain.handle("get-status", () => buildStatusPayload(lastTotalTokens));
  ipcMain.handle("get-pokedex", () => buildPokedexPayload());
  ipcMain.handle("get-egg-box", () => buildEggBoxPayload());
  ipcMain.handle("hatch-egg", (event, eggId) => startIncubatingEgg(eggId));
  ipcMain.handle("get-storage", () => buildStoragePayload());
  ipcMain.handle("resume-stored", (event, index) => resumeStoredCompanion(index));
  ipcMain.handle("box-and-new-egg", () => boxAndStartNewEgg());
  ipcMain.handle("open-popup", () => togglePopup());
  ipcMain.handle("widget-context-menu", () => showWidgetContextMenu());
  ipcMain.handle("refresh", () => {
    tick(); // 로그 재스캔 + 상태 저장까지 즉시 수행
    return buildStatusPayload(lastTotalTokens);
  });
  tick();
  togglePopup(); // exe 실행 직후 트레이 아이콘까지 찾아가서 눌러야 하는 게 아니라 바로 팝업이 뜨게
  if (state.widget.enabled) createOrShowWidget(); // 지난 세션에 위젯을 켜놨었으면 그대로 복원
  setInterval(tick, POLL_INTERVAL_MS);
});

app.on("window-all-closed", (e) => e.preventDefault()); // 트레이 상주, 창 닫아도 종료 안 함
