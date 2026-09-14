"""合成足部軌跡：已知真值的測試訊號。

用途是回歸測試與幀率消融實驗（docs/PLAN.md 第七節）。因為每一個 IC/TO 的
真實時刻都由參數決定，可以直接量出偵測器的誤差，不必依賴人工標註。

擺動期的形狀用 sin(pi*u)**0.6 而非單純的 raised cosine：後者在觸地瞬間的
導數為零（腳以零速度離地與落地），這在生理上不成立，且會讓任何以位置門檻
為準的偵測器看起來比實際更差。指數 0.6 讓腳以有限且偏大的垂直速度離地／落地，
比較接近真實的競走足部軌跡。
"""

from __future__ import annotations

import math
import random

from .types import ContactInterval, Foot, FootTrack

SWING_SHARPNESS = 0.6


def _contact_schedule(
    n_cycles: int, contact_ms: float, flight_ms: float
) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """左右腳交替觸地，每兩次觸地之間夾一段騰空。"""
    period = contact_ms + flight_ms
    left: list[tuple[float, float]] = []
    right: list[tuple[float, float]] = []

    for k in range(n_cycles):
        base = 2.0 * k * period
        left.append((base, base + contact_ms))
        right.append((base + period, base + period + contact_ms))

    return left, right


def _trajectory(
    schedule: list[tuple[float, float]],
    duration_ms: float,
    fps: float,
    ground: float,
    amplitude: float,
    swing_ms: float,
    noise_px: float,
    rng: random.Random,
) -> list[float]:
    dt_ms = 1000.0 / fps
    n_frames = int(duration_ms / dt_ms) + 1
    first_start = schedule[0][0]
    last_end = schedule[-1][1]
    ys: list[float] = []

    for i in range(n_frames):
        t = i * dt_ms
        y = ground

        in_contact = any(start <= t <= end for start, end in schedule)
        if not in_contact:
            # 找出這個時刻落在哪一段擺動期（前一次觸地結束 → 下一次觸地開始）。
            # 序列頭尾各補一段虛擬擺動期，否則第一次 IC 與最後一次 TO 沒有交越
            # 可偵測，真值就白給了。
            prev_end = max(
                (end for _, end in schedule if end <= t), default=first_start - swing_ms
            )
            next_start = min(
                (start for start, _ in schedule if start >= t), default=last_end + swing_ms
            )
            if next_start > prev_end:
                # 夾在 [0, 1]：虛擬擺動期可能讓 t 落在區間之外，而 sin 一旦為負，
                # 取分數次方會得到複數。
                u = min(1.0, max(0.0, (t - prev_end) / (next_start - prev_end)))
                y = ground - amplitude * (math.sin(math.pi * u) ** SWING_SHARPNESS)

        if noise_px:
            y += rng.gauss(0.0, noise_px)
        ys.append(y)

    return ys


def synth_tracks(
    fps: float = 240.0,
    n_cycles: int = 4,
    contact_ms: float = 300.0,
    flight_ms: float = 30.0,
    ground: float = 500.0,
    amplitude: float = 120.0,
    noise_px: float = 0.0,
    seed: int = 0,
) -> tuple[FootTrack, FootTrack, list[ContactInterval]]:
    """產生左右腳軌跡與對應的真值觸地區間。

    回傳的第三項是 ground truth，測試用它來計算偵測誤差。
    """
    rng = random.Random(seed)

    # 單腳的非觸地時間：自己的擺動 = 對側的觸地 + 前後兩段騰空
    swing_ms = contact_ms + 2.0 * flight_ms

    # 整個排程往後推一段擺動期，讓第一次觸地之前有腳從空中落下的過程可看
    lead_ms = swing_ms
    left_sched, right_sched = _contact_schedule(n_cycles, contact_ms, flight_ms)
    left_sched = [(s + lead_ms, e + lead_ms) for s, e in left_sched]
    right_sched = [(s + lead_ms, e + lead_ms) for s, e in right_sched]

    # 尾端同樣留一段，讓最後一次離地也有完整的抬腳過程
    duration_ms = right_sched[-1][1] + swing_ms

    left = FootTrack(
        foot=Foot.LEFT,
        y=_trajectory(left_sched, duration_ms, fps, ground, amplitude, swing_ms, noise_px, rng),
    )
    right = FootTrack(
        foot=Foot.RIGHT,
        y=_trajectory(right_sched, duration_ms, fps, ground, amplitude, swing_ms, noise_px, rng),
    )

    truth = [ContactInterval(Foot.LEFT, s, e) for s, e in left_sched]
    truth += [ContactInterval(Foot.RIGHT, s, e) for s, e in right_sched]
    truth.sort(key=lambda c: c.start_ms)

    return left, right, truth
