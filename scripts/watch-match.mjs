#!/usr/bin/env node
/**
 * The match watcher.
 *
 * One long-running job rather than a cron every minute: GitHub Actions
 * schedules fire every five minutes at best and are routinely late, but a
 * single job may run for six hours. So this starts once, loops on a sleep,
 * and commits after every poll that changed something.
 *
 * Each poll is diffed against the previous snapshot by the rules engine.
 * Detected shifts are written as board phases, which the app animates into.
 *
 *   node scripts/watch-match.mjs 1234567
 *   node scripts/watch-match.mjs 1234567 --interval 120 --max-minutes 140
 *   node scripts/watch-match.mjs --replay test/fixtures/replay   # offline
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Api, BudgetExhausted } from "./lib/api.mjs";
import { normaliseLineup, normaliseBench } from "./lib/normalise.mjs";
import { applyEvents } from "./lib/match-state.mjs";
import { readMatch } from "./lib/rules.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

const fixtureId = args.find((a) => /^\d+$/.test(a));
const replayDir = flag("replay", null);
const intervalSec = Number(flag("interval", 120));
const maxMinutes = Number(flag("max-minutes", 150));
const commitEach = !args.includes("--no-commit");

const FINISHED = new Set(["FT", "AET", "PEN", "PST", "CANC", "ABD", "AWD", "WO"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function commit(message) {
  if (!commitEach) return;
  try {
    await run("git", ["add", "data"]);
    const { stdout } = await run("git", ["status", "--porcelain", "data"]);
    if (!stdout.trim()) return;
    await run("git", ["commit", "-m", message]);
    await run("git", ["push"]);
    console.log(`   committed: ${message}`);
  } catch (err) {
    console.log(`   commit skipped: ${err.message.split("\n")[0]}`);
  }
}

/**
 * One poll.
 *
 * The lineups endpoint returns the STARTING eleven and never changes once a
 * match begins — so polling it alone would never show a substitution. We
 * fetch the starting elevens once, then poll the fixture and its events and
 * replay those events onto the base to get the team as it stands now.
 *
 * Cost per poll: 2 requests (fixture + events), the same as before.
 */
async function snapshot(api, id, squads, base) {
  const [fx] = await api.fixture(id);
  if (!fx) throw new Error(`fixture ${id} not found`);

  const events = await api.events(id);
  const homeName = fx.teams.home.name;
  const { teams, goals } = applyEvents(base, events, homeName);

  return {
    fixtureId: Number(id),
    kickoff: fx.fixture.date,
    status: fx.fixture.status?.short || "NS",
    minute: fx.fixture.status?.elapsed ?? null,
    // Prefer the provider's own score; fall back to what we counted.
    goals: {
      home: fx.goals?.home ?? goals.home,
      away: fx.goals?.away ?? goals.away,
    },
    venue: fx.fixture.venue?.name || null,
    fetchedAt: new Date().toISOString(),
    lineupsConfirmed: true,
    teams,
  };
}

/** The starting elevens, fetched once. */
async function fetchBase(api, id, squads) {
  const [fx] = await api.fixture(id);
  if (!fx) throw new Error(`fixture ${id} not found`);
  const lineups = await api.lineups(id);
  if (lineups.length < 2) return null;

  const homeName = fx.teams.home.name;
  const base = {};
  for (const l of lineups) {
    const side = l.team.name === homeName ? "home" : "away";
    const code = Object.keys(squads.clubs).find(
      (c) =>
        squads.clubs[c].team.toLowerCase() === l.team.name.toLowerCase() ||
        squads.clubs[c].nick.toLowerCase() === l.team.name.toLowerCase()
    );
    const n = normaliseLineup(l, side);
    base[side] = {
      code: code || null,
      name: l.team.name,
      nick: code ? squads.clubs[code].nick : l.team.name,
      providerId: l.team.id,
      coach: l.coach?.name || null,
      formation: n.formation,
      derivedShape: n.derived,
      players: n.players,
      bench: normaliseBench(l, side),
    };
  }
  return Object.keys(base).length === 2 ? base : null;
}

async function main() {
  const squads = await readJson("data/squads.json");
  if (!squads) throw new Error("data/squads.json missing");

  if (replayDir) return replay(replayDir, squads);

  if (!fixtureId) {
    console.error("Usage: node scripts/watch-match.mjs <fixtureId>");
    process.exit(1);
  }

  const api = new Api({});
  if (api.offline) {
    console.log("No API key set — nothing to watch.");
    return;
  }

  const perPoll = 2; // fixture + lineups
  const polls = Math.floor((maxMinutes * 60) / intervalSec);
  const need = polls * perPoll;
  const left = await api.remaining();

  console.log(`Watching fixture ${fixtureId}`);
  console.log(
    `  every ${intervalSec}s for up to ${maxMinutes} min = ~${need} requests; ${left} left today`
  );

  if (left < perPoll * 4) {
    console.log("  not enough budget left to follow a match. Stopping now.");
    return;
  }
  if (need > left) {
    console.log(
      `  budget is short — will follow until it runs out rather than refusing.`
    );
  }

  console.log("  fetching the starting elevens…");
  let base;
  try {
    base = await fetchBase(api, fixtureId, squads);
  } catch (err) {
    console.log(`  could not read the lineups: ${err.message}`);
    return;
  }
  if (!base) {
    console.log("  lineups not published yet. Try again nearer kickoff.");
    return;
  }
  console.log(`  ${base.home.nick} (${base.home.formation}) v ${base.away.nick} (${base.away.formation})`);

  const path = `data/live/${fixtureId}.json`;
  let prev = await readJson(path, null);
  const timeline = (await readJson(`data/live/${fixtureId}.timeline.json`, null)) || {
    fixtureId: Number(fixtureId),
    phases: [],
    shifts: [],
  };

  const deadline = Date.now() + maxMinutes * 60_000;

  while (Date.now() < deadline) {
    let next;
    try {
      next = await snapshot(api, fixtureId, squads, base);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        console.log(`Stopping: ${err.message}`);
        break;
      }
      console.log(`poll failed: ${err.message}`);
      await sleep(intervalSec * 1000);
      continue;
    }

    const found = prev ? readMatch(prev, next) : [];
    for (const { shift, phase } of found) {
      timeline.shifts.push({
        minute: shift.minute,
        side: shift.side,
        team: shift.team,
        ruleId: shift.ruleId,
        headline: phase.name,
        detail: phase.note,
      });
      timeline.phases.push(phase);
      console.log(`  ${phase.name} — ${phase.note}`);
    }

    await writeJson(path, next);
    if (found.length) {
      timeline.updatedAt = new Date().toISOString();
      await writeJson(`data/live/${fixtureId}.timeline.json`, timeline);
      await commit(`${next.teams.home?.nick} v ${next.teams.away?.nick}: ${found[0].phase.name}`);
    } else if (!prev) {
      await commit(`watching ${fixtureId}`);
    }

    prev = next;
    console.log(
      `  ${next.minute ?? "-"}' ${next.status} ${next.goals.home}-${next.goals.away} ` +
        `(${next.teams.home?.formation} v ${next.teams.away?.formation}) ` +
        `budget ${await api.remaining()}`
    );

    if (FINISHED.has(next.status)) {
      console.log("Match finished.");
      await commit(`full time: ${next.teams.home?.nick} ${next.goals.home}-${next.goals.away} ${next.teams.away?.nick}`);
      break;
    }
    await sleep(intervalSec * 1000);
  }

  await api.saveBudget();
  console.log(`Stopped. Budget left: ${await api.remaining()}`);
}

/** Offline: feed saved snapshots through the brain to check it reads a match. */
async function replay(dir, squads) {
  const manifest = await readJson(`${dir}/manifest.json`);
  console.log(`Replaying ${manifest.name} (${manifest.snapshots.length} snapshots)\n`);
  let prev = null;
  const phases = [];
  for (const file of manifest.snapshots) {
    const next = await readJson(`${dir}/${file}`);
    if (prev) {
      for (const { shift, phase } of readMatch(prev, next)) {
        phases.push(phase);
        console.log(`${String(shift.minute).padStart(3)}'  ${phase.name}`);
        console.log(`      ${phase.note}`);
        console.log(`      rule: ${shift.ruleId}\n`);
      }
    }
    prev = next;
  }
  console.log(`${phases.length} tactical shift(s) detected.`);
  return phases;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
