"""節點 N0–N1：讀取影片的中繼資料。

只讀 metadata，不解碼影格。能力分級（capability.py）完全靠這裡拿到的幀率，
所以寧可明確地失敗，也不要回一個猜出來的預設值——猜錯幀率會讓後面所有
毫秒數都跟著錯，而且錯得不明顯。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class ProbeError(RuntimeError):
    """無法取得影片資訊。"""


@dataclass(frozen=True)
class VideoInfo:
    path: Path
    fps: float
    width: int
    height: int
    duration_s: float
    n_frames: int | None = None

    def describe(self) -> str:
        return (
            f"{self.path.name}: {self.width}x{self.height} @ {self.fps:g} fps, "
            f"{self.duration_s:.1f} 秒"
        )


def _parse_rate(value: str) -> float:
    """ffprobe 的幀率是 '24000/1001' 這種分數字串。"""
    if "/" in value:
        num, _, den = value.partition("/")
        denominator = float(den)
        if denominator == 0:
            raise ProbeError(f"無效的幀率：{value}")
        return float(num) / denominator
    return float(value)


def probe(path: str | Path) -> VideoInfo:
    """以 ffprobe 讀取影片資訊。"""
    path = Path(path)
    if not path.exists():
        raise ProbeError(f"找不到檔案：{path}")

    if shutil.which("ffprobe") is None:
        raise ProbeError(
            "系統上找不到 ffprobe。請先安裝 ffmpeg："
            "macOS 用 `brew install ffmpeg`，Debian/Ubuntu 用 `apt install ffmpeg`。"
        )

    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=avg_frame_rate,width,height,nb_frames:format=duration",
                "-of", "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except subprocess.CalledProcessError as exc:
        raise ProbeError(f"ffprobe 讀取失敗：{exc.stderr.strip()}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProbeError("ffprobe 逾時") from exc

    payload = json.loads(result.stdout)
    streams = payload.get("streams") or []
    if not streams:
        raise ProbeError(f"{path} 裡面找不到視訊串流")

    stream = streams[0]
    fps = _parse_rate(stream.get("avg_frame_rate", "0/1"))
    if fps <= 0:
        raise ProbeError(
            f"無法從 {path.name} 判讀幀率。這個值決定整段分析的時間精度，"
            "不能用預設值帶過——請確認檔案沒有損毀。"
        )

    nb_frames = stream.get("nb_frames")

    return VideoInfo(
        path=path,
        fps=fps,
        width=int(stream.get("width", 0)),
        height=int(stream.get("height", 0)),
        duration_s=float(payload.get("format", {}).get("duration", 0.0)),
        n_frames=int(nb_frames) if nb_frames and nb_frames.isdigit() else None,
    )
