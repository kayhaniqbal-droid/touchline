#!/usr/bin/env node
/**
 * Run the brain over a real, finished match.
 *
 * API-Football's free tier covers seasons 2022–2024 in full, lineups and
 * events included. So while the current season needs a paid plan, you can
 * point the brain at any match from those seasons and watch it read the
 * substitutions and shape changes exactly as it would live — for nothing.
 *
 * It costs two requests: one for the lineups, one for the events.
 *
 *   node scripts/replay-real.mjs 1035037
 *   node scripts/replay-real.mjs 1035037 --save   # keep it as a board
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { Api } from "./lib/api.mjs";
import { normaliseLineup, normaliseBench } from "./lib/normalise.mjs";
import { applyEvents, changeMinutes } from "./lib/match-state.mjs";
import { readMatch } from "./lib/rules.mjs";

const args = process.argv.slice(2);
const fixtureId = args.find((a) => /^\d+$/.test(a));
const save = args.includes("--save");

if (!fixtureId) {
  console.error("Usage: node scripts/replay-real.mjs <fixtureId> [--save]");
  console.error("Free tier covers seasons 2022–2024.");
  process.exit(1);
}

/**
 * Rebuild the sequence of snapshots a live watcher would have seen, by
 * replaying the event feed against the starting elevens minute by minute.
 */
function buildSnapshots(fixture, lineups, events) {
  const homeName = fixture.teams.home.name;
  const base = {};
  for (const l of lineups) {
    const sideKey = l.team.name === homeName ? "home" : "away";
    const n = normaliseLineup(l, sideKey);
    base[sideKey] = {
      code: null,
      name: l.team.name,
      nick: l.team.name,
      providerId: l.team.id,
      coach: l.coach?.name || null,
      formation: n.formation,
      derivedShape: n.derived,
      players: n.players,
      bench: normaliseBench(l, sideKey),
    };
  }
  if (!base.home || !base.away) throw new Error("both lineups are required");

  const snapshots = [{
    fixtureId: Number(fixtureId),
    minute: 0,
    status: "1H",
    goals: { home: 0, away: 0 },
    lineupsConfirmed: true,
    teams: JSON.parse(JSON.stringify(base)),
  }];

  for (const minute of changeMinutes(events)) {
    const { teams, goals } = applyEvents(base, events, homeName, minute);
    snapshots.push({
      fixtureId: Number(fixtureId),
      minute,
      status: minute > 45 ? "2H" : "1H",
      goals,
      lineupsConfirmed: true,
      teams,
    });
  }

  const last = snapshots[snapshots.length - 1];
  snapshots.push({ ...JSON.parse(JSON.stringify(last)), minute: 90, status: "FT" });
  return snapshots;
}

async function main() {
  const api = new Api({});
  if (api.offline) {
    console.log("No API key set. Export API_FOOTBALL_KEY first.");
    return;
  }

  const [fx] = await api.fixture(fixtureId);
  if (!fx) {
    console.log("Fixture not found. On the free tier, try a match from 2022–2024.");
    return;
  }

  const lineups = await api.lineups(fixtureId);
  if (lineups.length < 2) {
    console.log("No lineups published for that fixture.");
    return;
  }
  const events = await api.events(fixtureId);
  await api.saveBudget();

  const title = `${fx.teams.home.name} ${fx.goals.home}–${fx.goals.away} ${fx.teams.away.name}`;
  console.log(`\n${title}`);
  console.log(`${fx.fixture.date.slice(0, 10)} · ${fx.league.name} · ${fx.fixture.venue?.name || ""}`);
  console.log(`${lineups[0].formation} v ${lineups[1].formation}\n`);

  const snapshots = buildSnapshots(fx, lineups, events);
  console.log(`Reconstructed ${snapshots.length} snapshots from the event feed.\n`);

  const phases = [];
  for (let i = 1; i < snapshots.length; i++) {
    for (const { shift, phase } of readMatch(snapshots[i - 1], snapshots[i])) {
      phases.push(phase);
      console.log(`${String(shift.minute).padStart(3)}'  ${phase.name}`);
      console.log(`      ${phase.note}`);
      console.log(`      [${shift.ruleId}]\n`);
    }
  }
  console.log(`${phases.length} tactical shift(s) read from a real match.`);
  console.log(`Requests left today: ${await api.remaining()}`);

  if (save) {
    await mkdir("data/live", { recursive: true });
    const final = snapshots[snapshots.length - 1];
    await writeFile(`data/live/${fixtureId}.json`, JSON.stringify(final, null, 1) + "\n");
    await writeFile(
      `data/live/${fixtureId}.timeline.json`,
      JSON.stringify({ fixtureId: Number(fixtureId), title, phases, shifts: [] }, null, 1) + "\n"
    );
    const idxPath = "data/live/index.json";
    let idx = { matches: {} };
    try { idx = JSON.parse(await readFile(idxPath, "utf8")); } catch {}
    idx.matches[fixtureId] = {
      kickoff: fx.fixture.date, status: "FT", title,
      home: null, away: null, confirmed: true, historic: true,
    };
    idx.updatedAt = new Date().toISOString();
    await writeFile(idxPath, JSON.stringify(idx, null, 1) + "\n");
    console.log(`\nSaved to data/live/${fixtureId}.*`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
