import type { IrisConfig } from "../config";
import { sampleParamsFull } from "../fixtures/sample-params";

/**
 * Textual planner stage: turns a free-text concept into Iris colour
 * parameters.
 *
 * Faked for iris-05. iris-08 replaces this body with a real model call, and
 * keeps this exact signature — it swaps out a function body, not a call site.
 *
 * Returns `unknown` deliberately: the real one calls a model and cannot
 * guarantee the shape. The pipeline's validate stage is what makes it trusted.
 */
export async function planConcept(
	concept: string,
	env: Env,
	config: IrisConfig,
	p_invoc_id: string,
): Promise<unknown> {
	return sampleParamsFull;
}
