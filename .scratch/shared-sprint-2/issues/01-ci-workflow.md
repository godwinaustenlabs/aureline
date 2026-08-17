# shared-01: CI workflow

**What to build:** the repo's first GitHub Actions workflow, running four checks on every pull request into `dev-iris`, `dev-atlas` and `dev`. Plus the one prerequisite fix that has to land before the test check means anything.

**Objective:** sprint 1 had no CI at all, and three of its worst incidents were things CI would have caught for free. A hand-resolved lockfile conflict produced invalid JSON and broke `npm install` for the whole team until someone tracked it down; a clean install in CI would have failed on the pull request. Test files sat completely unused for weeks because nobody had installed the test runner; a CI test step would have said so on day one. And the repo drifted into four branch-naming styles and three commit-message styles within a week, because a rule nobody can check automatically is a rule nobody follows.

**Final result:** no pull request can merge into any integration branch without a clean install, a clean typecheck, passing tests, and a commit convention check. None of it costs money, because CI never makes a model call.

**Blocked by:** `dev-iris` and `dev-atlas` existing, which iris-02 creates.

**Status:** ready-for-human.

**Owner:** Saad Naik. **Reviewer:** Maaz Bin Asif and Maaz Ahmad, both, because it gates both squads.

## Read this first

- `docs/sprint-2-3-conventions.md`, the CI section. It names the four checks and the branches. That section is this ticket's specification.
- The root `package.json`. Note `"test": "npm test --workspaces --if-present"` and read the work list below before assuming it does what it looks like it does.
- `docs/directory-structure.md`, which states plainly that there is no `.github/` today, so this is a genuinely new thing rather than an edit.

## Decisions

1. **Four checks, in this order: clean install, typecheck, test, commit convention.** Ordered cheapest-to-most-informative. A broken lockfile should fail in twenty seconds, not after the whole suite has run.
2. **`npm ci`, not `npm install`.** `npm ci` installs strictly from the lockfile and fails if the lockfile and `package.json` disagree. That failure is the entire value of this step, and `npm install` would helpfully fix the disagreement and hide it.
3. **Typechecking runs per workspace, from inside each workspace directory.** Each workspace carries its own TypeScript config, and `apps/agent-helios/tsconfig.json` uses `moduleResolution: node`, which is why typechecking has to run from inside that directory rather than from the root. Do not add a root `tsconfig.base.json` to make this neater; that is a change to how the repo is laid out and is not this ticket's call.
4. **CI never makes a real model call, ever.** No API tokens in the workflow, no Cloudflare credentials, no network access to a model. Any test touching the `AI` binding or the AI Gateway fakes it. Iris's `pipeline.test.ts` uses a fake `AI` binding that throws if called, and that is the pattern.
5. **The commit convention check runs on the PR title, not on every commit in the branch.** Checking every commit means a branch with one typo'd early commit can never merge without a rewrite, and people respond to that by force-pushing over their history. The PR title is what lands on `dev` and is the thing worth enforcing.
6. **The workflow runs on `pull_request`, not on `push`.** The point is to gate a merge, and running on every push to every branch burns minutes for no decision.
7. **Fix the root `test` script first, or the test step is theatre.** See the work list. A green test step that ran nothing is worse than no test step, because it is trusted.

## Work

### The prerequisite

- [ ] Check whether `npm test --workspaces --if-present` actually runs each workspace's tests. Run it from the repo root and count what executes against what exists: `apps/agent-helios` has `"test": "vitest run"`, `packages/shared-utils` has 34 tests across four files, and `apps/frontend` has its own suite. If any workspace's tests do not run, fix the root script so they do. (**Saad Naik**)
- [ ] Confirm the fixed command fails when a test fails, and not just when the runner errors. Break one assertion deliberately, run it from the root, confirm a non-zero exit, then put it back. A script that swallows a workspace's failure is precisely the failure mode this ticket exists to prevent. (**Saad Naik**)

### The workflow

- [ ] Create `.github/workflows/ci.yml`, triggered on `pull_request` targeting `dev`, `dev-iris` and `dev-atlas`. (**Saad Naik**)
- [ ] Pin Node to 24 or newer. The root `package.json`'s `engines` field requires it, because the repository tests use `node:sqlite`. A CI runner on Node 20 fails those tests in a way that looks like a code problem. (**Saad Naik**)
- [ ] Step 1: `npm ci` (decision 2). (**Saad Naik**)
- [ ] Step 2: typecheck. Run `npx tsc --noEmit` from inside each workspace that has a `tsconfig.json` (decision 3). As new engines are added, this list grows, so write it as a loop or a matrix rather than four copy-pasted steps. (**Saad Naik**)
- [ ] Step 3: `npm test` from the root, using the script fixed above. (**Saad Naik**)
- [ ] Step 4: check the PR title against `type(area): what changed`. Allowed `type` values and allowed `area` values both come from `docs/sprint-2-3-conventions.md`: `area` is an engine name (`iris`, `atlas`, `helios`) or a shared area (`ci`, `shared-types`, `shared-utils`, `docs`). Fail with a message that shows the expected format and a real example, not just "invalid". (**Saad Naik**)
- [ ] Add **no** step requiring a secret. Do not add a deploy step. Deploys stay manual, and a deploy step in a PR workflow is how a pull request ends up shipping to production. (**Saad Naik**)
- [ ] Cache `node_modules` or npm's cache directory so the install step stays fast. This is the only performance concern worth having here. (**Saad Naik**)

### Making it actually gate

- [ ] Mark the workflow as a required status check on `dev`, `dev-iris` and `dev-atlas` in the repository settings. Without this, CI runs, goes red, and the merge button still works. This is the step that turns the workflow from information into a gate, and it is the step most likely to be forgotten. (**Saad Naik**)
- [ ] Confirm branch protection on `main` is on, from iris-02. If it is not, do it here. It was the sprint 1 retro's highest-value fix and was never applied. (**Saad Naik**)

### Review gates

- [ ] Open a deliberately broken pull request against `dev-iris` and confirm CI catches it. Do this four times, once per check: a hand-mangled `package-lock.json`, a type error, a failing test, and a badly-titled PR. A CI workflow nobody has watched fail is a workflow nobody knows works. (**Maaz Bin Asif**)
- [ ] Confirm the required-status-check setting is on and the merge button is genuinely blocked when CI is red. (**Maaz Ahmad**)
- [ ] Confirm no secret, token or Cloudflare credential appears anywhere in the workflow file (decision 4). (**Maaz Ahmad**)
- [ ] Confirm the fixed root test script runs every workspace's tests, by counting the test totals in the CI log against what each workspace has locally. (**Maaz Bin Asif**)
- [ ] Nobody approves their own work. (**both managers**)

## Verification without burning budget

**Budget: zero, permanently and by design.** If a CI run ever costs money, that is a bug in the workflow, not a cost to accept.

1. The four deliberate failures above each produce a red CI run naming the right cause.
2. A correct pull request goes green.
3. The CI log's test count matches what `npm test` prints locally from the root.
4. The merge button is blocked on red.

## Two things that will waste your afternoon

**A workflow that runs and is not a required status check does nothing at all.** It goes red, everyone sees the red X, and the pull request merges anyway because nothing stops it. Half the value of this ticket is in the repository settings rather than in the YAML, and it is the half that gets forgotten because it is not in the diff.

**`npm test --workspaces --if-present` exits zero when it runs nothing.** That is what makes the prerequisite fix a prerequisite rather than a nice-to-have. If you wire up CI first and fix the script later, you get several days of green builds that prove nothing, and people will have started trusting them.
