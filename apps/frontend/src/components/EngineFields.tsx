import { CoverageSchema, GarmentRegionSchema, GarmentTypeSchema, PatternScaleSchema } from '@aureline/shared-types';
import type { Engine } from '../domain/engines';

/**
 * The inputs that only some engines have.
 *
 * **Every control here renders from the contract's own enum**, never from a
 * hand-written list. A literal array in a component drifts the moment the schema
 * widens, and it drifts silently, because both sides still compile.
 */

export interface EngineFieldValues {
	concept: string;
	motifRef: string;
	patternRef: string;
	garmentRef: string;
	designSessionId: string;
	garmentType: string;
	regions: string[];
	coverage: string;
	patternScale: string;
}

interface Props {
	engine: Engine;
	values: EngineFieldValues;
	onChange: <K extends keyof EngineFieldValues>(key: K, value: EngineFieldValues[K]) => void;
	/** Offered when a run from the engine upstream is on screen, so the chain can
	 *  be walked without copying ids by hand. */
	onCopyFromUpstream: (() => void) | null;
	/** Fields that were auto-populated from the previous engine's output. */
	autoFilled?: Partial<Record<keyof EngineFieldValues, boolean>>;
}

/**
 * Which regions each garment actually has.
 *
 * **Restated from `apps/agent-atlas/src/prompts/garment.glossary.ts`**, whose
 * `validRegions` is the source of truth. It is not importable — it lives inside
 * a worker app, not a shared package — so it is duplicated here in exactly one
 * place rather than scattered across components. If the glossary changes, change
 * this with it; the worker refuses an impossible combination either way, before
 * anything bills.
 */
const VALID_REGIONS: Record<string, readonly string[]> = {
	tshirt: ['front', 'back', 'neck', 'hem', 'sleeve'],
	kurta: ['front', 'back', 'neck', 'hem', 'sleeve'],
	// A scarf is a flat rectangle: no neck opening, no sleeve.
	scarf: ['front', 'back', 'hem'],
	hoodie: ['front', 'back', 'neck', 'hem', 'sleeve'],
	// Sleeveless by construction.
	dress: ['front', 'back', 'neck', 'hem'],
};

function FieldLabel({ label, autoFilled }: { label: string; autoFilled?: boolean }) {
	return (
		<label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
			{label}
			{autoFilled && (
				<span className="auto-filled-badge" title="Auto-filled from previous engine">
					✦ auto
				</span>
			)}
		</label>
	);
}

export function EngineFields({ engine, values, onChange, onCopyFromUpstream, autoFilled = {} }: Props) {
	if (engine === 'helios') return null;

	const available = VALID_REGIONS[values.garmentType] ?? [];

	function toggleRegion(region: string) {
		const next = values.regions.includes(region)
			? values.regions.filter((it) => it !== region)
			: [...values.regions, region];
		onChange('regions', next);
	}

	function changeGarment(garmentType: string) {
		onChange('garmentType', garmentType);
		// Changing the garment must clear a region it does not have, rather than
		// silently submitting one the worker will refuse.
		const nowValid = VALID_REGIONS[garmentType] ?? [];
		onChange(
			'regions',
			values.regions.filter((region) => nowValid.includes(region)),
		);
	}

	return (
		<>
			{onCopyFromUpstream && (
				<div className="field">
					<button className="small" onClick={onCopyFromUpstream}>
						Copy from the {engine === 'iris' ? 'Helios' : 'Iris'} run on screen
					</button>
					<span className="hint">
						There is no coordinator engine yet, so a person carries the reference and the design id forward at every hop. This does
						that copy for you.
					</span>
				</div>
			)}

			{engine === 'iris' && (
				<div className="field">
					<FieldLabel label="Motif image reference" autoFilled={autoFilled.motifRef} />
					<input
						id="motif-ref"
						type="text"
						value={values.motifRef}
						placeholder="http://localhost:8787/images/patterns/….jpg"
						onChange={(event) => onChange('motifRef', event.target.value)}
						className={autoFilled.motifRef ? 'auto-filled' : ''}
					/>
					<span className="hint">
						Paste the <code>image_url</code> from a Helios run. A URL or an R2 key — a reference, never bytes.
					</span>
				</div>
			)}

			{engine === 'atlas' && (
				<>
					<div className="field">
						<FieldLabel label="Coloured pattern reference" autoFilled={autoFilled.patternRef} />
						<input
							id="pattern-ref"
							type="text"
							value={values.patternRef}
							placeholder="http://localhost:8788/images/iris/….jpg"
							onChange={(event) => onChange('patternRef', event.target.value)}
							className={autoFilled.patternRef ? 'auto-filled' : ''}
						/>
						<span className="hint">
							The <code>image_url</code> from an Iris run. A URL, or an R2 key under the shared bucket's <code>iris/</code> prefix.
						</span>
					</div>

					<div className="field">
						<label htmlFor="garment-ref">Garment photo URL</label>
						<input
							id="garment-ref"
							type="text"
							value={values.garmentRef}
							placeholder="https://example.com/blank-tshirt.jpg"
							onChange={(event) => onChange('garmentRef', event.target.value)}
						/>
						<span className="hint warn">
							A <strong>link to an already-hosted photo, not a file to upload</strong> — there is no upload endpoint this sprint.
							Atlas fetches this URL itself; this page never touches the bytes. It must be a real URL, unlike the pattern
							reference above.
						</span>
					</div>

					<div className="field">
						<label htmlFor="garment-type">Garment</label>
						<select id="garment-type" value={values.garmentType} onChange={(event) => changeGarment(event.target.value)}>
							{GarmentTypeSchema.options.map((option) => (
								<option key={option} value={option}>
									{option}
								</option>
							))}
						</select>
					</div>

					<div className="field">
						<label>Regions</label>
						<div className="row wrap">
							{GarmentRegionSchema.options.map((region) => {
								const possible = available.includes(region);
								return (
									<label key={region} className={possible ? 'check' : 'check disabled'} title={possible ? undefined : `a ${values.garmentType} has no ${region}`}>
										<input
											type="checkbox"
											disabled={!possible}
											checked={values.regions.includes(region)}
											onChange={() => toggleRegion(region)}
										/>
										{region}
									</label>
								);
							})}
						</div>
						<span className="hint">
							At least one. Regions this garment does not have are disabled rather than refused on submit — a{' '}
							<code>{values.garmentType}</code> has {available.length === GarmentRegionSchema.options.length ? 'all five' : available.join(', ')}.
						</span>
					</div>

					<div className="field">
						<label htmlFor="coverage">Coverage</label>
						<select id="coverage" value={values.coverage} onChange={(event) => onChange('coverage', event.target.value)}>
							{CoverageSchema.options.map((option) => (
								<option key={option} value={option}>
									{option}
								</option>
							))}
						</select>
					</div>

					<div className="field">
						<label htmlFor="pattern-scale">Pattern scale</label>
						<select id="pattern-scale" value={values.patternScale} onChange={(event) => onChange('patternScale', event.target.value)}>
							{PatternScaleSchema.options.map((option) => (
								<option key={option} value={option}>
									{option}
								</option>
							))}
						</select>
					</div>
				</>
			)}

			<div className="field">
				<FieldLabel label="Design session id" autoFilled={autoFilled.designSessionId} />
				<input
					id="design-session"
					type="text"
					value={values.designSessionId}
					placeholder="design-…"
					onChange={(event) => onChange('designSessionId', event.target.value)}
					className={autoFilled.designSessionId ? 'auto-filled' : ''}
				/>
				<span className="hint">
					<strong>The design, not this run.</strong> Minted once upstream and carried unchanged through every engine — it is what
					stitches Helios's pattern, Iris's colouring and Atlas's placement into one story. Required, with no fallback: neither engine
					will mint one, because a run that cannot be traced back to a design still spends money and still lands in the audit table.
				</span>
			</div>
		</>
	);
}
