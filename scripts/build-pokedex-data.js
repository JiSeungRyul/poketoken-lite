/**
 * scripts/build-pokedex-data.js
 *
 * PokéAPI에서 포켓몬 정보를 fetch해서 data/pokedex.json 으로 캐싱한다.
 * 세대별로 완전히 독립된 범위로 진화 체인을 클리핑해서 빌드한다(GENERATIONS 참고) —
 * 1세대 파일(예전 build-gen1-data.js가 만들던 data/gen1.json)과 똑같은 방식을
 * 세대마다 따로 적용하는 것. 이유: PokéAPI의 evolution-chain은 세대 구분 없이
 * "그 종이 게임 역사상 진화한 모든 경로"를 다 담고 있어서(예: 이브이(1세대)→
 * 이브이의 진화형(2/4/6세대)), 세대 경계를 넘나드는 체인을 세대별로 독립적으로
 * 끊어서 봐야 각 세대 데이터가 서로 오염되지 않는다. 실제로 확인한 사례:
 * - 폴리곤(137, 1세대)→폴리곤2(233, 2세대): 1세대만 보면 233은 범위 밖이라
 *   안 보이고(정상), 2세대만 보면 137이 범위 밖이라 폴리곤2가 그 자체로
 *   독립된 1단 진화종이 됨(진화 전 형태 관계는 표현 안 됨 — 받아들인 단순화,
 *   1세대 데이터에서 삐삐(2세대 아기)→피츄→피카츄 관계도 이미 똑같이 끊겨있음).
 *
 * 실행: node scripts/build-pokedex-data.js (또는 npm run build-data)
 * (개발 PC에서 1회만 돌리면 됨. 앱 런타임엔 이 캐시 파일만 읽음 — PokéAPI 재호출 없음.
 * 세대가 늘어날수록 종 수만큼 API 호출도 늘어서 시간이 좀 걸림.)
 *
 * 주의: capture_rate 등 실제 수치는 이 스크립트가 PokéAPI에서 직접 가져오는 값이라
 * 정확함. 내가 임의로 하드코딩한 값이 아님 — 그래서 이 방식을 택함.
 */

const fs = require("fs");
const path = require("path");

const POKEAPI = "https://pokeapi.co/api/v2";

// 세대별 독립 범위. 나중에 3세대를 추가하려면 이 배열에 한 줄만 추가하면 됨.
const GENERATIONS = [
  { gen: 1, min: 1, max: 151 },
  { gen: 2, min: 152, max: 251 },
];

// 희귀도 티어 경계값 — 레퍼런스(PokeTokenBar) CompanionModel.swift의 Rarity.captureRateCeiling
// 실측값 그대로 사용(epic<=45, uncommon<=120, common<=255). 전설/환상 등급은 capture_rate로
// 판정하면 안 됨 — 예: 망나뇽(149)은 capture_rate=45라 예전 방식으론 legendary로 잘못
// 분류됐지만 실제로는 전설이 아님(is_legendary=false). PokéAPI의 is_legendary/is_mythical
// 플래그로 직접 판정한다. 레퍼런스는 전설/환상을 합쳐서 같은 등급으로 취급하는데,
// 우리는 사용자 요청으로 둘을 분리(mythical을 legendary보다 한 단계 더 위로) — 1세대
// 기준 확인: 프리져/썬더/파이어/뮤츠 4마리는 legendary, 뮤 1마리만 mythical.
//
// 레퍼런스는 이 capture_rate<=45 구간을 그냥 "rare"라고 부르는데(원래 legendary
// 판정 기준이랑 겹쳐서 예전엔 실수로 legendary 취급됐던 바로 그 구간 — 스타팅
// 포켓몬 최종진화, 잠만보, 이브이 라인, 망나뇽 등 55마리), 사용자 요청으로 "rare"라는
// 이름 대신 legendary 바로 아래 등급이라는 걸 드러내는 "epic"으로 이름을 바꿈
// (커먼<언커먼<에픽<레전더리<미시컬 — 게임에서 흔한 등급 순서).
const TIER_BOUNDS = {
  epic: 45,
  uncommon: 120,
  // 그 이상은 common
};

function classifyTier(captureRate, isLegendary, isMythical) {
  if (isMythical) return "mythical";
  if (isLegendary) return "legendary";
  if (captureRate <= TIER_BOUNDS.epic) return "epic";
  if (captureRate <= TIER_BOUNDS.uncommon) return "uncommon";
  return "common";
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  return res.json();
}

// evolution-chain 응답을 순회하며 { speciesId: { stage, evolvesTo: [speciesId,...] } } 로
// 변환하되, [minId, maxId] 범위 밖 노드는 기록만 안 하고(그 자손은 계속 내려가며 "범위
// 안 조상 기준 상대 stage"를 매김). relativeStage: 지금까지 거쳐온 범위 안 조상 수 기준
// 단계(범위 안 조상이 아직 없으면 undefined).
function flattenChain(node, out, minId, maxId, relativeStage) {
  const id = idFromUrl(node.species.url);
  const inRange = id >= minId && id <= maxId;
  const stage = inRange ? relativeStage ?? 1 : relativeStage;

  if (inRange) {
    out[id] = out[id] || { stage, evolvesTo: [] };
    out[id].stage = stage;
  }

  for (const next of node.evolves_to) {
    const nextId = idFromUrl(next.species.url);
    if (inRange && nextId >= minId && nextId <= maxId) {
      out[id].evolvesTo.push(nextId);
    }
    // 자손은 범위 밖 노드 밑이라도 계속 탐색 — 그 밑에 범위 안 후손이 있을 수 있음.
    flattenChain(next, out, minId, maxId, inRange ? stage + 1 : relativeStage);
  }
  return out;
}

// chainMap 안에서 id의 진짜 조상을 evolvesTo 역방향으로 추적해서 찾는다(부모가
// 없으면, 즉 아무도 이 id를 evolvesTo로 안 가리키면 그 자체가 기본형).
function findBaseFormId(chainMap, id) {
  const parentOf = {};
  for (const [pid, info] of Object.entries(chainMap)) {
    for (const child of info.evolvesTo) parentOf[child] = Number(pid);
  }
  let current = id;
  while (parentOf[current] !== undefined) current = parentOf[current];
  return current;
}

function idFromUrl(url) {
  const parts = url.split("/").filter(Boolean);
  return Number(parts[parts.length - 1]);
}

// chainCache는 evolution_chain URL이 키라 세대 경계와 무관하게 전역 공유해도 안전함
// (다만 flattenChain 결과 자체는 세대별 min/max에 따라 달라지므로, 세대+URL 조합으로
// 따로 캐싱해야 함 — 아래에서 `${gen}:${url}`로 키를 만듦).
async function buildGeneration({ gen, min, max }, chainMapCache, result) {
  const count = max - min + 1;
  for (let id = min; id <= max; id++) {
    process.stdout.write(`\r  [gen${gen}] ${id - min + 1}/${count} (id ${id})`);

    const species = await fetchJson(`${POKEAPI}/pokemon-species/${id}`);
    const pokemon = await fetchJson(`${POKEAPI}/pokemon/${id}`);

    const chainUrl = species.evolution_chain.url;
    const cacheKey = `${gen}:${chainUrl}`;
    let chainMap = chainMapCache.get(cacheKey);
    if (!chainMap) {
      const chain = await fetchJson(chainUrl);
      chainMap = flattenChain(chain.chain, {}, min, max, undefined);
      chainMapCache.set(cacheKey, chainMap);
    }

    const nameKo =
      species.names.find((n) => n.language.name === "ko")?.name ||
      species.names.find((n) => n.language.name === "en")?.name ||
      species.name;

    // 이 종 자신의 기본형 id — "도감에서 이 종(보통 최종형)을 다시 키울 때 어느
    // 기본형부터 시작해야 하는지" 판단에 씀(안 그러면 최종형 이름으로 0%부터 시작하는
    // 이상한 상태가 됨). evolvesTo 역추적으로 이 id의 진짜 조상을 따라 올라간다 —
    // "체인 안에서 stage===1인 아무 항목"을 찾으면 안 됨: 부모가 범위 밖이라 안 보이는
    // 형제 종이 여러 마리면(예: 이브이의 자식인 에브이/블래키가 둘 다 범위 밖 부모 밑에서
    // 독립적으로 stage:1이 됨) 서로 다른 종인데 같은 baseFormId로 잘못 묶이는 버그가
    // 실제로 있었음(에브이만 찾아서 블래키한테까지 씌워짐).
    const baseFormId = findBaseFormId(chainMap, id);

    // 5세대(블랙/화이트) 움직이는 픽셀 스프라이트(GIF). 혹시 없는 경우(null)엔
    // 정적 스프라이트로 폴백.
    const animated = pokemon.sprites.versions?.["generation-v"]?.["black-white"]?.animated;

    result[id] = {
      id,
      generation: gen,
      nameKo,
      nameEn: species.name,
      captureRate: species.capture_rate,
      tier: classifyTier(species.capture_rate, species.is_legendary, species.is_mythical),
      stage: chainMap[id]?.stage ?? 1,
      evolvesTo: chainMap[id]?.evolvesTo ?? [],
      maxStage: Math.max(...Object.values(chainMap).map((v) => v.stage)),
      baseFormId,
      sprite: animated?.front_default || pokemon.sprites.front_default,
      spriteShiny: animated?.front_shiny || pokemon.sprites.front_shiny,
    };
  }
  process.stdout.write("\n");
}

async function main() {
  const total = GENERATIONS.reduce((sum, g) => sum + (g.max - g.min + 1), 0);
  console.log(`Building pokedex data — ${GENERATIONS.length} generation(s), ${total} species total...`);
  const chainMapCache = new Map();
  const result = {};

  for (const g of GENERATIONS) {
    await buildGeneration(g, chainMapCache, result);
  }

  console.log("Done. Saving data/pokedex.json...");
  const outPath = path.join(__dirname, "..", "data", "pokedex.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  // Summary
  const tierCounts = { common: 0, uncommon: 0, epic: 0, legendary: 0, mythical: 0 };
  const genCounts = {};
  Object.values(result).forEach((p) => {
    tierCounts[p.tier]++;
    genCounts[p.generation] = (genCounts[p.generation] || 0) + 1;
  });
  console.log("Tier distribution:", tierCounts);
  console.log("Per-generation counts:", genCounts);
  console.log(`Saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
