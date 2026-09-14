"""步態特徵計算的測試。"""

from __future__ import annotations

import pytest

from racewalk import capability
from racewalk.gait import features
from racewalk.types import ContactInterval, Foot, Point


def _c(foot: Foot, start: float, end: float) -> ContactInterval:
    return ContactInterval(foot=foot, start_ms=start, end_ms=end)


def test_merge_overlapping_contacts() -> None:
    """雙支撐期（兩腳同時著地）要合併成一段，不能算出騰空。"""
    merged = features.merge_contacts(
        [_c(Foot.LEFT, 0.0, 300.0), _c(Foot.RIGHT, 280.0, 600.0)]
    )
    assert merged == [(0.0, 600.0)]


def test_flight_found_between_contacts() -> None:
    contacts = [_c(Foot.LEFT, 0.0, 300.0), _c(Foot.RIGHT, 330.0, 630.0)]
    flights = features.find_flights(contacts, capability.assess(240.0))

    assert len(flights) == 1
    assert flights[0].duration_ms == pytest.approx(30.0)


def test_no_flight_when_feet_overlap() -> None:
    contacts = [_c(Foot.LEFT, 0.0, 300.0), _c(Foot.RIGHT, 250.0, 600.0)]
    assert features.find_flights(contacts, capability.assess(240.0)) == []


def test_leading_and_trailing_gaps_are_not_flights() -> None:
    """序列頭尾的空檔可能只是影片還沒拍到腳，不能算成騰空。"""
    contacts = [_c(Foot.LEFT, 1000.0, 1300.0)]
    assert features.find_flights(contacts, capability.assess(240.0)) == []


def test_knee_angle_straight_leg() -> None:
    """髖、膝、踝共線且膝在中間 → 180 度（完全伸直）。"""
    angle = features.knee_angle(Point(0, 0), Point(0, 10), Point(0, 20))
    assert angle == pytest.approx(180.0)


def test_knee_angle_right_angle() -> None:
    angle = features.knee_angle(Point(0, 0), Point(0, 10), Point(10, 10))
    assert angle == pytest.approx(90.0)


def test_knee_angle_rejects_invalid_keypoints() -> None:
    """關鍵點無效時回傳 None，不可以猜一個角度出來。"""
    invalid = Point(0, 0, confidence=0.0)
    assert features.knee_angle(invalid, Point(0, 10), Point(0, 20)) is None


def test_knee_angle_rejects_degenerate_segment() -> None:
    assert features.knee_angle(Point(0, 10), Point(0, 10), Point(0, 20)) is None


def test_vertical_support_detected_at_sign_change() -> None:
    hips = [Point(0, 0), Point(5, 0), Point(10, 0)]
    ankles = [Point(8, 20), Point(8, 20), Point(8, 20)]
    assert features.vertical_support_index(hips, ankles, 0) == 1


def test_report_warns_on_low_frame_rate() -> None:
    cap = capability.assess(60.0)
    report = features.build_report(60.0, [_c(Foot.LEFT, 0.0, 300.0)], cap)

    assert any("120 fps" in note for note in report.notes)


def test_report_warns_when_nothing_detected() -> None:
    report = features.build_report(240.0, [], capability.assess(240.0))
    assert report.notes
    assert report.cadence_spm is None
