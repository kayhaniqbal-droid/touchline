#!/usr/bin/env node
/**
 * The one job that keeps everything current.
 *
 * Finds Premier League fixtures in a window, pulls each one's lineups and
 * incidents, replays the incidents onto the starting eleven, runs the brain
 * over the resulting snapshots, and writes it all to data/live/.
 *
 * Three requests per match. With 7,500 a day there is no budget anxiety.
 *
 *   node scripts/sync.mjs                    # yesterday to tomorrow
 *   node scripts/sync.mjs 2026-08-22 2026-08-25
 *   node scripts/sync.mjs --event 209544     # one match
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Bzz, BzzQuota, toStartXI, toEvents, codeFor } from "./lib/bzzoiro.mjs";
import { normaliseLineup } from "./lib/normalise.mjs";
import { applyEvents, changeMinutes } from "./lib/match-state.mjs";
import { readMatch } from "./lib/rules.mjs";

const args = process.argv.slice(2);
const onlyEvent = args.includes("--event") ? args[args.indexOf("--event") + 1] : null;
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const iso = (d) => d.toISOString().slice(0, 10);
const day = 86400000;
const from = dates[0] || iso(new Date(Date.now() - day));
const to = dates[1] || iso(new Date(Date.now() + day));

const read = async (p, f = null) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return f; } };
const write = async (p, v) => {
  await mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  await writeFile(p, JSON.stringify(v, null, 1) + "\n");
};

async function syncOne(api, ev, squads, index) {
  const id = ev.id;
  const homeName = (ev.home_team && ev.home_team.name) || ev.home_team;
  const awayName = (ev.away_team && ev.away_team.name) || ev.away_team;

  const lu = await api.lineups(id);
  if (!lu?.lineups?.home || !lu?.lineups?.away) {
    console.log(`  ${id} ${homeName} v ${awayName} — no lineups yet`);
    return;
  }

  const base = {};
  for (const side of ["home", "away"]) {
    const src = lu.lineups[side];
    const code = codeFor(src.team_name, squads);
    const n = normaliseLineup(
      { team: { name: src.team_name }, formation: src.formation, startXI: toStartXI(src), substitutes: [] },
      side
    );
    base[side] = {
      code, name: src.team_name,
      nick: code ? squads.clubs[code].nick : src.team_name,
      providerId: src.team_id,
      coach: null,
      formation: n.formation,
      derivedShape: n.derived,
      players: n.players,
      bench: [],
    };
  }

  const incidents = await api.incidents(id);
  const events = toEvents(incidents, homeName, awayName);

  // Rebuild the match minute by minute, exactly as a live watcher would see it.
  const snaps = [{
    fixtureId: id, minute: 0, status: "1H", goals: { home: 0, away: 0 },
    lineupsConfirmed: lu.lineup_status === "confirmed", teams: JSON.parse(JSON.stringify(base)),
  }];
  for (const minute of changeMinutes(events)) {
    const { teams, goals } = applyEvents(base, events, homeName, minute);
    snaps.push({
      fixtureId: id, minute, status: minute > 45 ? "2H" : "1H", goals,
      lineupsConfirmed: true, teams,
    });
  }

  const phases = [];
  for (let i = 1; i < snaps.length; i++) {
    for (const { phase } of readMatch(snaps[i - 1], snaps[i])) phases.push(phase);
  }

  const final = snaps[snaps.length - 1];
  final.status = ev.status === "finished" ? "FT" : ev.status || final.status;
  final.minute = ev.current_minute ?? final.minute;
  final.kickoff = ev.event_date;
  final.venue = ev.venue || null;
  final.fetchedAt = new Date().toISOString();
  if (ev.home_score != null) final.goals = { home: ev.home_score, away: ev.away_score };

  await write(`data/live/${id}.json`, final);
  await write(`data/live/${id}.timeline.json`, {
    fixtureId: id,
    title: `${homeName} ${final.goals.home}–${final.goals.away} ${awayName}`,
    lineupStatus: lu.lineup_status,
    phases, shifts: [],
  });

  index.matches[id] = {
    kickoff: ev.event_date, status: final.status,
    home: base.home.code, away: base.away.code,
    confirmed: lu.lineup_status === "confirmed",
  };

  console.log(
    `  ${id} ${base.home.nick} ${final.goals.home}–${final.goals.away} ${base.away.nick}` +
    `  (${base.home.formation} v ${base.away.formation})  ${phases.length} shift(s)  [${lu.lineup_status}]`
  );
}

async function main() {
  const api = new Bzz({});
  if (api.offline) {
    console.log("No BZZOIRO_KEY set. Site stays on shipped data.");
    return;
  }
  const squads = await read("data/squads.json");
  if (!squads) throw new Error("data/squads.json missing");

  let events;
  if (onlyEvent) {
    const e = await api.event(onlyEvent);
    events = [e.results ? e.results[0] : e];
  } else {
    events = await api.events({ from, to });
    console.log(`${from} to ${to}: ${events.length} Premier League fixture(s).`);
  }

  const index = (await read("data/live/index.json", null)) || { matches: {} };

  for (const ev of events) {
    try {
      await syncOne(api, ev, squads, index);
    } catch (err) {
      if (err instanceof BzzQuota) { console.log(`stopping: ${err.message}`); break; }
      console.log(`  ${ev.id} failed: ${err.message}`);
    }
  }

  index.updatedAt = new Date().toISOString();
  await write("data/live/index.json", index);
  console.log(`\n${api.used} request(s) used; ~${api.remaining ?? "?"} left today.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
