"""產生移植驗證用的固定資料。

Python 端生成軌跡、跑完整條管線，把「輸入軌跡」與「輸出結果」一起寫成 JSON。
JS 端讀同一份軌跡跑自己的管線，比對輸出是否一致。

軌跡本身由 Python 產生並存進 JSON，所以兩邊的亂數實作不同不影響比對——
驗證的是演算法，不是亂數產生器。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from racewalk import capability, synth  # noqa: E402
from racewalk.gait import events, features  # noqa: E402
from racewalk.types import Foot  # noqa: E402

CASES = [
    {"fps": 240.0, "noise_px": 0.0},
    {"fps": 240.0, "noise_px": 1.0},
    {"fps": 240.0, "noise_px": 3.0},
    {"fps": 120.0, "noise_px": 1.0},
    {"fps": 120.0, "noise_px": 2.0},
    {"fps": 60.0, "noise_px": 1.0},
    {"fps": 30.0, "noise_px": 0.0},
]


def run_case(fps: float, noise_px: float) -> dict:
    left, right, truth = synth.synth_tracks(fps=fps, noise_px=noise_px)

    detected = events.detect_events(left, fps) + events.detect_events(right, fps)
    contacts = events.to_contacts(detected, Foot.LEFT) + events.to_contacts(detected, Foot.RIGHT)
    contacts.sort(key=lambda c: c.start_ms)

    cap = capability.assess(fps)
    report = features.build_report(fps, contacts, cap)

    return {
        "fps": fps,
        "noise_px": noise_px,
        # 輸入：JS 端要拿這兩條軌跡跑自己的管線
        "tracks": {"left": left.y, "right": right.y},
        "truth": [
            {"foot": c.foot.value, "start_ms": c.start_ms, "end_ms": c.end_ms} for c in truth
        ],
        # 期望輸出
        "expected": {
            "tier": cap.tier.value,
            "flight_uncertainty_ms": cap.flight_uncertainty_ms,
            "contacts": [
                {"foot": c.foot.value, "start_ms": c.start_ms, "end_ms": c.end_ms}
                for c in report.contacts
            ],
            "flights": [
                {"start_ms": f.start_ms, "end_ms": f.end_ms, "verdict": f.verdict}
                for f in report.flights
            ],
            "cadence_spm": report.cadence_spm,
        },
    }


def main() -> int:
    out = Path(__file__).resolve().parent / "port-fixtures.json"
    payload = {"cases": [run_case(**case) for case in CASES]}
    out.write_text(json.dumps(payload), encoding="utf-8")

    total = sum(len(c["expected"]["contacts"]) for c in payload["cases"])
    print(f"寫入 {out.name}：{len(payload['cases'])} 組案例，共 {total} 次觸地")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
