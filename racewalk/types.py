"""節點之間交換的資料型別。

對應 docs/DATA_CONTRACTS.md。先把這層定死，之後換掉任何一個節點的實作
（例如把姿態模型從 RTMPose 換成 ViTPose）都不會波及下游。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class Foot(enum.Enum):
    LEFT = "L"
    RIGHT = "R"


class EventKind(enum.Enum):
    INITIAL_CONTACT = "IC"
    """觸地：腳第一次接觸地面的瞬間。"""

    TOE_OFF = "TO"
    """離地：腳離開地面的瞬間。"""


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    confidence: float = 1.0

    @property
    def valid(self) -> bool:
        return self.confidence > 0.0


@dataclass
class FootTrack:
    """單腳在整段影片中的垂直軌跡。

    y 採影像座標（向下為正），所以「腳在地面」對應 y 的極大值。
    """

    foot: Foot
    y: list[float]
    confidence: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.confidence:
            self.confidence = [1.0] * len(self.y)
        if len(self.confidence) != len(self.y):
            raise ValueError("confidence 與 y 的長度必須一致")


@dataclass(frozen=True)
class GaitEvent:
    foot: Foot
    kind: EventKind
    t_ms: float
    confidence: float = 1.0
    method: str = "threshold"


@dataclass(frozen=True)
class ContactInterval:
    """單腳的一次觸地期間：從 IC 到 TO。"""

    foot: Foot
    start_ms: float
    end_ms: float

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms


@dataclass(frozen=True)
class FlightPhase:
    """雙腳皆未觸地的區間。"""

    start_ms: float
    end_ms: float
    verdict: str
    """capability.flight_verdict() 的結果。"""

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms


@dataclass
class GaitReport:
    fps: float
    contacts: list[ContactInterval]
    flights: list[FlightPhase]
    cadence_spm: float | None = None
    """步頻，每分鐘步數 (steps per minute)。"""

    notes: list[str] = field(default_factory=list)
