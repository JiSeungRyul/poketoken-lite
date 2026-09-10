const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const { getTotalTokens } = require("./logParser");
const { evaluate, newEgg, HATCH_THRESHOLD, stageThresholds } = require("./growth");
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

  const result = evaluate(state.companion, gen1Data, totalTokens);
  state.companion = result.companion;

  if (result.event === "graduate") {
    state.pokedex.push({
      speciesId: state.companion.speciesId,
      graduatedAt: new Date().toISOString(),
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
      progress,
      needed: HATCH_THRESHOLD,
      hasNextEvolution: false, // 알 자체가 이미 미스터리라 "다음 포켓몬???" 힌트는 안 보여줌
      pokedexCount: state.pokedex.length,
    };
  }

  const species = gen1Data[companion.speciesId];
  const thresholds = stageThresholds(species);
  const needed = thresholds[companion.stage - 1] ?? null; // null이면 최종 진화(다음 tick에 졸업 처리)
  const progress = totalTokens - companion.hatchedAtTotal;

  return {
    state: companion.state,
    label: species.nameKo,
    tier: species.tier,
    sprite: species.sprite,
    progress,
    needed,
    hasNextEvolution: needed != null, // true면 다음 진화가 남아있음 (팝업에서 "다음 포켓몬: ???" 힌트)
    pokedexCount: state.pokedex.length,
  };
}

// 도감(졸업한 포켓몬) 목록을 종 정보와 합쳐서 반환. 최근 졸업한 순.
function buildPokedexPayload() {
  return [...state.pokedex]
    .reverse()
    .map((entry) => {
      const species = gen1Data[entry.speciesId];
      return {
        speciesId: entry.speciesId,
        nameKo: species.nameKo,
        sprite: species.sprite,
        tier: species.tier,
        graduatedAt: entry.graduatedAt,
      };
    });
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
  ipcMain.handle("refresh", () => {
    tick(); // 로그 재스캔 + 상태 저장까지 즉시 수행
    return buildStatusPayload(lastTotalTokens);
  });
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
});

app.on("window-all-closed", (e) => e.preventDefault()); // 트레이 상주, 창 닫아도 종료 안 함
