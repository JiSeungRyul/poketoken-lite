const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const { getTotalTokens } = require("./logParser");
const { evaluate, newEgg, pickHatchSpecies, HATCH_THRESHOLD, stageThresholds, SHINY_DENOMINATOR } = require("./growth");
const { loadState, saveState } = require("./state");

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5분, 추정 기본값

let tray = null;
let popup = null;
let gen1Data = null;
let state = null;
let lastTotalTokens = 0; // tick()에서 갱신, 팝업이 열릴 때마다 로그 전체를 재파싱하지 않기 위한 캐시

function loadGen1Data() {
  const p = path.join(__dirname, "..", "data", "gen1.json");
  if (!fs.existsSync(p)) {
    console.error(
      "data/gen1.json 이 없음. 먼저 `npm run build-data` 를 실행해서 PokéAPI 데이터를 받아야 함."
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
      console.error(`도감 항목의 speciesId를 복구할 수 없어 삭제함: ${entry.speciesId}`, entry);
      continue;
    }

    const species = gen1Data[resolvedId];
    if (species.evolvesTo.length > 0) {
      state.storedCompanions.push({
        speciesId: resolvedId,
        stage: 1,
        hatchedAtTotal: nowTotal,
        isShiny: !!entry.isShiny,
        storedAt: new Date().toISOString(),
      });
      movedToStorage += 1;
    } else {
      if (resolvedId !== entry.speciesId) renamedInPlace += 1;
      stillValid.push({ ...entry, speciesId: resolvedId });
    }
  }

  if (movedToStorage > 0 || renamedInPlace > 0) {
    state.pokedex = stillValid;
    console.log(
      `도감 보정: ${movedToStorage}건 보관함으로 이동(처음부터 다시 키울 수 있음), ${renamedInPlace}건 speciesId만 보정`
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
  console.error(`현재 컴패니언의 speciesId가 손상됨: ${companion.speciesId} → ${resolvedId ?? "복구 불가, 새 알로 리셋"}`);
  if (resolvedId != null) {
    state.companion = {
      state: "growing",
      speciesId: resolvedId,
      stage: 1,
      hatchedAtTotal: getTotalTokens(),
      isShiny: !!companion.isShiny,
    };
  } else {
    state.companion = null;
  }
  saveState(app.getPath("userData"), state);
}

function tick() {
  const totalTokens = getTotalTokens();
  lastTotalTokens = totalTokens;

  if (!state.companion) {
    state.companion = newEgg(totalTokens);
  }

  // 진화/졸업으로 등급 알을 적립할 때 등급 기준으로 쓸, "진화하기 직전" 개체 자신의 종.
  const preTransitionSpecies =
    state.companion.state !== "egg" ? gen1Data[state.companion.speciesId] : null;

  const ownedSpeciesIds = new Set(state.pokedex.map((e) => e.speciesId));
  const result = evaluate(state.companion, gen1Data, totalTokens, ownedSpeciesIds);
  state.companion = result.companion;

  // 진화(중간 단계 포함)/졸업 할 때마다 등급 알 1개를 보관함에 적립. 등급은 방금
  // 진화하기 직전 개체 자신의 tier를 그대로 씀(체인 내에서 등급이 실제로 바뀌는
  // 경우도 있지만 — 예: 두두 common→두트리오 legendary — "미진화체 등급 = 최종진화
  // 등급"으로 단순화하기로 함).
  if ((result.event === "evolve" || result.event === "graduate") && preTransitionSpecies) {
    state.eggBox.push({
      id: `egg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      grade: preTransitionSpecies.tier,
      createdAt: new Date().toISOString(),
    });
  }

  // 로그용으로 "무엇이 졸업했는지"를 companion을 새 알로 덮어쓰기 전에 미리 남겨둠 —
  // 안 그러면 아래 console.log에 졸업한 애 대신 그 자리의 새 알 정보가 찍힘.
  const graduatedCompanion = result.event === "graduate" ? state.companion : null;

  if (result.event === "graduate") {
    state.pokedex.push({
      speciesId: state.companion.speciesId,
      graduatedAt: new Date().toISOString(),
      isShiny: !!state.companion.isShiny,
    });
    state.companion = newEgg(totalTokens); // 새 알 시작
  }

  saveState(app.getPath("userData"), state);
  updateTrayIcon(totalTokens);

  if (result.event !== "none") {
    console.log(`이벤트: ${result.event}`, graduatedCompanion ?? state.companion, `(알 보관함: ${state.eggBox.length}개)`);
    // TODO: 알림(Notification) 붙이기
  }
}

// get-status IPC 응답 페이로드: 렌더러가 바로 그릴 수 있게 평이한 값으로 가공
function buildStatusPayload(totalTokens) {
  const companion = state.companion;

  if (!companion || companion.state === "egg") {
    const progress = totalTokens - (companion?.eggStartTotal ?? 0);
    return {
      state: "egg",
      label: "🥚 알",
      tier: null, // 부화 전엔 종이 아직 안 정해져서 등급도 없음
      sprite: null,
      isShiny: false,
      progress,
      needed: HATCH_THRESHOLD,
      hasNextEvolution: false, // 알 자체가 이미 미스터리라 "다음 포켓몬???" 힌트는 안 보여줌
      pokedexCount: state.pokedex.length,
      eggBoxCount: state.eggBox.length,
      storedCount: state.storedCompanions.length,
    };
  }

  const species = gen1Data[companion.speciesId];
  const thresholds = stageThresholds(species);
  const needed = thresholds[companion.stage - 1] ?? null; // null이면 최종 진화(다음 tick에 졸업 처리)
  const progress = totalTokens - companion.hatchedAtTotal;
  const isShiny = !!companion.isShiny;

  return {
    state: companion.state,
    speciesId: companion.speciesId,
    label: species.nameKo,
    tier: species.tier,
    sprite: isShiny ? species.spriteShiny : species.sprite,
    isShiny,
    progress,
    needed,
    hasNextEvolution: needed != null, // true면 다음 진화가 남아있음 (팝업에서 "다음 포켓몬: ???" 힌트)
    pokedexCount: state.pokedex.length,
    eggBoxCount: state.eggBox.length,
    storedCount: state.storedCompanions.length,
  };
}

// speciesId(보통 도감의 최종형)의 기본형부터 시작해서 진화 라인 전체를 순서대로 나열.
// evolvesTo[0] 고정 경로라 그 개체가 실제로 밟아온 단계와 동일하다(가지치기 진화는
// 다른 분기가 있어도 안 보임 — growth.js와 동일한 단순화).
function buildEvolutionChain(speciesId) {
  const chain = [];
  const baseId = gen1Data[speciesId]?.baseFormId ?? speciesId;
  let current = gen1Data[baseId];
  while (current) {
    chain.push({
      speciesId: current.id,
      nameKo: current.nameKo,
      sprite: current.sprite,
      tier: current.tier,
    });
    current = current.evolvesTo[0] != null ? gen1Data[current.evolvesTo[0]] : null;
  }
  return chain;
}

// 도감(졸업한 포켓몬) 목록을 종 정보와 합쳐서 반환. 최근 졸업한 순.
// gen1Data에 없는 speciesId(원인 불명의 손상 데이터)가 섞여 있어도 전체가
// 죽지 않게 그 항목만 건너뛰고 콘솔에 남긴다.
function buildPokedexPayload() {
  const result = [];
  for (const entry of [...state.pokedex].reverse()) {
    const species = gen1Data[entry.speciesId];
    if (!species) {
      console.error(`도감 항목에 알 수 없는 speciesId: ${entry.speciesId}`, entry);
      continue;
    }
    const isShiny = !!entry.isShiny;
    result.push({
      speciesId: entry.speciesId,
      nameKo: species.nameKo,
      sprite: isShiny ? species.spriteShiny : species.sprite,
      isShiny,
      tier: species.tier,
      graduatedAt: entry.graduatedAt,
      evolutionChain: buildEvolutionChain(entry.speciesId),
    });
  }
  return result;
}

// 지금 키우던 애가 "성장 중"이면 잃어버리지 않게 보관함에 저장. 알 상태면 아직
// 특정 개체가 안 정해진 상태라 보관 없이 그냥 교체됨(부화 진행률은 호출부에서 별도 처리).
function boxCurrentCompanionIfGrowing() {
  if (state.companion && state.companion.state !== "egg") {
    state.storedCompanions.push({
      speciesId: state.companion.speciesId,
      stage: state.companion.stage,
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
 * 알 보관함에서 알 하나를 골라 부화시킨다(티켓처럼 종을 직접 고르는 게 아니라,
 * 그 알의 등급 이상 범위에서 capture_rate 가중치로 랜덤 부화 — 원본(PokeTokenBar)의
 * "등급 보증 알" 방식과 동일). 지금 뭔가 성장 중이어도 가능 — 그 컴패니언은 버려지지
 * 않고 보관함(storedCompanions)으로 들어가서 나중에 다시 꺼내 키울 수 있다. 지금 알
 * 상태였다면 그 알이 모아둔 부화 진행률은 버리지 않고 새 컴패니언의 진화 진행률로
 * 이어받는다.
 * 반환: { ok: boolean, reason?: string, status: buildStatusPayload() }
 */
function hatchEgg(eggId) {
  const eggIndex = state.eggBox.findIndex((e) => e.id === eggId);
  if (eggIndex === -1) {
    return { ok: false, reason: "egg-not-found", status: buildStatusPayload(lastTotalTokens) };
  }

  const egg = state.eggBox[eggIndex];
  const ownedSpeciesIds = new Set(state.pokedex.map((e) => e.speciesId));
  const newSpecies = pickHatchSpecies(gen1Data, ownedSpeciesIds, egg.grade);

  const wasEgg = state.companion?.state === "egg";
  const hatchedAtTotal = wasEgg ? state.companion.eggStartTotal : lastTotalTokens;

  boxCurrentCompanionIfGrowing();

  state.eggBox.splice(eggIndex, 1);
  state.companion = {
    state: "growing",
    speciesId: newSpecies.id,
    stage: 1,
    hatchedAtTotal,
    isShiny: Math.random() < 1 / SHINY_DENOMINATOR,
  };
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
      console.error(`보관함 항목에 알 수 없는 speciesId: ${c.speciesId}`, c);
      return;
    }
    const isShiny = !!c.isShiny;
    result.push({
      index,
      speciesId: c.speciesId,
      nameKo: species.nameKo,
      sprite: isShiny ? species.spriteShiny : species.sprite,
      isShiny,
      tier: species.tier,
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
    hatchedAtTotal: resumed.hatchedAtTotal,
    isShiny: resumed.isShiny,
  };
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

function createTray() {
  const iconPath = path.join(__dirname, "..", "assets", "tray-icon.png");
  const image = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(image);
  const menu = Menu.buildFromTemplate([
    { label: "지금 새로고침", click: tick },
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
    width: 320,
    height: 420,
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
  createTray();
  ipcMain.handle("get-status", () => buildStatusPayload(lastTotalTokens));
  ipcMain.handle("get-pokedex", () => buildPokedexPayload());
  ipcMain.handle("get-egg-box", () => buildEggBoxPayload());
  ipcMain.handle("hatch-egg", (event, eggId) => hatchEgg(eggId));
  ipcMain.handle("get-storage", () => buildStoragePayload());
  ipcMain.handle("resume-stored", (event, index) => resumeStoredCompanion(index));
  ipcMain.handle("refresh", () => {
    tick(); // 로그 재스캔 + 상태 저장까지 즉시 수행
    return buildStatusPayload(lastTotalTokens);
  });
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
});

app.on("window-all-closed", (e) => e.preventDefault()); // 트레이 상주, 창 닫아도 종료 안 함
