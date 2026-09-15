const initBtn = document.getElementById('initAi');
const analyzeBtn = document.getElementById('analyzeBtn');
const videoInput = document.getElementById('videoInput');
const engineBadge = document.getElementById('engineBadge');
const status = document.getElementById('status');

let initRequested = false;
let retryTimer = null;

function aiReady() {
  return /AI 已載入/.test(engineBadge?.textContent || '');
}

function aiFailed() {
  return /失敗|錯誤/.test(status?.textContent || '');
}

function requestAiInit(reason = '自動') {
  if (!initBtn || aiReady()) return;
  if (initRequested && !aiFailed()) return;
  initRequested = true;
  if (status) status.textContent = `${reason}載入 AI 模型中，手機首次載入可能需要數秒…`;
  initBtn.click();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!aiReady() && status && !aiFailed()) {
      status.textContent = 'AI 模型仍在載入。若網路較慢請稍候；載入完成後「開始 AI 分析」會自動啟用。';
    }
  }, 8000);
}

// 頁面載入後直接初始化，不再要求使用者先按「載入 AI」。
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => requestAiInit('自動'), 150);
});

// 選影片時再次確認 AI 已啟動。
videoInput?.addEventListener('change', () => {
  if (!aiReady()) requestAiInit('影片已選取，正在');
});

// 將舊的「載入 AI」按鈕保留為手動重試用途。
initBtn?.addEventListener('click', () => {
  if (!aiReady()) {
    initRequested = true;
    initBtn.textContent = 'AI 載入中…';
    initBtn.disabled = true;
  }
});

// 監看狀態；載入成功後恢復按鈕，失敗時允許一鍵重試。
const observer = new MutationObserver(() => {
  if (aiReady()) {
    initRequested = false;
    clearTimeout(retryTimer);
    if (initBtn) {
      initBtn.disabled = false;
      initBtn.textContent = '重新載入 AI';
    }
    if (analyzeBtn) analyzeBtn.textContent = '開始 AI 分析';
  } else if (aiFailed()) {
    initRequested = false;
    if (initBtn) {
      initBtn.disabled = false;
      initBtn.textContent = '重試 AI';
    }
  }
});
if (engineBadge) observer.observe(engineBadge, { childList: true, subtree: true, characterData: true });
if (status) observer.observe(status, { childList: true, subtree: true, characterData: true });
