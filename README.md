# RaceWalk Lab 3.0.5

ChatGPT rebuild of the browser racewalking analysis tool. This is not a byte-for-byte migration of the earlier hosted simulator. Model/identity accuracy is not established by UI or repeated-photo tests.

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
