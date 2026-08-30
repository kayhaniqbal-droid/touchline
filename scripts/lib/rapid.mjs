/**
 * RapidAPI "free-api-live-football-data" client.
 *
 * What this API is good for and what it is not, established by probing the
 * whole endpoint surface rather than trusting the listing:
 *
 *   IT HAS      fixtures and results by date, including the CURRENT season,
 *               live scores, league metadata, player search, team logos.
 *   IT HAS NOT  lineups, formations, starting elevens, substitutions,
 *               cards or any match events. There is no endpoint for them.
 *
 * So it cannot drive the tactics board, but it can keep the season's
 * scores current — which API-Football's free tier refuses to do, because
 * that tier stops at season 2024.
 *
 * The budget is the catch: the free plan allows 100 requests PER MONTH,
 * not per day. One request covers every match on a given date, so a round
 * costs three or four. Treat each call as expensive.
 */

const HOST = "free-api-live-football-data.p.rapidapi.com";
const PREMIER_LEAGUE = 47;

export class RapidBudget extends Error {}

export class Rapid {
  constructor({ key } = {}) {
    this.key = key || process.env.RAPIDAPI_KEY || "";
    this.used = 0;
    this.remaining = null; // filled from response headers
  }

  get offline() {
    return !this.key;
  }

  async get(path) {
    if (!this.key) throw new RapidBudget("no RAPIDAPI_KEY configured");

    const res = await fetch(`https://${HOST}/${path}`, {
      headers: {
        "x-rapidapi-host": HOST,
        "x-rapidapi-key": this.key,
      },
      signal: AbortSignal.timeout(20_000),
    });

    this.used++;
    const left = res.headers.get("x-ratelimit-requests-remaining");
    if (left !== null) this.remaining = Number(left);

    if (res.status === 429) throw new RapidBudget("monthly request quota spent");
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);

    const body = await res.json();
    if (body.status !== "success") throw new Error(`unexpected: ${JSON.stringify(body).slice(0, 160)}`);
    return body.response;
  }

  /** Every match on a date. One request covers the whole day. */
  async matchesOn(yyyymmdd) {
    const r = await this.get(`football-get-matches-by-date?date=${yyyymmdd}`);
    const all = r?.matches || [];
    return all.filter((m) => m.leagueId === PREMIER_LEAGUE);
  }

  /** Matches in progress right now, across all competitions. */
  async live() {
    const r = await this.get("football-current-live");
    return (r?.live || []).filter((m) => m.leagueId === PREMIER_LEAGUE);
  }
}

/**
 * This provider's club names differ from ours in the usual ways.
 * Anything not listed falls through to a normalised comparison.
 */
const ALIASES = {
  "man city": "MCI",
  "manchester city": "MCI",
  "man united": "MUN",
  "man utd": "MUN",
  "manchester united": "MUN",
  "nottm forest": "NFO",
  "nottingham forest": "NFO",
  "spurs": "TOT",
  "tottenham": "TOT",
  "tottenham hotspur": "TOT",
  "brighton": "BHA",
  "brighton & hove albion": "BHA",
  "bournemouth": "BOU",
  "afc bournemouth": "BOU",
  "newcastle": "NEW",
  "newcastle united": "NEW",
  "leeds": "LEE",
  "leeds united": "LEE",
  "hull": "HUL",
  "hull city": "HUL",
  "ipswich": "IPS",
  "ipswich town": "IPS",
  "coventry": "COV",
  "coventry city": "COV",
  "crystal palace": "CRY",
  "west ham": "WHU",
  "wolves": "WOL",
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").trim();

/** Resolve a provider club name to our three-letter code. */
export function codeFor(name, squads) {
  const n = norm(name);
  if (ALIASES[n]) return ALIASES[n];
  for (const [code, club] of Object.entries(squads.clubs)) {
    if (norm(club.team) === n || norm(club.nick) === n) return code;
  }
  // last resort: unique prefix match
  const hits = Object.entries(squads.clubs).filter(
    ([, c]) => norm(c.team).startsWith(n) || n.startsWith(norm(c.nick))
  );
  return hits.length === 1 ? hits[0][0] : null;
}

/** "2026-08-28T19:00:00.000Z" -> "20260828" */
export function toApiDate(iso) {
  const d = new Date(iso);
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}
