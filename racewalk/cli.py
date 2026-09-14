"""命令列介面。

    racewalk check <video>   讀取影片並回報它能回答什麼問題
    racewalk demo            以合成軌跡跑完整條步態管線
    racewalk ablation        幀率消融實驗：量化不同幀率下的精度劣化
"""

from __future__ import annotations

import argparse
import sys

from . import capability, synth
from .gait import events, features
from .io.probe import ProbeError, probe
from .types import Foot, GaitReport

DISCLAIMER = (
    "本工具為輔助分析用途，不是判罰工具。競走犯規的判定權屬於人類裁判，"
    "任何標記僅供人工複核參考。"
)


def _analyse_tracks(left, right, fps: float) -> GaitReport:
    """把左右腳軌跡跑完 N6 → N7。"""
    detected = events.detect_events(left, fps) + events.detect_events(right, fps)
    contacts = events.to_contacts(detected, Foot.LEFT) + events.to_contacts(detected, Foot.RIGHT)
    contacts.sort(key=lambda c: c.start_ms)

    return features.build_report(fps, contacts, capability.assess(fps))


def _print_report(report: GaitReport) -> None:
    cap = capability.assess(report.fps)
    print(f"\n影片能力等級：{cap.describe()}")

    print(f"\n觸地區間（{len(report.contacts)} 次）")
    for c in report.contacts:
        print(
            f"  {c.foot.value}  {c.start_ms:9.1f} → {c.end_ms:9.1f} ms"
            f"   觸地 {c.duration_ms:6.1f} ms"
        )

    if cap.flight_time_reliable:
        print(f"\n騰空區間（{len(report.flights)} 次，門檻 "
              f"{capability.DEFAULT_VISIBILITY_THRESHOLD_MS:g} ms）")
        for f in report.flights:
            print(
                f"  {f.start_ms:9.1f} → {f.end_ms:9.1f} ms"
                f"   騰空 {f.duration_ms:6.1f} ± {cap.flight_uncertainty_ms:.1f} ms"
                f"   {f.verdict}"
            )
    else:
        print("\n騰空區間：未輸出（幀率不足）")

    if report.cadence_spm:
        print(f"\n步頻：{report.cadence_spm:.1f} 步/分")

    for note in report.notes:
        print(f"\n[注意] {note}")


def cmd_check(args: argparse.Namespace) -> int:
    try:
        info = probe(args.video)
    except ProbeError as exc:
        print(f"錯誤：{exc}", file=sys.stderr)
        return 1

    cap = capability.assess(info.fps)
    print(info.describe())
    print(f"能力等級：{cap.describe()}")

    if cap.tier is capability.Tier.GAIT_ONLY:
        print(
            "\n這段影片無法用於騰空判定。若要量測騰空，請依 docs/CAPTURE_GUIDE.md "
            "重拍：至少 120 fps，建議 240 fps，快門 1/1000 s 以上。"
        )
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    """以合成軌跡示範完整管線，不需要任何影片或模型。"""
    print(f"合成軌跡：{args.fps:g} fps，觸地 {args.contact:g} ms，"
          f"騰空 {args.flight:g} ms，雜訊 {args.noise:g} px")

    left, right, truth = synth.synth_tracks(
        fps=args.fps,
        contact_ms=args.contact,
        flight_ms=args.flight,
        noise_px=args.noise,
    )
    report = _analyse_tracks(left, right, args.fps)
    _print_report(report)

    # 有真值可比對，直接把誤差印出來
    errors = []
    for t in truth:
        matched = [
            c for c in report.contacts
            if c.foot is t.foot and abs(c.start_ms - t.start_ms) < 100.0
        ]
        if matched:
            errors.append(abs(matched[0].start_ms - t.start_ms))
            errors.append(abs(matched[0].end_ms - t.end_ms))

    if errors:
        print(f"\n對照真值：偵測到 {len(report.contacts)}/{len(truth)} 次觸地，"
              f"IC/TO 最大誤差 {max(errors):.2f} ms，平均 {sum(errors) / len(errors):.2f} ms")

    flight_errors = [abs(f.duration_ms - args.flight) for f in report.flights]
    if flight_errors:
        print(f"           騰空時間 MAE {sum(flight_errors) / len(flight_errors):.2f} ms")

    print(f"\n{DISCLAIMER}")
    return 0


def cmd_ablation(args: argparse.Namespace) -> int:
    """幀率消融實驗（docs/PLAN.md 第七節第 3 項）。

    用實測數字回答「60 fps 到底夠不夠」，而不是用猜的。
    """
    print(f"幀率消融實驗：觸地 {args.contact:g} ms，騰空 {args.flight:g} ms\n")
    print(f"{'fps':>6}  {'等級':<10}  {'觸地數':>8}  {'IC/TO 最大誤差':>14}  {'騰空 MAE':>10}")
    print("-" * 60)

    for fps in (240.0, 120.0, 60.0, 30.0):
        left, right, truth = synth.synth_tracks(
            fps=fps, contact_ms=args.contact, flight_ms=args.flight, noise_px=args.noise
        )
        report = _analyse_tracks(left, right, fps)
        cap = capability.assess(fps)

        errors = []
        for t in truth:
            matched = [
                c for c in report.contacts
                if c.foot is t.foot and abs(c.start_ms - t.start_ms) < 100.0
            ]
            if matched:
                errors.append(abs(matched[0].start_ms - t.start_ms))
                errors.append(abs(matched[0].end_ms - t.end_ms))

        flight_errors = [abs(f.duration_ms - args.flight) for f in report.flights]
        mae = sum(flight_errors) / len(flight_errors) if flight_errors else float("nan")

        print(
            f"{fps:6.0f}  {cap.tier.value:<10}  {len(report.contacts):>4}/{len(truth):<3}"
            f"  {max(errors) if errors else float('nan'):>13.2f}ms  {mae:>8.2f}ms"
        )

    print(
        f"\n騰空時間只有 {args.flight:g} ms。上表的騰空 MAE 若接近這個量級，"
        "代表該幀率下的量測沒有意義。"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="racewalk", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_check = sub.add_parser("check", help="讀取影片並回報它能回答什麼問題")
    p_check.add_argument("video", help="影片檔路徑")
    p_check.set_defaults(func=cmd_check)

    p_demo = sub.add_parser("demo", help="以合成軌跡跑完整條步態管線")
    p_demo.add_argument("--fps", type=float, default=240.0)
    p_demo.add_argument("--contact", type=float, default=300.0, help="觸地時間（毫秒）")
    p_demo.add_argument("--flight", type=float, default=30.0, help="騰空時間（毫秒）")
    p_demo.add_argument("--noise", type=float, default=1.0, help="關鍵點雜訊（像素）")
    p_demo.set_defaults(func=cmd_demo)

    p_abl = sub.add_parser("ablation", help="幀率消融實驗")
    p_abl.add_argument("--contact", type=float, default=300.0)
    p_abl.add_argument("--flight", type=float, default=30.0)
    p_abl.add_argument("--noise", type=float, default=1.0)
    p_abl.set_defaults(func=cmd_ablation)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
