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

影片透過 `URL.createObjectURL()` 在瀏覽器本機播放與推論，不會由本程式提交到 GitHub。首次載入 AI 需要從 jsDelivr / Google Storage 下載 MediaPipe WASM 與模型。

## 分支策略

`chatgpt-racewalk-lab` 是新版主線；部署只使用 `chatgpt-v3/`。舊 `main` 保留為歷史資料，不混入本版程式。

## 本機驗證

```bash
node chatgpt-v3/tests/core.test.mjs
node --check chatgpt-v3/site/core.js
node --check chatgpt-v3/site/app.js
python3 -m http.server 8080 -d chatgpt-v3/site
```

## GitHub Pages

`.github/workflows/chatgpt-racewalk-pages.yml` 在 `chatgpt-racewalk-lab` push 後測試並部署 `chatgpt-v3/site/`。
若 repository 尚未啟用 Pages，GitHub Settings → Pages → Build and deployment → Source 選 `GitHub Actions`。

> 本工具是訓練與人工複查輔助，不是正式競走裁判系統。
