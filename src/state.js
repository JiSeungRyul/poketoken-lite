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

function loadState(userDataDir) {
  const p = getStatePath(userDataDir);
  if (!fs.existsSync(p)) {
    return { companion: null, pokedex: [], eggBox: [], storedCompanions: [] };
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
    return state;
  } catch (err) {
    console.error("상태 파일 손상, 초기화:", err.message);
    return { companion: null, pokedex: [], eggBox: [], storedCompanions: [] };
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
