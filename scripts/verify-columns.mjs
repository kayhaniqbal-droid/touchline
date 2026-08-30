#!/usr/bin/env node
/**
 * Settle the one setting that will silently mirror every board.
 *
 * Providers disagree about whether grid column 1 is the team's left or their
 * right. Guess wrong and right-backs appear on the left, nothing throws, and
 * you notice a week later. This checks the setting against a lineup we know
 * by hand, and tells you which way to set TOUCHLINE_COLUMN_ONE.
 *
 *   node scripts/verify-columns.mjs 1234567       # a real fixture
 *   node scripts/verify-columns.mjs --self-test   # no key needed
 */

import { readFile } from "node:fs/promises";
import { Api } from "./lib/api.mjs";
import { gridToPositions, displayName } from "./lib/normalise.mjs";

const args = process.argv.slice(2);
const fixtureId = args.find((a) => /^\d+$/.test(a));

/**
 * A team sheet written the conventional way — keeper, then the back line
 * from the team's RIGHT to their LEFT. If our channel mapping is correct,
 * the defender we list first must come out in channel 0.
 */
function report(placed, expectFirstDefender) {
  const back = placed.filter((p) => p.line === 1).sort((a, b) => a.channel - b.channel);
  if (!back.length) return { ok: false, why: "no defensive line found" };
  const rightMost = displayName(back[0].name);
  return {
    ok: rightMost.toLowerCase() === expectFirstDefender.toLowerCase(),
    rightMost,
    order: back.map((p) => `${p.channel}:${displayName(p.name)}`).join("  "),
  };
}

async function selfTest() {
  // A synthetic 4-2-3-1 whose grid we control, so the assertion is about
  // our own mapping rather than about any provider.
  const startXI = [
    { id: 1, name: "Keeper", number: 1, grid: "1:1" },
    { id: 2, name: "RightBack", number: 2, grid: "2:1" },
    { id: 3, name: "RightCentre", number: 4, grid: "2:2" },
    { id: 4, name: "LeftCentre", number: 5, grid: "2:3" },
    { id: 5, name: "LeftBack", number: 3, grid: "2:4" },
    { id: 6, name: "RightPivot", number: 6, grid: "3:1" },
    { id: 7, name: "LeftPivot", number: 8, grid: "3:2" },
    { id: 8, name: "RightWing", number: 7, grid: "4:1" },
    { id: 9, name: "Ten", number: 10, grid: "4:2" },
    { id: 10, name: "LeftWing", number: 11, grid: "4:3" },
    { id: 11, name: "Striker", number: 9, grid: "5:1" },
  ];
  const placed = gridToPositions(startXI, "home");
  const r = report(placed, "RightBack");
  console.log("Self-test — a grid where column 1 is the team's right:");
  console.log("  back line by channel:", r.order);
  console.log(
    r.ok
      ? "  PASS: column 1 maps to channel 0 (the team's right)."
      : `  FAIL: expected RightBack in channel 0, got ${r.rightMost}.`
  );
  if (!r.ok) process.exitCode = 1;
  console.log(
    "\nThis proves the mapping is internally consistent. It does NOT prove\n" +
      "the provider agrees. Run this against a real fixture before a matchday:\n" +
      "  node scripts/verify-columns.mjs <fixtureId>"
  );
}

async function againstFixture(id) {
  const api = new Api({});
  if (api.offline) {
    console.log("No API key set. Run with --self-test, or export API_FOOTBALL_KEY.");
    return;
  }
  const lineups = await api.lineups(id);
  if (!lineups.length) {
    console.log("No lineups for that fixture.");
    return;
  }
  for (const l of lineups) {
    const startXI = (l.startXI || []).map((e) => e.player || e);
    const placed = gridToPositions(startXI, "home");
    if (!placed) {
      console.log(`${l.team.name}: no usable grid data.`);
      continue;
    }
    const back = placed.filter((p) => p.line === 1).sort((a, b) => a.channel - b.channel);
    console.log(`\n${l.team.name}  (${l.formation})`);
    console.log("  reading channel 0 -> 4, which should be RIGHT -> LEFT:");
    for (const p of back) {
      console.log(`    ch${p.channel}  ${String(p.number ?? "").padStart(2)} ${displayName(p.name)}`);
    }
  }
  console.log(
    "\nCheck the first name against the actual right-back in that match.\n" +
      "If it is the LEFT-back, set TOUCHLINE_COLUMN_ONE=left as a repository\n" +
      "variable and re-run. Do not guess — every board depends on this."
  );
  await api.saveBudget();
}

(fixtureId ? againstFixture(fixtureId) : selfTest()).catch((e) => {
  console.error(e);
  process.exit(1);
});
