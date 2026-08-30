# Touchline

A football tactics board that fills in its own lineups and reads how a match
is being reshaped while it happens.

Drag any player anywhere. Every fixture of the 2026/27 Premier League season
is in it, animated phases show a team building up, pressing, countering or
sitting in, and once an API key is attached the board updates itself: real
team sheets an hour before kickoff, and a running commentary on substitutions
and shape changes as they occur.

**Infrastructure costs nothing.** GitHub Pages hosts it, GitHub Actions
updates it, and the repo is the database. The one caveat is the data: the
free API tier covers seasons 2022–2024, so following the *current* season
live needs a $19/month plan. Everything else — the board, all 380 fixtures,
and the brain reading real matches from 2022–24 — is free.

---

## Setting it up

Three steps, about ten minutes. The site works from the first push — the API
key only switches on the automatic updates.

### 1. Put it on GitHub

Create a **public** repository (public matters: Actions minutes are free and
unlimited on public repos, metered on private ones), then:

```bash
git remote add origin https://github.com/YOUR-NAME/touchline.git
git branch -M main
git push -u origin main
```

### 2. Turn on Pages

**Settings → Pages → Build and deployment → Deploy from a branch**, then pick
`main` and `/ (root)`. Save.

A minute later the site is live at `https://YOUR-NAME.github.io/touchline/`.
Deploying from the branch rather than an Action matters: it means every data
commit during a match is served immediately, with no rebuild.

At this point you have a working tactics board with all 380 fixtures, using
the lineups each club fielded on the opening weekend. Everything below adds
live data on top.

### 3. Add a free API key

Sign up at **[api-football.com](https://www.api-football.com/)**, then
**Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
| --- | --- |
| `API_FOOTBALL_KEY` | your key |

> **Read this before you rely on it.** The free tier includes lineups,
> benches and live events — genuinely generous — but it only covers
> **seasons 2022 to 2024**. Ask it for a 2026/27 fixture and it answers:
> *"Free plans do not have access to this season, try from 2022 to 2024."*
>
> So on the free tier the current season stays on the projected line-ups
> that ship with the repo, and the automatic updates do nothing. Following
> this season live needs the **$19/month Pro plan**. Nothing else in the
> project costs anything, and nothing else needs changing when you upgrade —
> just raise `API_FOOTBALL_DAILY_CAP` and the sweep starts working.
>
> What the free tier *is* good for is the brain. See below.

---

## The column direction — already settled

This is the setting that silently mirrors every board, and it has been
pinned against a real payload rather than guessed.

In API-Football's response for Burnley v Manchester City (fixture 1035037),
Kyle Walker — a right-back — sits at grid column **4**, and Rico Lewis — a
left-back — at column **1**. Burnley agree: Connor Roberts at column 5 on
the right, Vitinho at column 1 on the left.

**So for this provider, column 1 is the team's LEFT.** That is the default,
and `test/run.mjs` holds a regression test using that saved response, so it
cannot quietly flip back.

If you ever switch provider, re-check it:

```bash
npm run verify:columns                    # our own mapping, no key needed
node scripts/verify-columns.mjs <fixture> # against a match you watched
```

Set the repository variable `TOUCHLINE_COLUMN_ONE` to `right` if the new
provider counts the other way.

---

## Using it

### Lineups arrive on their own

`.github/workflows/lineups.yml` runs a few times a day, finds that day's
fixtures, and asks for each one's team sheet. Confirmed lineups get committed
to `data/live/`. Fixtures already confirmed are skipped, so repeat runs are
cheap.

### Following a match live

Go to **Actions → Watch a match → Run workflow** and give it the fixture id.
It polls every two minutes, diffs each snapshot against the last, and writes
any tactical shift it finds as a board phase you can animate into.

One long-running job rather than a cron every minute — Actions schedules fire
every five minutes at best and are often late, but a single job can run for
six hours, which comfortably covers a match.

### The request budget

The free tier is 100 requests a day, and `data/budget.json` tracks the spend.
A rough matchday:

| Job | Requests |
| --- | ---: |
| Find the day's fixtures | 1 |
| Confirmed lineups across the round | ~30 |
| Following one match, every 2 min | ~60 |
| **Total** | **~91** |

That is why the watcher follows **one match at a time**. It refuses to start
if the day's budget cannot cover a decent chunk of a game, rather than dying
at 70 minutes. If you want all ten fixtures live at once, that is the $19
tier — set `API_FOOTBALL_DAILY_CAP` as a repository variable to raise the cap.

---

## The brain

Two stages, deliberately separated.

**Detection is deterministic.** `scripts/lib/rules.mjs` compares consecutive
snapshots and works out what changed — who came off, who came on, whether the
shape moved, whether anyone was sent off, and what the score was at the time.
It can be wrong about *meaning*, but it cannot invent a substitution that
never happened.

**Substitutions come from the events feed, not the lineups feed.** The
lineups endpoint returns the *starting* eleven and never changes once a
match kicks off, so a watcher that only re-read lineups would never see a
change. `scripts/lib/match-state.mjs` replays events onto the starting
eleven instead. One detail that reads backwards: in an API-Football `subst`
event, `player` is the one going **off** and `assist` is the one coming
**on**.

**Narration only describes what detection found.** Templates by default, which
cost nothing. If you later want a language model writing the sentences, give
it the detected shift — never the raw feed, or it will eventually narrate a
substitution nobody made.

The rules live as data, so you can add one while watching a game:

```js
{
  id: "shut-up-shop",
  when: (c) => c.kind === "sub" && c.outRole === "FWD" &&
               c.inRole === "DEF" && c.minute >= 60 &&
               c.scoreState === "leading",
  weight: 10,
  headline: "{nick} close it out",
  detail: "{out} off, {in} on with {lead} to protect. {shapeChange}"
}
```

### Watching it read a real match — free

The free tier covers 2022–2024 in full, so you can point the brain at any
finished match from those seasons and watch it work on real data. Two
requests per match.

```bash
export API_FOOTBALL_KEY=...
node scripts/replay-real.mjs 1035037        # Burnley v Man City, Aug 2023
node scripts/replay-real.mjs 1035037 --save # keep it as a board
```

```
Burnley 0–3 Manchester City
2023-08-11 · Premier League · Turf Moor
5-4-1 v 4-2-3-1

 23'  Manchester City freshen it up
      Kovačić on for De Bruyne on 23', same job.
 61'  Burnley make a double change
      Bruun Larsen and Zaroury on together for Koleosho and Amdouni.
 79'  Manchester City make a double change
      Laporte and Gvardiol on together for Aké and Lewis.
 94'  Burnley down to ten
      Zaroury sent off on 94'. The shape re-forms as 5-4-1.
```

Or with no key and no network at all:

```bash
npm run replay
```

```
 46'  Fulham change it at the break
      Iwobi and Palacios off, Smith Rowe and Muniz on at the break.
      That is a reset, not a tweak.

 63'  Chelsea close it out
      João Pedro off, Chalobah on with a one-goal lead to protect.
      3-4-2-1 becomes 5-4-1.

 71'  Fulham reshuffle without a change
      Same eleven, different shape — 4-2-3-1 to 4-2-4.

 84'  Chelsea down to ten
      Palmer sent off on 84'. The shape re-forms as 5-3-1.
```

### What it can and cannot see

Detectable from substitutions and shape alone: closing out a lead, chasing a
game, half-time resets, forced reshapes after a red card, and — the subtlest
one — a formation that changes with no substitution at all, meaning the
manager reshuffled without changing personnel.

Not available at this price: pressing intensity, defensive line height,
territory, average positions, pass networks. Those need event or tracking
data from Opta, StatsBomb or Sportradar, which are enterprise contracts.
Don't scrape a site that has them — live match feeds carry database right
(*Football DataCo v Sportradar*), and every major site's terms forbid it.

---

## Working on it locally

```bash
npm run serve      # http://localhost:8080, exactly as Pages serves it
npm test           # 15 checks, no API key required
npm run replay     # run the brain over saved snapshots
npm run replay:real -- <fixtureId>   # over a real 2022-24 match
npm run lineups    # sweep today's fixtures (needs a key)
```

Open it through the server rather than as a file — the page fetches its data
from `data/`, which the browser blocks over `file://`.

```
index.html              the app; works standalone off seeded data
assets/engine.mjs       the tactics engine, shared by browser and scripts
data/squads.json        20 clubs, their elevens, coaches and known shapes
data/calendar.json      all 380 fixtures
data/live/              what the ingest job writes
scripts/lib/api.mjs     provider client + request budget
scripts/lib/normalise.mjs   provider grid -> board slots
scripts/lib/rules.mjs   the brain
```

The formation model is the reason this is small: a slot is a **channel**
(which strip of the pitch, 0 = the team's right) and a **line** (0 keeper,
4 attack), which is the same idea as the row/column grid providers publish.
So a provider lineup drops straight in, and the same solver re-seats a team
after a substitution — which is why a detected tactical shift is just a phase
the board already knows how to animate.

---

## A note on what's on screen

Club names, player names, squad numbers and fixture lists are all fine to
display — they are facts, and fixture lists were settled twice at the CJEU.
Club crests and player photographs are not: they are trade marks and
copyright works, and the UK has no fair use. That is why this uses colour
chips and three-letter codes, which read better on a tactics board anyway.

Keep "Premier League" out of the site's name and domain. Add a footer saying
it is unofficial and unaffiliated. This is research, not legal advice.

---

## Data

Matchweek 1's twenty elevens are the confirmed line-ups, cross-checked across
Sky Sports, WhoScored, ESPN, FotMob and club team news. Every later fixture
starts projected — each club in the personnel and shape it used on the
opening weekend — until the ingest job replaces it with the real thing.
