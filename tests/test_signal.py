"""訊號處理的測試。"""

from __future__ import annotations

import math

import pytest

from racewalk import signal


def test_filtfilt_is_zero_phase() -> None:
    """零相位是硬性要求：任何相位延遲都會變成 IC/TO 的系統性時間偏差。

    用單峰的高斯脈衝而非週期訊號——正弦波有多個等高峰值，argmax 選到哪一個
    由浮點誤差決定，測不出相位。
    """
    fs = 240.0
    centre = 240
    x = [math.exp(-(((i - centre) / 20.0) ** 2)) for i in range(480)]
    y = signal.filtfilt(x, 20.0, fs)

    peak_y = max(range(len(y)), key=lambda i: y[i])
    assert abs(peak_y - centre) <= 1


def test_filtfilt_preserves_constant_signal() -> None:
    """常數輸入必須得到常數輸出。

    濾波器狀態若從零開始，數百像素的 DC 偏移會在開頭產生巨大暫態，
    足以在影片頭尾生出假的觸地事件。
    """
    x = [500.0] * 200
    y = signal.filtfilt(x, 50.0, 240.0)
    assert max(abs(v - 500.0) for v in y) < 1e-6


def test_filtfilt_attenuates_high_frequency() -> None:
    fs = 240.0
    slow = [math.sin(2 * math.pi * 1.0 * i / fs) for i in range(480)]
    noisy = [v + 0.5 * math.sin(2 * math.pi * 90.0 * i / fs) for i, v in enumerate(slow)]

    filtered = signal.filtfilt(noisy, 10.0, fs)
    residual = max(abs(a - b) for a, b in zip(filtered, slow, strict=True))
    assert residual < 0.15


def test_filtfilt_passes_short_series_through() -> None:
    assert signal.filtfilt([1.0, 2.0], 10.0, 240.0) == [1.0, 2.0]


def test_cutoff_above_nyquist_rejected() -> None:
    with pytest.raises(ValueError):
        signal.filtfilt([0.0] * 100, 200.0, 240.0)


def test_crossings_are_sub_frame() -> None:
    """交越點必須是浮點索引，否則精度下限就是一個影格。"""
    x = [0.0, 1.0, 2.0, 3.0]
    (idx,) = signal.crossings(x, 1.5, rising=True)
    assert idx == pytest.approx(1.5)


def test_crossings_direction() -> None:
    x = [0.0, 2.0, 0.0]
    assert signal.crossings(x, 1.0, rising=True) == pytest.approx([0.5])
    assert signal.crossings(x, 1.0, rising=False) == pytest.approx([1.5])


def test_derivative_of_line_is_constant_slope() -> None:
    dt = 0.5
    x = [3.0 * i for i in range(10)]
    d = signal.derivative(x, dt)
    assert all(v == pytest.approx(3.0 / dt) for v in d)


def test_percentile_interpolates() -> None:
    assert signal.percentile([0.0, 10.0], 50.0) == pytest.approx(5.0)
    assert signal.percentile([5.0], 99.0) == 5.0


def test_percentile_rejects_empty() -> None:
    with pytest.raises(ValueError):
        signal.percentile([], 50.0)
