#!/usr/bin/env node
/**
 * Daily lineup sweep.
 *
 * Finds today's Premier League fixtures, asks for each one's lineup, and
 * writes what it gets into data/rounds/. Fixtures whose lineup has already
 * landed are skipped on later runs, so repeat calls are cheap.
 *
 *   node scripts/fetch-lineups.mjs              # today
 *   node scripts/fetch-lineups.mjs 2026-08-29   # a specific date
 *   node scripts/fetch-lineups.mjs --fixtures test/fixtures   # offline
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Api, BudgetExhausted } from "./lib/api.mjs";
import { normaliseLineup, normaliseBench } from "./lib/normalise.mjs";

const args = process.argv.slice(2);
const fixtureDir = args.includes("--fixtures")
  ? args[args.indexOf("--fixtures") + 1]
  : null;
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || isoToday();

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(p, v) {
  await mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  await writeFile(p, JSON.stringify(v, null, 1) + "\n");
}

/** Provider club name -> our three-letter code, via the seeded squads. */
function codeIndex(squads) {
  const idx = new Map();
  for (const [code, club] of Object.entries(squads.clubs)) {
    idx.set(club.team.toLowerCase(), code);
    idx.set(club.nick.toLowerCase(), code);
    idx.set(code.toLowerCase(), code);
  }
  // A few names providers spell differently from us.
  const aliases = {
    "afc bournemouth": "BOU",
    bournemouth: "BOU",
    "brighton & hove albion": "BHA",
    "brighton and hove albion": "BHA",
    "manchester utd": "MUN",
    "man united": "MUN",
    "man city": "MCI",
    "newcastle": "NEW",
    "nottingham forest": "NFO",
    "tottenham": "TOT",
    "leeds": "LEE",
    "hull": "HUL",
    "ipswich": "IPS",
    "coventry": "COV",
    "crystal palace": "CRY",
  };
  for (const [k, v] of Object.entries(aliases)) idx.set(k, v);
  return idx;
}

async function main() {
  const squads = await readJson("data/squads.json");
  if (!squads) throw new Error("data/squads.json missing — run scripts/seed.mjs");
  const codes = codeIndex(squads);

  const api = new Api({ fixtureDir });

  if (api.offline) {
    console.log("No API key set. Nothing to fetch; the site runs on seeded data.");
    console.log("Add API_FOOTBALL_KEY as a repository secret to switch this on.");
    return;
  }

  console.log(`Sweep for ${date}. Budget left: ${await api.remaining()}`);

  let fixtures;
  try {
    fixtures = await api.fixturesByDate(date);
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      console.log(`Stopping: ${err.message}`);
      return;
    }
    throw err;
  }

  if (!fixtures.length) {
    console.log("No Premier League fixtures today.");
    return;
  }
  console.log(`${fixtures.length} fixture(s) today.`);

  const out = (await readJson("data/live/index.json", null)) || { matches: {} };

  for (const f of fixtures) {
    const id = f.fixture.id;
    const existing = await readJson(`data/live/${id}.json`, null);
    if (existing?.lineupsConfirmed) {
      console.log(`  ${id} lineup already confirmed, skipping.`);
      continue;
    }

    if (!(await api.canAfford(1))) {
      console.log("  budget reserve reached, stopping the sweep here.");
      break;
    }

    let lineups = [];
    try {
      lineups = await api.lineups(id);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        console.log(`  stopping: ${err.message}`);
        break;
      }
      console.log(`  ${id} lineup fetch failed: ${err.message}`);
      continue;
    }

    const homeName = f.teams.home.name;
    const record = {
      fixtureId: id,
      kickoff: f.fixture.date,
      status: f.fixture.status?.short || "NS",
      minute: f.fixture.status?.elapsed ?? null,
      goals: { home: f.goals?.home ?? 0, away: f.goals?.away ?? 0 },
      venue: f.fixture.venue?.name || null,
      round: f.league?.round || null,
      lineupsConfirmed: lineups.length === 2,
      fetchedAt: new Date().toISOString(),
      teams: {},
    };

    for (const l of lineups) {
      const side = l.team.name === homeName ? "home" : "away";
      const code = codes.get(l.team.name.toLowerCase()) || null;
      try {
        const n = normaliseLineup(l, side);
        record.teams[side] = {
          code,
          name: l.team.name,
          nick: code ? squads.clubs[code].nick : l.team.name,
          providerId: l.team.id,
          coach: l.coach?.name || (code ? squads.clubs[code].coach : null),
          formation: n.formation,
          derivedShape: n.derived,
          players: n.players,
          bench: normaliseBench(l, side),
        };
      } catch (err) {
        console.log(`  ${id} ${side} lineup unusable: ${err.message}`);
      }
    }

    if (record.lineupsConfirmed && Object.keys(record.teams).length === 2) {
      await writeJson(`data/live/${id}.json`, record);
      out.matches[id] = {
        kickoff: record.kickoff,
        status: record.status,
        home: record.teams.home?.code,
        away: record.teams.away?.code,
        confirmed: true,
      };
      console.log(
        `  ${id} ${record.teams.home.nick} (${record.teams.home.formation}) v ` +
          `${record.teams.away.nick} (${record.teams.away.formation}) — confirmed`
      );
    } else {
      console.log(`  ${id} lineups not published yet.`);
    }
  }

  out.updatedAt = new Date().toISOString();
  await writeJson("data/live/index.json", out);
  await api.saveBudget();
  console.log(`Done. Budget left: ${await api.remaining()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
