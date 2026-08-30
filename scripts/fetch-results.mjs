#!/usr/bin/env node
/**
 * Fill in current-season scores from RapidAPI.
 *
 * API-Football's free tier stops at season 2024, so it cannot tell us what
 * happened this weekend. This one can. It has no lineups — that is what the
 * board still needs a paid plan for — but it keeps the results honest.
 *
 * Costs one request per matchday date, against a 100-per-MONTH free quota.
 *
 *   node scripts/fetch-results.mjs 2        # matchweek 2
 *   node scripts/fetch-results.mjs 2 3 4    # several
 */

import { readFile, writeFile } from "node:fs/promises";
import { Rapid, RapidBudget, codeFor, toApiDate } from "./lib/rapid.mjs";

const rounds = process.argv.slice(2).map(Number).filter(Boolean);

const read = async (p) => JSON.parse(await readFile(p, "utf8"));
const write = (p, v) => writeFile(p, JSON.stringify(v, null, 1) + "\n");

/** "Fri, Aug 28" -> "20260828", using the season's year rollover. */
function dateKey(when) {
  const m = String(when).match(/([A-Z][a-z]{2})\s+(\d{1,2})/);
  if (!m) return null;
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const mi = months[m[1]];
  if (mi === undefined) return null;
  const year = mi <= 4 ? 2027 : 2026; // Jan–May is the back half of the season
  return toApiDate(new Date(Date.UTC(year, mi, Number(m[2]))));
}

async function main() {
  const api = new Rapid({});
  if (api.offline) {
    console.log("No RAPIDAPI_KEY set — skipping results.");
    return;
  }
  const squads = await read("data/squads.json");
  const cal = await read("data/calendar.json");

  const targets = rounds.length
    ? cal.rounds.filter((r) => rounds.includes(r.n))
    : cal.rounds;

  // One request per distinct date, not per match.
  const dates = new Set();
  for (const r of targets) for (const m of r.m) {
    const k = dateKey(m[2]);
    if (k) dates.add(k);
  }
  console.log(`${targets.length} round(s), ${dates.size} date(s) to fetch.`);

  const byPair = new Map();
  for (const d of [...dates].sort()) {
    let matches;
    try {
      matches = await api.matchesOn(d);
    } catch (err) {
      if (err instanceof RapidBudget) { console.log(`stopping: ${err.message}`); break; }
      console.log(`  ${d} failed: ${err.message}`);
      continue;
    }
    let kept = 0;
    for (const m of matches) {
      const h = codeFor(m.home?.name || m.home?.longName, squads);
      const a = codeFor(m.away?.name || m.away?.longName, squads);
      if (!h || !a) continue;
      const finished = m.status?.finished;
      if (!finished) continue;
      byPair.set(`${h}-${a}`, `${m.home.score}–${m.away.score}`);
      kept++;
    }
    console.log(`  ${d}: ${matches.length} PL match(es), ${kept} finished  [quota left ${api.remaining ?? "?"}]`);
  }

  let written = 0;
  for (const r of cal.rounds) {
    for (const m of r.m) {
      const score = byPair.get(`${m[0]}-${m[1]}`);
      if (score && m[3] !== score) { m[3] = score; written++; }
    }
  }

  // A round with every match scored counts as played.
  cal.playedRounds = cal.rounds.filter((r) => r.m.every((m) => m[3])).length;
  cal.resultsUpdatedAt = new Date().toISOString();
  await write("data/calendar.json", cal);
  console.log(`\n${written} score(s) written. Rounds fully played: ${cal.playedRounds}.`);
  console.log(`Requests used: ${api.used}; monthly quota left: ${api.remaining ?? "unknown"}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
