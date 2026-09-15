# RaceWalk Lab 3.0.5

ChatGPT rebuild of the browser racewalking analysis tool. This is not a byte-for-byte migration of the earlier hosted simulator. Model/identity accuracy is not established by UI or repeated-photo tests.

## Flight measurement

`site/core.js` reports double-support gaps with a sampling bound rather than a point
estimate. Observing k consecutive frames with both feet off the ground at interval Δ,
bounded on each side by a frame in confirmed contact, gives `lowerMs = (k-1)·Δ` as a
rigorous lower bound on the real flight time. It holds at any frame rate and needs no
accuracy assumption. Screening should rely on this value alone.

`upperMs = (k+1)·Δ` is **not** a rigorous upper bound. The contact threshold has width,
so a foot that has just left the ground still falls inside the band and is labelled
contact; the observed run is a subset of the real flight. A synthetic 240 fps case with
a true 90 ms flight observes 18 frames and reports `upperMs` of 79 ms — below the truth.
The lower bound also assumes the ground estimate does not mislabel planted feet as
airborne; `estimateGroundY` takes the 96th percentile to stay conservative.

Runs bounded by `unknown` or by the ends of the sequence are dropped: the start and end
of the flight were never observed, so no bound follows. Treating `unknown` as `off`
would manufacture flight out of occlusion.

Foot height is low-pass filtered (zero phase, mirror-padded, filter state referenced to
the first sample) before thresholding, and the threshold widens with measured residual
noise. Per-foot runs shorter than 60 ms of contact or 100 ms of swing are filled in — a
foot cannot leave the ground and return within 100 ms, so a short gap is a dropped
observation, not flight. Without this a single noisy frame splits one contact in two and
the seam is counted as a flight interval.

Sequences shorter than 8 frames are not filtered and fall back to per-frame thresholding.

`node tests/contact.test.mjs` covers these invariants on synthetic gait with known
ground truth: compliant 30 ms flights produce no provable marking at 240/120/60/30 fps,
and 120 ms flights are provable at all four. Low frame rates lose sensitivity as missed
detections, not false ones. None of this is measured accuracy on real video.

## Judge-detection bands

TR54 prohibits flight that is *visible to the human eye*, not flight as such —
elite flight times sit at 20–40 ms, so a true/false airborne detector flags
every legal athlete. `judgeDetection` in `site/core.js` therefore maps a flight
time onto what the literature reports about judges seeing it, not onto a pass/fail
threshold.

The published evidence supports two anchors: no reported detection below 40 ms,
and 3 of 8 international judges detecting flight in the 40–45 ms band, with that
study describing sub-45 ms non-detection as normal human vision. Those two points
give three bands. Fitting a sigmoid through two points would invent every number
in between and look more precise than the evidence is, so the bands stay discrete
and each carries its own `evidence` string and a `source` pointing at `docs/RULES.md`.

The band is computed from `lowerMs`, the rigorous bound, not from the observed
run, so it errs low: the real flight can only be longer and land in a higher band.
Nothing here is calibrated against this tool's own output — no red-card footage
has been processed.

## Knee angle

TR54 constrains the knee only from initial contact until the leg passes the vertical
upright position. Bending the knee during swing is normal gait, so a minimum taken over
the whole clip is not a quantity the rule speaks about. `supportKnee` in `site/core.js`
restricts the minimum to that window, per contact, per foot, and the report surfaces it
as the headline figure.

Where the hip never passes over the ankle during a contact — the athlete leaves frame
before mid-stance — that phase falls back to the full contact interval and is counted
separately as `partialSupportPhases`, so a wider-than-specified window is visible rather
than silent. The whole-clip minimum is kept in the report as `minLeftKneeWholeClip` /
`minRightKneeWholeClip` for diagnosis, labelled as not being the rule's criterion.
Report schema is now 5.

Off-sagittal camera placement biases measured knee angles low. The magnitude of that
bias is not calibrated.

## Reading the angle chart

A knee-angle line on its own does not say what to look at. TR54 constrains the knee
only between initial contact and the vertical upright position, so the chart shades
those support phases and marks each one's minimum; a minimum taken anywhere else is
not a quantity the rule speaks about. Frames with no reliable match are drawn as
hatched blanks rather than a gap in the line, because a break in a line looks the same
as a straight leg. Suspected flight intervals are marked with their `lowerMs` and
coloured by detection band. Clicking or dragging anywhere on the chart seeks the video
to that moment.

None of the shading is a verdict. The support-phase minimum is the number TR54 talks
about; whether it constitutes a bent knee is a judgment this tool does not make.

## Self-diagnosis

`diagnoseCapture` in `site/core.js` reads a finished report's own summary and says
whether the result is worth reading, because a coach is handed numbers and needs to
know what to change. Each finding carries a cause and an action, and the rules are
ordered blocker / warn / info. The thresholds are plausibility checks on the capture,
not TR54 criteria: a support-phase minimum well below a straight leg is reported as
likely off-sagittal projection, never as a bent-knee finding, and no flagged flight is
reported as absence of proof rather than absence of flight. It also refuses two things the second real clip produced: a knee series whose
median frame-to-frame rate exceeds any real gait (reported as jitter, most likely
left/right legs swapping under a side view, not as technique), and a flight interval
longer than any credible one (reported as feet lost from the frame, not as flight).
An interval whose rigorous lower bound is zero proves nothing and is listed separately
from the provable ones rather than beside them. Each finding that can be located
carries the time it happens at — the worst jitter frame, the longest blank, the support
phase holding the smallest angle — and the panel offers a button that seeks the video
there; a finding about a whole-clip setting says so instead of inventing a frame. None of the thresholds is
calibrated against real footage. `node tests/diagnose.test.mjs` covers the wording as
well as the branching, including that an early loss of tracking is only attributed to a
bad seed skeleton when continuity is also low.

## Documentation

`docs/PLAN.md` is the current plan: what the tool is now, what is blocked on real
footage, and which parts of the original Python-pipeline design the implementation
overturned. `site/plan.html` is the same content as a standalone page,
deployed with the site and linked from the tool's footer. `docs/RULES.md` maps each TR54 clause to the quantity the code computes, states what
judges can do that this system cannot, and lists the international sources — the
Competition and Technical Rules, C2.1, the judging guide, the TR54.7.8 handheld-device
amendment and the 2022 ban on shoes containing sensing technology — each marked as
obtained from secondary search summaries, because `worldathletics.org` and PMC were
unreachable from this environment. `docs/CAPTURE_GUIDE.md` gives capture specs and a
field checklist. Both predate the 3.0 rebuild and were restored with their references
updated; they describe the sport and the capture problem, which the rebuild did not change.

## Build

```sh
python scripts/build_controller.py
python scripts/build_site.py
python -m http.server 8000 --directory site
```

Controller, loader, entry HTML and inherited browser regressions are generated from the audited templates under `src/`. Edit the templates/build transformation, not ignored generated files. The transformation fails on unmatched required source blocks. New continuity logic is in `site/continuity.js`; previous strict association invariants remain in `site/target-lock.js`.

A tracker-predicted crop is clamped as a box, not edge by edge. Velocity is
`Δposition/Δtime`, so a short sampling interval can produce a very large value; the
old code extrapolated it unclamped and clamped each of the four edges into [0,1]
independently, which put `x1` to the right of `x2` whenever the predicted centre left
the frame. The inference layer rejected the resulting negative-width crop by throwing,
which ended the whole run. Real footage hit this: 251 of 272 frames were discarded at
the point the athlete reached the right edge. The extrapolated drift is now bounded,
the centre is clamped before the box is expanded, and a crop the inference layer would
still refuse falls back to full-frame for that frame instead of aborting — a frame with
no measurement is a blank, not a failure. A crop the *user* drew is still rejected out
loud.

3.0.5 deduplicates near-identical anatomical observations, uses a local target-following crop, continues scanning when measurements are unavailable, and requires three consistent observations before bounded recovery. More than 0.75 s of uncertainty requires explicit reselection; subsequent frames remain null rather than changing target. This trades coverage for caution and is not an identity guarantee.

The pinned 9,398,198-byte pose model is cached separately from the app version where CacheStorage is available. Corrupt cache is rejected. First-time transfer and WASM initialization are distinct; no promise of instant startup on every device.

GitHub Actions build/test the emitted site, deploy the tested artifact and verify the live URL. Public CI uses public repeated-image fixtures and injected faults. Private user videos, pose outputs and screenshots must not be committed or uploaded as public CI artifacts.
