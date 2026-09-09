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
    return { companion: null, pokedex: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    console.error("상태 파일 손상, 초기화:", err.message);
    return { companion: null, pokedex: [] };
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
