"""把核心演算法內嵌進 analyzer.html，產出可直接雙擊開啟的單一檔案。

為什麼需要這個建置步驟：瀏覽器從 file:// 載入 ES module 會被 CORS 擋，
所以 analyzer.html 不能用 `import ... from "./racewalk-core.js"`。但把演算法
直接手寫進 HTML 會產生第二份副本，兩份各自演化的話，同一段影片在 CLI 與
網頁版會給出不同的騰空毫秒數，而使用者沒辦法知道該相信哪一個。

作法是保留 web/racewalk-core.js 作為唯一來源，建置時把它內嵌進模板。
CI 會重跑建置並比對，確保提交的 analyzer.html 沒有和來源脫節。

用法：
    python3 tools/build-web.py            產生 web/analyzer.html
    python3 tools/build-web.py --check     只檢查是否為最新（CI 用）
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "web" / "racewalk-core.js"
TEMPLATE = ROOT / "web" / "analyzer.template.html"
OUTPUT = ROOT / "web" / "analyzer.html"

PLACEHOLDER = "/* __RACEWALK_CORE__ */"

BANNER = """  // ===================================================================
  // 以下由 tools/build-web.py 從 web/racewalk-core.js 自動內嵌。
  // 不要直接改這一段——改 racewalk-core.js，然後重跑：
  //     python3 tools/build-web.py
  // ===================================================================
"""


def inline_core(source: str) -> str:
    """移除 ESM 的 export 關鍵字，讓核心程式碼可以直接放進 <script> 區塊。"""
    source = re.sub(r"^export\s+(const|function|class|let)\b", r"\1", source, flags=re.MULTILINE)

    if "export" in re.sub(r"//.*", "", source):
        remaining = [
            line for line in source.splitlines() if re.match(r"^\s*export\b", line)
        ]
        if remaining:
            raise SystemExit(f"還有無法內嵌的 export 語法：{remaining}")

    return source


def build() -> str:
    if not TEMPLATE.exists():
        raise SystemExit(f"找不到模板：{TEMPLATE}")

    template = TEMPLATE.read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        raise SystemExit(f"模板裡找不到佔位符 {PLACEHOLDER}")

    core = inline_core(CORE.read_text(encoding="utf-8"))
    return template.replace(PLACEHOLDER, BANNER + core)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="只檢查 analyzer.html 是否為最新，不寫入（不同步時以非零狀態結束）",
    )
    args = parser.parse_args()

    result = build()

    if args.check:
        if not OUTPUT.exists():
            print("analyzer.html 不存在，請執行 python3 tools/build-web.py", file=sys.stderr)
            return 1
        if OUTPUT.read_text(encoding="utf-8") != result:
            print(
                "analyzer.html 與 racewalk-core.js 不同步。"
                "請執行 python3 tools/build-web.py 後重新提交。",
                file=sys.stderr,
            )
            return 1
        print("analyzer.html 是最新的")
        return 0

    OUTPUT.write_text(result, encoding="utf-8")
    print(f"寫入 {OUTPUT.relative_to(ROOT)}（{len(result):,} 位元組）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
