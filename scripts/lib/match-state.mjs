/**
 * Rebuilding the eleven on the pitch at any moment.
 *
 * The lineups endpoint returns the STARTING eleven and does not change once
 * a match kicks off. So a watcher that only re-reads lineups would never see
 * a substitution. The changes live in the events feed, and this applies them
 * to the starting eleven to produce the team as it stands right now.
 *
 * One detail worth writing down, because it is the opposite of what the
 * field names suggest: in an API-Football `subst` event, `player` is the
 * one going OFF and `assist` is the one coming ON. Verified against fixture
 * 1035037, where De Bruyne (player) went off injured on 23' and Kovačić
 * (assist) replaced him.
 */

import { displayName } from "./normalise.mjs";

const RED = /red/i;

/**
 * @param {object} baseTeams  {home,away} as returned by normaliseLineup
 * @param {Array}  events     /fixtures/events response
 * @param {string} homeName   provider's name for the home team
 * @param {number} [upTo]     only apply events up to this minute
 * @returns {{teams:object, goals:{home:number,away:number}, applied:number}}
 */
export function applyEvents(baseTeams, events, homeName, upTo = Infinity) {
  const teams = JSON.parse(JSON.stringify(baseTeams));
  const goals = { home: 0, away: 0 };
  let applied = 0;

  const ordered = (events || [])
    .filter((e) => ["subst", "Card", "Goal"].includes(e.type))
    .map((e) => ({ ...e, m: (e.time?.elapsed ?? 0) + (e.time?.extra ?? 0) }))
    .filter((e) => e.m <= upTo)
    .sort((a, b) => a.m - b.m);

  for (const e of ordered) {
    const side = e.team?.name === homeName ? "home" : "away";
    const team = teams[side];
    if (!team) continue;

    if (e.type === "Goal") {
      // Own goals count for the other side.
      const scoring = /own goal/i.test(e.detail || "")
        ? side === "home" ? "away" : "home"
        : side;
      goals[scoring] += 1;
      continue;
    }

    if (e.type === "Card") {
      if (!RED.test(e.detail || "")) continue;
      const i = team.players.findIndex((p) => p.providerId === e.player?.id);
      if (i >= 0) {
        team.players.splice(i, 1);
        applied++;
      }
      continue;
    }

    if (e.type === "subst") {
      const offId = e.player?.id; // yes: `player` is the one leaving
      const on = e.assist; // and `assist` is the one arriving
      if (!on?.id) continue;
      const i = team.players.findIndex((p) => p.providerId === offId);
      if (i < 0) continue; // already replaced, or never started
      const slot = team.players[i];
      team.players[i] = {
        ...slot,
        id: `${side}-${on.id}`,
        providerId: on.id,
        name: displayName(on.name),
        num: null,
      };
      applied++;
    }
  }

  return { teams, goals, applied };
}

/** Every minute at which something changed, for stepping through a match. */
export function changeMinutes(events) {
  const mins = new Set();
  for (const e of events || []) {
    if (!["subst", "Card", "Goal"].includes(e.type)) continue;
    if (e.type === "Card" && !RED.test(e.detail || "")) continue;
    mins.add((e.time?.elapsed ?? 0) + (e.time?.extra ?? 0));
  }
  return [...mins].sort((a, b) => a - b);
}
