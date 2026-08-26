import { ENGINE_SPECS, type Engine } from '../domain/engines';
import type { CallOutcome } from '../domain/outcome';

interface Props {
	engine: Engine;
	outcome: CallOutcome | null;
	fields: {
		designSessionId: string;
		motifRef: string;
		patternRef: string;
	};
}

const ENGINE_ORDER: Engine[] = ['helios', 'iris', 'atlas'];

function getEngineIndex(engine: Engine): number {
	return ENGINE_ORDER.indexOf(engine);
}

function getStageStatus(
	engine: Engine,
	currentEngine: Engine,
	outcome: CallOutcome | null,
	fields: Props['fields']
): 'pending' | 'active' | 'completed' | 'failed' {
	const currentIndex = getEngineIndex(currentEngine);
	const engineIndex = getEngineIndex(engine);

	if (engineIndex < currentIndex) {
		// Previous engines - check if they have results
		if (engine === 'helios') return 'completed';
		if (engine === 'iris') return fields.motifRef ? 'completed' : 'pending';
		if (engine === 'atlas') return fields.patternRef ? 'completed' : 'pending';
	}

	if (engineIndex === currentIndex) {
		if (outcome?.kind === 'run') {
			return outcome.result.status === 'completed' ? 'completed' : 'failed';
		}
		if (outcome?.kind === 'transport' || outcome?.kind === 'refusal') {
			return 'failed';
		}
		return 'active';
	}

	// Future engines
	if (engine === 'iris' && !fields.motifRef) return 'pending';
	if (engine === 'atlas' && !fields.patternRef) return 'pending';
	return 'pending';
}

export function PipelineFlow({ engine, outcome, fields }: Props) {
	return (
		<div className="pipeline-flow">
			<div className="pipeline-flow__label">Design Pipeline</div>
			<div className="pipeline-flow__steps">
				{ENGINE_ORDER.map((e, index) => {
					const status = getStageStatus(e, engine, outcome, fields);
					const spec = ENGINE_SPECS[e];
					const isLast = index === ENGINE_ORDER.length - 1;

					return (
						<div key={e} className="pipeline-flow__step">
							<div className={`pipeline-flow__node pipeline-flow__node--${status}`}>
								<span className="pipeline-flow__icon">{spec.label[0]}</span>
							</div>
							<div className="pipeline-flow__info">
								<div className="pipeline-flow__name">{spec.label}</div>
								<div className="pipeline-flow__tagline">{spec.tagline}</div>
								<div className={`pipeline-flow__status pipeline-flow__status--${status}`}>
									{status === 'pending' && 'Waiting'}
									{status === 'active' && 'Running…'}
									{status === 'completed' && 'Done'}
									{status === 'failed' && 'Failed'}
								</div>
							</div>
							{!isLast && (
								<div className={`pipeline-flow__connector pipeline-flow__connector--${status === 'completed' ? 'completed' : 'pending'}`} />
							)}
						</div>
					);
				})}
			</div>
			{fields.designSessionId && (
				<div className="pipeline-flow__design-id">
					Design Session: <code>{fields.designSessionId}</code>
				</div>
			)}
		</div>
	);
}