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

## Sub-frame contact timing, and what it did not fix

`flightIntervals` now also reports `estimateMs`, from linear interpolation of the
smoothed foot height between the frames that bracket the threshold crossing. It is
reported beside `lowerMs`, never instead of it: the bound is rigorous because it only
counts observed frames, while the interpolation assumes the height is locally linear.

Measuring it changed the roadmap. The estimate is closer to the truth than the bound,
but it sits about 12 ms low and that error does not shrink with frame rate — 12.5 ms at
60 fps, 12.6 at 120, 12.5 at 240. The contact band has width, so a foot must rise
through it before it reads as airborne, and the same at landing; interpolation fixes
quantisation, not the band. Reaching the 40–45 ms band judges actually decide on is
therefore a contact-model problem, not a camera problem. No correction factor was
fitted from the synthetic data — that would be fitting the simulation. The direction of
the bias and its indifference to frame rate are held by tests.

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
Report schema is now 6.

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

## Analysis survives the screen going dark

`presentFrame` used to throw the moment `document.hidden` became true. On a phone that
is not an edge case: the screen dimming, a notification, or a glance at another app all
set it, and a fifteen-second analysis died partway through with no obvious cause —
reported as "it stops by itself". It now waits for the page to return to the foreground
and carries on, says so in the status line while it waits, and gives up only after two
minutes hidden. The same applies to the video scrolling out of view: it scrolls back and
retries rather than aborting.

## Frame rate is measured, not declared

Sampling is clamped to the video's frame rate, since sampling above the source only
re-feeds the same frame and can manufacture a run of consecutive airborne frames. That
clamp reads a hand-typed field, which would have punished exactly the person who shot
at 240 fps and never edited it. The rate is now measured from the file on load via
`requestVideoFrameCallback`, written into the field, and reported — including when the
measurement contradicts what was typed. `snapFps` rounds to the nearest standard rate
within 4% and otherwise reports what it measured rather than forcing a standard value.

The rate comes from the median gap between presented frames, not from frames divided by
elapsed time. Verifying this in a real browser is what showed why: on a clip recorded at
a 30 fps cadence the mean read 19.8, because the first frames after `play()` are
irregular while the decoder warms up, and because a recording is variable frame rate and
drops frames under load. The median recovers the cadence, which is the number sampling
must align to — aligning to the average would under-sample every frame.
`tests/fps_smoke.py` records a clip in the browser and holds this end to end, including
that the measurement restores the video's position and mute state.

## Coaching metrics

The contact states were already computed and only used to find flight. `gaitMetrics`
also derives cadence, per-foot contact time and left/right asymmetry — quantities a
coach can act on this week, and which say nothing about TR54. Only contacts bounded by
observed lift-off on both sides are counted, so a contact truncated by the start or end
of the clip cannot drag the mean down silently, the same standard `flightIntervals`
applies. Cadence comes from the median interval between successive contacts rather than
steps over clip length, which would count the incomplete cycles at each end. Below four
complete contacts the panel says so instead of computing from one or two steps. The 10%
asymmetry mark is a prompt to look, not a calibrated threshold.

## Two capture modes, kept apart

Ad-hoc phone filming and a tripod setup can both be useful, but not in the same trend
line. Cadence and left/right asymmetry are timing quantities and ratios, largely
indifferent to where the camera stands. Support-phase knee angle is not: off-sagittal
placement biases it systematically, so a handheld session and a tripod session carry
different systematic errors, and plotting them together produces a slope made entirely
of camera placement.

Each session records `captureMode`. Handheld points are drawn as squares rather than
circles — a shape, so the distinction survives colourblindness and black-and-white
printing — and the knee panel omits them altogether, connecting the comparable sessions
across the gap, because an excluded session is not a failed measurement of that series.
The caption says how many were left out and why.

## Trend chart

Four measures on incompatible scales — cadence around 180, contact around 300 ms,
asymmetry a few percent, knee angle near 175° — so the records tab draws four small
multiples sharing one time axis rather than one chart with two y-scales, where a
crossing of two lines would look like it meant something. A crosshair and tooltip read
every measure for the hovered session at once.

A session whose continuity fell below 70% is drawn as a hollow amber-ringed point and
counted in the caption: its numbers are present but not to be read as part of the
trend. The left/right series colours are the ones the angle chart already uses, so a
foot keeps its colour across the app; the previous teal failed the palette validator's
chroma floor (it reads as grey) and moved one step to `#0d9488`, which passes all six
checks, including a CVD separation of ΔE 21 against the purple.

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

## Records, export and the reading guide

Records are per-session summaries in this browser's local storage, so the records tab
lists them oldest first — a trend read left to right — and exports to CSV for a
spreadsheet or JSON for moving between devices. Import merges by timestamp, so
re-importing the same file does not double the history. The tab says plainly that
clearing site data loses everything, because local storage is not a backup.

A 怎麼看數據 tab explains what each number means, when not to trust it, and how to
record day to day, alongside what we could verify about the sport: race-walk distances
with their sources, the injury mechanism that follows from the straight-knee rule, and
a sampling protocol for a race that lasts far longer than one clip. The junior-high
distance is left blank and marked unverified rather than guessed, because distance
decides training structure.

`node --check` parses a `.js` file with script semantics, where a duplicate function
declaration is legal; it is an error in a module. A duplicate `download` therefore
passed the check and broke the page at load. Both the local check and CI now parse
site scripts as modules.

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
