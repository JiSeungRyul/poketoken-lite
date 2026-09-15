/**
 * src/state.js
 * 현재 컴패니언 상태 + 도감(졸업한 포켓몬 목록)을 로컬 JSON에 저장.
 * 저장 위치: Electron userData 폴더 (Windows: %APPDATA%\PokeTokenLite\state.json)
 */

const fs = require("fs");
const path = require("path");

function getStatePath(userDataDir) {
  return path.join(userDataDir, "state.json");
}

// 항상 떠있는 위젯 설정 기본값 — enabled/opacity/위치(x,y, null=기본 위치) 전부
// 여기 하나로 관리. x/y는 화면 해상도 기준값이라 저장 안 해둔(null) 상태가 기본.
const DEFAULT_WIDGET = { enabled: false, opacity: 0.85, x: null, y: null };

function loadState(userDataDir) {
  const p = getStatePath(userDataDir);
  if (!fs.existsSync(p)) {
    return { companion: null, pokedex: [], eggBox: [], storedCompanions: [], firstHatchDone: false, widget: { ...DEFAULT_WIDGET }, unlockedGen: 1 };
  }
  try {
    const state = JSON.parse(fs.readFileSync(p, "utf-8"));
    // 이 필드들 추가 전 저장 파일 호환
    state.storedCompanions ??= [];
    state.eggBox ??= [];
    // eggInventory(추상적 개수) → eggBox(등급 알 목록) 전환 전 저장분 마이그레이션.
    // 등급 정보가 없던 시절 값이라 안전하게 커먼으로 채워 넣는다.
    if (state.eggInventory > 0) {
      for (let i = 0; i < state.eggInventory; i++) {
        state.eggBox.push({
          id: `migrated-${Date.now()}-${i}`,
          grade: "common",
          createdAt: new Date().toISOString(),
        });
      }
      delete state.eggInventory;
    }
    // firstHatchDone(첫 부화는 common/uncommon만 뽑히게 하는 기능) 추가 전 저장 파일 호환.
    // 이미 도감/보관함에 뭔가 있거나 지금 알이 아닌 개체를 키우는 중이면 첫 부화는 이미
    // 지나간 것 — true로 채워 지금 키우는 중인 개체를 소급으로 안 건드린다. 반대로 아직
    // 아무것도 없이 알 상태 그대로라면(이 기능 나오기 전에 막 시작한 경우) 대상에 포함.
    if (state.firstHatchDone === undefined) {
      const stillOnFirstEgg =
        (state.pokedex?.length ?? 0) === 0 &&
        (state.storedCompanions?.length ?? 0) === 0 &&
        (!state.companion || state.companion.state === "egg");
      state.firstHatchDone = !stillOnFirstEgg;
    }
    // widget(항상 떠있는 위젯 설정) 추가 전 저장 파일 호환 — 기본값 위에 기존 저장분을
    // 덮어써서 일부 필드만 있던 경우도 나머지는 기본값으로 채운다.
    state.widget = { ...DEFAULT_WIDGET, ...(state.widget || {}) };
    // unlockedGen(해금된 최대 세대) 추가 전 저장 파일 호환 — 다들 1세대만 있던
    // 시절이니 기본값 1(아직 2세대 안 열림).
    state.unlockedGen ??= 1;
    return state;
  } catch (err) {
    console.error("State file corrupted, resetting:", err.message);
    return { companion: null, pokedex: [], eggBox: [], storedCompanions: [], firstHatchDone: false, widget: { ...DEFAULT_WIDGET }, unlockedGen: 1 };
  }
}

function saveState(userDataDir, state) {
  const p = getStatePath(userDataDir);
  // 원자적 쓰기: 임시파일에 쓰고 rename (중간에 죽어도 손상 방지)
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

module.exports = { loadState, saveState };
