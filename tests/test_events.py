"""步態事件偵測的回歸測試。

用合成軌跡（真值已知）量測偵測器誤差。這些門檻直接對應 docs/PLAN.md 的
M3 驗收標準，任何一項退步都應該讓 CI 變紅。
"""

from __future__ import annotations

import pytest

from racewalk import capability, synth
from racewalk.gait import events, features
from racewalk.types import Foot

CONTACT_MS = 300.0
FLIGHT_MS = 30.0


def _run(fps: float, noise_px: float = 0.0):
    left, right, truth = synth.synth_tracks(
        fps=fps, contact_ms=CONTACT_MS, flight_ms=FLIGHT_MS, noise_px=noise_px
    )
    detected = events.detect_events(left, fps) + events.detect_events(right, fps)
    contacts = events.to_contacts(detected, Foot.LEFT) + events.to_contacts(detected, Foot.RIGHT)
    contacts.sort(key=lambda c: c.start_ms)
    return contacts, truth


def _event_errors(contacts, truth) -> list[float]:
    """把偵測到的觸地區間對到真值，回傳所有 IC/TO 的絕對誤差。"""
    errors: list[float] = []
    for t in truth:
        matches = [
            c for c in contacts if c.foot is t.foot and abs(c.start_ms - t.start_ms) < 100.0
        ]
        assert matches, f"{t.foot.value} 腳在 {t.start_ms:.0f} ms 的觸地沒有被偵測到"
        errors.append(abs(matches[0].start_ms - t.start_ms))
        errors.append(abs(matches[0].end_ms - t.end_ms))
    return errors


@pytest.mark.parametrize("noise_px", [0.0, 1.0])
def test_all_contacts_detected(noise_px: float) -> None:
    contacts, truth = _run(240.0, noise_px)
    assert len(contacts) == len(truth)


@pytest.mark.parametrize("noise_px", [0.0, 1.0])
def test_event_timing_within_m3_target(noise_px: float) -> None:
    """M3 驗收：240 fps 下 IC/TO 誤差須在一個影格（約 4.2 ms）以內。"""
    contacts, truth = _run(240.0, noise_px)
    assert max(_event_errors(contacts, truth)) < 4.2


@pytest.mark.parametrize("noise_px", [0.0, 1.0])
def test_flight_time_within_m3_target(noise_px: float) -> None:
    """M3 驗收：騰空時間 MAE 須在 8 ms 以內。"""
    fps = 240.0
    contacts, _ = _run(fps, noise_px)
    flights = features.find_flights(contacts, capability.assess(fps))

    assert flights, "應該要偵測到騰空區間"
    errors = [abs(f.duration_ms - FLIGHT_MS) for f in flights]
    assert sum(errors) / len(errors) < 8.0


def test_cadence_matches_truth() -> None:
    """步頻誤差須小於 2%。真值 = 60000 / (觸地 + 騰空)。"""
    contacts, _ = _run(240.0)
    expected = 60_000.0 / (CONTACT_MS + FLIGHT_MS)
    measured = features.cadence_spm(contacts)

    assert measured is not None
    assert abs(measured - expected) / expected < 0.02


def test_low_frame_rate_degrades_flight_accuracy() -> None:
    """60 fps 的騰空量測誤差必須明顯大於 240 fps。

    這不是在測「程式有沒有壞」，而是把規劃書的核心論點釘成可執行的事實：
    幀率不足時騰空時間就是量不準，所以 60 fps 影片才會被歸入 GAIT_ONLY。
    若哪天有人把 MIN_FPS_FOR_FLIGHT 調低，這個測試會擋下來。
    """
    errors: dict[float, float] = {}
    for fps in (240.0, 60.0):
        contacts, _ = _run(fps)
        flights = features.find_flights(contacts, capability.assess(fps))
        errors[fps] = max(abs(f.duration_ms - FLIGHT_MS) for f in flights)

    assert errors[60.0] > errors[240.0] * 3
    # 30 ms 的騰空若誤差達 10 ms，等於三成的相對誤差，不可用於任何判定
    assert errors[60.0] > FLIGHT_MS * 0.25


def test_flat_track_yields_no_events() -> None:
    """腳完全沒動（追蹤失敗）時不應該硬生出事件。"""
    from racewalk.types import FootTrack

    flat = FootTrack(foot=Foot.LEFT, y=[500.0] * 200)
    assert events.detect_events(flat, 240.0) == []


def test_incomplete_contacts_are_dropped() -> None:
    """只有 IC 沒有 TO 的半段觸地要捨棄，不能猜一個結束時間。"""
    from racewalk.types import EventKind, GaitEvent

    only_ic = [GaitEvent(Foot.LEFT, EventKind.INITIAL_CONTACT, 100.0)]
    assert events.to_contacts(only_ic, Foot.LEFT) == []


@pytest.mark.parametrize("fps", [240.0, 120.0, 60.0])
@pytest.mark.parametrize("noise_px", [0.0, 1.0, 2.0, 3.0, 4.0])
def test_contact_count_survives_noise(fps: float, noise_px: float) -> None:
    """已驗證的運作範圍：三種幀率、0–4 px 關鍵點雜訊下，觸地次數都要正確。

    數量算錯比時間不準嚴重得多——少一次觸地會憑空造出一段假的騰空，
    多一次則會吃掉一段真的騰空。
    """
    contacts, truth = _run(fps, noise_px)
    assert len(contacts) == len(truth)


def test_dropout_inside_a_contact_is_merged() -> None:
    """同一隻腳觸地期間的短暫掉格要接回去，不能算成騰空。

    一隻腳離地後必須向前擺盪再落下，不可能在幾毫秒內回到地面。
    """
    from racewalk.types import EventKind, GaitEvent

    sequence = [
        GaitEvent(Foot.LEFT, EventKind.INITIAL_CONTACT, 0.0),
        GaitEvent(Foot.LEFT, EventKind.TOE_OFF, 91.0),  # 掉格開始
        GaitEvent(Foot.LEFT, EventKind.INITIAL_CONTACT, 96.5),  # 5.5 ms 後就回來
        GaitEvent(Foot.LEFT, EventKind.TOE_OFF, 300.0),
    ]
    merged = events._merge_short_gaps(sequence, events.MIN_SWING_MS)
    contacts = events.to_contacts(merged, Foot.LEFT)

    assert len(contacts) == 1
    assert contacts[0].duration_ms == pytest.approx(300.0)


def test_real_flight_between_feet_is_not_merged() -> None:
    """真正的騰空發生在不同腳之間，不可以被掉格合併吃掉。"""
    contacts, _ = _run(240.0)
    flights = features.find_flights(contacts, capability.assess(240.0))

    assert len(flights) >= 5
    assert all(f.duration_ms > 20.0 for f in flights)


def test_adaptive_band_widens_with_noise() -> None:
    """雜訊大時門檻要自動放寬，否則雜訊自己會穿越門檻造出假事件。"""
    import random

    rng = random.Random(0)
    amplitude = 100.0
    smooth = [0.0] * 400
    noisy = [rng.gauss(0.0, 5.0) for _ in range(400)]

    clean_band = events._adaptive_band(smooth, amplitude, events.DEFAULT_CONTACT_BAND)
    noisy_band = events._adaptive_band(noisy, amplitude, events.DEFAULT_CONTACT_BAND)

    # 平滑訊號不該被放寬，維持在設定的下限
    assert clean_band == pytest.approx(events.DEFAULT_CONTACT_BAND)
    # 5 px 雜訊 × NOISE_MARGIN / 100 px 振幅 ≈ 0.3，遠高於下限
    assert noisy_band > clean_band * 3


def test_residual_noise_estimate_is_accurate() -> None:
    """雜訊估計要接近真實的標準差，否則自適應門檻會抓錯寬度。"""
    import random

    rng = random.Random(1)
    series = [rng.gauss(0.0, 3.0) for _ in range(2000)]

    assert events.residual_noise_px(series) == pytest.approx(3.0, rel=0.1)


def test_residual_noise_ignores_smooth_trend() -> None:
    """緩慢的真實運動不能被誤判成雜訊。"""
    import math

    ramp = [100.0 * math.sin(i / 200.0) for i in range(1000)]
    assert events.residual_noise_px(ramp) < 0.01
