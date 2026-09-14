"""可疑片段粗篩的測試。

粗篩最重要的性質不是「抓得到」，而是**不誤報**。裁判看兩次假警報就不會
再用了，所以合規選手必須零標記，而每一個標記都要有取樣界線撐著。
"""

from __future__ import annotations

import pytest

from racewalk import screen, synth
from racewalk.gait import events
from racewalk.screen import Signal
from racewalk.types import Foot, FootTrack


def _tracks(fps: float, flight_ms: float, noise_px: float = 1.0):
    left, right, _ = synth.synth_tracks(
        fps=fps, contact_ms=300.0, flight_ms=flight_ms, noise_px=noise_px
    )
    return left, right


def _flight_findings(fps: float, flight_ms: float):
    left, right = _tracks(fps, flight_ms)
    report = screen.screen(left, right, fps)
    return [f for f in report.findings if f.signal is Signal.VISIBLE_FLIGHT]


# ------------------------------------------------------------ 取樣界線本身


@pytest.mark.parametrize(
    ("k", "fps", "expected"),
    [
        (1, 240.0, (0.0, 2 * 1000 / 240)),
        (2, 240.0, (1000 / 240, 3 * 1000 / 240)),
        (3, 30.0, (2 * 1000 / 30, 4 * 1000 / 30)),
    ],
)
def test_flight_bounds(k: int, fps: float, expected: tuple[float, float]) -> None:
    assert screen.flight_bounds(k, fps) == pytest.approx(expected)


def test_single_airborne_frame_proves_nothing() -> None:
    """只看到一格離地，下界必須是 0——這是誠實，不是缺陷。"""
    lower, _ = screen.flight_bounds(1, 30.0)
    assert lower == 0.0


def test_bounds_bracket_the_truth() -> None:
    """界線必須真的夾住真值，否則整個推論失效。"""
    fps, flight_ms = 240.0, 90.0
    left, right = _tracks(fps, flight_ms)
    masks = (events.contact_mask(left, fps), events.contact_mask(right, fps))

    runs = screen._airborne_runs(*masks)
    assert runs

    for start, end in runs:
        lower, upper = screen.flight_bounds(end - start, fps)
        assert lower < flight_ms < upper


def test_zero_airborne_frames_rejected() -> None:
    with pytest.raises(ValueError):
        screen.flight_bounds(0, 240.0)


# ------------------------------------------------------------ 不誤報


@pytest.mark.parametrize("fps", [240.0, 120.0, 60.0, 30.0])
def test_compliant_athlete_is_never_flagged(fps: float) -> None:
    """騰空 30 ms 的合規選手，在任何幀率下都不該被標記。

    這是粗篩能不能被實際採用的關鍵：誤報一次，使用者對整個工具的信任就沒了。
    """
    assert _flight_findings(fps, 30.0) == []


@pytest.mark.parametrize("fps", [240.0, 120.0, 60.0])
def test_flight_below_threshold_is_not_flagged(fps: float) -> None:
    """騰空 35 ms 低於 40 ms 門檻，不該被標記。"""
    assert _flight_findings(fps, 35.0) == []


def test_flight_just_above_threshold_is_flagged_when_provable() -> None:
    """騰空 45 ms 確實超過門檻，而且 240 fps 的取樣足以證明，就該標記。

    這裡的判準始終是「證得出來嗎」，不是「超過多少才算嚴重」。門檻本身
    （capability.DEFAULT_VISIBILITY_THRESHOLD_MS）是可調的政策參數。
    """
    findings = _flight_findings(240.0, 45.0)
    assert findings
    assert all(f.metrics["lower_ms"] > screen.DEFAULT_VISIBILITY_THRESHOLD_MS for f in findings)


def test_coarse_sampling_cannot_prove_a_marginal_flight() -> None:
    """同樣是 45 ms 的騰空，30 fps 的取樣證明不了，就不該標記。

    靈敏度隨幀率下降是取樣的必然結果，不是缺陷——重點是它以「漏報」
    而非「誤報」的形式呈現。
    """
    assert _flight_findings(30.0, 45.0) == []


# ------------------------------------------------------------ 抓得到明顯的


@pytest.mark.parametrize("fps", [240.0, 120.0, 60.0, 30.0])
def test_clear_violation_is_flagged_at_every_frame_rate(fps: float) -> None:
    """騰空 90 ms 遠超門檻，即使 30 fps 也該標記。"""
    findings = _flight_findings(fps, 90.0)
    assert findings
    assert all(f.metrics["lower_ms"] > screen.DEFAULT_VISIBILITY_THRESHOLD_MS for f in findings)


def test_low_frame_rate_finds_fewer_segments() -> None:
    """30 fps 的靈敏度必須低於 240 fps——這是取樣的代價，要如實反映。"""
    assert len(_flight_findings(30.0, 90.0)) < len(_flight_findings(240.0, 90.0))


def test_larger_flight_scores_higher() -> None:
    small = _flight_findings(240.0, 70.0)
    large = _flight_findings(240.0, 150.0)
    assert max(f.score for f in large) > max(f.score for f in small)


# ------------------------------------------------------------ 遮擋處理


def test_unknown_frames_never_become_flight() -> None:
    """信心度不足的影格是「不知道」，不可以被當成「離地」。

    把不知道讀成離地會憑空生出騰空，那正是這個模組最該避免的錯誤。
    """
    fps = 240.0
    left, right = _tracks(fps, 30.0)
    n = len(left.y)

    # 把中間一整段標成不可信，且座標飄到空中
    lo, hi = n // 3, n // 2
    for i in range(lo, hi):
        left.y[i] = 380.0
        right.y[i] = 380.0
        left.confidence[i] = 0.0
        right.confidence[i] = 0.0

    report = screen.screen(left, right, fps)
    findings = [f for f in report.findings if f.signal is Signal.VISIBLE_FLIGHT]
    for f in findings:
        assert not (lo * 1000 / fps <= f.start_ms <= hi * 1000 / fps)


def test_airborne_run_needs_contact_on_both_sides() -> None:
    """前後沒有確定踩地的影格就推不出界線，不該產生標記。"""
    masks_left = [None, False, False, None]
    masks_right = [None, False, False, None]
    assert screen._airborne_runs(masks_left, masks_right) == []

    bounded_left = [True, False, False, True]
    bounded_right = [True, False, False, True]
    assert screen._airborne_runs(bounded_left, bounded_right) == [(1, 3)]


# ------------------------------------------------------------ 報告


def test_low_coverage_is_reported() -> None:
    fps = 240.0
    left, right = _tracks(fps, 30.0)
    for i in range(len(left.y) // 2):
        left.confidence[i] = 0.0
        right.confidence[i] = 0.0

    report = screen.screen(left, right, fps)
    assert report.coverage < screen.LOW_COVERAGE_FRACTION
    assert any("遮擋" in note for note in report.notes)


def test_low_frame_rate_note_explains_the_tradeoff() -> None:
    left, right = _tracks(30.0, 30.0)
    report = screen.screen(left, right, 30.0)
    assert any("靈敏度" in note for note in report.notes)


def test_empty_result_is_not_a_clean_bill() -> None:
    """沒有標記不等於合規，報告必須說清楚。"""
    left, right = _tracks(240.0, 30.0)
    report = screen.screen(left, right, 240.0)
    assert not report.findings
    assert any("不代表完全合規" in note for note in report.notes)


def test_findings_are_ranked_by_priority() -> None:
    left, right = _tracks(240.0, 120.0)
    report = screen.screen(left, right, 240.0)
    priorities = [f.priority for f in report.findings]
    assert priorities == sorted(priorities, reverse=True)


def test_priority_penalises_low_quality() -> None:
    """訊號再強，資料不可信就不該排前面。"""
    strong_but_murky = screen.Finding(
        signal=Signal.VISIBLE_FLIGHT, start_ms=0, end_ms=100,
        score=1.0, quality=0.2, headline="", detail="",
    )
    modest_but_clear = screen.Finding(
        signal=Signal.VISIBLE_FLIGHT, start_ms=0, end_ms=100,
        score=0.5, quality=1.0, headline="", detail="",
    )
    assert modest_but_clear.priority > strong_but_murky.priority


def test_flat_track_produces_no_findings() -> None:
    flat = FootTrack(foot=Foot.LEFT, y=[500.0] * 200)
    other = FootTrack(foot=Foot.RIGHT, y=[500.0] * 200)
    assert screen.screen(flat, other, 240.0).findings == []
