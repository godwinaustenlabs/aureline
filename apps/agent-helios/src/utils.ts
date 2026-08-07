import { ZodError } from "zod";

/**
 * Renders the first problem in a `ZodError` as one readable line, naming the
 * offending field — Zod's own message omits the path, and its default
 * serialization is a multi-line JSON blob unfit for an API response.
 */
export function firstIssueMessage(zodError: ZodError): string {
	const issue = zodError.issues[0];
	if (!issue) return "invalid input";
	const field = issue.path.join(".");
	return field ? `${field}: ${issue.message}` : issue.message;
}

/** Best-effort one-line description of anything thrown. */
export function describeError(cause: unknown): string {
	if (cause instanceof ZodError) return firstIssueMessage(cause);
	return cause instanceof Error ? cause.message : String(cause);
}
/** Neuron count from a model call's usage data, or null when the provider
 * did not report a real (non-zero) figure for this call shape. A zero is
 * not trustworthy cost data — treat it as absent, not as free. */
export function extractNeuronCost(usage: unknown): number | null {
	const rawNeurons = (usage as { neurons?: number })?.neurons;
	return rawNeurons ? rawNeurons : null;
}
