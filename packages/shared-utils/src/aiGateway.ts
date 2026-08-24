/**
 * AI Gateway configuration shared by every model-calling helper in this
 * package. See docs/adr/0006-ai-gateway-for-all-model-calls.md.
 *
 * Cloudflare routes a Workers AI call through a Gateway when `ai.run` is
 * given a third argument of the form `{ gateway: { id, ... } }`. No extra
 * binding is involved — the same `AI` binding is used either way.
 */

/**
 * The subset of Cloudflare's `GatewayOptions` this repo uses.
 * Full platform type: apps/agent-helios/worker-configuration.d.ts (GatewayOptions).
 */
export interface GatewayConfig {
  /**
   * AI Gateway name, from `env.AI_GATEWAY_ID`. An empty or absent id means
   * "no gateway" and the call falls through to direct Workers AI.
   */
  id?: string;
  /** Cache lifetime in seconds. Omitted means no caching. */
  cacheTtl?: number;
  /** Bypass the cache for this call, even if a cacheTtl is configured. */
  skipCache?: boolean;
  /** Override the derived cache key. */
  cacheKey?: string;
  /**
   * Attached to the Gateway log row. Use it to carry the id of the run this
   * call belongs to, so a log entry can be joined back to an audit row
   * (ADR-0001). Iris calls that id `pipeline_id`; Helios still calls it
   * `p_invoc_id` and joins back to `helios_runs`.
   */
  metadata?: Record<string, string | number | boolean | null>;
}

/** The options object forwarded as `ai.run`'s third argument. */
export interface AiRunOptions {
  gateway?: { id: string } & Omit<GatewayConfig, "id">;
}

/** Default cache lifetime for image generations, in seconds. */
export const DEFAULT_IMAGE_CACHE_TTL = 3600;

/**
 * Builds `ai.run`'s third argument from a gateway config.
 *
 * Returns `undefined` when no gateway id is configured, so the call behaves
 * exactly as it did before the Gateway existed. Values in `gateway` win over
 * `defaults`, and keys left undefined are dropped rather than sent as
 * `undefined`.
 */
export function buildAiRunOptions(
  gateway?: GatewayConfig,
  defaults?: Omit<GatewayConfig, "id">
): AiRunOptions | undefined {
  const id = gateway?.id;
  if (!id) {
    return undefined;
  }

  const merged: Omit<GatewayConfig, "id"> = { ...defaults };

  if (gateway.cacheTtl !== undefined) merged.cacheTtl = gateway.cacheTtl;
  if (gateway.skipCache !== undefined) merged.skipCache = gateway.skipCache;
  if (gateway.cacheKey !== undefined) merged.cacheKey = gateway.cacheKey;
  if (gateway.metadata !== undefined) merged.metadata = gateway.metadata;

  for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
    if (merged[key] === undefined) delete merged[key];
  }

  return { gateway: { id, ...merged } };
}
