/**
 * src/logParser.js
 *
 * Claude Code가 로컬에 남기는 세션 로그(JSONL)를 읽어 누적 토큰 사용량을 계산한다.
 * Windows 경로: %USERPROFILE%\.claude\projects\**\*.jsonl
 *
 * 스키마 검증 완료 (실제 jsonl 파일 대조):
 * entry.message.usage.{input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens} 필드명은 맞음.
 * 단, 같은 assistant 메시지(message.id 동일)가 thinking/text/tool_use 블록별로
 * 여러 줄에 나뉘어 로깅되면서 동일한 usage가 반복 등장하므로, dedup은 반드시
 * message.id 기준으로 해야 함 (entry.uuid는 줄마다 고유해 dedup 키로 못 씀).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

function getClaudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

// dirents 중 디렉토리만 안전하게 나열 (권한 문제 등으로 readdirSync가 실패해도 죽지 않게)
function safeListDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
}

/**
 * Windows에서 트레이 앱을 띄우되 실제 코딩은 WSL에서 하는 경우를 위해,
 * \\wsl.localhost(또는 구버전 \\wsl$) 밑의 모든 배포판 × 모든 유저 홈을 훑어서
 * .claude/projects가 있는 경로를 전부 찾는다. 배포판/사용자명을 하드코딩하지
 * 않으므로 다른 사람이 클론해서 써도 자기 WSL 환경에 맞게 자동으로 잡힘.
 */
function findWslClaudeProjectDirs() {
  for (const root of ["\\\\wsl.localhost", "\\\\wsl$"]) {
    if (!fs.existsSync(root)) continue;

    const dirs = [];
    for (const distro of safeListDirs(root)) {
      const homeDir = path.join(root, distro.name, "home");
      for (const user of safeListDirs(homeDir)) {
        const projectsDir = path.join(homeDir, user.name, ".claude", "projects");
        if (fs.existsSync(projectsDir)) dirs.push(projectsDir);
      }
    }
    // wsl.localhost와 wsl$는 같은 내용을 가리키는 별칭이라, 먼저 찾은 쪽에서
    // 뭔가 나왔으면 거기서 멈춘다(둘 다 스캔하면 같은 jsonl을 두 번 읽게 됨).
    if (dirs.length > 0) return dirs;
  }
  return [];
}

function getClaudeProjectsDirs() {
  const dirs = [getClaudeProjectsDir()];
  if (process.platform === "win32") {
    dirs.push(...findWslClaudeProjectDirs());
  }
  return dirs;
}

// 디렉토리 재귀 순회하며 .jsonl 파일 목록 수집
function findJsonlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

// 한 줄(JSON) 에서 토큰 사용량 추출 — 추정 구조, 검증 필요
function extractUsage(entry) {
  // 흔히 관찰되는 형태: assistant 메시지 안에 usage 객체
  const usage = entry?.message?.usage;
  if (!usage) return null;

  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;

  return {
    // message.id가 dedup 키여야 함: 같은 assistant 메시지가 thinking/text/tool_use
    // 블록별로 여러 JSONL 줄에 나뉘어 로깅되면서 동일한 usage가 반복 등장한다
    // (entry.uuid는 줄마다 항상 고유해서 그걸 우선하면 dedup이 전혀 동작하지 않음 —
    // 실측 결과 최대 2배 과다 집계됨).
    messageId: entry.message?.id || entry.uuid || null,
    total: input + output + cacheCreate + cacheRead,
    timestamp: entry.timestamp || null,
  };
}

function parseJsonlFile(filePath, seenMessageIds) {
  let fileTotal = 0;
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 손상된 줄은 스킵
    }

    const usage = extractUsage(entry);
    if (!usage) continue;

    // 메시지 id로 중복 제거 (같은 메시지가 여러 로그에 재등장하는 경우 대비)
    if (usage.messageId) {
      if (seenMessageIds.has(usage.messageId)) continue;
      seenMessageIds.add(usage.messageId);
    }

    fileTotal += usage.total;
  }

  return fileTotal;
}

/**
 * 전체 누적 토큰 계산.
 * 1차 MVP는 "전체 누적" 기준으로 성장시킴 (원본처럼 5시간/주간 블록 구분은 안 함).
 */
function getTotalTokens() {
  const seenMessageIds = new Set();
  let total = 0;

  for (const dir of getClaudeProjectsDirs()) {
    const files = findJsonlFiles(dir);
    for (const file of files) {
      try {
        total += parseJsonlFile(file, seenMessageIds);
      } catch (err) {
        console.error(`로그 파싱 실패: ${file}`, err.message);
      }
    }
  }
  return total;
}

module.exports = {
  getTotalTokens,
  getClaudeProjectsDir,
  getClaudeProjectsDirs,
  findJsonlFiles,
  extractUsage,
};
