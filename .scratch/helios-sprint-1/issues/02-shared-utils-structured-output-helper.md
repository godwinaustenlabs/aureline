# 02 — `shared-utils` structured-output helper and Image Helper

**What to build:** A reusable, standalone helper that calls a model and returns schema-validated structured output, retrying on schema drift — usable by every future engine's planner, not just Helios's.

**Blocked by:** 1 - as soon as prompts are available, we can start building this helper.

**Status:** ready-for-human

**Team:** Single-Agent Structure Team

- [x] `packages/shared-utils` exports `getTextualModelOutput(schema, prompt, model)` (or equivalent signature) — **Arham Zahid** (LLM/AI integration)
- [x] Given a JSON schema, a prompt, and a model, it returns output validated against the schema — **Arham Zahid**
- [x] On schema-drift (invalid output), it raises error which will be catched at pipeline — **Arham Zahid**
- [x] `packages/shared-utils` exports `getImageModelOutput(prompt, model)`. — **Hashir Rauf** (LLM/AI integration, single module execution)

```
const response = await env.AI.run(
          "@cf/black-forest-labs/flux-1-schnell",
          input
        );

        const binaryString = atob(response.image as string);
        const img = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));

        return new Response(img, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "no-cache",
          },
        })
;
```