/**
 * src/shop.js
 *
 * 상점 가격/효과량 상수 — growth.js(성장 밸런스)와는 관심사를 분리해서 여기 모아둔다.
 * growth.js 상수를 참조만 하고, growth.js는 이 파일을 모른다(단방향 의존성).
 */

const { GRADUATION_TOTAL, HATCH_THRESHOLD, SHINY_DENOMINATOR } = require("./growth");

// 이상한 사탕 — 가방에 보관해뒀다가 원할 때 사용. 사용 시 진행도를 즉시 이만큼
// 앞당긴다(growth.js의 applyRareCandy 참고). 가격은 1:1 — "지금 당겨쓰기"의 대가로
// HATCH_THRESHOLD와 동급인 500만.
const RARE_CANDY_XP = HATCH_THRESHOLD;
const RARE_CANDY_PRICE = HATCH_THRESHOLD;

// 이로치 부적 — 1회성 패시브 구매, 보유하면 이로치 확률이 영구히 2배(분모 절반).
// 고가 럭셔리 아이템이라 가격은 epic 졸업 총량과 동급으로 잡음.
const SHINY_CHARM_PRICE = GRADUATION_TOTAL.epic;
const SHINY_CHARM_DENOMINATOR = Math.round(SHINY_DENOMINATOR / 2);

// 등급 보장 알 — 알 보관함에 바로 적립(즉시 폐기+교체 아님, 기존 eggBox 플로우
// 재사용). 가격은 그 등급 졸업 총량의 일정 비율.
const EGG_PRICE_RATIO = 0.2;

function eggPrice(tier) {
  return Math.round((GRADUATION_TOTAL[tier] ?? GRADUATION_TOTAL.common) * EGG_PRICE_RATIO);
}

module.exports = {
  RARE_CANDY_XP,
  RARE_CANDY_PRICE,
  SHINY_CHARM_PRICE,
  SHINY_CHARM_DENOMINATOR,
  EGG_PRICE_RATIO,
  eggPrice,
};
