# Export every settled row in the Durable Object before pruning any of it

Ticket 07 built two things that look independent: copying finished runs into D1, and pruning the Durable Object down to a retention limit. They are not independent, and pairing them wrongly loses data permanently.

The first shape we built exported only the current invocation's rows and then pruned the whole DO. That is a data-loss window. Export failures are swallowed on purpose, because an audit copy should not cost a caller the result they already waited for, so a run whose export failed sits in the DO unexported and nobody is told. A later, unrelated invocation then exports its own two rows successfully and prunes the whole DO, and the earlier run is deleted from the DO having never reached D1. It is gone from both stores, and the only trace is a `console.error` from minutes earlier.

**Decision:** export and prune operate over the same set. `exportAndPrune` reads every settled row in the DO via `getSettledRows`, exports all of them, and only then prunes. The invariant is exact and easy to state: pruning only ever runs once everything prunable is confirmed in D1. A run whose export failed earlier is swept up by the next invocation that gets that far, which is also why a failed D1 export needs no recovery route of its own.

Three rules fall out of this and are load-bearing rather than incidental.

**`running` rows are never exported.** One DO serves one session (ADR-0005), so two overlapping invocations can leave a half-written row in the table. `exportRuns` uses `onConflictDoNothing` on the primary key, which makes the first version of a row to reach D1 the version that stays there forever. Exporting a `running` row would freeze null params, a null cost and a null `completed_at` into D1 permanently, and every later correct version would be silently discarded on conflict. `getSettledRows` filters them out for this reason alone.

**Pruning deletes whole runs, never rows, and only fully completed ones.** The unit a retention limit counts is an invocation, not a row, so a run is eligible only when every row it has is `completed`, and it is then deleted entirely. A run with any `running` row belongs to an invocation still in flight and is left alone. Ordering is by the run's newest `created_at`, not by any single row's.

**Failed runs are never pruned.** They are the runs most worth keeping, they are what `POST /resume` reads to recover an invocation, and they are the reason the audit table exists. The accepted cost is that failed rows accumulate without bound in the DO, which is why `pruneCompletedRuns` selects only the three columns its grouping actually reads rather than whole rows: the scan it performs on every request only grows.

Because a failed invocation must remain identifiable, it has to *have* a failed row. An invocation that failed while opening its second row used to leave a single `completed` row behind, which satisfied "every row is completed" and was pruned as though it had succeeded. That is now closed at the source: the image stage always leaves an image row behind, `failed` if it never opened. The retention rules here assume ADR-0001's two-rows-per-invocation invariant holds on failure paths too, and they are wrong wherever it does not.
