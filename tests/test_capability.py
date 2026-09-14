"""能力分級與騰空結論的測試。

這一組測試守的是專案最重要的一條原則：寧可不給答案，不可給錯答案。
"""

from __future__ import annotations

import pytest

from racewalk import capability
from racewalk.capability import Tier


@pytest.mark.parametrize(
    ("fps", "expected"),
    [
        (240.0, Tier.FULL),
        (300.0, Tier.FULL),
        (120.0, Tier.REDUCED),
        (239.0, Tier.REDUCED),
        (60.0, Tier.GAIT_ONLY),
        (30.0, Tier.GAIT_ONLY),
    ],
)
def test_tier_boundaries(fps: float, expected: Tier) -> None:
    assert capability.assess(fps).tier is expected


def test_low_fps_marks_flight_unreliable() -> None:
    assert not capability.assess(60.0).flight_time_reliable
    assert capability.assess(240.0).flight_time_reliable


def test_uncertainty_shrinks_with_frame_rate() -> None:
    fast = capability.assess(240.0).flight_uncertainty_ms
    slow = capability.assess(120.0).flight_uncertainty_ms
    assert fast < slow


def test_invalid_fps_rejected() -> None:
    with pytest.raises(ValueError):
        capability.assess(0.0)


def test_verdict_never_claims_a_violation() -> None:
    """系統不做判罰。輸出只能是「疑似」，不能是「犯規」。"""
    cap = capability.assess(240.0)
    verdicts = {
        capability.flight_verdict(ms, cap) for ms in (5.0, 30.0, 40.0, 60.0, 200.0)
    }
    assert verdicts <= {"suspected", "within_tolerance", "inconclusive"}


def test_verdict_respects_uncertainty_band() -> None:
    """騰空時間落在誤差範圍內跨越門檻時，不下結論。"""
    cap = capability.assess(120.0)  # 不確定度約 ±4.2 ms
    assert capability.flight_verdict(40.0, cap) == "inconclusive"
    assert capability.flight_verdict(80.0, cap) == "suspected"
    assert capability.flight_verdict(10.0, cap) == "within_tolerance"


def test_unreliable_overrides_everything() -> None:
    """幀率不足時，再長的騰空也不給結論。"""
    cap = capability.assess(30.0)
    assert capability.flight_verdict(500.0, cap) == "unreliable"
