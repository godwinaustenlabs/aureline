# Aureline documentation

Aureline is built out of **engines**. An engine is a specialist that takes a design brief and returns one artifact. Today there is exactly one, `agent-helios`, which turns a text concept into a black-and-white textile pattern.

Every engine is built the same way, so these docs describe **the engine shape in general** and use Helios as the worked example. When a second engine arrives it will not copy all of this. It adds one file under `docs/engines/` listing only what differs.

## Start here

| Doc | The question it answers |
|---|---|
| [architecture.md](architecture.md) | How does an engine work, and why is it built this way? |
| [spec.md](spec.md) | What is the stack, and which exact object does each job? |
| [database.md](database.md) | How is data stored, in which store, and for how long? |
| [flows.md](flows.md) | What actually happens between a request arriving and a response going out? |
| [directory-structure.md](directory-structure.md) | What is in each file, and why does it exist? |
| [running-locally.md](running-locally.md) | How do I run it, and how do I know it works? |

Read them in that order the first time. After that they are reference and you can jump straight to the one you need.

## The other two kinds of doc here

**[adr/](adr/)** holds the Architecture Decision Records. The docs above tell you what the system does. An ADR tells you **why one decision was made and what was rejected**. When a doc above says "this is done because ADR-0006", that ADR is the full argument. Read them before changing architecture, because `agent-helios` is the template every future engine copies and several of those decisions apply repo-wide rather than to Helios alone.

**[helios-runs-conventions.md](helios-runs-conventions.md)** is for one specific job: writing a query against the `helios_runs` audit table without having built it. What the columns mean, which status combinations are legal, and the traps in the cost column. [database.md](database.md) explains how the table is *designed*; that one explains how to *read* it.

## A note on trust

Every claim in these docs names the file or function it comes from, so you can check it. If a doc and the code disagree, the code is right and the doc is a bug. Please fix it.
