/**
 * src/growth.js
 *
 * 누적 토큰량 + 현재 포켓몬(species, stage)을 받아서
 * 다음 상태(부화/진화/졸업 여부)를 판정한다.
 *
 * 판정 방식: 실시간 비례 성장이 아니라 "임계치(threshold)를 넘으면 다음 단계" 방식.
 * 아래 상수들은 전부 추정 기본값 — 실사용 데이터 보면서 조정할 것.
 */

const HATCH_THRESHOLD = 500_000; // 알 → 부화까지 필요한 토큰 (추정값)
const BASE_STAGE_GROWTH = 1_000_000; // common 티어 기준, 진화 1단계당 필요 토큰 (추정값)

const TIER_MULTIPLIER = {
  common: 1,
  rare: 3,
  legendary: 8,
};

/**
 * 특정 species의 진화 단계별 누적 임계치 배열을 계산.
 * 예: maxStage=3 (3단 진화)면 [부화, 1→2단, 2→3단] 두 번의 진화 임계치 반환.
 * 반환값은 "부화 시점부터의 누적 토큰" 기준.
 */
function stageThresholds(species) {
  const multiplier = TIER_MULTIPLIER[species.tier] ?? 1;
  const stagesToClimb = species.maxStage - 1; // 진화 횟수
  if (stagesToClimb <= 0) return []; // 이미 최종 진화(단일 형태)

  const perStage = (BASE_STAGE_GROWTH * multiplier) / stagesToClimb;
  const thresholds = [];
  for (let i = 1; i <= stagesToClimb; i++) {
    thresholds.push(Math.round(perStage * i));
  }
  return thresholds;
}

/**
 * companion: { speciesId, hatchedAtTotal, stage, graduated }
 * gen1Data: build-gen1-data.js가 만든 전체 데이터 맵
 * totalTokens: 현재까지 누적 토큰
 *
 * 반환: { event: 'none'|'hatch'|'evolve'|'graduate', ...업데이트된 companion }
 */
function evaluate(companion, gen1Data, totalTokens) {
  // 알 상태 (아직 부화 전)
  if (!companion || companion.state === "egg") {
    const progressTokens = totalTokens - (companion?.eggStartTotal ?? 0);
    if (progressTokens >= HATCH_THRESHOLD) {
      const newSpecies = pickHatchSpecies(gen1Data);
      return {
        event: "hatch",
        companion: {
          state: "growing",
          speciesId: newSpecies.id,
          stage: 1,
          hatchedAtTotal: totalTokens,
        },
      };
    }
    return { event: "none", companion };
  }

  // 성장 중
  const species = gen1Data[companion.speciesId];
  const thresholds = stageThresholds(species);
  const progressSinceHatch = totalTokens - companion.hatchedAtTotal;

  const nextStageIndex = companion.stage; // stage=1이면 다음은 thresholds[0](1→2단)
  if (nextStageIndex - 1 < thresholds.length) {
    const needed = thresholds[nextStageIndex - 1];
    if (progressSinceHatch >= needed) {
      const isFinal = companion.stage + 1 >= species.maxStage;
      return {
        event: isFinal ? "graduate" : "evolve",
        companion: {
          ...companion,
          stage: companion.stage + 1,
          state: isFinal ? "graduated" : "growing",
        },
      };
    }
  }

  return { event: "none", companion };
}

// 1단 진화(species.stage === 1)인 것들 중에서 랜덤 하나 뽑기 (부화 시 시작 종)
function pickHatchSpecies(gen1Data) {
  const starters = Object.values(gen1Data).filter((p) => p.stage === 1);
  const idx = Math.floor(Math.random() * starters.length);
  return starters[idx];
}

function newEgg(currentTotalTokens) {
  return { state: "egg", eggStartTotal: currentTotalTokens };
}

module.exports = { evaluate, stageThresholds, newEgg, HATCH_THRESHOLD, TIER_MULTIPLIER };
