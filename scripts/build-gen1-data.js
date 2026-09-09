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

// evolution-chain 응답을 순회하며 { speciesId: { stage, evolvesTo: [speciesId,...] } } 로 변환
function flattenChain(node, stage, out) {
  const id = idFromUrl(node.species.url);
  out[id] = out[id] || { stage, evolvesTo: [] };
  out[id].stage = stage;
  for (const next of node.evolves_to) {
    const nextId = idFromUrl(next.species.url);
    out[id].evolvesTo.push(nextId);
    flattenChain(next, stage + 1, out);
  }
  return out;
}

function idFromUrl(url) {
  const parts = url.split("/").filter(Boolean);
  return Number(parts[parts.length - 1]);
}

async function main() {
  console.log(`Gen1 데이터 빌드 시작 (1~${GEN1_COUNT}번)...`);
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
      chainMap = flattenChain(chain.chain, 1, {});
      chainCache.set(chainUrl, chainMap);
    }

    const nameKo =
      species.names.find((n) => n.language.name === "ko")?.name ||
      species.names.find((n) => n.language.name === "en")?.name ||
      species.name;

    result[id] = {
      id,
      nameKo,
      nameEn: species.name,
      captureRate: species.capture_rate,
      tier: tierFromCaptureRate(species.capture_rate),
      stage: chainMap[id]?.stage ?? 1,
      evolvesTo: chainMap[id]?.evolvesTo ?? [],
      maxStage: Math.max(...Object.values(chainMap).map((v) => v.stage)),
      sprite: pokemon.sprites.front_default,
      spriteShiny: pokemon.sprites.front_shiny,
    };
  }

  console.log("\n완료. data/gen1.json 저장 중...");
  const outPath = path.join(__dirname, "..", "data", "gen1.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  // 요약 출력
  const tierCounts = { common: 0, rare: 0, legendary: 0 };
  Object.values(result).forEach((p) => tierCounts[p.tier]++);
  console.log("티어 분포:", tierCounts);
  console.log(`저장 위치: ${outPath}`);
}

main().catch((err) => {
  console.error("빌드 실패:", err);
  process.exit(1);
});
