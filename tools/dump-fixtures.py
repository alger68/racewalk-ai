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

from racewalk import capability, screen, synth  # noqa: E402
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
    # 遮擋案例：模擬姿態模型在集團畫面中鎖到旁邊選手的腳。
    # 沒有這幾組，信心度守門的程式碼在移植驗證裡完全不會被執行到。
    {"fps": 240.0, "noise_px": 1.0, "occlude": (700.0, 950.0, 500.0)},
    {"fps": 240.0, "noise_px": 1.0, "occlude": (1100.0, 1250.0, 380.0)},
    {"fps": 120.0, "noise_px": 1.0, "occlude": (900.0, 1400.0, 500.0)},
    # 明顯騰空：讓粗篩產生標記，否則 screen 的比對永遠是空清單
    {"fps": 240.0, "noise_px": 1.0, "flight_ms": 90.0},
    {"fps": 30.0, "noise_px": 1.0, "flight_ms": 120.0},
]


def run_case(
    fps: float, noise_px: float, occlude: tuple | None = None, flight_ms: float = 30.0
) -> dict:
    left, right, truth = synth.synth_tracks(fps=fps, noise_px=noise_px, flight_ms=flight_ms)

    if occlude is not None:
        start_ms, end_ms, y_value = occlude
        lo, hi = int(start_ms * fps / 1000), int(end_ms * fps / 1000)
        for i in range(lo, min(hi, len(left.y))):
            left.y[i] = y_value
            left.confidence[i] = 0.0

    detected = events.detect_events(left, fps) + events.detect_events(right, fps)
    contacts = events.to_contacts(detected, Foot.LEFT) + events.to_contacts(detected, Foot.RIGHT)
    contacts.sort(key=lambda c: c.start_ms)

    cap = capability.assess(fps)
    report = features.build_report(fps, contacts, cap)
    screen_report = screen.screen(left, right, fps, contacts=contacts)

    return {
        "fps": fps,
        "noise_px": noise_px,
        "occluded": occlude is not None,
        # 輸入：JS 端要拿這兩條軌跡跑自己的管線
        "tracks": {
            "left": left.y,
            "right": right.y,
            "left_conf": left.confidence,
            "right_conf": right.confidence,
        },
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
            # 粗篩：沒有這一段，screen.py 的移植在比對中不會被執行到
            "screen": {
                "coverage": screen_report.coverage,
                "findings": [
                    {
                        "signal": f.signal.value,
                        "start_ms": f.start_ms,
                        "end_ms": f.end_ms,
                        "score": f.score,
                        "quality": f.quality,
                    }
                    for f in screen_report.findings
                ],
            },
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
