# The Playground

A guide to `apps/frontend` — what it is, how to run it, and how every part works.

Written to be readable without knowing the codebase. If you have never opened this repo before, start at the top and keep going.

---

## 1. What is it

The Playground is a **debug console** for the Helios pattern engine.

Helios is a Cloudflare Worker that takes a sentence like *"art deco paisley with fine linework"* and gives back a black-and-white textile pattern. Before this page existed, the only way to use it was typing `curl` commands into a terminal and reading raw JSON.

The Playground replaces that. One page where you type a concept, spend the money once, and see **as much of what happened as the engine is capable of telling you**.

It is not a product. Nobody outside the team will ever use it. It exists so that when something breaks, you can see *where*.

### The one thing to understand before anything else

**Every time you press Generate, real money leaves a real Cloudflare account.**

About $0.0029. That is true on your laptop exactly as it is in production — the AI part of the Worker has no offline simulator, so `localhost` bills the same account production does. There is no free practice mode.

This is why the page has a confirm dialog, a running spend counter, and no automatic retries anywhere.

---

## 2. How to run it

Two things need to be running: the **engine** (the backend) and the **page** (the frontend).

You have two choices for the engine.

### Option A — use the deployed engine (easiest)

The engine is already live on the internet. You do not need a Cloudflare account, you do not need to log in, and you do not need to run a second terminal.

```bash
cd apps/frontend
npx vite
```

Open `http://localhost:5173`, and put this in the **API base URL** field:

```
https://agent-helios.aureline.workers.dev
```

Press **Check**. It should say `reachable`.

Money spent this way comes off the **project's** Cloudflare account.

### Option B — run the engine locally

```bash
# terminal 1 — the engine
cd apps/agent-helios
npm run dev            # starts on http://localhost:8787

# terminal 2 — the page
cd apps/frontend
npx vite               # starts on http://localhost:5173
```

Leave the base URL field as `http://localhost:8787`.

Money spent this way comes off **whichever Cloudflare account your `wrangler` is logged into**. Check with `npx wrangler whoami`.

### The port matters

The page **must** run on port 5173. If that port is busy, Vite will refuse to start rather than quietly move to another one — and that is deliberate.

The engine only accepts requests from a short list of approved web addresses, and `localhost:5173` is on it. If the page moved to `localhost:5174`, every single request would be blocked by the browser before it even left your machine. Failing to start is much easier to debug than that.

The list lives in `ALLOWED_ORIGINS` in `apps/agent-helios/wrangler.jsonc`.

---

## 3. The three traps

This engine does three things that are **not** what most APIs do. Each one will produce a bug if you assume the normal behaviour. They shaped the entire design of this page, so they are worth understanding before anything else.

### Trap 1 — a failed run comes back as "success"

Normally, when a web request fails, you get an error code — 404, 500, something red.

Helios does not work that way. If the pipeline runs and *fails halfway through*, you still get **HTTP 200**, the code that means "OK". The real answer is inside the response, in a field called `status`, which will say `"failed"`.

```json
{
  "p_invoc_id": "c6e43fb4-...",
  "status": "failed",          ← the real answer is here
  "params": { ... },
  "image_url": null,
  "error": "image: 5006: ..."
}
```

Why? Because the run genuinely happened. Rows were written, money was spent. Calling that an "error" would be a lie — it was a real run with a bad outcome. The engine only returns a non-200 code when something failed *before* becoming a run at all.

**If the page had checked the HTTP code, every failed run would have rendered as a success with a blank image.** That is the single most likely bug in a page like this, and the architecture is built to make it impossible. More on that in section 6.

### Trap 2 — a refused resume is a third kind of thing

When you ask to re-run something that cannot be re-run, you get **HTTP 409** and a plain English sentence:

> *"this run already has an image, and resuming would generate and charge for a second one"*

This is **not an error and not a run**. Nothing was written, nothing was billed. It is the engine saying "no, and here is why".

So the page has three outcome types, not two:

| | What it means | Did it cost money? |
|---|---|---|
| **A run** | The pipeline ran and settled — well or badly | Yes |
| **A refusal** | The engine declined before starting | No |
| **A transport error** | The request never became a run at all | No |

The sentence in a refusal is written to be shown to a human word-for-word. The page never rewrites it.

### Trap 3 — the "cost" in the response is only half the cost

The response has a field called `cost_usd`. It sounds like the total. It is not.

A run has two halves — the **planner** (an AI that turns your sentence into design parameters) and the **image generator** (which draws the picture). `cost_usd` is only the image half.

A run that actually cost $0.0029 will report `cost_usd: 0.0019`.

So the page never displays that number as a total. It is labelled **"Image cost, as the response reported it"**, and the real total is calculated separately by adding up both halves from the database. See section 7.

---

## 4. The four regions of the page

### 01 — Input

| Field | What it does |
|---|---|
| **Concept** | Your sentence. 1 to 1000 characters. Checked in the browser before sending, so a bad one never costs a round trip |
| **Session id** | Which storage bucket your runs go into. See below — this is more important than it looks |
| **Reference image** | Accepted, previewed, and **thrown away**. It is not wired up yet. It is labelled everywhere |
| **API base URL** | Which engine to talk to. Local or deployed |
| **Generate** | Spends the money. Locked while a run is in flight |

### 02 — Response

What came back. Three possible looks:

- **Green banner** — the run completed. The image appears below, mounted on a grey card.
- **Red banner** — the run failed. The stage that broke is named.
- **Violet banner** — refused. The engine's sentence, verbatim, plus a note that nothing was billed.

Underneath, always: **the raw response body, exactly as it arrived.** Never reformatted, never prettified. This is a debugging tool and the exact bytes are the point.

### 03 — Scratchpad

The whole reason this page exists. Everything the engine recorded about the run:

- The status of each half (planner, image)
- Which stage failed, if one did
- Which AI models were used, and how many tokens
- **Planner cost, image cost, and the real total**
- How long each half took
- The parameters the planner produced
- Where the image file is stored
- Resume lineage, if the run is a retry of another one

It fills in **once**, after the response arrives, from a second (free) request to the engine. There is no live progress bar, because the engine is one single request — nothing exists until everything is done. Faking a step-by-step animation would be inventing information.

**And it names what is missing.** Five things the engine simply does not record — the AI's reasoning, the prompts it built, how many times it retried internally, and which sessions exist — each get a visible row explaining why. An empty box looks like a broken page. A labelled gap looks like what it is: a limit of the engine.

### 04 — Run history

Every run in the current session, newest first: its id, when it happened, the status of both halves, the total cost, and a **Resume** button where one applies.

**The history is short on purpose.** The engine keeps only the newest 5 *completed* runs and deletes older ones every time you run something. Failed runs are never deleted, so those pile up. Everything is kept permanently in a separate database, but there is no way to read that from here.

---

## 5. Session ids

This is the part people get wrong, so it gets its own section.

**A session id is the name of a storage bucket.** Send the same id, land in the same bucket, see the same history. Send a different id, get a completely separate bucket that shares nothing.

Three ways to set it:

1. **Type one.** Any text. It is trimmed and lowercased before sending, so `Test`, `test` and `test ` all reach the same place. The field shows you exactly what will be sent.
2. **Randomise.** Makes a fresh readable id like `test-quiet-harbor-4f2a`. Use this when you want a clean slate — and use it if someone else is testing at the same time, so you do not delete each other's history.
3. **Pick a previous one.** A dropdown of ids this browser has used before.

### Two things that will surprise you

**An empty session id is not "no session".** The engine falls back to a shared bucket literally named `default`. That is a real bucket with real history in it, not a blank slate. The page warns you about this in amber.

**Resume only works inside its own session.** A run id from one session is refused in another. If you change the session while a result is on screen, its Resume button disappears and explains why.

### Why the dropdown is only your browser's history

There is **no way to ask the engine "what sessions exist"**. Storage buckets are found by name, not listed, and no database row records which session it came from. So the dropdown remembers what *this browser* has used, and nothing more. A session id you used on another machine has to be typed in by hand.

This is a limitation, not a design choice. Fixing it would mean adding a column to the database and a new route, which is its own piece of work.

---

## 6. How the code is organised

```
apps/frontend/src/
├── api/
│   ├── client.ts       every network request. Nothing else calls fetch()
│   └── runs.ts         the shape of a database row
├── domain/             pure logic. No React, no network — all unit tested
│   ├── outcome.ts      the three-outcome rule (see below)
│   ├── runView.ts      turns database rows into "runs"
│   ├── scratchpad.ts   builds the scratchpad rows
│   ├── notCaptured.ts  the five "the engine does not record this" rows
│   ├── validate.ts     checks the concept before sending
│   └── format.ts       money, durations, timestamps
├── state/
│   ├── sessions.ts     the session list, saved in the browser
│   ├── settings.ts     the base URL, saved in the browser
│   └── spend.ts        the money counter
├── components/         the visible parts
└── App.tsx             wires it all together
```

### The single most important design decision

Trap 1 — a failure arriving as HTTP 200 — is not defended against by remembering to check the right field. It is made **structurally impossible**.

Every request goes through one function in `api/client.ts`, which returns this:

```ts
type CallOutcome =
  | { kind: 'run';       result: HeliosResult; raw: string }
  | { kind: 'refusal';   reason: string;       raw: string }
  | { kind: 'transport'; message: string;      raw: string };
```

Three possibilities. Notice what is missing: **there is no `success`.** `kind: 'run'` means "a run happened" and says nothing about whether it worked. To find that out you must read `result.status`, because there is nothing else to read.

No component in the entire app ever sees a raw HTTP response. There is no `response.ok` to be tempted by, anywhere.

### Two smaller rules that matter

**The raw body is kept as text.** The client reads the response as a string and keeps that string. It parses a *copy*. If it re-formatted the parsed object instead, the "raw" panel would show something subtly different from what the engine actually sent — different spacing, different key order, and any field this app does not know about silently dropped.

**Nothing bills without a click.** Spending calls exist only inside button handlers. The only request that ever fires automatically is the free, read-only one that loads the history. There is no retry, no polling loop, no timer.

---

## 7. Where the data lives

Four different storage systems, each doing a different job.

| | Think of it as | Holds | How long |
|---|---|---|---|
| **Durable Object** | A private notebook, one per session id | Recent runs for that session | Newest 5 completed |
| **D1** | A spreadsheet / SQL database | The same rows, all sessions | Forever |
| **R2** | A folder of files | The image files (`.jpg`) | Forever |
| **KV** | A settings drawer | Which AI model to use, limits. **No run data** | Until edited |

The Durable Object and D1 hold the **same table**, called `helios_runs`. The Durable Object is the short-term copy for one session; D1 is the permanent archive of everything.

### Every run is two rows

One run writes **two rows** that share an id — one for the planner half, one for the image half.

Here is a real successful run:

| Column | text row | image row |
|---|---|---|
| `pInvocId` | `849778fa…` | `849778fa…` ← same |
| `modality` | `text` | `image` |
| `status` | `completed` | `completed` |
| `plannerParams` | the 8 design params | the same 8 params |
| `imageR2Key` | `null` | `patterns/849778fa….jpg` |
| `costUsd` | `null` | `0.0019008` |
| `createdAt` | 10:55:05 | 10:55:05 |
| `completedAt` | 10:55:05 | 10:55:10 |

Two things worth noticing:

- **`imageR2Key` is the only link to the picture.** The database stores no image data — just that filename. When the page shows an image, the engine looks up that filename in R2 and sends the bytes.
- **`costUsd` being `null` is not the same as zero.** Null means "we could not find out", or "it was never charged". The page always shows `not recorded` for null, never `$0.00`. Printing zero would state a fact nobody has.

This example is a *resume*, which is why the text row cost is null — no planner ran, so nothing was charged for that half.

### The session id is stored nowhere

Look at that table again. There is no session column. The storage bucket is *named* after the session, but nothing inside it records that name.

That is exactly why the session dropdown has to use browser storage, and why nobody can list which sessions exist.

---

## 8. Resume, and why a failed run stays failed

If the planner succeeded but the image failed, the run can be **resumed** — the image half runs again using the parameters already saved. The planner is never called again, which is why it costs $0.0019 instead of $0.0029.

**A resume creates a brand new run.** It gets its own new id, and its own two rows. The original failed run is left exactly as it was, forever.

That surprises people. Surely resuming should *fix* the broken one? No — and deliberately so. That failure record is the evidence. Overwrite it and you lose the only proof that anything went wrong. (In practice this is how a real production bug was found: a run failed, the failure record stayed, and the error message in it pointed straight at a bad configuration value.)

So a failed run **keeps offering Resume** even after one of its resumes succeeded.

### "Attempt 2" on two different runs is not a bug

Resume the same failed run twice and you get two new runs that **both** say `attempt 2`.

That is correct. `attempt` means *how many steps from the original*, not *how many tries*. Two resumes of the same run are siblings, both one step away:

```
c6e43fb4   (the original, image failed)
├── 849778fa   attempt 2
└── 0714644d   attempt 2
```

It would only reach `attempt 3` if you resumed a resume.

To count how many attempts a concept has actually had, the engine uses a different field called `root` — both children carry `root = c6e43fb4`, and counting those is how the limit is enforced.

### Resuming a run that already worked

Each image request is deliberately told **not to reuse a cached result**, so the same parameters produce a *different picture* every time. That means resuming an already-resumed run is a legitimate thing to do — it buys another variation.

So the page does not hide the button. Instead it tells you what you would be buying:

> ⚠ *already resumed 2 times, and this brief already has an image — another resume buys a different variation, not a fix*

The same note appears in the confirm dialog. How many resumes are allowed is capped by the engine; past the cap you get a 409 that says so.

---

## 9. The colour language

The page is deliberately grey. **Colour only ever means something**, and there are exactly six meanings:

| Colour | Meaning | Where you see it |
|---|---|---|
| 🟢 Green | It worked | `completed` chips, success banner |
| 🔴 Red | It failed, or this removes something | `failed` chips, error text, **Forget** |
| 🟡 Amber | **This spends real money** | **Generate**, **Resume**, confirm button, the spend meter |
| 🔵 Blue | This is free | **Check**, **Refresh**, **Randomise**, run ids |
| 🟣 Violet | Refused, billed nothing | the 409 panel |
| ⚪ Grey | Not a state at all | `absent` rows, **Cancel** |

The important pair is **amber against blue**. A blue control can never cost you money. An amber one always does.

A `failed` chip is the only filled-in, high-contrast element on the page. That is on purpose — a failed run is the thing you are here to find.

---

## 10. What costs money and what does not

### Free — use these freely

- Loading the page, switching sessions, **Refresh**, clicking a run id
- The **Check** button
- Viewing an image
- Typing a bad concept (blocked in the browser, never sent)
- **Every** resume refusal — nothing is written, nothing is billed
- Cancelling the confirm dialog
- Running the tests, typechecking, building

### Paid — only these

| Action | Cost |
|---|---|
| Generate | **~$0.0029** — about $0.001 planner + $0.0019 image |
| Resume | **~$0.0019** — image only, planner skipped |

Nothing spends without a confirm dialog naming the amount first.

### Testing cheaply

If you need a *failed* run to test with, you do not have to pay full price. Point the engine's image-model setting at a name that does not exist and the image half fails instantly without being charged — so a run costs about $0.001 instead of $0.0029, and gives you exactly the shapes that are hardest to get right.

```bash
cd apps/agent-helios
npm run kv:put -- image_model "@cf/does/not-exist"     # then restart the engine
npm run config:pull                                     # to undo it
```

**Always use those npm scripts, never a bare `wrangler` command.** Run from the repo root, a bare command finds no configuration, silently changes nothing, and your next request is a full-price success instead of the failure you wanted. This has already cost real money once.

Note this only works against a **local** engine. The deployed engine's settings live in an account you probably cannot edit.

---

## 11. Running the checks

```bash
cd apps/frontend

npx tsc --noEmit      # typecheck
npm test              # 62 tests
npm run build         # production build
```

All three are free and make no network requests.

The tests cover the pure logic in `domain/` — the three-outcome rule, the cost arithmetic, when a run is resumable, the session list — plus one test that renders the whole page without a browser to catch anything obviously broken.

**None of them talk to the real engine.** That is deliberate, but it means a green test suite proves the logic is right, not that the API still behaves the way we think. Point the page at a real engine early and often.

---

## 12. Deploying

```bash
cd apps/frontend
npm run deploy
```

This builds the page and publishes it to `https://frontend.aureline.workers.dev`.

**The name matters.** The engine only accepts requests from approved web addresses, and that exact address is on its list. Deploy under any other name and every request is blocked by a backend nobody thought to change. If the name ever has to move, the engine's list moves with it in the same commit.

---

## 13. When something goes wrong

| What you see | What it usually means |
|---|---|
| Every request fails, nothing in the network tab | The page is not on port 5173, so the engine is refusing it. Check the port |
| "could not reach…" | The engine is not running, or the base URL is wrong. Press **Check** |
| History is empty but you know you ran something | Wrong session id. It is case-insensitive here but the bucket is exact — check the "Sending as" line |
| A run shows `not recorded` for every cost | The engine could not read the cost log. Usually means the account has no AI Gateway set up. The run still worked |
| The page loads but the fonts look wrong | No internet. Fonts load from Google; everything falls back to system fonts |
| A run failed with `5006 … properties not allowed` | An engine configuration problem, not a page problem. Something is sending a setting the AI model does not accept |

---

## 14. Things that are limitations, not bugs

- **The history is short.** Only the newest 5 completed runs survive. Failed runs are kept.
- **You cannot list sessions.** Not from this page and not from anywhere.
- **The reference image does nothing.** It is labelled. It exists so the shape is ready for later.
- **There is no live progress.** The engine is one request; nothing exists until it finishes.
- **There is no login.** Anyone who can reach the engine can spend its money. The approved-addresses list is the only thing standing in the way, which is why it is short and reviewed.
- **You cannot read the permanent database.** Everything is archived in D1 forever, but no route exposes it.

---

## 15. Where to read more

| Doc | Question |
|---|---|
| [../architecture.md](../architecture.md) | How does the engine work internally? |
| [../database.md](../database.md) | How is data stored and for how long? |
| [../helios-runs-conventions.md](../helios-runs-conventions.md) | How do I read the `helios_runs` table? |
| [../running-locally.md](../running-locally.md) | How do I run and verify the engine? |
| [../adr/](../adr/) | Why was a particular decision made? |

The original requirements are in `.scratch/helios-sprint-1/issues/09-minimal-playground.md`.

**If this doc and the code disagree, the code is right and this doc is a bug. Please fix it.**
