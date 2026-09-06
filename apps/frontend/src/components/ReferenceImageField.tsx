import { useEffect, useState } from 'react';

/**
 * The reference image, which is now really sent.
 *
 * The file lives in the app's state rather than here, because the request is
 * built there — this component only picks it and previews it. That is the whole
 * change from the earlier version of this panel, which held the file locally
 * precisely so it *could not* reach a request body.
 *
 * Attaching one switches the request from JSON to `multipart/form-data`. A run
 * without one sends exactly the JSON body it always did.
 */
export function ReferenceImageField({
	file,
	onFile,
	// Distinct per panel. The two panels are never on screen together today, but
	// a duplicated id silently breaks label-to-input association the moment they
	// are, and that failure is invisible to everyone not using a screen reader.
	id = 'reference',
}: {
	file: File | null;
	onFile: (file: File | null) => void;
	id?: string;
}) {
	const [preview, setPreview] = useState<string | null>(null);

	// The preview follows whatever the app is actually holding, rather than a
	// second copy of it kept here. Two sources of truth would let the picture on
	// screen disagree with the bytes in the request — which is the one thing this
	// preview exists to rule out.
	useEffect(() => {
		if (!file) {
			setPreview(null);
			return;
		}

		const url = URL.createObjectURL(file);
		setPreview(url);

		// An object URL is held by the document until it is revoked. This runs on
		// every change and on unmount, so each URL created here is released once.
		return () => URL.revokeObjectURL(url);
	}, [file]);

	return (
		<div className="field">
			<label htmlFor={id}>Reference image</label>
			<div className="reference">
				<span className="hint">
					Optional. When attached, the request is sent as <code>multipart/form-data</code> and the image goes to the planner, which reads
					it and writes what it saw into <code>image_prompt</code>. Leave it empty and the request is the same JSON body as before.
				</span>
				<input
					id={id}
					type="file"
					accept="image/*"
					onChange={(event) => onFile(event.target.files?.[0] ?? null)}
				/>
				{file && (
					<>
						{preview && <img src={preview} alt={`Preview of ${file.name}, the reference image sent with this run`} />}
						<div className="row">
							<span className="hint">
								{file.name} — {Math.round(file.size / 1024)} KB, sent with the next run.
							</span>
							<button className="small" onClick={() => onFile(null)} title="Send this run without a reference image">
								Remove
							</button>
						</div>
						{file.size > 1_500_000 && (
							<span className="hint warn">
								Large files are not rejected here and are not resized anywhere. A JSON-bodied image call serialises the bytes as an
								integer array, roughly six times their size, so a file this big may fail at the model call with an error that does not
								mention size.
							</span>
						)}
					</>
				)}
			</div>
		</div>
	);
}
