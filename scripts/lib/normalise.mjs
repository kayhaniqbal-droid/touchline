/**
 * Turn an API-Football lineup into the board's own shape model.
 *
 * The provider gives each player a `grid` of "row:col", counted from the
 * team's own goal — row 1 is the keeper. The board thinks in lines and
 * channels, which is the same idea, so the conversion is mechanical and
 * the existing solver does the rest.
 */

import {
  FORMATIONS,
  teamSpaceToPitch,
  matchToTargets,
} from "../../assets/engine.mjs";

/**
 * Which touchline column 1 sits on.
 *
 * THIS IS THE ONE SETTING THAT WILL SILENTLY MIRROR EVERY BOARD.
 *
 * Settled against a real payload rather than guessed. In API-Football's
 * response for Burnley v Manchester City (fixture 1035037), Kyle Walker —
 * a right-back — is at grid column 4, and Rico Lewis — a left-back — is at
 * column 1. Burnley agree: Connor Roberts at column 5 on the right,
 * Vitinho at column 1 on the left.
 *
 * So for this provider, COLUMN 1 IS THE TEAM'S LEFT. The regression test
 * in test/run.mjs pins it using that saved response.
 */
export const COLUMN_ONE_IS = process.env.TOUCHLINE_COLUMN_ONE || "left";

/** Team-space x for each line, matching the ranges the formations use. */
const LINE_X = [4, 15, 26, 37, 45];
/** Team-space y for each channel. Channel 0 is the team's right. */
const CHANNEL_Y = [88, 66, 50, 34, 12];

/** "R. Sánchez" -> "Sánchez"; "João Pedro" -> "João Pedro". */
export function displayName(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/^(?:[A-ZÀ-Þ]\.\s*)+(.+)$/);
  return (m ? m[1] : s).trim();
}

function parseGrid(grid) {
  if (!grid || typeof grid !== "string" || !grid.includes(":")) return null;
  const [row, col] = grid.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  return { row, col };
}

/**
 * Place provider players on the pitch from their grid alone, ignoring the
 * formation label. Works for any shape, including ones we don't know.
 */
export function gridToPositions(startXI, side) {
  const withGrid = startXI
    .map((e) => ({ ...e, g: parseGrid(e.grid) }))
    .filter((e) => e.g);

  if (withGrid.length !== startXI.length) return null; // incomplete grid data

  const maxRow = Math.max(...withGrid.map((e) => e.g.row));
  const byRow = new Map();
  for (const e of withGrid) {
    if (!byRow.has(e.g.row)) byRow.set(e.g.row, []);
    byRow.get(e.g.row).push(e);
  }

  const out = [];
  for (const [row, group] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    // Sort so index 0 is always the team's RIGHT, whatever the feed does.
    group.sort((a, b) =>
      COLUMN_ONE_IS === "right" ? a.g.col - b.g.col : b.g.col - a.g.col
    );

    // Row 1 is the keeper; spread the remaining rows over lines 1..4.
    const line =
      row === 1
        ? 0
        : maxRow <= 2
          ? 1
          : Math.max(1, Math.min(4, Math.round(1 + ((row - 2) / (maxRow - 2)) * 3)));

    const n = group.length;
    group.forEach((e, i) => {
      const channel = n === 1 ? 2 : Math.round((i / (n - 1)) * 4);
      const p = teamSpaceToPitch(side, LINE_X[line], CHANNEL_Y[channel]);
      out.push({ ...e, line, channel, x: p.x, y: p.y });
    });
  }
  return out;
}

/** Our slot list for a formation, in pitch coordinates for this side. */
function slotsFor(formation, side) {
  const table = FORMATIONS[formation];
  if (!table) return null;
  return table.map((s) => {
    const p = teamSpaceToPitch(side, s[2], s[3]);
    return { pos: s[0], role: s[1], x: p.x, y: p.y };
  });
}

/**
 * @param {object} lineup   one entry from /fixtures/lineups
 * @param {"home"|"away"} side
 * @returns {{formation:string, players:Array, derived:boolean}}
 */
export function normaliseLineup(lineup, side) {
  const startXI = (lineup.startXI || []).map((e) => e.player || e);
  if (startXI.length !== 11) {
    throw new Error(`expected 11 players, got ${startXI.length}`);
  }

  const placed = gridToPositions(startXI, side);
  const declared = lineup.formation && FORMATIONS[lineup.formation] ? lineup.formation : null;

  // Preferred path: place by grid, then let the solver seat them in our slots.
  if (placed && declared) {
    const asPlayers = placed.map((e) => ({
      id: `${side}-${e.id}`,
      providerId: e.id,
      name: displayName(e.name),
      num: Number.isFinite(e.number) ? e.number : null,
      pos: "CM",
      role: "MID",
      x: e.x,
      y: e.y,
      line: e.line,
      channel: e.channel,
    }));
    const targets = slotsFor(declared, side);
    const seated = matchToTargets(asPlayers, targets);
    return {
      formation: declared,
      derived: false,
      players: seated.map((p, i) => ({
        ...p,
        pos: targets[i].pos,
        role: targets[i].role,
        x: targets[i].x,
        y: targets[i].y,
      })),
    };
  }

  // Fallback: no usable formation label, or no grid. Build slots from
  // whatever we do have rather than forcing a shape that doesn't fit.
  if (placed) {
    return {
      formation: lineup.formation || describeShape(placed),
      derived: true,
      players: placed.map((e) => ({
        id: `${side}-${e.id}`,
        providerId: e.id,
        name: displayName(e.name),
        num: Number.isFinite(e.number) ? e.number : null,
        pos: labelFor(e.line, e.channel),
        role: ["GK", "DEF", "MID", "MID", "FWD"][e.line],
        x: e.x,
        y: e.y,
        line: e.line,
        channel: e.channel,
      })),
    };
  }

  // Last resort: positions only, no grid at all. Seat by the shape label.
  const targets = slotsFor(declared || "4-2-3-1", side);
  return {
    formation: declared || "4-2-3-1",
    derived: true,
    players: startXI.map((p, i) => ({
      id: `${side}-${p.id}`,
      providerId: p.id,
      name: displayName(p.name),
      num: Number.isFinite(p.number) ? p.number : null,
      pos: targets[i].pos,
      role: targets[i].role,
      x: targets[i].x,
      y: targets[i].y,
    })),
  };
}

/** "3-4-2-1" from the row occupancy, for shapes we have no label for. */
export function describeShape(placed) {
  const counts = new Map();
  for (const p of placed) {
    if (p.line === 0) continue;
    counts.set(p.line, (counts.get(p.line) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, n]) => n)
    .join("-");
}

const CHANNEL_LABEL = ["R", "RC", "", "LC", "L"];
const LINE_LABEL = ["GK", "B", "DM", "AM", "S"];
function labelFor(line, channel) {
  if (line === 0) return "GK";
  return (CHANNEL_LABEL[channel] + LINE_LABEL[line]).toUpperCase();
}

/** Bench, for substitutions. */
export function normaliseBench(lineup, side) {
  return (lineup.substitutes || []).map((e) => {
    const p = e.player || e;
    return {
      id: `${side}-${p.id}`,
      providerId: p.id,
      name: displayName(p.name),
      num: Number.isFinite(p.number) ? p.number : null,
      pos: p.pos || null,
    };
  });
}
