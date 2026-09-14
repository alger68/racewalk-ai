"""節點 N7：由觸地區間與關節點推導步態指標。

- 騰空時間：雙腳都不在地面的區間長度。這是規則的核心量，也是本專案的主要產出。
- 步頻：由相鄰 IC 的間隔推算。
- 膝角：觸地到通過垂直支撐位置期間的最小膝關節角度（彎膝規則的判準）。
"""

from __future__ import annotations

import math

from ..capability import DEFAULT_VISIBILITY_THRESHOLD_MS, Capability, flight_verdict
from ..types import ContactInterval, FlightPhase, GaitReport, Point


def merge_contacts(contacts: list[ContactInterval]) -> list[tuple[float, float]]:
    """把左右腳的觸地區間合併成「至少有一腳在地面」的時間區間。"""
    if not contacts:
        return []

    spans = sorted((c.start_ms, c.end_ms) for c in contacts)
    merged = [list(spans[0])]

    for start, end in spans[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    return [(a, b) for a, b in merged]


def find_flights(
    contacts: list[ContactInterval],
    capability: Capability,
    threshold_ms: float = DEFAULT_VISIBILITY_THRESHOLD_MS,
) -> list[FlightPhase]:
    """找出雙腳皆離地的區間。

    只取「被兩側觸地區間夾住」的空隙。序列最前與最後的空檔可能只是影片
    還沒拍到腳，不是真的騰空。
    """
    merged = merge_contacts(contacts)
    flights: list[FlightPhase] = []

    for (_, prev_end), (next_start, _) in zip(merged, merged[1:], strict=False):
        duration = next_start - prev_end
        if duration <= 0:
            continue
        flights.append(
            FlightPhase(
                start_ms=prev_end,
                end_ms=next_start,
                verdict=flight_verdict(duration, capability, threshold_ms),
            )
        )

    return flights


def cadence_spm(contacts: list[ContactInterval]) -> float | None:
    """步頻（每分鐘步數），由相鄰觸地起點的間隔中位數推算。"""
    starts = sorted(c.start_ms for c in contacts)
    if len(starts) < 2:
        return None

    gaps = sorted(b - a for a, b in zip(starts, starts[1:], strict=False))
    mid = len(gaps) // 2
    median = gaps[mid] if len(gaps) % 2 else (gaps[mid - 1] + gaps[mid]) / 2.0

    if median <= 0:
        return None
    return round(60_000.0 / median, 2)


def knee_angle(hip: Point, knee: Point, ankle: Point) -> float | None:
    """膝關節角度（度）。180° 代表完全伸直。

    回傳 None 表示任一關鍵點無效或兩段肢段長度為零，此時不應該猜一個數字出來。
    """
    if not (hip.valid and knee.valid and ankle.valid):
        return None

    ux, uy = hip.x - knee.x, hip.y - knee.y
    vx, vy = ankle.x - knee.x, ankle.y - knee.y

    nu = math.hypot(ux, uy)
    nv = math.hypot(vx, vy)
    if nu == 0 or nv == 0:
        return None

    cosine = max(-1.0, min(1.0, (ux * vx + uy * vy) / (nu * nv)))
    return math.degrees(math.acos(cosine))


def min_knee_angle_during_support(
    hips: list[Point],
    knees: list[Point],
    ankles: list[Point],
    start_idx: int,
    end_idx: int,
) -> float | None:
    """觸地到通過垂直支撐位置期間的最小膝角。

    這正是 TR54 彎膝規則所規範的區間：前導腳自觸地起到通過身體垂直位置為止，
    膝關節必須保持伸直。
    """
    angles = [
        a
        for i in range(max(0, start_idx), min(end_idx + 1, len(knees)))
        if (a := knee_angle(hips[i], knees[i], ankles[i])) is not None
    ]
    return min(angles) if angles else None


def vertical_support_index(hips: list[Point], ankles: list[Point], start_idx: int) -> int | None:
    """找出髖關節通過踝關節正上方的影格索引（垂直支撐位置）。

    以 hip.x - ankle.x 的變號點判定。
    """
    for i in range(max(0, start_idx), min(len(hips), len(ankles)) - 1):
        cur = hips[i].x - ankles[i].x
        nxt = hips[i + 1].x - ankles[i + 1].x
        if cur == 0 or cur * nxt < 0:
            return i
    return None


def build_report(
    fps: float,
    contacts: list[ContactInterval],
    capability: Capability,
    threshold_ms: float = DEFAULT_VISIBILITY_THRESHOLD_MS,
) -> GaitReport:
    """組出完整的步態報告。"""
    flights = find_flights(contacts, capability, threshold_ms)
    notes: list[str] = []

    if not capability.flight_time_reliable:
        notes.append(
            f"幀率 {fps:g} fps 低於騰空判定所需的 120 fps，"
            f"騰空時間僅供參考，不可作為任何判讀依據。"
        )
    if not contacts:
        notes.append("未偵測到任何完整的觸地區間，請檢查追蹤與姿態估計的結果。")

    return GaitReport(
        fps=fps,
        contacts=contacts,
        flights=flights,
        cadence_spm=cadence_spm(contacts),
        notes=notes,
    )
