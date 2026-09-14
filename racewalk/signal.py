"""一維訊號處理：低通濾波、微分、次幀精度的門檻交越。

刻意只用標準函式庫。步態訊號一段只有數百個取樣點，numpy 在這裡沒有意義，
而少一個相依套件，CI 就能在幾秒內跑完、任何人 clone 下來就能執行測試。
"""

from __future__ import annotations

import math

Series = list[float]


def _butter2_lowpass(cutoff_hz: float, fs: float) -> tuple[Series, Series]:
    """二階 Butterworth 低通的 biquad 係數（雙線性轉換）。"""
    if not 0 < cutoff_hz < fs / 2:
        raise ValueError(f"截止頻率 {cutoff_hz} Hz 必須介於 0 與 Nyquist ({fs / 2}) 之間")
    wc = math.tan(math.pi * cutoff_hz / fs)
    k1 = math.sqrt(2.0) * wc
    k2 = wc * wc
    a0 = 1.0 + k1 + k2
    b = [k2 / a0, 2.0 * k2 / a0, k2 / a0]
    a = [1.0, 2.0 * (k2 - 1.0) / a0, (1.0 - k1 + k2) / a0]
    return b, a


def _lfilter(b: Series, a: Series, x: Series) -> Series:
    """Direct form I，單向。

    濾波器狀態以 x[0] 為基準而非零，等同 scipy 的 lfilter_zi 作法。

    這一步不是可有可無的細節：足部 y 座標的 DC 偏移動輒數百像素，若讓狀態從
    零開始，輸出會從 0 一路衝到 500，在影片開頭造成一段幅度數百像素的假訊號，
    足以被誤判成觸地事件。實測一段常數輸入原本會產生 ±0.7 像素的漣漪並生出
    一個假事件，補上這個基準後歸零。
    """
    offset = x[0] if x else 0.0
    xs = [v - offset for v in x]

    y = [0.0] * len(xs)
    for n in range(len(xs)):
        acc = b[0] * xs[n]
        if n >= 1:
            acc += b[1] * xs[n - 1] - a[1] * y[n - 1]
        if n >= 2:
            acc += b[2] * xs[n - 2] - a[2] * y[n - 2]
        y[n] = acc

    return [v + offset for v in y]


def filtfilt(x: Series, cutoff_hz: float, fs: float, pad: int = 12) -> Series:
    """零相位低通：前向 + 後向各濾一次。

    步態事件的時刻就是我們要量的東西，任何相位延遲都會直接變成 IC/TO 的系統性
    偏差，所以這裡必須零相位，不能只濾一次。
    """
    if len(x) < 4:
        return list(x)
    b, a = _butter2_lowpass(cutoff_hz, fs)

    # 鏡像填補，避免邊界暫態汙染頭尾的事件。
    #
    # 這裡刻意用偶對稱（鏡像）而非奇對稱反射。奇對稱會把整段填補錨定在端點
    # x[0] / x[-1] 上，而端點本身也帶著雜訊，於是那個雜訊被放大兩倍灌進濾波器。
    # 實測一段含高頻雜訊的訊號，奇對稱在尾端的殘差是 0.35，鏡像只有 0.09。
    pad = min(pad, len(x) - 1)
    head = list(x[pad:0:-1])
    tail = list(x[-2 : -pad - 2 : -1])
    padded = head + list(x) + tail

    forward = _lfilter(b, a, padded)
    backward = _lfilter(b, a, forward[::-1])[::-1]
    return backward[pad : pad + len(x)]


def derivative(x: Series, dt: float) -> Series:
    """中央差分；兩端退回單邊差分。"""
    n = len(x)
    if n < 2:
        return [0.0] * n
    out = [0.0] * n
    out[0] = (x[1] - x[0]) / dt
    out[-1] = (x[-1] - x[-2]) / dt
    for i in range(1, n - 1):
        out[i] = (x[i + 1] - x[i - 1]) / (2.0 * dt)
    return out


def percentile(x: Series, q: float) -> float:
    """線性內插的百分位數（q 為 0–100）。"""
    if not x:
        raise ValueError("空序列沒有百分位數")
    s = sorted(x)
    if len(s) == 1:
        return s[0]
    pos = (q / 100.0) * (len(s) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(s) - 1)
    frac = pos - lo
    return s[lo] * (1.0 - frac) + s[hi] * frac


def interpolate_gaps(x: Series, valid: list[bool]) -> Series:
    """把不可信的區段以線性內插填補。

    為什麼不能直接沿用前一格的值：那會造出一段水平的平台，而水平平台正是
    「腳踩在地上」的特徵。遮擋一發生就生出一次假觸地，這比沒有資料更糟。
    線性內插至少會延續遮擋前後的趨勢，不會憑空造出觸地的形狀。

    內插不會讓遮擋期間的資料變成真的——事件仍須由信心度守門（見
    gait/events.py）。這一步只是避免把垃圾餵進濾波器汙染鄰近的影格。
    """
    if len(x) != len(valid):
        raise ValueError("valid 遮罩與序列長度必須一致")
    if not any(valid):
        return list(x)

    out = list(x)
    n = len(x)

    first = valid.index(True)
    last = n - 1 - valid[::-1].index(True)

    # 頭尾的無效區段無法內插，只能延伸最近的有效值
    for i in range(first):
        out[i] = x[first]
    for i in range(last + 1, n):
        out[i] = x[last]

    i = first
    while i <= last:
        if valid[i]:
            i += 1
            continue
        gap_start = i
        while i <= last and not valid[i]:
            i += 1
        gap_end = i  # 第一個重新有效的位置
        y0, y1 = x[gap_start - 1], x[gap_end]
        span = gap_end - (gap_start - 1)
        for k in range(gap_start, gap_end):
            out[k] = y0 + (y1 - y0) * (k - (gap_start - 1)) / span

    return out


def crossings(x: Series, threshold: float, rising: bool) -> list[float]:
    """找出序列穿越門檻的位置，回傳「次幀精度」的索引（浮點數）。

    這是整個系統精度的來源之一：若只回傳整數索引，IC/TO 的誤差下限就是
    一個影格；線性內插可以把它壓到影格間隔以下。
    """
    out: list[float] = []
    for i in range(len(x) - 1):
        a, b = x[i], x[i + 1]
        hit = (a < threshold <= b) if rising else (a >= threshold > b)
        if not hit:
            continue
        if b == a:  # 理論上到不了，保險
            out.append(float(i))
        else:
            out.append(i + (threshold - a) / (b - a))
    return out
