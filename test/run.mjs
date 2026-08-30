#!/usr/bin/env node
/** Everything that can be checked without an API key. */

import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  FORMATIONS,
  FORMATION_KEYS,
  buildPlayers,
  matchToTargets,
  teamSpaceToPitch,
  genericPhases,
  shapePositions,
} from "../assets/engine.mjs";
import { normaliseLineup, gridToPositions, displayName } from "../scripts/lib/normalise.mjs";
import { detectShifts, classify, readMatch } from "../scripts/lib/rules.mjs";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}\n    ${err.message}`);
  }
}

const squads = JSON.parse(await readFile(new URL("../data/squads.json", import.meta.url)));
const calendar = JSON.parse(await readFile(new URL("../data/calendar.json", import.meta.url)));

/* ---- seed data ---- */

test("twenty clubs, each with a valid eleven and shape", () => {
  const codes = Object.keys(squads.clubs);
  assert.equal(codes.length, 20);
  for (const c of codes) {
    const club = squads.clubs[c];
    assert.equal(club.xi.length, 11, `${c} has ${club.xi.length} players`);
    assert.ok(FORMATIONS[club.formation], `${c} unknown shape ${club.formation}`);
    assert.ok(club.coach, `${c} has no coach`);
    for (const [f] of club.shapes) assert.ok(FORMATIONS[f], `${c} unknown alt shape ${f}`);
  }
});

test("calendar is a complete season", () => {
  assert.equal(calendar.rounds.length, 38);
  let total = 0;
  const home = {}, away = {};
  for (const r of calendar.rounds) {
    assert.equal(r.m.length, 10, `round ${r.n} has ${r.m.length} matches`);
    const seen = new Set();
    for (const [h, a] of r.m) {
      assert.ok(!seen.has(h) && !seen.has(a), `round ${r.n}: a club plays twice`);
      seen.add(h); seen.add(a);
      home[h] = (home[h] || 0) + 1;
      away[a] = (away[a] || 0) + 1;
      total++;
    }
    assert.equal(seen.size, 20);
  }
  assert.equal(total, 380);
  for (const c of Object.keys(squads.clubs)) {
    assert.equal(home[c], 19, `${c} has ${home[c]} home games`);
    assert.equal(away[c], 19, `${c} has ${away[c]} away games`);
  }
});

/* ---- the solver ---- */

test("every club can be re-seated into every formation", () => {
  for (const code of Object.keys(squads.clubs)) {
    const club = squads.clubs[code];
    const players = buildPlayers("home", club.formation, club.xi);
    for (const f of FORMATION_KEYS) {
      const targets = FORMATIONS[f].map((s) => {
        const p = teamSpaceToPitch("home", s[2], s[3]);
        return { pos: s[0], role: s[1], x: p.x, y: p.y };
      });
      const seated = matchToTargets(players, targets);
      assert.equal(seated.filter(Boolean).length, 11, `${code} -> ${f}`);
      assert.equal(new Set(seated.map((p) => p.id)).size, 11, `${code} -> ${f} duplicated a player`);
    }
  }
});

test("a keeper is never seated outfield", () => {
  const club = squads.clubs.CHE;
  const players = buildPlayers("away", club.formation, club.xi);
  for (const f of FORMATION_KEYS) {
    const targets = FORMATIONS[f].map((s) => {
      const p = teamSpaceToPitch("away", s[2], s[3]);
      return { pos: s[0], role: s[1], x: p.x, y: p.y };
    });
    const seated = matchToTargets(players, targets);
    const gkSlot = targets.findIndex((t) => t.pos === "GK");
    assert.equal(seated[gkSlot].pos, "GK", `${f} moved the keeper`);
  }
});

test("every generated phase keeps players on the pitch", () => {
  for (const r of calendar.rounds) {
    for (const [h, a, when] of r.m) {
      const fx = {
        venue: squads.clubs[h].venue,
        home: { team: squads.clubs[h].team, nick: squads.clubs[h].nick, formation: squads.clubs[h].formation },
        away: { team: squads.clubs[a].team, nick: squads.clubs[a].nick, formation: squads.clubs[a].formation },
      };
      for (const spec of genericPhases(fx)) {
        for (const side of ["home", "away"]) {
          for (const t of shapePositions(side, spec[side])) {
            assert.ok(t.x >= 0 && t.x <= 100 && t.y >= 0 && t.y <= 100,
              `${h} v ${a} ${spec.name} put someone off the pitch`);
          }
        }
      }
    }
  }
});

/* ---- the normaliser ---- */

test("a provider grid maps right-to-left as channel 0 upward", () => {
  const startXI = [
    { id: 1, name: "K. Eeper", number: 1, grid: "1:1" },
    { id: 2, name: "R. Back", number: 2, grid: "2:1" },
    { id: 3, name: "R. Centre", number: 4, grid: "2:2" },
    { id: 4, name: "L. Centre", number: 5, grid: "2:3" },
    { id: 5, name: "L. Back", number: 3, grid: "2:4" },
    { id: 6, name: "R. Pivot", number: 6, grid: "3:1" },
    { id: 7, name: "L. Pivot", number: 8, grid: "3:2" },
    { id: 8, name: "R. Wing", number: 7, grid: "4:1" },
    { id: 9, name: "T. En", number: 10, grid: "4:2" },
    { id: 10, name: "L. Wing", number: 11, grid: "4:3" },
    { id: 11, name: "S. Triker", number: 9, grid: "5:1" },
  ];
  const placed = gridToPositions(startXI, "home");
  assert.equal(placed.length, 11);
  const back = placed.filter((p) => p.line === 1).sort((a, b) => a.channel - b.channel);
  assert.equal(displayName(back[0].name), "Back");
  assert.equal(back[0].channel, 0);
  assert.equal(placed.find((p) => p.line === 0).channel, 2, "keeper should be central");
});

test("a provider lineup seats into our slots", () => {
  const lineup = {
    team: { id: 49, name: "Chelsea" },
    formation: "3-4-2-1",
    startXI: [
      { player: { id: 1, name: "R. Sánchez", number: 1, grid: "1:1" } },
      { player: { id: 2, name: "J. Acheampong", number: 34, grid: "2:1" } },
      { player: { id: 3, name: "M. Lacroix", number: 5, grid: "2:2" } },
      { player: { id: 4, name: "L. Colwill", number: 6, grid: "2:3" } },
      { player: { id: 5, name: "M. Gusto", number: 27, grid: "3:1" } },
      { player: { id: 6, name: "R. James", number: 24, grid: "3:2" } },
      { player: { id: 7, name: "R. Lavia", number: 45, grid: "3:3" } },
      { player: { id: 8, name: "J. Hato", number: 21, grid: "3:4" } },
      { player: { id: 9, name: "C. Palmer", number: 10, grid: "4:1" } },
      { player: { id: 10, name: "M. Rogers", number: 17, grid: "4:2" } },
      { player: { id: 11, name: "João Pedro", number: 20, grid: "5:1" } },
    ],
    substitutes: [],
  };
  const n = normaliseLineup(lineup, "away");
  assert.equal(n.formation, "3-4-2-1");
  assert.equal(n.players.length, 11);
  assert.equal(n.derived, false);
  const gk = n.players.find((p) => p.pos === "GK");
  assert.equal(gk.name, "Sánchez", "initials should be stripped");
  assert.equal(gk.num, 1);
  assert.equal(new Set(n.players.map((p) => p.providerId)).size, 11);
});

test("an unknown formation falls back to the grid rather than forcing a shape", () => {
  const startXI = Array.from({ length: 11 }, (_, i) => ({
    player: { id: i + 1, name: `P${i}`, number: i + 1,
      grid: `${i === 0 ? 1 : i < 5 ? 2 : i < 8 ? 3 : i < 10 ? 4 : 5}:${i}` },
  }));
  const n = normaliseLineup({ team: { name: "X" }, formation: "4-1-2-1-2", startXI, substitutes: [] }, "home");
  assert.equal(n.players.length, 11);
  assert.equal(n.derived, true, "should be flagged as derived");
});

test("a short lineup is rejected rather than half-rendered", () => {
  assert.throws(() =>
    normaliseLineup({ team: { name: "X" }, formation: "4-4-2", startXI: [], substitutes: [] }, "home")
  );
});

/* ---- the brain ---- */

const snap = (minute, status, goals, teams) => ({
  fixtureId: 1, minute, status, goals, lineupsConfirmed: true, teams,
});
const side = (name, nick, formation, players) => ({ name, nick, formation, players });
const pl = (id, name, role, channel = 2) => ({
  providerId: id, id: `x-${id}`, name, role, pos: role, channel, x: 50, y: 50,
});

test("a double change is one event, not two", () => {
  const before = snap(45, "1H", { home: 0, away: 1 }, {
    home: side("Fulham", "Fulham", "4-2-3-1",
      [pl(1, "A", "MID"), pl(2, "B", "MID"), pl(3, "C", "FWD")]),
  });
  const after = snap(46, "2H", { home: 0, away: 1 }, {
    home: side("Fulham", "Fulham", "4-2-3-1",
      [pl(4, "D", "MID"), pl(5, "E", "FWD"), pl(3, "C", "FWD")]),
  });
  const shifts = detectShifts(before, after);
  assert.equal(shifts.length, 1, `expected one shift, got ${shifts.length}`);
  assert.equal(shifts[0].simultaneous, 2);
  assert.equal(shifts[0].outList.length, 2);
});

test("a striker off for a defender while ahead reads as closing it out", () => {
  const before = snap(60, "2H", { home: 0, away: 1 }, {
    away: side("Chelsea", "Chelsea", "3-4-2-1", [pl(1, "Pedro", "FWD")]),
  });
  const after = snap(63, "2H", { home: 0, away: 1 }, {
    away: side("Chelsea", "Chelsea", "5-4-1", [pl(2, "Chalobah", "DEF")]),
  });
  const [shift] = classify(detectShifts(before, after));
  assert.equal(shift.ruleId, "shut-up-shop");
  assert.match(shift.rule.headline, /close it out/);
});

test("a shape change with no substitution is detected", () => {
  const team = [pl(1, "A", "DEF"), pl(2, "B", "MID")];
  const before = snap(70, "2H", { home: 0, away: 0 }, {
    home: side("Fulham", "Fulham", "4-2-3-1", team),
  });
  const after = snap(71, "2H", { home: 0, away: 0 }, {
    home: side("Fulham", "Fulham", "4-2-4", team),
  });
  const [shift] = classify(detectShifts(before, after));
  assert.equal(shift.ruleId, "reshape-no-sub");
});

test("a player leaving with nobody arriving is a red card", () => {
  const before = snap(83, "2H", { home: 1, away: 1 }, {
    away: side("Chelsea", "Chelsea", "5-4-1", [pl(1, "A", "DEF"), pl(2, "B", "MID")]),
  });
  const after = snap(84, "2H", { home: 1, away: 1 }, {
    away: side("Chelsea", "Chelsea", "5-3-1", [pl(1, "A", "DEF")]),
  });
  const [shift] = classify(detectShifts(before, after));
  assert.equal(shift.ruleId, "red-card-reshape");
  assert.equal(shift.player, "B");
});

test("narration never claims a shape change that did not happen", () => {
  const team = [pl(1, "A", "MID"), pl(2, "B", "MID")];
  const before = snap(60, "2H", { home: 0, away: 0 }, {
    home: side("Fulham", "Fulham", "4-2-3-1", team),
  });
  const after = snap(61, "2H", { home: 0, away: 0 }, {
    home: side("Fulham", "Fulham", "4-2-3-1", [pl(3, "C", "MID"), pl(2, "B", "MID")]),
  });
  const found = readMatch(before, after);
  assert.equal(found.length, 1);
  assert.doesNotMatch(found[0].phase.note, /4-2-3-1 becomes 4-2-3-1/);
  assert.doesNotMatch(found[0].phase.note, /undefined/);
});

test("no snapshot pair ever produces an empty or undefined sentence", () => {
  const combos = [
    ["FWD", "DEF", 70, { home: 0, away: 1 }],
    ["DEF", "FWD", 60, { home: 1, away: 0 }],
    ["MID", "MID", 55, { home: 0, away: 0 }],
    ["GK", "GK", 20, { home: 0, away: 0 }],
  ];
  for (const [outRole, inRole, minute, goals] of combos) {
    const before = snap(minute - 1, "2H", goals, {
      away: side("Chelsea", "Chelsea", "3-4-2-1", [pl(1, "Out", outRole, 0)]),
    });
    const after = snap(minute, "2H", goals, {
      away: side("Chelsea", "Chelsea", "3-4-2-1", [pl(2, "In", inRole, 4)]),
    });
    for (const { phase } of readMatch(before, after)) {
      assert.ok(phase.name.trim().length > 3, `empty headline for ${outRole}->${inRole}`);
      assert.ok(phase.note.trim().length > 3, `empty detail for ${outRole}->${inRole}`);
      assert.doesNotMatch(phase.note, /undefined|null|\{\w+\}/, `unfilled token: ${phase.note}`);
      assert.doesNotMatch(phase.name, /undefined|null|\{\w+\}/);
    }
  }
});

/* ---- report ---- */

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.log("  FAIL " + f + "\n");
process.exit(failures.length ? 1 : 0);
