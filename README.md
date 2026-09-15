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

## Documentation

`docs/PLAN.md` is the current plan: what the tool is now, what is blocked on real
footage, and which parts of the original Python-pipeline design the implementation
overturned. `docs/plan.html` is the same content as a standalone page — open it
directly in a browser; it is not part of the Pages deployment, which publishes
`site/` only. `docs/RULES.md` maps each TR54 clause to the quantity the code computes, states what
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

3.0.5 deduplicates near-identical anatomical observations, uses a local target-following crop, continues scanning when measurements are unavailable, and requires three consistent observations before bounded recovery. More than 0.75 s of uncertainty requires explicit reselection; subsequent frames remain null rather than changing target. This trades coverage for caution and is not an identity guarantee.

The pinned 9,398,198-byte pose model is cached separately from the app version where CacheStorage is available. Corrupt cache is rejected. First-time transfer and WASM initialization are distinct; no promise of instant startup on every device.

GitHub Actions build/test the emitted site, deploy the tested artifact and verify the live URL. Public CI uses public repeated-image fixtures and injected faults. Private user videos, pose outputs and screenshots must not be committed or uploaded as public CI artifacts.
