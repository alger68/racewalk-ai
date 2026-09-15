/* Report module startup failure without disabling independent video controls. */
(()=>{
 const status=document.getElementById('status'),badge=document.getElementById('engineBadge');let ready=false;
 function fail(error){if(status)status.textContent=`網頁啟動失敗：${error?.message||String(error)}。請重新整理；此訊息不是 AI 分析結果。`;if(badge)badge.textContent='程式啟動失敗';const b=document.getElementById('initAi');if(b){b.disabled=false;b.textContent='重新載入網頁';b.onclick=()=>location.reload();}}
 const timer=setTimeout(()=>{if(!ready)fail(new Error('主程式載入逾時'));},20000);
 import('./app.js?v=3.0.5').then(()=>{ready=true;clearTimeout(timer);}).catch(error=>{clearTimeout(timer);fail(error);});
})();
