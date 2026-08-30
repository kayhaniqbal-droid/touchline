/**
 * The tactical brain.
 *
 * Two stages, deliberately separated:
 *
 *   detectShifts()  — deterministic. Compares two snapshots of a match and
 *                     says what changed. It can be wrong about meaning but
 *                     it cannot invent a substitution that never happened.
 *   narrate()       — templates (free) or, optionally, a language model,
 *                     turning a detected shift into a sentence.
 *
 * Everything the board renders comes out of stage one. Stage two only ever
 * touches wording, so the worst a model can do is phrase a real event badly.
 */

import { FORMATIONS, matchToTargets, teamSpaceToPitch } from "../../assets/engine.mjs";

const ROLE_RANK = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

/* ------------------------------------------------------------------ *
 * Rules. Ordered most specific first; the first match wins.
 * Each `when` is a predicate over a change record.
 * ------------------------------------------------------------------ */

export const RULES = [
  {
    id: "shut-up-shop",
    when: (c) =>
      c.kind === "sub" &&
      c.outRole === "FWD" &&
      c.inRole === "DEF" &&
      c.minute >= 60 &&
      c.scoreState === "leading",
    weight: 10,
    headline: "{nick} close it out",
    detail:
      "{out} off, {in} on with {lead} to protect. {shapeChange}",
  },
  {
    id: "chasing",
    when: (c) =>
      c.kind === "sub" &&
      (c.outRole === "DEF" || c.outRole === "MID") &&
      c.inRole === "FWD" &&
      c.minute >= 55 &&
      c.scoreState === "trailing",
    weight: 10,
    headline: "{nick} go for it",
    detail:
      "{in} on for {out} while chasing the game. {shapeChange}",
  },
  {
    id: "reshape-no-sub",
    when: (c) => c.kind === "shape" && !c.viaSub,
    weight: 9,
    headline: "{nick} reshuffle without a change",
    detail:
      "Same eleven, different shape — {oldShape} to {newShape}. Someone has been told to move.",
  },
  {
    id: "red-card-reshape",
    when: (c) => c.kind === "red",
    weight: 10,
    headline: "{nick} down to ten",
    detail: "{player} sent off on {minute}'. The shape re-forms as {newShape}.",
  },
  {
    id: "halftime-double",
    when: (c) => c.kind === "sub" && c.minute <= 47 && c.simultaneous >= 2,
    weight: 8,
    headline: "{nick} change it at the break",
    detail:
      "{out} off, {in} on at the break. That is a reset, not a tweak. {shapeChange}",
  },
  {
    id: "double-change",
    when: (c) => c.kind === "sub" && c.simultaneous >= 2,
    weight: 6,
    headline: "{nick} make a double change",
    detail: "{in} on together for {out} on {minute}'. {shapeChange}",
  },
  {
    id: "push-wide",
    when: (c) =>
      c.kind === "sub" && c.outChannel != null && c.inChannel != null &&
      Math.abs(c.outChannel - 2) < Math.abs(c.inChannel - 2) &&
      Math.abs(c.inChannel - 2) === 2,
    weight: 5,
    headline: "{nick} go wider",
    detail: "{in} on for {out}, pushing the play out to the touchline. {shapeChange}",
  },
  {
    id: "like-for-like",
    when: (c) => c.kind === "sub" && c.outRole === c.inRole,
    weight: 2,
    headline: "{nick} freshen it up",
    detail: "{in} on for {out} on {minute}', same job. {shapeChange}",
  },
  {
    id: "sub",
    when: (c) => c.kind === "sub",
    weight: 1,
    headline: "{nick} make a change",
    detail: "{in} on for {out} on {minute}'. {shapeChange}",
  },
  {
    id: "shape",
    when: (c) => c.kind === "shape",
    weight: 1,
    headline: "{nick} change shape",
    detail: "{shapeChange}",
  },
];

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

function scoreState(goals, side) {
  const us = side === "home" ? goals.home : goals.away;
  const them = side === "home" ? goals.away : goals.home;
  if (us > them) return "leading";
  if (us < them) return "trailing";
  return "level";
}

/** "Muniz", "Muniz and Smith Rowe", "A, B and C" */
function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/**
 * When several players change at once, the meaningful one is whoever moves
 * furthest from the middle of the pitch — a centre-back arriving says more
 * about intent than a like-for-like winger alongside them.
 */
function dominantRole(players) {
  let best = players[0];
  for (const p of players) {
    const rank = ROLE_RANK[p.role] ?? 2;
    const bestRank = ROLE_RANK[best.role] ?? 2;
    if (Math.abs(rank - 1.5) > Math.abs(bestRank - 1.5)) best = p;
  }
  return best.role;
}

function leadText(goals, side) {
  const us = side === "home" ? goals.home : goals.away;
  const them = side === "home" ? goals.away : goals.home;
  const d = us - them;
  return d === 1 ? "a one-goal lead" : `a ${d}-goal lead`;
}

/**
 * Compare two snapshots of the same fixture and return the tactical
 * changes between them, most significant first.
 *
 * @param {object} prev  previous snapshot ({teams:{home,away}, goals, ...})
 * @param {object} next  current snapshot
 * @returns {Array} shift records, each already carrying its new shape
 */
export function detectShifts(prev, next) {
  const shifts = [];
  if (!prev || !next) return shifts;

  for (const side of ["home", "away"]) {
    const a = prev.teams?.[side];
    const b = next.teams?.[side];
    if (!a || !b) continue;

    const before = new Map((a.players || []).map((p) => [p.providerId, p]));
    const after = new Map((b.players || []).map((p) => [p.providerId, p]));

    const outs = [...before.values()].filter((p) => !after.has(p.providerId));
    const ins = [...after.values()].filter((p) => !before.has(p.providerId));

    const minute = next.minute ?? null;
    const state = scoreState(next.goals || { home: 0, away: 0 }, side);

    // Pair departures with arrivals. Same count is the normal case; a red
    // card leaves an extra departure with nobody replacing them.
    // Changes made at the same moment are ONE event, not one per player —
    // a double change is a single decision and should read as one.
    const pairs = Math.min(outs.length, ins.length);
    if (pairs > 0) {
      const pairedOut = outs.slice(0, pairs);
      const pairedIn = ins.slice(0, pairs);
      shifts.push({
        kind: "sub",
        side,
        team: b.name,
        nick: b.nick || b.name,
        minute,
        out: joinNames(pairedOut.map((p) => p.name)),
        in: joinNames(pairedIn.map((p) => p.name)),
        outList: pairedOut.map((p) => p.name),
        inList: pairedIn.map((p) => p.name),
        // Role tests read the most significant change: the one that moves
        // furthest between lines, which is what actually reshapes a team.
        outRole: dominantRole(pairedOut),
        inRole: dominantRole(pairedIn),
        outChannel: pairedOut[0].channel ?? null,
        inChannel: pairedIn[0].channel ?? null,
        simultaneous: pairs,
        count: pairs,
        oldShape: a.formation,
        newShape: b.formation,
        scoreState: state,
        lead: leadText(next.goals || { home: 0, away: 0 }, side),
        viaSub: true,
      });
    }

    for (let i = pairs; i < outs.length; i++) {
      shifts.push({
        kind: "red",
        side,
        team: b.name,
        nick: b.nick || b.name,
        minute,
        player: outs[i].name,
        oldShape: a.formation,
        newShape: b.formation,
        scoreState: state,
      });
    }

    // A shape change with no personnel change is the interesting one.
    if (a.formation !== b.formation && pairs === 0 && outs.length === 0) {
      shifts.push({
        kind: "shape",
        side,
        team: b.name,
        nick: b.nick || b.name,
        minute,
        oldShape: a.formation,
        newShape: b.formation,
        scoreState: state,
        viaSub: false,
      });
    }
  }

  return shifts;
}

/** Attach the first matching rule to each shift. */
export function classify(shifts) {
  return shifts
    .map((s) => {
      const rule = RULES.find((r) => {
        try {
          return r.when(s);
        } catch {
          return false;
        }
      });
      return rule ? { ...s, ruleId: rule.id, weight: rule.weight, rule } : null;
    })
    .filter(Boolean)
    .sort((x, y) => y.weight - x.weight);
}

/* ------------------------------------------------------------------ *
 * Narration — templates by default, nothing external required.
 * ------------------------------------------------------------------ */

function fill(template, shift) {
  const vars = {
    ...shift,
    // Only speak about shape when it actually moved.
    shapeChange:
      shift.oldShape && shift.newShape && shift.oldShape !== shift.newShape
        ? `${shift.oldShape} becomes ${shift.newShape}.`
        : "",
    plural: shift.count > 1 ? "s" : "",
  };
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] === undefined || vars[k] === null ? "" : String(vars[k])
  );
}

export function narrate(shift) {
  return {
    headline: fill(shift.rule.headline, shift).trim(),
    detail: fill(shift.rule.detail, shift)
      .replace(/\s+/g, " ")
      .replace(/\s+([.,'])/g, "$1")
      .replace(/\.\s*\./g, ".")
      .trim(),
  };
}

/* ------------------------------------------------------------------ *
 * Turning a shift into a board phase
 * ------------------------------------------------------------------ */

/**
 * Re-seat a team in a formation and return board positions. This is the
 * same solver the app uses, so a detected shift lands as a phase the
 * board can animate into with no extra rendering code.
 */
export function phaseFor(shift, snapshot) {
  const side = shift.side;
  const team = snapshot.teams[side];
  const formation = FORMATIONS[team.formation] ? team.formation : null;

  let players = team.players;
  if (formation) {
    const targets = FORMATIONS[formation].map((s) => {
      const p = teamSpaceToPitch(side, s[2], s[3]);
      return { pos: s[0], role: s[1], x: p.x, y: p.y };
    });
    const seated = matchToTargets(players, targets);
    players = seated.map((p, i) => ({
      ...p,
      pos: targets[i].pos,
      role: targets[i].role,
      x: targets[i].x,
      y: targets[i].y,
    }));
  }

  const text = narrate(shift);
  return {
    id: `shift-${shift.side}-${shift.minute}-${shift.ruleId}`,
    minute: shift.minute,
    side,
    name: `${shift.minute ? shift.minute + "' " : ""}${text.headline}`,
    note: text.detail,
    ruleId: shift.ruleId,
    formation: team.formation,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      num: p.num,
      pos: p.pos,
      role: p.role,
      x: p.x,
      y: p.y,
    })),
  };
}

/** Full pass: two snapshots in, board-ready phases out. */
export function readMatch(prev, next) {
  const shifts = classify(detectShifts(prev, next));
  return shifts.map((s) => ({ shift: s, phase: phaseFor(s, next) }));
}
