/**
 * API-Football client with a hard request budget.
 *
 * The free tier allows 100 requests a day. Every call goes through here so
 * the budget file is the single source of truth on what has been spent, and
 * a job refuses to start work it cannot finish rather than dying mid-match.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const BASE = "https://v3.football.api-sports.io";
const BUDGET_FILE = "data/budget.json";

/** Requests we keep in reserve so a live watcher can always finish a half. */
const RESERVE = 8;

export class BudgetExhausted extends Error {}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 1) + "\n");
}

export class Api {
  /**
   * @param {object} opts
   * @param {string} [opts.key]      API-Football key. Absent = offline mode.
   * @param {number} [opts.dailyCap] Requests allowed per day (free tier: 100).
   * @param {string} [opts.fixtureDir] Read canned responses from here instead
   *                                   of the network. Used by the tests.
   */
  constructor({ key, dailyCap = 100, fixtureDir = null } = {}) {
    this.key = key || process.env.API_FOOTBALL_KEY || "";
    this.dailyCap = Number(process.env.API_FOOTBALL_DAILY_CAP || dailyCap);
    this.fixtureDir = fixtureDir;
    this.budget = null;
  }

  get offline() {
    return !this.key && !this.fixtureDir;
  }

  async loadBudget() {
    if (this.budget) return this.budget;
    const saved = await readJson(BUDGET_FILE, null);
    this.budget =
      saved && saved.date === today()
        ? saved
        : { date: today(), used: 0, cap: this.dailyCap };
    this.budget.cap = this.dailyCap;
    return this.budget;
  }

  async remaining() {
    const b = await this.loadBudget();
    return Math.max(0, b.cap - b.used);
  }

  /** Would `n` more requests leave the reserve intact? */
  async canAfford(n, { useReserve = false } = {}) {
    const left = await this.remaining();
    return left - n >= (useReserve ? 0 : RESERVE);
  }

  async saveBudget() {
    if (this.budget) await writeJson(BUDGET_FILE, this.budget);
  }

  async get(path, params = {}, { useReserve = false } = {}) {
    if (this.fixtureDir) return this.#fromFixture(path, params);

    if (!this.key) throw new BudgetExhausted("no API key configured");

    if (!(await this.canAfford(1, { useReserve }))) {
      throw new BudgetExhausted(
        `daily request budget spent (${this.budget.used}/${this.budget.cap})`
      );
    }

    const qs = new URLSearchParams(params).toString();
    const url = `${BASE}${path}${qs ? "?" + qs : ""}`;

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { "x-apisports-key": this.key },
          signal: AbortSignal.timeout(20_000),
        });
        this.budget.used += 1;
        await this.saveBudget();

        if (res.status === 429) throw new BudgetExhausted("provider rate limit");
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

        const body = await res.json();
        // API-Football answers 200 with an `errors` object on bad input.
        if (body.errors && Object.keys(body.errors).length) {
          const msg = JSON.stringify(body.errors);
          if (/limit|plan|subscription/i.test(msg)) throw new BudgetExhausted(msg);
          throw new Error(msg);
        }
        return body.response ?? [];
      } catch (err) {
        if (err instanceof BudgetExhausted) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async #fromFixture(path, params) {
    const slug =
      path.replace(/\//g, "_").replace(/^_/, "") +
      (params.id ? `_${params.id}` : "") +
      (params.date ? `_${params.date}` : "");
    const body = await readJson(`${this.fixtureDir}/${slug}.json`, null);
    if (!body) throw new Error(`no canned response for ${slug}`);
    return body.response ?? [];
  }

  /* ---- endpoints we actually use ---- */

  fixturesByDate(date, league = 39, season = 2026) {
    return this.get("/fixtures", { date, league, season });
  }

  fixture(id) {
    return this.get("/fixtures", { id });
  }

  lineups(fixtureId) {
    return this.get("/fixtures/lineups", { fixture: fixtureId });
  }

  events(fixtureId) {
    return this.get("/fixtures/events", { fixture: fixtureId });
  }
}
