# atlas-03: Can the model put a pattern on a garment?

**What to build:** nothing permanent. Make one real call that hands the model a flat colored pattern plus a real photo of a garment and asks it to render that pattern printed onto that garment, and write down what actually came back. The deliverable is the "What we found" section of this file, filled in.

**Objective:** iris-06 answers what this model's request looks like. It does not answer whether this model can do Atlas's job. Those are different questions, and this one is the bigger risk: the whole Atlas sprint assumes an image-to-image model handed a flat repeating pattern and a garment photo will produce a recognisable version of that same garment carrying that pattern, and nobody has seen it do that. If it instead returns a flat tiled square, ignores the second image, blends the two images into something unrecognisable, or produces a garment with an unrelated pattern on it, then atlas-05, atlas-06 and atlas-07 are all built on a false premise and we find out at the demo. One call now, roughly a third of a cent, removes that.

**Final result:** a plain answer, in this file, to "does this approach work", with the output images attached to the pull request. atlas-07 is written against that answer rather than against an assumption.

**Blocked by:** atlas-02 for the `AI` binding and a working gateway, and iris-06 for the confirmed request shape. Do not start before iris-06's findings are filled in: re-deriving the multipart shape here would duplicate that ticket and waste a call.

**Status:** blocked, waiting on iris-06.

**Owner:** Ali Amir. **Reviewer:** M. Subhan.

**Duration:** 1 day. **Scheduled:** Tue Aug 25 to Tue Aug 25.

## Read this first

- `.scratch/iris-sprint-2/issues/06-flux-2-klein-probe.md`, the "What we found" section. That is the request shape. Use it exactly and verify none of it: it is already verified.
- `.scratch/atlas-sprint-2/plan.md`, "How Atlas repeats the pattern". The reasoning for one image call and no text call is there and is what this ticket is testing the foundation of.
- `packages/shared-utils/src/aiGateway.ts` (70 lines), `buildAiRunOptions`, and the reason it returns `undefined` when there is no gateway id.
- `apps/agent-helios/src/services/gatewayCost.ts`, for why a cost read retries.

## Decisions

1. **This ticket verifies capability, not shape.** Every row of iris-06's table is settled. If something in it turns out to be wrong, that is a finding worth reporting back to the Iris squad, but chasing it is not this ticket's job.
2. **Ask the model in the plainest possible words first.** Before any careful prompt engineering, send the simplest instruction that describes what we want. If the plain version works, atlas-05 has an easy job. If only an elaborate prompt works, atlas-05 needs to know that, and it is a finding rather than something for atlas-05 to discover on its own budget.
3. **Test at least two garments and two coverage styles.** One success proves nothing about a vocabulary of five garments and three coverage styles. Three or four calls total, still under two cents.
4. **Two input images, both real: the pattern and an actual garment photo.** This was settled after this ticket was first written: Atlas no longer describes the garment in words alone, it also sends a real photo of it as a second input image (`input_image_0` the pattern, `input_image_1` the garment). This ticket now has a second, equally important question to answer: does the model treat the second image as the thing to render onto, or does it ignore it, blend the two, or redraw the garment from scratch. Use two visibly different garment photos (not just two garment types named in the prompt) so a real difference in the reference image is actually being tested.
5. **Write the findings into this file, not into a message.** A verified answer to "can it do this" is exactly the kind of thing that gets re-litigated in six weeks if it lives in a chat.
6. **Throw the probe code away.** No service, no helper, no test ships from this ticket. If the script is worth keeping, put it in `tests/` as a named harness, which is what that directory is for and which is explicitly not the test suite.
7. **If the answer is no, stop and raise it in the group before atlas-07 starts.** A negative result here is a successful ticket, not a failed one, and it changes the approach rather than the shape. Do not try to rescue it inside this ticket.

## What we need to know

| Question | Answer |
|---|---|
| Does the output read as a garment at all, or as a flat square? | |
| Is the output recognisably **the same garment we sent** as `input_image_1`, or does the model invent a different one? | |
| Is the pattern in the output recognisably the pattern we sent, or a new one in a similar style? | |
| If the two input images are swapped, does the output visibly get worse or nonsensical (proving image order matters)? | |
| Does naming regions in the prompt (`back`, `neck`, `hem`) change anything observable in the output? | |
| Does asking for `trim` coverage differ visibly from asking for `allover`? | |
| Does sending a different garment photo (not just a different `garment_type` word) produce a visibly different output garment? | |
| Does the pattern's scale respond to asking for small versus large? | |
| Real cost per call, to the digits the gateway log shows | |
| Was the cost present on the first log read, or only after a retry? | |
| Does the plain-words prompt work, or did it need elaboration to tell the model which image is which? | |

## Work

- [ ] Write a throwaway probe: a `tests/` harness or a temporary route on the Atlas worker, whichever is faster. Do not put it in `services/`. (**Ali Amir**)
- [ ] Use a real colored pattern as `input_image_0`. If Iris is not producing them yet, any flat repeating colored textile image works, and note which you used. (**Ali Amir**)
- [ ] Use a real photo of a garment as `input_image_1`. A plain product photo, laid flat or on a mannequin, is fine; note which you used and attach it. (**Ali Amir**)
- [ ] Resize both inputs under the limit iris-06 confirmed, before sending. An oversized input is a known failure and would waste the call. (**Ali Amir**)
- [ ] Make the call with the gateway configured, carrying a `p_invoc_id` in the gateway metadata so the log row is findable. (**Ali Amir**)
- [ ] Start with the plainest prompt you can write, but it must still tell the model which image is the pattern and which is the garment (decision 2). Record it verbatim in the findings, whether or not it worked. (**Ali Amir**)
- [ ] Run at least two garment photos and two coverage styles (decision 3, decision 4). Attach every output image to the pull request, including the bad ones. A bad output is more informative than a good one here. (**Ali Amir**)
- [ ] Run one call with the two input images swapped, to confirm the model is actually using image order rather than ignoring one of them (decision 4). (**Ali Amir**)
- [ ] Answer every row of the table above. A row you did not test is written as "not tested", never left blank. (**Ali Amir**)
- [ ] Record the real cost per call, and whether it appeared on the first log read (**Ali Amir**)
- [ ] Give a plain-language verdict: does this approach work, work with caveats, or not work. One paragraph, no hedging. atlas-07's owner is going to act on it. (**Ali Amir**)
- [ ] Delete the probe code before merging, or move it into `tests/` as a named harness. Nothing from this ticket ships in `src/`. (**Ali Amir**)

### Review gates

- [ ] **Read this as the person who will write atlas-07.** Is the verdict specific enough to build on, and is the working prompt written down verbatim rather than described? (**M. Subhan**)
- [ ] Look at the output images yourself and agree or disagree with the verdict, in writing. One person's read of an image is not a finding. (**M. Subhan**)
- [ ] Confirm no row of the table is blank. A blank row will be read as "yes" by whoever writes atlas-05. (**M. Subhan**)
- [ ] Confirm `git diff` shows no new file under `apps/agent-atlas/src/`. (**M. Subhan**)
- [ ] Nobody approves their own work. (**both**)

## Verification without burning budget

**Budget: about $0.003 per call, four or five calls (two garments, two coverage styles, one image-order swap), roughly one and a half cents total.** Do not loop, do not iterate on prompt wording more than a couple of times here (that is atlas-05's job with atlas-05's budget), and do not leave the probe on a route anyone else can hit.

1. Every call returns an image and produces a gateway log row with a cost.
2. Every output image is attached to the pull request.
3. Every row of the table has an answer.
4. The verdict is one paragraph and takes a position.

## What we found

Fill this in. Until it is filled in, atlas-05 and atlas-07 are both blocked.

```
// The plain-words prompt, verbatim:
```

```
// The prompt that actually worked, if different:
```

**Verdict:** _fill in_
**Cost per call:** _fill in_
**Cost available on first log read:** _fill in_
**The output uses the actual garment we sent as `input_image_1`:** _fill in_
**Swapping the two input images visibly breaks the output:** _fill in_
**Regions in the prompt change the output:** _fill in_
**Coverage style changes the output:** _fill in_
**Pattern scale changes the output:** _fill in_
**Anything surprising:** _fill in_

## Two things that will waste your afternoon

**`buildAiRunOptions` returns `undefined` when the gateway id is empty, and the call then goes straight to Workers AI with no error and no log row.** If the gateway log is empty after your call, the most likely cause is not the model, it is that the call never went through the gateway. `env.AI.aiGatewayLogId` being null is the signal. Check that before concluding anything.

**Judging "does it work" from one image is how a sprint gets built on a fluke.** Image models are not deterministic, and the first output being great or terrible tells you very little. Run the same prompt twice before deciding either way, and say in the findings that you did.
