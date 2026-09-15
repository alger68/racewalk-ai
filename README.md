# RaceWalk Lab 3.0 — 宥蓁競走動作分析

Clean ChatGPT rebuild. **No Claude source code is reused.**

## 目標

以瀏覽器本機分析競走影片，支援：

- 多人姿態偵測（最多 6 人）與目標選手鎖定
- 骨架、肩線、髖線、軀幹參考線
- 左右膝角度與 2 px 點位不確定度帶
- 人工修正髖／膝／踝點位後立即重算
- 地面線與疑似雙腳離地區間
- JSON / CSV / HTML 報告匯出
- 本機摘要紀錄（不保存影片）
- 核心猴子測試 / invariants
- GitHub Actions 測試通過後部署 Pages

## 隱私

影片透過瀏覽器本機載入與推論，不會由本程式提交到 GitHub。首次載入 AI 需要從 CDN 下載 MediaPipe WASM 與模型。

## 分支策略

`main` 是 RaceWalk Lab 3.0 正式主線。Claude 舊版完整保留於 `claude-legacy`，不參與本版分析與部署。

## 本機驗證

```bash
node tests/core.test.mjs
node --check site/core.js
node --check site/app.js
python3 -m http.server 8080 -d site
```

瀏覽器開啟 `http://localhost:8080`。

## GitHub Pages

`.github/workflows/pages.yml` 在 `main` 更新時先測試，再部署 `site/`。

> 本工具是訓練與人工複查輔助，不是正式競走裁判系統。
