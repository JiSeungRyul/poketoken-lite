/**
 * src/boost.js
 *
 * "부스트" 기믹(메가진화/기가맥스/테라스탈 컨셉) 상수 — growth.js/shop.js를
 * 참조만 하는 단방향 의존성(shop.js와 같은 분리 원칙).
 */

const { RARE_CANDY_XP } = require("./shop");
const { HATCH_THRESHOLD } = require("./growth");

// 부스트 게이지 임계치 — HATCH_THRESHOLD의 3배. 다 채우면 자동 완료.
const BOOST_GAUGE_THRESHOLD = HATCH_THRESHOLD * 3;

// 완료 시 모은 양에 곱하는 보너스 배율 — "부스팅 리스크(그동안 진화 멈춤)"의 대가.
const BOOST_BONUS_MULTIPLIER = 1.3;

// 모은 양(×보너스)을 이상한 사탕 개수로 반올림 환전. 포켓몬마다 모으는 양이
// 달라도 전부 같은 단위(사탕 개수)로 합쳐져서 가방엔 항상 "이상한 사탕 N개"라는
// 단일 숫자만 남는다(BACKLOG.md 참고).
function candiesFromBoost(amount) {
  return Math.round((amount * BOOST_BONUS_MULTIPLIER) / RARE_CANDY_XP);
}

module.exports = { BOOST_GAUGE_THRESHOLD, BOOST_BONUS_MULTIPLIER, candiesFromBoost };
