/**
 * The design session id — and why it is not the session id next to it in the UI.
 *
 * Three ids in this system look alike and mean completely different things
 * (AGENTS.md §3). Two of them are typed into this page:
 *
 * - **`session_id`** picks which Durable Object serves the request. A routing
 *   key, nothing more. One session accumulates many runs. `state/sessions.ts`
 *   owns it, and its ids are deliberately readable, because a person types them.
 * - **`design_session_id`** is *the design*, minted once at the start and carried
 *   unchanged through Helios → Iris → Atlas. It is what answers "show me
 *   everything that went into this design". This file owns it.
 *
 * They live in separate modules on purpose. Putting the design id beside the
 * routing ids is how the two start looking interchangeable, which is the exact
 * confusion §3 exists to prevent.
 *
 * A UUID rather than a readable id: this one is stored in every engine's rows
 * and passed between engines, and nobody needs to type it. It is generated per
 * design, not per run — keeping the same one across two generates is what makes
 * them two attempts at one design rather than two unrelated designs.
 */
export function newDesignSessionId(): string {
	return crypto.randomUUID();
}
