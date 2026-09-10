const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const { getTotalTokens } = require("./logParser");
const { evaluate, newEgg, HATCH_THRESHOLD, stageThresholds, SHINY_DENOMINATOR } = require("./growth");
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

function tick() {
  const totalTokens = getTotalTokens();
  lastTotalTokens = totalTokens;

  if (!state.companion) {
    state.companion = newEgg(totalTokens);
  }

  const ownedSpeciesIds = new Set(state.pokedex.map((e) => e.speciesId));
  const result = evaluate(state.companion, gen1Data, totalTokens, ownedSpeciesIds);
  state.companion = result.companion;

  // 진화(중간 단계 포함)/졸업 할 때마다 알 티켓 1개 적립 — 도감에서 직접 종을
  // 골라 키우는 기능(choose-species)의 재화. 알 자체의 자동 부화 루프와는 별개.
  if (result.event === "evolve" || result.event === "graduate") {
    state.eggInventory += 1;
  }

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
    console.log(`이벤트: ${result.event}`, state.companion);
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
      eggInventory: state.eggInventory,
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
    eggInventory: state.eggInventory,
  };
}

// 도감(졸업한 포켓몬) 목록을 종 정보와 합쳐서 반환. 최근 졸업한 순.
function buildPokedexPayload() {
  return [...state.pokedex]
    .reverse()
    .map((entry) => {
      const species = gen1Data[entry.speciesId];
      const isShiny = !!entry.isShiny;
      return {
        speciesId: entry.speciesId,
        nameKo: species.nameKo,
        sprite: isShiny ? species.spriteShiny : species.sprite,
        isShiny,
        tier: species.tier,
        graduatedAt: entry.graduatedAt,
      };
    });
}

/**
 * 도감에서 종을 직접 골라 키우기 시작. 알 티켓(eggInventory)을 1개 소모하고,
 * 알 상태일 때만 가능(이미 뭔가 키우는 중이면 그 진행을 버리게 되므로 막음).
 * 반환: { ok: boolean, reason?: string, status: buildStatusPayload() }
 */
function chooseSpecies(speciesId) {
  if (state.eggInventory <= 0) {
    return { ok: false, reason: "no-ticket", status: buildStatusPayload(lastTotalTokens) };
  }
  if (!state.companion || state.companion.state !== "egg") {
    return { ok: false, reason: "not-egg-state", status: buildStatusPayload(lastTotalTokens) };
  }
  if (!gen1Data[speciesId]) {
    return { ok: false, reason: "unknown-species", status: buildStatusPayload(lastTotalTokens) };
  }

  state.eggInventory -= 1;
  state.companion = {
    state: "growing",
    speciesId,
    stage: 1,
    hatchedAtTotal: lastTotalTokens,
    isShiny: Math.random() < 1 / SHINY_DENOMINATOR, // 직접 골라도 이로치 여부는 똑같이 랜덤
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
  createTray();
  ipcMain.handle("get-status", () => buildStatusPayload(lastTotalTokens));
  ipcMain.handle("get-pokedex", () => buildPokedexPayload());
  ipcMain.handle("choose-species", (event, speciesId) => chooseSpecies(speciesId));
  ipcMain.handle("refresh", () => {
    tick(); // 로그 재스캔 + 상태 저장까지 즉시 수행
    return buildStatusPayload(lastTotalTokens);
  });
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
});

app.on("window-all-closed", (e) => e.preventDefault()); // 트레이 상주, 창 닫아도 종료 안 함
