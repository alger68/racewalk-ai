"""可疑片段粗篩。

這個模組的定位和 gait/ 不同，值得先講清楚差別。

gait/ 回答的是「這一步的騰空時間是幾毫秒」——需要 240 fps、側向機位、
選手不被遮擋。比賽的集團畫面給不了這些條件。

粗篩回答的是另一個問題：「這段影片裡，哪幾秒鐘值得裁判或教練親自看一眼」。
它不量精確值，改為輸出**在爛畫面上仍然成立的陳述**，並把片段排序。

核心手法是界線而非估計。若觀察到連續 k 格雙腳都離地，取樣間隔為 Δ，
而前後各有一格確定踩在地上，那麼真實騰空時間必然滿足：

        (k - 1) · Δ  <  騰空時間  <  (k + 1) · Δ

這不是估計，是取樣本身推出的邏輯界線，在任何幀率下都成立。30 fps 看到連續
三格雙腳離地，就能斷言騰空超過 66 毫秒——遠高於 40 毫秒的門檻，不需要任何
精度假設。

代價是靈敏度：30 fps 只能證明「很大的騰空」，小的騰空無法分辨。這正是粗篩
該有的取捨——**寧可漏掉，也不要誤報**。每一個標記都要站得住腳，否則裁判
看兩次假警報就不會再用了。

輸出一律是「值得看一眼」，不是「犯規」。判定權屬於人類裁判。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

from .capability import DEFAULT_VISIBILITY_THRESHOLD_MS, Capability, assess
from .gait import features
from .gait.events import contact_mask
from .types import ContactInterval, Foot, FootTrack, Point

# 膝角低於此值視為值得一看（度）。180° 為完全伸直。
# TR54 要求前導腳自觸地到通過垂直位置期間不彎膝，但姿態估計本身有數度誤差，
# 且非矢狀面拍攝會讓角度系統性偏小，所以門檻必須留裕度。
DEFAULT_KNEE_THRESHOLD_DEG = 168.0

# 膝角要低於門檻多少度才算滿分（用於分數正規化）。
KNEE_SCORE_SPAN_DEG = 12.0

# 觸地時間偏離自身中位數幾倍 MAD 才標記。
RHYTHM_MAD_THRESHOLD = 3.0

# 一段軌跡的可信影格比例低於此值時，整體結果都要打上警告。
LOW_COVERAGE_FRACTION = 0.7


class Signal(enum.Enum):
    """粗篩訊號的種類。"""

    VISIBLE_FLIGHT = "visible_flight"
    """雙腳離地的影格數多到足以斷言騰空超過門檻。"""

    BENT_KNEE = "bent_knee"
    """支撐期的膝關節角度明顯小於伸直。"""

    IRREGULAR_RHYTHM = "irregular_rhythm"
    """觸地時間明顯偏離該選手自己的節奏。"""


@dataclass(frozen=True)
class Finding:
    """一個值得人工看一眼的片段。

    這不是判定。score 是「相對強度」而非犯規機率，只用來排序同一段影片裡的
    片段——不同影片之間的 score 不可比較，因為拍攝條件不同。
    """

    signal: Signal
    start_ms: float
    end_ms: float
    score: float
    """0–1，訊號強度。用於排序，不是機率。"""

    quality: float
    """0–1，這個片段的資料有多可信。"""

    headline: str
    detail: str
    metrics: dict[str, float] = field(default_factory=dict)

    @property
    def priority(self) -> float:
        """排序用：訊號再強，資料不可信就不該排前面。"""
        return self.score * self.quality


@dataclass
class ScreenReport:
    fps: float
    findings: list[Finding]
    coverage: float
    """可信影格佔全部影格的比例。"""

    notes: list[str] = field(default_factory=list)


def flight_bounds(airborne_frames: int, fps: float) -> tuple[float, float]:
    """由「連續幾格雙腳離地」推出騰空時間的上下界（毫秒）。

    觀察到 k 格離地，且前後各有一格確定踩在地上，則真實騰空時間落在
    ((k-1)·Δ, (k+1)·Δ)。下界來自這 k 格本身橫跨的時間，上界來自前後兩格
    確定踩地的時刻。

    k=1 時下界為 0——只看到一格離地，什麼都證明不了，這是誠實的結果。
    """
    if airborne_frames < 1:
        raise ValueError("離地影格數必須至少為 1")

    dt_ms = 1000.0 / fps
    return (airborne_frames - 1) * dt_ms, (airborne_frames + 1) * dt_ms


def _airborne_runs(
    left: list[bool | None], right: list[bool | None]
) -> list[tuple[int, int]]:
    """找出雙腳皆確定離地的連續區段，且前後各有一格確定踩地。

    任一腳為 None（不知道）就中斷區段。把「不知道」當成「離地」會憑空
    生出騰空，那正是這整個模組要避免的事。
    """
    n = min(len(left), len(right))
    runs: list[tuple[int, int]] = []

    i = 0
    while i < n:
        if not (left[i] is False and right[i] is False):
            i += 1
            continue

        start = i
        while i < n and left[i] is False and right[i] is False:
            i += 1
        end = i  # 第一個不再離地的位置

        # 前後都必須是「確定踩在地上」，否則界線推不出來
        before_ok = start > 0 and (left[start - 1] is True or right[start - 1] is True)
        after_ok = end < n and (left[end] is True or right[end] is True)
        if before_ok and after_ok:
            runs.append((start, end))

    return runs


def _window_quality(
    left: FootTrack, right: FootTrack, start_idx: int, end_idx: int
) -> float:
    """這個時間窗內關鍵點信心度的平均值。"""
    lo, hi = max(0, start_idx), min(len(left.confidence), end_idx + 1)
    if hi <= lo:
        return 0.0
    values = left.confidence[lo:hi] + right.confidence[lo:hi]
    return sum(values) / len(values)


def screen_flights(
    left: FootTrack,
    right: FootTrack,
    fps: float,
    threshold_ms: float = DEFAULT_VISIBILITY_THRESHOLD_MS,
) -> list[Finding]:
    """標出「可以斷言騰空超過門檻」的片段。

    只在下界都超過門檻時才標記。下界超過門檻代表：無論取樣落在哪裡，
    這段騰空都比門檻長。這種陳述不依賴任何精度假設，爛畫面上也站得住。
    """
    left_mask = contact_mask(left, fps)
    right_mask = contact_mask(right, fps)
    dt_ms = 1000.0 / fps
    findings: list[Finding] = []

    for start, end in _airborne_runs(left_mask, right_mask):
        k = end - start
        lower, upper = flight_bounds(k, fps)
        if lower <= threshold_ms:
            continue  # 證明不了超過門檻，不標記

        findings.append(
            Finding(
                signal=Signal.VISIBLE_FLIGHT,
                start_ms=start * dt_ms,
                end_ms=end * dt_ms,
                score=min(1.0, (lower - threshold_ms) / threshold_ms),
                quality=_window_quality(left, right, start, end),
                headline=f"騰空至少 {lower:.0f} ms",
                detail=(
                    f"連續 {k} 格觀察到雙腳皆離地。取樣間隔 {dt_ms:.1f} ms，"
                    f"因此騰空時間必定介於 {lower:.0f}–{upper:.0f} ms 之間，"
                    f"下界已超過 {threshold_ms:.0f} ms 門檻。"
                ),
                metrics={
                    "airborne_frames": float(k),
                    "lower_ms": lower,
                    "upper_ms": upper,
                },
            )
        )

    return findings


def screen_knee(
    contacts: list[ContactInterval],
    joints: dict[Foot, tuple[list[Point], list[Point], list[Point]]],
    fps: float,
    left: FootTrack,
    right: FootTrack,
    knee_threshold_deg: float = DEFAULT_KNEE_THRESHOLD_DEG,
) -> list[Finding]:
    """標出支撐期膝角明顯彎曲的觸地。

    膝角比騰空時間更適合低幀率畫面：它是幾何量，不需要次幀精度。30 fps 下
    一次觸地仍有約 10 個取樣點，足以看出膝關節有沒有明顯彎曲。

    真正的限制在角度而非時間——非矢狀面拍攝會讓量到的膝角系統性偏小，
    所以門檻留了裕度，而且結果只用於排序，不作為判定。
    """
    dt_ms = 1000.0 / fps
    findings: list[Finding] = []

    for contact in contacts:
        legs = joints.get(contact.foot)
        if legs is None:
            continue
        hips, knees, ankles = legs

        start_idx = int(round(contact.start_ms / dt_ms))
        support_idx = features.vertical_support_index(hips, ankles, start_idx)
        end_idx = support_idx if support_idx is not None else int(round(contact.end_ms / dt_ms))

        angle = features.min_knee_angle_during_support(hips, knees, ankles, start_idx, end_idx)
        if angle is None or angle >= knee_threshold_deg:
            continue

        findings.append(
            Finding(
                signal=Signal.BENT_KNEE,
                start_ms=contact.start_ms,
                end_ms=min(contact.end_ms, end_idx * dt_ms),
                score=min(1.0, (knee_threshold_deg - angle) / KNEE_SCORE_SPAN_DEG),
                quality=_window_quality(left, right, start_idx, end_idx),
                headline=f"{contact.foot.value} 腳支撐期最小膝角 {angle:.0f}°",
                detail=(
                    f"觸地到通過垂直支撐位置期間，膝關節最小角度 {angle:.1f}°，"
                    f"低於 {knee_threshold_deg:.0f}° 的檢視門檻。"
                    f"注意非矢狀面拍攝會讓角度偏小，請以影片複核。"
                ),
                metrics={"min_knee_angle_deg": angle},
            )
        )

    return findings


def screen_rhythm(
    contacts: list[ContactInterval],
    left: FootTrack,
    right: FootTrack,
    fps: float,
    mad_threshold: float = RHYTHM_MAD_THRESHOLD,
) -> list[Finding]:
    """標出觸地時間明顯偏離該選手自身節奏的步伐。

    這是相對比較，不是絕對判準，所以對拍攝條件不敏感——正是爛畫面上還能
    用的性質。節奏斷裂本身不是犯規，但常伴隨犯規發生，值得一看。
    """
    if len(contacts) < 5:
        return []  # 樣本太少，中位數沒有意義

    dt_ms = 1000.0 / fps
    durations = sorted(c.duration_ms for c in contacts)
    mid = len(durations) // 2
    median = (
        durations[mid] if len(durations) % 2 else (durations[mid - 1] + durations[mid]) / 2
    )

    deviations = sorted(abs(c.duration_ms - median) for c in contacts)
    dmid = len(deviations) // 2
    mad = (
        deviations[dmid]
        if len(deviations) % 2
        else (deviations[dmid - 1] + deviations[dmid]) / 2
    )
    if mad <= 0:
        return []

    findings: list[Finding] = []
    for contact in contacts:
        z = abs(contact.duration_ms - median) / mad
        if z < mad_threshold:
            continue

        start_idx = int(round(contact.start_ms / dt_ms))
        end_idx = int(round(contact.end_ms / dt_ms))
        findings.append(
            Finding(
                signal=Signal.IRREGULAR_RHYTHM,
                start_ms=contact.start_ms,
                end_ms=contact.end_ms,
                score=min(1.0, (z - mad_threshold) / mad_threshold),
                quality=_window_quality(left, right, start_idx, end_idx),
                headline=f"{contact.foot.value} 腳觸地 {contact.duration_ms:.0f} ms，偏離節奏",
                detail=(
                    f"這一步的觸地時間與該選手中位數 {median:.0f} ms 相差 "
                    f"{abs(contact.duration_ms - median):.0f} ms（{z:.1f} 倍 MAD）。"
                    f"節奏斷裂本身不是犯規，但常伴隨犯規出現。"
                ),
                metrics={"contact_ms": contact.duration_ms, "median_ms": median, "z": z},
            )
        )

    return findings


def coverage_of(left: FootTrack, right: FootTrack, fps: float) -> float:
    """可信影格佔全部影格的比例。"""
    masks = contact_mask(left, fps) + contact_mask(right, fps)
    if not masks:
        return 0.0
    return sum(1 for m in masks if m is not None) / len(masks)


def screen(
    left: FootTrack,
    right: FootTrack,
    fps: float,
    contacts: list[ContactInterval] | None = None,
    joints: dict[Foot, tuple[list[Point], list[Point], list[Point]]] | None = None,
    threshold_ms: float = DEFAULT_VISIBILITY_THRESHOLD_MS,
    knee_threshold_deg: float = DEFAULT_KNEE_THRESHOLD_DEG,
) -> ScreenReport:
    """跑完所有粗篩訊號，依優先度排序回傳。"""
    cap: Capability = assess(fps)
    findings = screen_flights(left, right, fps, threshold_ms)

    if contacts:
        findings += screen_rhythm(contacts, left, right, fps)
        if joints:
            findings += screen_knee(
                contacts, joints, fps, left, right, knee_threshold_deg
            )

    findings.sort(key=lambda f: f.priority, reverse=True)

    coverage = coverage_of(left, right, fps)
    notes: list[str] = []

    if coverage < LOW_COVERAGE_FRACTION:
        notes.append(
            f"只有 {coverage * 100:.0f}% 的影格可信，其餘多半是遮擋。"
            f"粗篩只在可信的片段上進行，沒被標記不代表沒有問題——"
            f"也可能只是那段看不到。"
        )

    if not cap.flight_time_reliable:
        notes.append(
            f"{fps:g} fps 無法量出精確的騰空時間，本頁的騰空標記改用取樣界線："
            f"只在「無論取樣落在哪裡，騰空都超過 {threshold_ms:.0f} ms」時才標記。"
            f"靈敏度因此偏低——小幅度的騰空在這個幀率下無法分辨。"
        )

    if not findings:
        notes.append("沒有片段達到標記門檻。這代表沒有明顯到能被證明的問題，不代表完全合規。")

    return ScreenReport(fps=fps, findings=findings, coverage=coverage, notes=notes)
