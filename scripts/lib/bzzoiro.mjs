/**
 * Bzzoiro Sports Data API client.
 *
 * Probed rather than assumed. Against every alternative tried, this is the
 * one that actually fits:
 *
 *   CURRENT SEASON   yes — 2026/27 Premier League is league_id 1
 *   LINEUPS          yes, with formation and a `lineup_status` of
 *                    "confirmed" or predicted
 *   SUBSTITUTIONS    yes, via /incidents/ with minute, player in and out
 *   CARDS AND GOALS  yes, same feed
 *   BUDGET           7,500 requests a day — 75x API-Football's free tier
 *
 * The one thing it lacks is API-Football's row:col grid; positions come as
 * G/D/M/F only. That is fine: players arrive in team-sheet order, so we
 * seat them into the formation's slots by order and let the solver place
 * them. No mirroring risk, because there are no columns to get backwards.
 */

const BASE = "https://sports.bzzoiro.com";
export const PREMIER_LEAGUE = 1;

export class BzzQuota extends Error {}

export class Bzz {
  constructor({ key } = {}) {
    this.key = key || process.env.BZZOIRO_KEY || "";
    this.used = 0;
    this.remaining = null;
  }

  get offline() {
    return !this.key;
  }

  async get(path) {
    if (!this.key) throw new BzzQuota("no BZZOIRO_KEY configured");
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Token ${this.key}` },
      signal: AbortSignal.timeout(20_000),
    });
    this.used++;

    // ratelimit: "football";r=7494;t=80309
    const rl = res.headers.get("ratelimit");
    const m = rl && rl.match(/r=(\d+)/);
    if (m) this.remaining = Number(m[1]);

    if (res.status === 429) throw new BzzQuota("daily request quota spent");
    if (res.status === 401) throw new BzzQuota("key rejected");
    if (!res.ok) throw new Error(`${res.status} on ${path}`);
    return res.json();
  }

  events({ from, to, leagueId = PREMIER_LEAGUE, limit = 20 }) {
    const q = new URLSearchParams({
      league_id: String(leagueId),
      date_from: from,
      date_to: to,
      limit: String(limit),
    });
    return this.get(`/api/v2/events/?${q}`).then((d) => d.results || []);
  }

  lineups(eventId) {
    return this.get(`/api/v2/events/${eventId}/lineups/`);
  }

  incidents(eventId) {
    return this.get(`/api/v2/events/${eventId}/incidents/`);
  }

  event(eventId) {
    return this.get(`/api/v2/events/${eventId}/`);
  }
}

/* ------------------------------------------------------------------ */

const ROLE_OF = { G: 0, D: 1, M: 2, F: 3 };

/**
 * Convert a Bzzoiro lineup into the entries normaliseLineup() expects.
 *
 * Players arrive in team-sheet order. We keep that order but sort defensively
 * by position first, so a feed that ever returns them jumbled still seats
 * keeper-then-defence-then-midfield-then-attack, matching our slot order.
 */
export function toStartXI(sideLineup) {
  const players = (sideLineup.players || []).slice(0, 11);
  return players
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ra = ROLE_OF[a.p.position] ?? 2;
      const rb = ROLE_OF[b.p.position] ?? 2;
      return ra - rb || a.i - b.i;
    })
    .map(({ p }) => ({
      id: p.id,
      name: p.short_name || p.name,
      number: p.jersey_number ?? null,
      pos: p.position || null,
      grid: null, // no grid in this feed; seat by formation instead
      captain: !!p.captain,
    }));
}

/** Bzzoiro incidents -> the event shape scripts/lib/match-state.mjs applies. */
export function toEvents(incidents, homeTeamName, awayTeamName) {
  const items = incidents?.incidents || incidents?.results || [];
  const out = [];
  for (const i of items) {
    const teamName = i.is_home ? homeTeamName : awayTeamName;
    const minute = (i.minute ?? 0) + (i.added_time ?? 0);
    const t = i.type || i.incident_type;

    if (t === "substitution") {
      out.push({
        type: "subst",
        time: { elapsed: minute, extra: null },
        team: { name: teamName },
        // match-state expects `player` to be the one LEAVING
        player: { id: i.player_out_id, name: i.player_out },
        assist: { id: i.player_in_id, name: i.player_in },
      });
    } else if (t === "card") {
      out.push({
        type: "Card",
        detail: /red/i.test(i.card_type || i.detail || "") ? "Red Card" : "Yellow Card",
        time: { elapsed: minute, extra: null },
        team: { name: teamName },
        player: { id: i.player_id, name: i.player },
      });
    } else if (t === "goal") {
      out.push({
        type: "Goal",
        detail: i.goal_type || "Normal Goal",
        time: { elapsed: minute, extra: null },
        team: { name: teamName },
        player: { id: i.player_id, name: i.player },
      });
    }
  }
  return out.sort((a, b) => a.time.elapsed - b.time.elapsed);
}

/** Their club names to our three-letter codes. */
const ALIASES = {
  "liverpool fc": "LIV", "manchester city": "MCI", "manchester united": "MUN",
  "newcastle united": "NEW", "tottenham hotspur": "TOT", "nottingham forest": "NFO",
  "brighton & hove albion": "BHA", "leeds united": "LEE", "ipswich town": "IPS",
  "hull city": "HUL", "coventry city": "COV", "crystal palace": "CRY",
  "aston villa": "AVL", "west ham united": "WHU", "afc bournemouth": "BOU",
  "bournemouth": "BOU",
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z& ]/g, "").trim();

export function codeFor(name, squads) {
  const n = norm(name);
  if (ALIASES[n]) return ALIASES[n];
  for (const [code, c] of Object.entries(squads.clubs)) {
    if (norm(c.team) === n || norm(c.nick) === n) return code;
  }
  const hits = Object.entries(squads.clubs).filter(
    ([, c]) => n.startsWith(norm(c.nick)) || norm(c.team).startsWith(n)
  );
  return hits.length === 1 ? hits[0][0] : null;
}
