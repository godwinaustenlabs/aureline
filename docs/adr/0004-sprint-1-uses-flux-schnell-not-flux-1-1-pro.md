# Sprint 1 uses Flux Schnell (Cloudflare Workers AI) instead of Flux 1.1 Pro (Replicate) as the image model

The Models & Prompts Research report names Flux 1.1 Pro as the primary image model based on quality, with Flux Schnell as fallback. But Flux 1.1 Pro is only available via Replicate, which has no ongoing free tier — new accounts require prepaid credits (purchased upfront, non-refundable), which isn't something to set up as a Sprint 1 blocker. Flux Schnell is available in-platform via Cloudflare Workers AI, with a documented free testing tier (~15-20 images/day) and no separate vendor/API key.

Decision: Sprint 1's `services/imageGenerator.ts` calls Flux Schnell via Cloudflare Workers AI, not Flux 1.1 Pro. This is a temporary substitution, not a reversal of the model research's quality conclusion — Flux 1.1 Pro remains the intended production-quality primary model and becomes a drop-in swap behind the same image-generator interface once Replicate credits are purchased (a decision independent of this sprint).

Note: Cloudflare acquired Replicate in December 2025. No Cloudflare-specific Replicate pricing/integration existed at the time of this decision, but it's worth re-checking before assuming Flux 1.1 Pro still requires a separate Replicate vendor relationship in future sprints.
