/**
 * scripts/build-gen1-data.js
 *
 * PokéAPI에서 1세대(1~151번) 포켓몬 정보를 fetch해서 data/gen1.json 으로 캐싱한다.
 * - capture_rate → 희귀도 티어 계산 (common / rare / legendary)
 * - evolution_chain → 진화 단계(stage), 다음 진화 종(species id) 매핑
 * - 스프라이트 URL(front_default, front_shiny)
 *
 * 실행: node scripts/build-gen1-data.js
 * (개발 PC에서 1회만 돌리면 됨. 앱 런타임엔 이 캐시 파일만 읽음 — PokéAPI 재호출 없음)
 *
 * 주의: capture_rate 등 실제 수치는 이 스크립트가 PokéAPI에서 직접 가져오는 값이라
 * 정확함. 내가 임의로 하드코딩한 값이 아님 — 그래서 이 방식을 택함.
 */

const fs = require("fs");
const path = require("path");

const POKEAPI = "https://pokeapi.co/api/v2";
const GEN1_COUNT = 151;

// 희귀도 티어 경계값 — 추정/기본값, 튜닝 가능
const TIER_BOUNDS = {
  legendary: 45, // capture_rate <= 45
  rare: 150,     // capture_rate <= 150
  // 그 이상은 common
};

function tierFromCaptureRate(rate) {
  if (rate <= TIER_BOUNDS.legendary) return "legendary";
  if (rate <= TIER_BOUNDS.rare) return "rare";
  return "common";
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  return res.json();
}

// evolution-chain 응답을 순회하며 { speciesId: { stage, evolvesTo: [speciesId,...] } } 로 변환.
// PokéAPI의 evolution-chain은 세대 구분 없이 "그 종이 게임 역사상 진화한 모든 경로"를
// 다 담고 있어서, 1세대 포켓몬이 후속 세대에서 얻은 진화(예: 마그네톤(82)→메탕그(462, 4세대))는
// 물론, 후속 세대에 새로 추가된 "사전 진화체"까지 딸려온다(예: 에레키드(239, 2세대 아기)
// →에레브(125, 1세대)→에레키블(466, 4세대) — 체인의 뿌리 자체가 범위 밖인 경우).
// 그래서 "범위 밖이면 그 서브트리를 통째로 버리는" 방식은 안 되고, 범위 밖 노드는
// 기록만 하지 않되 그 자손은 계속 내려가면서 "범위 안 조상 기준 상대 stage"를 매겨야 한다.
// relativeStage: 지금까지 거쳐온 범위 안 조상 수 기준 단계(범위 안 조상이 아직 없으면 undefined).
function flattenChain(node, out, maxId, relativeStage) {
  const id = idFromUrl(node.species.url);
  const inRange = id >= 1 && id <= maxId;
  const stage = inRange ? relativeStage ?? 1 : relativeStage;

  if (inRange) {
    out[id] = out[id] || { stage, evolvesTo: [] };
    out[id].stage = stage;
  }

  for (const next of node.evolves_to) {
    const nextId = idFromUrl(next.species.url);
    if (inRange && nextId >= 1 && nextId <= maxId) {
      out[id].evolvesTo.push(nextId);
    }
    // 자손은 범위 밖 노드 밑이라도 계속 탐색 — 그 밑에 범위 안 후손(사전 진화체 패턴의
    // 반대, 혹은 더 깊은 세대 추가분 밑에 또 범위 안이 나오는 경우는 없지만 방어적으로)이 있을 수 있음.
    flattenChain(next, out, maxId, inRange ? stage + 1 : relativeStage);
  }
  return out;
}

function idFromUrl(url) {
  const parts = url.split("/").filter(Boolean);
  return Number(parts[parts.length - 1]);
}

async function main() {
  console.log(`Building gen1 data (1-${GEN1_COUNT})...`);
  const chainCache = new Map(); // evolution_chain url -> flattened map
  const result = {};

  for (let id = 1; id <= GEN1_COUNT; id++) {
    process.stdout.write(`\r  ${id}/${GEN1_COUNT}`);

    const species = await fetchJson(`${POKEAPI}/pokemon-species/${id}`);
    const pokemon = await fetchJson(`${POKEAPI}/pokemon/${id}`);

    const chainUrl = species.evolution_chain.url;
    let chainMap = chainCache.get(chainUrl);
    if (!chainMap) {
      const chain = await fetchJson(chainUrl);
      chainMap = flattenChain(chain.chain, {}, GEN1_COUNT, undefined);
      chainCache.set(chainUrl, chainMap);
    }

    const nameKo =
      species.names.find((n) => n.language.name === "ko")?.name ||
      species.names.find((n) => n.language.name === "en")?.name ||
      species.name;

    // 이 체인에서 stage===1인 멤버의 id — "도감에서 이 종(보통 최종형)을 다시 키울 때
    // 어느 기본형부터 시작해야 하는지" 판단에 씀 (안 그러면 최종형 이름으로 0%부터
    // 시작하는 이상한 상태가 됨). 못 찾으면 자기 자신(이미 기본형이거나 단일 형태).
    const baseEntry = Object.entries(chainMap).find(([, v]) => v.stage === 1);
    const baseFormId = baseEntry ? Number(baseEntry[0]) : id;

    result[id] = {
      id,
      nameKo,
      nameEn: species.name,
      captureRate: species.capture_rate,
      tier: tierFromCaptureRate(species.capture_rate),
      stage: chainMap[id]?.stage ?? 1,
      evolvesTo: chainMap[id]?.evolvesTo ?? [],
      maxStage: Math.max(...Object.values(chainMap).map((v) => v.stage)),
      baseFormId,
      sprite: pokemon.sprites.front_default,
      spriteShiny: pokemon.sprites.front_shiny,
    };
  }

  console.log("\nDone. Saving data/gen1.json...");
  const outPath = path.join(__dirname, "..", "data", "gen1.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  // Summary
  const tierCounts = { common: 0, rare: 0, legendary: 0 };
  Object.values(result).forEach((p) => tierCounts[p.tier]++);
  console.log("Tier distribution:", tierCounts);
  console.log(`Saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
