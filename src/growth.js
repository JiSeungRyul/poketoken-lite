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

// 이로치(shiny) 부화 확률 분모. 원본(PokeTokenBar)도 본가 1/4096 대신 1/64를 씀
// ("데스크톱 앱 규모에선 평생 못 봄"이라 완화) — 우리도 그대로 따름.
const SHINY_DENOMINATOR = 64;

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
 * companion: { speciesId, hatchedAtTotal, stage, graduated, isShiny }
 * gen1Data: build-gen1-data.js가 만든 전체 데이터 맵
 * totalTokens: 현재까지 누적 토큰
 * ownedSpeciesIds: 이미 도감에 있는 speciesId의 Set — 부화 가중치 계산용(선택)
 *
 * 반환: { event: 'none'|'hatch'|'evolve'|'graduate', ...업데이트된 companion }
 */
function evaluate(companion, gen1Data, totalTokens, ownedSpeciesIds) {
  // 알 상태 (아직 부화 전)
  if (!companion || companion.state === "egg") {
    const progressTokens = totalTokens - (companion?.eggStartTotal ?? 0);
    if (progressTokens >= HATCH_THRESHOLD) {
      const newSpecies = pickHatchSpecies(gen1Data, ownedSpeciesIds);
      // 이로치는 부화 시점에 확정되고 이후 진화해도 유지됨(아래 evolve/graduate 분기의
      // `...companion` 스프레드가 그대로 물려줌 — 여기서만 한 번 굴리면 됨).
      const isShiny = Math.random() < 1 / SHINY_DENOMINATOR;
      return {
        event: "hatch",
        companion: {
          state: "growing",
          speciesId: newSpecies.id,
          stage: 1,
          hatchedAtTotal: totalTokens,
          isShiny,
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
      // 진화할 종의 실제 PokeAPI id로 speciesId 갱신 — 이걸 안 하면 몇 단계를 진화하든
      // 화면·도감에 계속 부화 당시 기본형 이름만 뜨는 버그가 남는다(실제로 발생했던 문제:
      // 두두→두트리오처럼 진화하며 등급까지 바뀌는 경우도 계속 부화 시점 등급으로 계산됨).
      // 가지치기 진화(이브이 등)는 evolvesTo[0]로 고정 — 분기 선택 UI는 스코프 밖.
      const nextSpeciesId = species.evolvesTo[0] ?? companion.speciesId;
      return {
        event: isFinal ? "graduate" : "evolve",
        companion: {
          ...companion,
          speciesId: nextSpeciesId,
          stage: companion.stage + 1,
          state: isFinal ? "graduated" : "growing",
        },
      };
    }
  }

  return { event: "none", companion };
}

/**
 * 1단 진화(species.stage === 1)인 것들 중에서 부화 시 시작 종을 뽑는다.
 * PokéAPI capture_rate에 비례한 가중치 랜덤 — capture_rate가 낮을수록(잡기 어려울수록)
 * 뽑힐 확률도 낮아짐. 예전엔 균등 랜덤이라 legendary(24/68종)가 35%나 나왔는데,
 * "legendary는 희귀해야 한다"는 의도에 안 맞아서 원본(PokeTokenBar)처럼 가중치를 줬다.
 *
 * ownedSpeciesIds가 주어지면, 이미 도감에 있는 종은 가중치를 절반으로 깎는다(완전 배제는
 * 아님) — 원본이 "새 종을 2배 더 잘 나오게 하되, 재부화·샤이니 사냥은 막지 않는다"는
 * 의도로 쓰는 방식을 그대로 따름.
 */
function pickHatchSpecies(gen1Data, ownedSpeciesIds) {
  const starters = Object.values(gen1Data).filter((p) => p.stage === 1);
  const weights = starters.map((p) =>
    ownedSpeciesIds?.has(p.id) ? Math.max(1, p.captureRate / 2) : Math.max(1, p.captureRate)
  );
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  let roll = Math.random() * totalWeight;
  for (let i = 0; i < starters.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return starters[i];
  }
  return starters[starters.length - 1]; // 부동소수 오차 대비 fallback
}

function newEgg(currentTotalTokens) {
  return { state: "egg", eggStartTotal: currentTotalTokens };
}

module.exports = {
  evaluate,
  stageThresholds,
  newEgg,
  HATCH_THRESHOLD,
  TIER_MULTIPLIER,
  SHINY_DENOMINATOR,
};
