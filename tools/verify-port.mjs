/**
 * 驗證 web/racewalk-core.js 與 Python 實作逐數值一致。
 *
 * 讀 tools/port-fixtures.json（由 tools/dump-fixtures.py 產生），
 * 用裡面的軌跡跑 JS 管線，比對輸出。
 *
 * 為什麼需要這個：核心演算法有兩份實作，一份給 CLI、一份給網頁版。
 * 兩份各自演化的話，同一段影片在兩邊會給出不同的騰空毫秒數，而使用者
 * 沒有辦法知道該相信哪一個。這個腳本讓分歧立刻暴露出來。
 *
 * 用法：
 *   python3 tools/dump-fixtures.py && node tools/verify-port.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Capability, Events, Features, Screen } from "../web/racewalk-core.js";

const here = dirname(fileURLToPath(import.meta.url));

// 容許的數值差異（毫秒）。兩邊都是 IEEE 754 雙精度、運算順序也刻意寫成一致，
// 所以差異應該落在浮點捨入的量級，不該有實質分歧。
const TOL_MS = 1e-6;

function analyse(caseData) {
  const { fps, tracks } = caseData;
  const left = { foot: "L", y: tracks.left, confidence: tracks.left_conf };
  const right = { foot: "R", y: tracks.right, confidence: tracks.right_conf };

  const detected = [...Events.detect(left, fps), ...Events.detect(right, fps)];
  const contacts = [
    ...Events.toContacts(detected, "L"),
    ...Events.toContacts(detected, "R"),
  ].sort((a, b) => a.startMs - b.startMs);

  const cap = Capability.assess(fps);
  return {
    cap,
    report: Features.buildReport(fps, contacts, cap),
    screen: Screen.run(left, right, fps, { contacts }),
  };
}

let failures = 0;
const fail = (label, msg) => {
  console.error(`  ✗ ${label}: ${msg}`);
  failures += 1;
};

const { cases } = JSON.parse(readFileSync(join(here, "port-fixtures.json"), "utf-8"));

for (const caseData of cases) {
  const label =
    `fps=${caseData.fps} noise=${caseData.noise_px}px` + (caseData.occluded ? " +遮擋" : "");
  const { cap, report, screen } = analyse(caseData);
  const want = caseData.expected;

  if (cap.tier !== want.tier) {
    fail(label, `能力等級 ${cap.tier} ≠ ${want.tier}`);
    continue;
  }
  if (Math.abs(cap.flightUncertaintyMs - want.flight_uncertainty_ms) > TOL_MS) {
    fail(label, `不確定度 ${cap.flightUncertaintyMs} ≠ ${want.flight_uncertainty_ms}`);
  }

  if (report.contacts.length !== want.contacts.length) {
    fail(label, `觸地次數 ${report.contacts.length} ≠ ${want.contacts.length}`);
    continue;
  }

  let worstContact = 0;
  for (let i = 0; i < want.contacts.length; i++) {
    const got = report.contacts[i];
    const exp = want.contacts[i];
    if (got.foot !== exp.foot) {
      fail(label, `第 ${i} 次觸地是 ${got.foot} 腳，應為 ${exp.foot}`);
      break;
    }
    worstContact = Math.max(
      worstContact,
      Math.abs(got.startMs - exp.start_ms),
      Math.abs(got.endMs - exp.end_ms)
    );
  }
  if (worstContact > TOL_MS) {
    fail(label, `觸地時刻最大差異 ${worstContact.toExponential(2)} ms 超過容許值`);
  }

  if (report.flights.length !== want.flights.length) {
    fail(label, `騰空次數 ${report.flights.length} ≠ ${want.flights.length}`);
    continue;
  }

  let worstFlight = 0;
  for (let i = 0; i < want.flights.length; i++) {
    const got = report.flights[i];
    const exp = want.flights[i];
    if (got.verdict !== exp.verdict) {
      fail(label, `第 ${i} 段騰空結論 ${got.verdict} ≠ ${exp.verdict}`);
      break;
    }
    worstFlight = Math.max(
      worstFlight,
      Math.abs(got.startMs - exp.start_ms),
      Math.abs(got.endMs - exp.end_ms)
    );
  }
  if (worstFlight > TOL_MS) {
    fail(label, `騰空時刻最大差異 ${worstFlight.toExponential(2)} ms 超過容許值`);
  }

  const gotCadence = report.cadenceSpm;
  const expCadence = want.cadence_spm;
  if (gotCadence === null || expCadence === null) {
    if (gotCadence !== expCadence) fail(label, `步頻 ${gotCadence} ≠ ${expCadence}`);
  } else if (Math.abs(gotCadence - expCadence) > 1e-9) {
    fail(label, `步頻 ${gotCadence} ≠ ${expCadence}`);
  }

  // 粗篩
  const wantScreen = want.screen;
  if (Math.abs(screen.coverage - wantScreen.coverage) > 1e-9) {
    fail(label, `粗篩覆蓋率 ${screen.coverage} ≠ ${wantScreen.coverage}`);
  }
  if (screen.findings.length !== wantScreen.findings.length) {
    fail(label, `粗篩標記數 ${screen.findings.length} ≠ ${wantScreen.findings.length}`);
    continue;
  }
  let worstScreen = 0;
  for (let i = 0; i < wantScreen.findings.length; i++) {
    const got = screen.findings[i];
    const exp = wantScreen.findings[i];
    if (got.signal !== exp.signal) {
      fail(label, `第 ${i} 個標記類型 ${got.signal} ≠ ${exp.signal}`);
      break;
    }
    worstScreen = Math.max(
      worstScreen,
      Math.abs(got.startMs - exp.start_ms),
      Math.abs(got.endMs - exp.end_ms),
      Math.abs(got.score - exp.score),
      Math.abs(got.quality - exp.quality)
    );
  }
  if (worstScreen > TOL_MS) {
    fail(label, `粗篩最大差異 ${worstScreen.toExponential(2)} 超過容許值`);
  }

  if (!failures) {
    console.log(
      `  ✓ ${label.padEnd(26)} 觸地 ${report.contacts.length}、騰空 ${report.flights.length}、` +
        `粗篩 ${screen.findings.length}、` +
        `最大差異 ${Math.max(worstContact, worstFlight, worstScreen).toExponential(2)}`
    );
  }
}

if (failures) {
  console.error(`\nJS 移植與 Python 實作不一致：${failures} 項差異`);
  process.exit(1);
}

console.log(`\nJS 移植與 Python 實作一致（${cases.length} 組案例）`);
