"""節點 N6：從足部垂直軌跡偵測觸地 (IC) 與離地 (TO)。

這是 MVP 的核心。方法與精度取捨見 docs/PLAN.md 第一節 N6。

作法（方法 A，幾何法）：
  1. 零相位低通濾掉姿態估計的抖動，但截止頻率不能壓太低，否則會把觸地瞬間
     的速度轉折一起抹平——那正是我們要偵測的特徵。
  2. 由整段軌跡的分佈推出「地面高度」與步態振幅，據此定出觸地門檻。
  3. 門檻的上行交越 = IC，下行交越 = TO，並以線性內插取得次幀精度。

刻意不用「速度過零」當主要判準：姿態估計的足部關鍵點在觸地時常有數像素的
跳動，微分會把雜訊放大，反而不如位置門檻穩定。速度只拿來做信心度評估。

關於門檻寬度——這是本模組最重要的一個參數，值得說明它是怎麼定下來的：

門檻必然設在地面高度之上（否則雜訊會讓判定亂跳），於是腳「越過門檻」的時刻
總是早於它真正踩到地面。結果是每個 TO 偏晚、每個 IC 偏早，而騰空時間正好夾在
TO 與 IC 之間，會被系統性低估兩倍的偏差。對一個門檻只有 40 ms 的判定來說，
這種偏差不能忽略。

以合成軌跡實測（tests/test_events.py 涵蓋）：
    門檻 0.25 → TO/IC 偏差約 ±11 ms   ← 完全不可用
    門檻 0.12 → 約 ±4 ms
    門檻 0.06 → 小於 1 ms             ← 目前採用
    門檻 0.03 → 偏差回升，且開始受雜訊影響

曾嘗試以交越點的局部斜率外插回地面高度來修正偏差，結果過度修正約 66%：
足部軌跡在接近地面時斜率持續增大，線性外插的前提不成立。改用窄門檻讓偏差
從源頭就很小，比事後修正單純也可靠。

門檻的下限由雜訊決定，不是越窄越好。0.06 是在真實影片上重新校準前的起始值。
"""

from __future__ import annotations

from .. import signal
from ..types import ContactInterval, EventKind, Foot, FootTrack, GaitEvent

# 低通截止頻率（Hz）。步態分析常用 10–12 Hz，但那是為了分析關節角度等
# 緩變訊號。這裡要偵測的是 20–40 ms 的觸地轉折，12 Hz 會把它抹平，
# 必須保留到 50 Hz 左右的頻寬。
DEFAULT_CUTOFF_HZ = 50.0

# 截止頻率相對於取樣率的上限。低幀率影片的 Nyquist 頻率本來就不夠高，
# 這也正是它們被歸入 GAIT_ONLY 等級的原因（見 capability.py）。
MAX_CUTOFF_RATIO = 0.4

# 觸地門檻相對於步態振幅的位置。理由見模組開頭。
DEFAULT_CONTACT_BAND = 0.06

# 最短合理觸地時間（毫秒）。競走的觸地期遠長於此，低於這個值的一律視為雜訊。
MIN_CONTACT_MS = 60.0

# 單腳最短合理擺動時間（毫秒）。腳離地後必須向前擺盪再落下，短於此值的
# 「離地→觸地」不可能是真的騰空，而是關鍵點掉格。
MIN_SWING_MS = 100.0

# 足部軌跡的最小垂直振幅（像素）。低於此值代表這條腿根本沒在動，
# 通常是追蹤失敗或關鍵點卡住，此時不該硬生出事件。
MIN_AMPLITUDE_PX = 1.0


def detect_events(
    track: FootTrack,
    fps: float,
    cutoff_hz: float = DEFAULT_CUTOFF_HZ,
    contact_band: float = DEFAULT_CONTACT_BAND,
    min_contact_ms: float = MIN_CONTACT_MS,
) -> list[GaitEvent]:
    """偵測單腳的 IC/TO 事件，依時間排序回傳。"""
    n = len(track.y)
    if n < 8:
        return []

    dt_ms = 1000.0 / fps
    y = signal.filtfilt(track.y, min(cutoff_hz, fps * MAX_CUTOFF_RATIO), fps)

    # 影像座標 y 向下為正 → 腳踩在地上時 y 最大。
    ground = signal.percentile(y, 95.0)
    swing_top = signal.percentile(y, 5.0)
    amplitude = ground - swing_top

    if amplitude < MIN_AMPLITUDE_PX:
        return []  # 軌跡幾乎是平的，代表這條腳沒有被正確追蹤

    band = _adaptive_band(y, amplitude, contact_band)
    threshold = ground - amplitude * band

    ic_idx = signal.crossings(y, threshold, rising=True)
    to_idx = signal.crossings(y, threshold, rising=False)

    velocity = signal.derivative(y, dt_ms / 1000.0)
    events: list[GaitEvent] = []

    for idx in ic_idx:
        events.append(
            GaitEvent(
                foot=track.foot,
                kind=EventKind.INITIAL_CONTACT,
                t_ms=idx * dt_ms,
                confidence=_confidence(track, velocity, idx),
                method="narrow-threshold",
            )
        )
    for idx in to_idx:
        events.append(
            GaitEvent(
                foot=track.foot,
                kind=EventKind.TOE_OFF,
                t_ms=idx * dt_ms,
                confidence=_confidence(track, velocity, idx),
                method="narrow-threshold",
            )
        )

    events.sort(key=lambda e: e.t_ms)
    events = _merge_short_gaps(events, MIN_SWING_MS)
    return _drop_short_contacts(events, min_contact_ms)


# 觸地門檻至少要高出雜訊這麼多倍的標準差，否則雜訊自己就會穿越門檻。
# 6.0 是實測掃描的結果：4.0 時 120 fps 在 2 px 雜訊下有三成的片段會算錯，
# 8.0 則讓門檻過寬、60 fps 的誤差反而上升。
NOISE_MARGIN = 6.0


def residual_noise_px(y: list[float]) -> float:
    """估計序列中殘留的高頻雜訊（像素標準差）。

    量的是「濾波之後還剩多少雜訊」，不是「濾掉了多少」。這個區別很重要：
    低幀率影片的截止頻率會被 Nyquist 限制夾到很靠近取樣率一半的位置，
    濾波器其實沒濾掉多少東西，若用「原始減濾波」去估雜訊會嚴重低估。

    作法是取二階差分 y[i] - (y[i-1] + y[i+1]) / 2，它對平滑訊號趨近於零，
    對白雜訊則有 sqrt(1.5) 倍的標準差，除掉這個係數即得原始雜訊水準。
    """
    if len(y) < 3:
        return 0.0

    rough = [y[i] - (y[i - 1] + y[i + 1]) / 2.0 for i in range(1, len(y) - 1)]
    n = len(rough)
    mean = sum(rough) / n
    variance = sum((v - mean) ** 2 for v in rough) / max(1, n - 1)

    return (variance**0.5) / 1.2247


def _adaptive_band(filtered: list[float], amplitude: float, floor: float) -> float:
    """依實測雜訊放寬觸地門檻。

    窄門檻的時間精度較好（見模組開頭），但門檻一旦落進雜訊的振幅範圍，雜訊
    本身就會製造出假的交越，偵測結果會從「稍微不準」直接崩壞成「完全錯誤」——
    實測 120 fps 搭配 2 px 雜訊時，固定門檻會生出一個誤差 156 ms 的假觸地。

    所以這裡取「設定值」與「雜訊下限」的較大者：雜訊小的時候維持高精度，
    雜訊大的時候寧可犧牲一點時間精度，也不要輸出垃圾。
    """
    if amplitude <= 0:
        return floor

    return max(floor, NOISE_MARGIN * residual_noise_px(filtered) / amplitude)


def _confidence(track: FootTrack, velocity: list[float], idx: float) -> float:
    """以關鍵點信心度為主，交越處速度過小時扣分。

    速度太接近零代表軌跡在門檻附近磨蹭，交越點的時間定位會不穩。
    """
    i = min(int(idx), len(velocity) - 1)
    kp_conf = track.confidence[i] if i < len(track.confidence) else 1.0

    speed = abs(velocity[i])
    reference = max(abs(v) for v in velocity) or 1.0
    sharpness = min(1.0, speed / (reference * 0.1)) if reference else 0.0

    return round(kp_conf * (0.5 + 0.5 * sharpness), 4)


def _merge_short_gaps(events: list[GaitEvent], min_swing_ms: float) -> list[GaitEvent]:
    """把單腳觸地期間的短暫掉格補回去。

    關鍵的物理約束：一隻腳一旦離地，必須向前擺盪再落下，不可能在幾毫秒內
    回到地面。所以同一隻腳的 TO 後面若緊接著一個過近的 IC，那不是騰空，
    是關鍵點抖動造成的掉格，應該把這次觸地接回去。

    這個約束不會誤刪真正的騰空：真正的騰空發生在「不同腳」之間，這裡只看
    同一隻腳自己的事件序列。實測 240 fps 搭配 3 px 雜訊時，最後一次觸地會被
    一段 5.5 ms 的掉格切成兩次，正是這一步要處理的情況。
    """
    kept: list[GaitEvent] = []
    i = 0
    while i < len(events):
        cur = events[i]
        if (
            cur.kind is EventKind.TOE_OFF
            and i + 1 < len(events)
            and events[i + 1].kind is EventKind.INITIAL_CONTACT
            and events[i + 1].t_ms - cur.t_ms < min_swing_ms
        ):
            i += 2  # 這組 TO/IC 是掉格，兩個都丟掉，觸地自然接回去
            continue
        kept.append(cur)
        i += 1
    return kept


def _drop_short_contacts(events: list[GaitEvent], min_contact_ms: float) -> list[GaitEvent]:
    """移除短於門檻的 IC→TO 配對，這些幾乎都是雜訊造成的假交越。"""
    kept: list[GaitEvent] = []
    i = 0
    while i < len(events):
        cur = events[i]
        if (
            cur.kind is EventKind.INITIAL_CONTACT
            and i + 1 < len(events)
            and events[i + 1].kind is EventKind.TOE_OFF
            and events[i + 1].t_ms - cur.t_ms < min_contact_ms
        ):
            i += 2  # 整對丟掉
            continue
        kept.append(cur)
        i += 1
    return kept


def to_contacts(events: list[GaitEvent], foot: Foot) -> list[ContactInterval]:
    """把事件序列配對成觸地區間。

    只取完整的 IC→TO 配對。影片開頭就已經踩在地上、或結尾還沒抬腳的那半段，
    無法得知真正的起訖時間，寧可捨棄也不要猜。
    """
    intervals: list[ContactInterval] = []
    pending: float | None = None

    for ev in events:
        if ev.foot is not foot:
            continue
        if ev.kind is EventKind.INITIAL_CONTACT:
            pending = ev.t_ms
        elif ev.kind is EventKind.TOE_OFF and pending is not None:
            intervals.append(ContactInterval(foot=foot, start_ms=pending, end_ms=ev.t_ms))
            pending = None

    return intervals
