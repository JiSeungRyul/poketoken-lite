/**
 * src/growth.js
 *
 * 누적 토큰량 + 현재 포켓몬(species, stage)을 받아서
 * 다음 상태(부화/진화/졸업 여부)를 판정한다.
 *
 * 판정 방식: 실시간 비례 성장이 아니라 "임계치(threshold)를 넘으면 다음 단계" 방식.
 * 아래 상수들은 전부 추정 기본값 — 실사용 데이터 보면서 조정할 것.
 */

// 레퍼런스(PokeTokenBar) CompanionModel.swift/PokemonBalance를 실제로 확인해서 그대로
// 가져온 값들 — "실측 평균 하루 2.53억 토큰" 기준으로 산정된 값이라 우리가 추정했던
// 것보다 자릿수가 훨씬 크다(전엔 부화 50만·졸업 100만~800만이었는데, 그러면 대화
// 하나로도 여러 단계를 몰아서 넘겨버려 진화 과정이 거의 안 보이는 문제가 있었음).
const HATCH_THRESHOLD = 5_000_000; // 알 → 부화까지 필요한 토큰

// 등급별 "졸업까지 총 필요 토큰" — 진화 단계 수와 무관하게 등급 하나당 고정값.
// (레퍼런스의 PokemonBalance.graduationTotal 그대로)
const GRADUATION_TOTAL = {
  common: 750_000_000,
  uncommon: 1_875_000_000,
  rare: 3_000_000_000,
  legendary: 6_000_000_000,
};

// 등급 알(egg box)의 "이 등급 이상 보장" 판정 + 정렬에 쓰는 순위 — 높을수록 희귀.
const TIER_RANK = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

// 이로치(shiny) 부화 확률 분모. 원본(PokeTokenBar)도 본가 1/4096 대신 1/64를 씀
// ("데스크톱 앱 규모에선 평생 못 봄"이라 완화) — 우리도 그대로 따름.
const SHINY_DENOMINATOR = 64;

/**
 * tier(그 개체의 진화 라인 전체에 고정된 등급) + maxStage(진화 체인 총 단계 수)로
 * 진화 단계별 누적 임계치 배열을 계산. 예: maxStage=3(3단 진화)면 [1→2단, 2→3단]
 * 두 번의 진화 임계치 반환. 반환값은 "부화 시점부터의 누적 토큰" 기준.
 *
 * 단계가 갈수록 비용이 커지는 삼각수 가중치(레퍼런스 PokemonBalance.phaseThreshold와
 * 같은 방식) — i번째 단계 누적 임계치 = GRADUATION_TOTAL(tier) × i / (n(n+1)/2),
 * n=진화 횟수. 마지막 임계치(i=n)는 정확히 GRADUATION_TOTAL(tier)와 같아서 "졸업까지
 * 총 얼마나 필요한지"가 등급 하나로 고정되고, 진화 단계 수가 몇 개든 총량은 안 바뀐다.
 *
 * maxStage=1(전설 새들처럼 진화 트리가 자기 혼자뿐인 종)은 진화 횟수가 0이라
 * 예전엔 빈 배열을 반환했는데, evaluate()가 빈 배열을 "체크할 임계치 없음"으로
 * 처리해서 이런 종은 아무리 토큰을 모아도 영원히 졸업 판정이 안 나는 버그가 있었다.
 * 진화가 없어도 "부화 → 졸업"까지 1단계는 있는 걸로 취급해서 최소 1개는 반환한다.
 */
function stageThresholds(tier, maxStage) {
  const total = GRADUATION_TOTAL[tier] ?? GRADUATION_TOTAL.common;
  const stagesToClimb = Math.max(maxStage - 1, 1);
  const denom = (stagesToClimb * (stagesToClimb + 1)) / 2;

  // i번째 단계의 "증분"이 total*i/denom — 이 증분들을 다 더한 게 total(1+2+...+n = denom
  // 이니까). 반환값은 누적치라서, 증분을 하나씩 더해가며 쌓는다(증분 자체를 누적치로
  // 착각하면 마지막 값이 total보다 작아지는 계산 실수가 남 — 실제로 한 번 그랬었음).
  const thresholds = [];
  let cumulative = 0;
  for (let i = 1; i <= stagesToClimb; i++) {
    cumulative += Math.round((total * i) / denom);
    thresholds.push(cumulative);
  }
  return thresholds;
}

/**
 * companion: { speciesId, hatchedAtTotal, stage, tier, isShiny } 또는
 *   알 상태면 { state: 'egg', eggStartTotal, guaranteedGrade? }
 *   (guaranteedGrade는 등급 알 보관함에서 품기 시작한 경우에만 있음 — 일반 알은 없음)
 * gen1Data: build-gen1-data.js가 만든 전체 데이터 맵
 * totalTokens: 현재까지 누적 토큰
 * ownedSpeciesIds: 이미 도감에 있는 speciesId의 Set — 부화 가중치 계산용(선택)
 *
 * 반환: { event: 'none'|'hatch'|'evolve'|'graduate', ...업데이트된 companion }
 */
function evaluate(companion, gen1Data, totalTokens, ownedSpeciesIds) {
  // 알 상태 (아직 부화 전) — 일반 알이든 등급 알이든 똑같이 HATCH_THRESHOLD를 채워야
  // 부화한다. 등급 알은 "부화하면 뭐가 나올지 등급만 보장됨"이지 즉시 나오는 게 아님.
  if (!companion || companion.state === "egg") {
    const progressTokens = totalTokens - (companion?.eggStartTotal ?? 0);
    if (progressTokens >= HATCH_THRESHOLD) {
      const newSpecies = pickHatchSpecies(gen1Data, ownedSpeciesIds, companion?.guaranteedGrade);
      // 이로치는 부화 시점에 확정되고 이후 진화해도 유지됨(아래 evolve/graduate 분기의
      // `...companion` 스프레드가 그대로 물려줌 — 여기서만 한 번 굴리면 됨).
      const isShiny = Math.random() < 1 / SHINY_DENOMINATOR;
      // 등급도 부화한 기본형의 등급으로 여기서 딱 한 번 고정. 진화해도 절대 안 바뀜 —
      // 예전엔 진화할 때마다 그 단계 종 자신의 capture_rate로 다시 계산해서, 예를 들어
      // 두두(common)로 부화했는데 두트리오(legendary)로 진화하는 순간 갑자기 등급이
      // 바뀌는 버그가 있었음(사용자 지적: "미진화체가 common이면 최종진화까지 common
      // 이어야지"). 레퍼런스(PokeTokenBar)도 등급을 컴패니언에 고정 저장하고 재계산 안 함.
      return {
        event: "hatch",
        companion: {
          state: "growing",
          speciesId: newSpecies.id,
          stage: 1,
          tier: newSpecies.tier,
          hatchedAtTotal: totalTokens,
          isShiny,
        },
      };
    }
    return { event: "none", companion };
  }

  // 성장 중
  const species = gen1Data[companion.speciesId];
  const thresholds = stageThresholds(companion.tier, species.maxStage);
  const progressSinceHatch = totalTokens - companion.hatchedAtTotal;

  const nextStageIndex = companion.stage; // stage=1이면 다음은 thresholds[0](1→2단)
  if (nextStageIndex - 1 < thresholds.length) {
    const needed = thresholds[nextStageIndex - 1];
    if (progressSinceHatch >= needed) {
      const isFinal = companion.stage + 1 >= species.maxStage;
      // 진화할 종의 실제 PokeAPI id로 speciesId 갱신 — 이걸 안 하면 몇 단계를 진화하든
      // 화면·도감에 계속 부화 당시 기본형 이름만 뜨는 버그가 남는다. tier는 건드리지
      // 않음(위 설명대로 부화 시점에 고정된 값을 계속 씀) — companion 스프레드가 그대로 물려줌.
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
 *
 * minTier가 주어지면 그 등급 미만인 후보는 아예 제외한다(등급 알 부화용 — "이 등급
 * 이상 보장"). 생략하면 전체 68종 대상.
 */
function pickHatchSpecies(gen1Data, ownedSpeciesIds, minTier) {
  const minRank = minTier ? TIER_RANK[minTier] ?? 0 : 0;
  const starters = Object.values(gen1Data).filter(
    (p) => p.stage === 1 && (TIER_RANK[p.tier] ?? 0) >= minRank
  );
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

// guaranteedGrade를 주면 "등급 알"(부화 시 그 등급 이상 보장) — 안 주면 평범한 알.
function newEgg(currentTotalTokens, guaranteedGrade) {
  return { state: "egg", eggStartTotal: currentTotalTokens, guaranteedGrade };
}

module.exports = {
  evaluate,
  stageThresholds,
  newEgg,
  pickHatchSpecies,
  HATCH_THRESHOLD,
  GRADUATION_TOTAL,
  TIER_RANK,
  SHINY_DENOMINATOR,
};
