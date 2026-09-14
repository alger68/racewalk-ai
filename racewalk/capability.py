"""依影片幀率決定「這段影片能回答什麼問題」。

這是整個專案最重要的一段防呆。菁英選手的騰空時間落在 20–40 ms，若拿 60 fps
（每幀 16.7 ms）的影片去估一個 30 ms 的量，量測誤差會和被量的東西同一個數量級。
與其給一個看起來很精確、實際上沒有意義的毫秒數，不如明確拒絕回答。

參見 docs/PLAN.md 第二節。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

# 人眼可見性門檻的預設值（毫秒）。這是可調參數，不是物理常數——
# 規則寫的是「肉眼可見的騰空」，而「可見」沒有官方數值定義。
# 40 ms 是本專案的起始假設，必須以實驗與裁判對照來校準。
DEFAULT_VISIBILITY_THRESHOLD_MS = 40.0

# 騰空判定所需的最低幀率。低於此值，flight time 一律標示為不可靠。
MIN_FPS_FOR_FLIGHT = 120.0

# 可完整信任騰空量測的幀率。
FPS_FOR_FULL_CONFIDENCE = 240.0


class Tier(enum.Enum):
    """影片的能力等級。"""

    FULL = "full"
    """≥ 240 fps：騰空時間、膝角、步態指標全部可用。"""

    REDUCED = "reduced"
    """120–240 fps：騰空時間可用但不確定度較大，須連同誤差一起呈現。"""

    GAIT_ONLY = "gait_only"
    """< 120 fps：只提供膝角、步頻、步長；騰空相關輸出一律標示不可靠。"""


@dataclass(frozen=True)
class Capability:
    fps: float
    tier: Tier
    frame_interval_ms: float
    flight_uncertainty_ms: float
    """單筆騰空時間估計的預期不確定度（毫秒）。"""

    @property
    def flight_time_reliable(self) -> bool:
        return self.tier is not Tier.GAIT_ONLY

    def describe(self) -> str:
        if self.tier is Tier.FULL:
            return f"{self.fps:g} fps（每幀 {self.frame_interval_ms:.1f} ms）— 騰空量測可靠"
        if self.tier is Tier.REDUCED:
            return (
                f"{self.fps:g} fps（每幀 {self.frame_interval_ms:.1f} ms）— 騰空量測可用，"
                f"但不確定度達 ±{self.flight_uncertainty_ms:.1f} ms，判讀時務必連同誤差一起看"
            )
        return (
            f"{self.fps:g} fps（每幀 {self.frame_interval_ms:.1f} ms）— 幀率不足，"
            f"不輸出騰空時間；僅提供膝角、步頻、步長"
        )


def assess(fps: float) -> Capability:
    """由幀率判定能力等級。"""
    if fps <= 0:
        raise ValueError(f"幀率必須為正數，收到 {fps}")

    frame_interval_ms = 1000.0 / fps

    # IC 與 TO 各有一次門檻交越，次幀內插後每次的殘餘誤差約為影格間隔的 1/4；
    # 兩次獨立誤差相加（保守起見直接線性相加而非平方相加）。
    flight_uncertainty_ms = frame_interval_ms * 0.5

    if fps >= FPS_FOR_FULL_CONFIDENCE:
        tier = Tier.FULL
    elif fps >= MIN_FPS_FOR_FLIGHT:
        tier = Tier.REDUCED
    else:
        tier = Tier.GAIT_ONLY

    return Capability(
        fps=fps,
        tier=tier,
        frame_interval_ms=frame_interval_ms,
        flight_uncertainty_ms=flight_uncertainty_ms,
    )


def flight_verdict(
    flight_ms: float,
    capability: Capability,
    threshold_ms: float = DEFAULT_VISIBILITY_THRESHOLD_MS,
) -> str:
    """把一個騰空時間對應到可讀的結論。

    注意這裡回傳的永遠是「疑似」而非「犯規」。系統不做判罰，判定權屬於裁判。
    """
    if not capability.flight_time_reliable:
        return "unreliable"

    u = capability.flight_uncertainty_ms
    if flight_ms - u > threshold_ms:
        return "suspected"  # 疑似騰空，待人工複核
    if flight_ms + u < threshold_ms:
        return "within_tolerance"
    return "inconclusive"  # 誤差範圍跨越門檻，不下結論
