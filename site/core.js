export const JOINTS = {
  left_shoulder: 11, right_shoulder: 12,
  left_hip: 23, right_hip: 24,
  left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28,
  left_heel: 29, right_heel: 30,
  left_foot: 31, right_foot: 32,
};

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function angleDeg(a, b, c) {
  if (!a || !b || !c) return null;
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const den = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!den) return null;
  const cos = clamp((abx * cbx + aby * cby) / den, -1, 1);
  return Math.acos(cos) * 180 / Math.PI;
}

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function angleWithUncertainty(a, b, c, sigmaPx, width, height, samples = 96, seed = 1) {
  const value = angleDeg(a, b, c);
  if (value == null || !sigmaPx || sigmaPx <= 0) return { value, low: value, high: value };
  const rand = rng(seed);
  let low = value, high = value;
  const jitter = (p) => ({
    ...p,
    x: p.x + ((rand() * 2 - 1) * sigmaPx) / Math.max(1, width),
    y: p.y + ((rand() * 2 - 1) * sigmaPx) / Math.max(1, height),
  });
  for (let i = 0; i < samples; i++) {
    const v = angleDeg(jitter(a), jitter(b), jitter(c));
    if (v == null) continue;
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  return { value, low, high };
}

export function bboxFromLandmarks(landmarks, minVisibility = 0.2) {
  const pts = (landmarks || []).filter(p => p && (p.visibility ?? 1) >= minVisibility && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x1 = Math.min(...xs), y1 = Math.min(...ys), x2 = Math.max(...xs), y2 = Math.max(...ys);
  return { x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, area: Math.max(0, (x2 - x1) * (y2 - y1)) };
}

export function chooseTarget(candidates, previous, clickPoint = null) {
  if (!candidates?.length) return -1;
  const boxes = candidates.map(c => bboxFromLandmarks(c));
  if (clickPoint) {
    let best = -1, bestScore = Infinity;
    boxes.forEach((b, i) => {
      if (!b) return;
      const dx = b.cx - clickPoint.x, dy = b.cy - clickPoint.y;
      const inside = clickPoint.x >= b.x1 && clickPoint.x <= b.x2 && clickPoint.y >= b.y1 && clickPoint.y <= b.y2;
      const score = Math.hypot(dx, dy) - (inside ? 1 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }
  if (previous) {
    let best = -1, bestScore = Infinity;
    boxes.forEach((b, i) => {
      if (!b) return;
      const d = Math.hypot(b.cx - previous.cx, b.cy - previous.cy);
      const sizePenalty = previous.area ? Math.abs(Math.log((b.area + 1e-6) / (previous.area + 1e-6))) * 0.15 : 0;
      const score = d + sizePenalty;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }
  let best = 0;
  boxes.forEach((b, i) => { if ((b?.area ?? 0) > (boxes[best]?.area ?? 0)) best = i; });
  return best;
}

export function percentile(values, p) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * clamp(p, 0, 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function estimateGroundY(frames) {
  const ys = [];
  for (const f of frames || []) {
    const lm = f.landmarks;
    if (!lm) continue;
    for (const i of [27, 28, 29, 30, 31, 32]) {
      const p = lm[i];
      if (p && (p.visibility ?? 1) > 0.35) ys.push(p.y);
    }
  }
  return percentile(ys, 0.96);
}

// 時序處理常數。原本 footContact 直接對每一格的原始關鍵點做門檻判定，
// 姿態估計的抖動會讓接地狀態逐格跳動；以下三項分別處理抖動、雜訊與單格假訊號。
export const SMOOTH_CUTOFF_HZ = 50;   // 低通截止。步態分析慣用 10–12Hz，但那會抹掉 20–40ms 的觸地轉折
export const SMOOTH_MIN_FRAMES = 8;   // 短於此長度不濾波——樣本太少，濾了反而失真
export const NOISE_MARGIN = 6;        // 門檻至少要高出殘餘雜訊這麼多倍標準差
export const MIN_CONTACT_MS = 60;     // 短於此的觸地是雜訊
export const MIN_SWING_MS = 100;      // 腳離地後必須向前擺盪再落下，短於此的離地是掉格

function butter2(cutoffHz, fs) {
  const wc = Math.tan(Math.PI * cutoffHz / fs);
  const k1 = Math.SQRT2 * wc, k2 = wc * wc, a0 = 1 + k1 + k2;
  return { b: [k2 / a0, 2 * k2 / a0, k2 / a0], a: [1, 2 * (k2 - 1) / a0, (1 - k1 + k2) / a0] };
}

// Direct form I。狀態以 x[0] 為基準而非零：足部座標帶著 DC 偏移，
// 若讓狀態從零開始，輸出會在開頭衝出一段幅度等同該偏移的假訊號。
function lfilter(b, a, x) {
  const off = x.length ? x[0] : 0, xs = x.map(v => v - off), y = new Array(xs.length).fill(0);
  for (let n = 0; n < xs.length; n++) {
    let acc = b[0] * xs[n];
    if (n >= 1) acc += b[1] * xs[n - 1] - a[1] * y[n - 1];
    if (n >= 2) acc += b[2] * xs[n - 2] - a[2] * y[n - 2];
    y[n] = acc;
  }
  return y.map(v => v + off);
}

// 零相位低通：前向 + 後向各濾一次。相位延遲會直接變成觸地時刻的系統性偏差。
// 邊界用鏡像填補而非奇對稱——奇對稱會把雜訊汙染的端點放大兩倍灌進濾波器。
export function lowpass(values, fps, cutoffHz = SMOOTH_CUTOFF_HZ) {
  if (!values || values.length < 4) return (values || []).slice();
  const fc = Math.min(cutoffHz, fps * 0.4);
  if (!(fc > 0 && fc < fps / 2)) return values.slice();
  const { b, a } = butter2(fc, fps), p = Math.min(12, values.length - 1), head = [], tail = [];
  for (let i = p; i >= 1; i--) head.push(values[i]);
  for (let i = values.length - 2; i >= values.length - 1 - p && i >= 0; i--) tail.push(values[i]);
  const padded = [...head, ...values, ...tail];
  const back = lfilter(b, a, lfilter(b, a, padded).reverse()).reverse();
  return back.slice(p, p + values.length);
}

// 殘餘雜訊（標準差）。量的是「濾波後還剩多少」而非「濾掉了多少」：
// 低幀率的截止頻率被 Nyquist 夾得很高，濾波器其實沒濾掉多少東西。
export function residualNoise(values) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 3) return 0;
  const rough = [];
  for (let i = 1; i < v.length - 1; i++) rough.push(v[i] - (v[i - 1] + v[i + 1]) / 2);
  const mean = rough.reduce((s, x) => s + x, 0) / rough.length;
  const varr = rough.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rough.length - 1);
  return Math.sqrt(varr) / 1.2247;
}

// 不可信區段以線性內插填補，不可沿用前一格——沿用會造出水平平台，
// 而水平平台正是「腳踩在地上」的特徵，遮擋一發生就生出一次假觸地。
export function fillGaps(values, valid) {
  const out = values.slice(), n = out.length, first = valid.indexOf(true);
  if (first < 0) return out;
  const last = valid.lastIndexOf(true);
  for (let i = 0; i < first; i++) out[i] = values[first];
  for (let i = last + 1; i < n; i++) out[i] = values[last];
  let i = first;
  while (i <= last) {
    if (valid[i]) { i++; continue; }
    const s = i;
    while (i <= last && !valid[i]) i++;
    const y0 = values[s - 1], y1 = values[i], span = i - (s - 1);
    for (let k = s; k < i; k++) out[k] = y0 + (y1 - y0) * (k - (s - 1)) / span;
  }
  return out;
}

// 單腳每一格的最低點（影像座標 y 向下為正，所以踩地時 y 最大）。
export function footHeights(frames, side) {
  const ids = side === 'L' ? [27, 29, 31] : [28, 30, 32], y = [], valid = [];
  for (const f of frames || []) {
    const pts = ids.map(i => f?.landmarks?.[i]).filter(p => p && (p.visibility ?? 1) > 0.3);
    valid.push(pts.length >= 2);
    y.push(pts.length ? Math.max(...pts.map(p => p.y)) : NaN);
  }
  return { y, valid };
}

// 把過短的 run 補掉。單格雜訊既能切斷一段真的觸地，也能造出一段假的離地；
// 後者尤其危險——被切開的縫隙會被算成騰空，等於憑空生出一份犯規證據。
function cleanRuns(states, fps) {
  const dt = 1000 / Math.max(1, fps), out = states.slice();
  const limits = { contact: MIN_CONTACT_MS, off: MIN_SWING_MS };
  let i = 0;
  while (i < out.length) {
    const kind = out[i];
    let j = i;
    while (j < out.length && out[j] === kind) j++;
    const before = i > 0 ? out[i - 1] : null, after = j < out.length ? out[j] : null;
    // 只補「被同一種狀態夾住」的短 run，否則無從判斷該補成什麼
    if (limits[kind] && before && before === after && (j - i) * dt < limits[kind]) {
      for (let k = i; k < j; k++) out[k] = before;
    }
    i = j;
  }
  return out;
}

// 逐格接地狀態：'contact' | 'off' | 'unknown'。
// 'unknown' 不可以當成 'off'——把「不知道」讀成「離地」會憑空生出騰空。
export function contactStates(frames, side, groundY, fps, threshold = 0.018) {
  const n = (frames || []).length;
  if (!n || groundY == null) return new Array(n).fill('unknown');
  const { y, valid } = footHeights(frames, side);
  if (!valid.some(Boolean)) return new Array(n).fill('unknown');

  let series = y, band = threshold;
  if (n >= SMOOTH_MIN_FRAMES) {
    series = lowpass(fillGaps(y, valid), fps);
    // 雜訊大時放寬門檻：門檻一旦落進雜訊振幅，雜訊自己就會穿越門檻造出假事件
    band = Math.max(threshold, NOISE_MARGIN * residualNoise(series));
  }

  const states = series.map((v, i) => {
    if (!valid[i] || !Number.isFinite(v)) return 'unknown';
    const gap = groundY - v;
    return gap <= band && gap >= -band * 1.4 ? 'contact' : 'off';
  });
  return n >= SMOOTH_MIN_FRAMES ? cleanRuns(states, fps) : states;
}

export function footContact(landmarks, side, groundY, threshold = 0.018) {
  if (!landmarks || groundY == null) return 'unknown';
  const ids = side === 'L' ? [27, 29, 31] : [28, 30, 32];
  const pts = ids.map(i => landmarks[i]).filter(p => p && (p.visibility ?? 1) > 0.3);
  if (pts.length < 2) return 'unknown';
  const lowest = Math.max(...pts.map(p => p.y));
  const gap = groundY - lowest;
  return gap <= threshold && gap >= -threshold * 1.4 ? 'contact' : 'off';
}

// 裁判可見性：把騰空時間對應到「文獻報告過什麼」，而不是一個門檻。
//
// TR54 判的是「肉眼可見」的騰空，所以問題不是「超過幾毫秒」，而是「這麼長的
// 騰空，裁判看得見嗎」。而那是一條機率曲線，不是階梯。
//
// 但已發表的量化資料很少。可靠的只有兩個錨點：40 ms 以下沒有偵測報告，
// 以及 40–45 ms 區間「8 位國際裁判中 3 位察覺」。用這兩點去擬一條連續曲線，
// 中間的數值全是捏造的——看起來精確，實際沒有依據，比階梯門檻更糟。
//
// 因此這裡只輸出文獻撐得起的分帶，每一帶都附得出出處，並明確標示樣本大小。
// 這不是本工具的校準結果，也不是判定；要當成判準之前必須自行對照裁判紅卡。
export const DETECTION_BANDS = [
  { max: 40, band: 'below-reported',
    label: '低於文獻報告的偵測範圍',
    evidence: '未見裁判察覺此長度騰空的已發表報告' },
  { max: 45, band: 'at-threshold',
    label: '落在文獻報告的偵測門檻區間',
    evidence: '一項研究中 8 位國際裁判有 3 位察覺 40–45 ms 的騰空' },
  { max: Infinity, band: 'above-threshold',
    label: '高於文獻描述「無法察覺屬正常」的範圍',
    evidence: '該研究指出低於約 45 ms 無法察覺屬人類視覺系統的正常表現' },
];

export const DETECTION_SOURCE =
  'Assessment of IAAF Racewalk Judges\' Ability to Detect Legal and Non-legal Technique; ' +
  '經二手摘要取得，引用前請核對原文。詳見 docs/RULES.md。';

// 套用在 lowerMs（嚴謹下界）而非觀察值，所以結論偏保守：
// 真實騰空只會更長，落到更高的分帶，不會更低。
export function judgeDetection(flightMs) {
  if (!Number.isFinite(flightMs)) return null;
  const hit = DETECTION_BANDS.find(b => flightMs < b.max) ?? DETECTION_BANDS[DETECTION_BANDS.length - 1];
  return { ...hit, flightMs, source: DETECTION_SOURCE };
}

// 雙腳皆離地的區間，附取樣界線。
//
// lowerMs = (k-1)·Δ 是嚴謹的下界：觀察到連續 k 格雙腳離地、取樣間隔 Δ，
// 這 k 格橫跨的時間就是真實騰空的一部分，所以騰空至少這麼長。任何幀率下
// 都成立，不需要精度假設——這是粗篩唯一該依賴的數字。
//
// upperMs = (k+1)·Δ 不是嚴謹的上界，只是「若接地標記完全準確」時的估計。
// 實際上接地門檻有寬度，腳剛離地時仍落在門檻帶內而被標成 contact，於是
// 觀察到的離地區段是真實騰空的子集合。合成實測：240fps 下真值 90ms 的騰空
// 只觀察到 18 格，upperMs 算出 79ms——比真值還小。判讀時請只採信 lowerMs。
//
// 下界本身也有一個前提：接地標記不會把真的觸地誤標成離地。地面高度若估得
// 太高，踩穩的腳會被讀成離地，那時下界也不可信。estimateGroundY 取 96
// 百分位就是為了偏保守。
//
// 前後必須是確定觸地這個條件不能省：若區段被 'unknown' 或序列端點夾住，
// 騰空的起訖根本沒有被觀察到，連下界都失去依據——那段可能任意長。
export function flightIntervals(frames, groundY, fps, threshold = 0.018) {
  const out = [], n = (frames || []).length;
  if (!n) return out;
  const dt = 1000 / Math.max(1, fps);
  const L = contactStates(frames, 'L', groundY, fps, threshold);
  const R = contactStates(frames, 'R', groundY, fps, threshold);
  const off = i => L[i] === 'off' && R[i] === 'off';
  const grounded = i => L[i] === 'contact' || R[i] === 'contact';

  let i = 0;
  while (i < n) {
    if (!off(i)) { i++; continue; }
    const start = i;
    while (i < n && off(i)) i++;
    const end = i - 1;
    // 邊界未被確定觸地夾住 → 界線推不出來，寧可不報
    if (start === 0 || i >= n || !grounded(start - 1) || !grounded(i)) continue;
    const k = end - start + 1;
    out.push({
      startIndex: start, endIndex: end,
      startTime: frames[start].t, endTime: frames[end].t,
      frames: k,
      lowerMs: Math.max(0, (k - 1) * dt),  // 嚴謹下界
      upperMs: (k + 1) * dt,               // 估計值，非嚴謹上界（見上方說明）
      bounded: true,
      detection: judgeDetection(Math.max(0, (k - 1) * dt)),
    });
  }
  return out;
}

// TR54 的彎膝規則規範的是「前導腳自觸地起，到通過身體垂直位置為止」這段
// 支撐期——擺動期把膝蓋彎到 90° 是正常動作。取整段影片的最小膝角會混進
// 擺動期的值，得到一個和規則無關的數字。以下把區間限制回規則真正規範的範圍。

// 把逐格狀態切成連續的 run。
export function runsOf(states, kind) {
  const out = [];
  let i = 0;
  while (i < states.length) {
    if (states[i] !== kind) { i++; continue; }
    const start = i;
    while (i < states.length && states[i] === kind) i++;
    out.push({ start, end: i - 1 });
  }
  return out;
}

// 髖關節通過踝關節正上方的影格（垂直支撐位置），以 hip.x - ankle.x 的變號點判定。
// 用變號而非固定方向，所以左右兩個行進方向都適用。
export function verticalSupportIndex(frames, side, startIdx, endIdx) {
  const hipId = side === 'L' ? 23 : 24, ankleId = side === 'L' ? 27 : 28;
  const at = i => {
    const h = frames[i]?.landmarks?.[hipId], a = frames[i]?.landmarks?.[ankleId];
    return h && a && Number.isFinite(h.x) && Number.isFinite(a.x) ? h.x - a.x : null;
  };
  for (let i = Math.max(0, startIdx); i < Math.min(endIdx, frames.length - 1); i++) {
    const cur = at(i), nxt = at(i + 1);
    if (cur == null || nxt == null) continue;
    if (cur === 0 || cur * nxt < 0) return i;
  }
  return null;
}

// 每一次觸地的支撐期最小膝角。
//
// 回傳的 supportIndex 為 null 代表整段觸地期間髖都沒有通過踝的正上方——
// 通常是選手還沒走到鏡頭中線就出框。此時退回用整段觸地期，並標記 partial，
// 讓判讀者知道這個值涵蓋的範圍比規則規定的大。
export function supportKnee(frames, groundY, fps, threshold = 0.018) {
  const out = { left: [], right: [], minLeft: null, minRight: null };
  if (!frames?.length || groundY == null) return out;

  for (const side of ['L', 'R']) {
    const states = contactStates(frames, side, groundY, fps, threshold);
    const hipId = side === 'L' ? 23 : 24, kneeId = side === 'L' ? 25 : 26,
          ankleId = side === 'L' ? 27 : 28;

    for (const { start, end } of runsOf(states, 'contact')) {
      const support = verticalSupportIndex(frames, side, start, end);
      const stop = support ?? end;
      const angles = [];
      for (let i = start; i <= stop; i++) {
        const lm = frames[i]?.landmarks;
        const a = lm && angleDeg(lm[hipId], lm[kneeId], lm[ankleId]);
        if (Number.isFinite(a)) angles.push(a);
      }
      if (!angles.length) continue;
      (side === 'L' ? out.left : out.right).push({
        startIndex: start, endIndex: end,
        supportIndex: support,
        partial: support == null,
        startTime: frames[start].t, endTime: frames[stop].t,
        minAngle: Math.min(...angles),
      });
    }
  }

  const lowest = list => list.length ? Math.min(...list.map(c => c.minAngle)) : null;
  out.minLeft = lowest(out.left);
  out.minRight = lowest(out.right);
  return out;
}

export function computeFrameMetrics(frame, opts = {}) {
  const lm = frame?.landmarks;
  if (!lm) return { leftKnee: null, rightKnee: null };
  const sigma = opts.uncertaintyEnabled ? (opts.sigmaPx ?? 2) : 0;
  const w = opts.width ?? 1920, h = opts.height ?? 1080;
  const left = angleWithUncertainty(lm[23], lm[25], lm[27], sigma, w, h, 96, (frame.index ?? 0) * 17 + 1);
  const right = angleWithUncertainty(lm[24], lm[26], lm[28], sigma, w, h, 96, (frame.index ?? 0) * 19 + 7);
  return { leftKnee: left, rightKnee: right };
}

export function runMonkeyCore(iterations = 1000) {
  let passed = 0;
  for (let i = 0; i < iterations; i++) {
    const a = {x: Math.random(), y: Math.random()}, b = {x: Math.random(), y: Math.random()}, c = {x: Math.random(), y: Math.random()};
    const ang = angleDeg(a, b, c);
    if (!(ang == null || (ang >= 0 && ang <= 180))) throw new Error(`angle invariant failed @${i}`);
    const u = angleWithUncertainty(a,b,c,2,1920,1080,16,i+1);
    if (u.value != null && !(u.low <= u.value && u.value <= u.high)) throw new Error(`uncertainty invariant failed @${i}`);
    passed++;
  }
  return { passed, iterations };
}

// ---- 量測可信度自診 -----------------------------------------------------
// 這裡的門檻**不是 TR54 判準**，是「這段影片能不能拿來判讀」的檢查。
// 每一條對應 docs/CAPTURE_GUIDE.md 裡一個具體的拍攝原因，
// 因為使用者拿到的是數字，需要的是「所以我該改什麼」。
// 全部只讀報告裡既有的統計量，不碰原始影像。

export const MIN_SCREENING_FPS = 120;        // 40ms 騰空在 60fps 只有 2–3 個取樣點
export const LOW_CONTINUITY = .70;
export const VERY_LOW_CONTINUITY = .40;
// 合格競走選手支撐期的膝角接近伸直。量到明顯小於此值時，
// 先懷疑投影誤差（機位非正側面），而不是宣稱選手彎膝。
export const IMPLAUSIBLE_SUPPORT_KNEE = 160;
// 步態中膝角的尖峰角速度約 300–400°/s。逐格變化的**中位數**就超過這個量級時，
// 那不是動作，是量測跳動——最常見的原因是側面視角下左右腳被交換。
export const MAX_PLAUSIBLE_KNEE_RATE = 400;
// 競走的騰空是 20–40 ms 等級；短跑的騰空也只有約 120 ms。
// 下界超過這個值時，較可能是足部關鍵點遺失而非真的騰空。
export const MAX_PLAUSIBLE_FLIGHT_MS = 200;
const LEVEL_ORDER = {blocker: 0, warn: 1, info: 2};

// 逐格角度變化的中位數（°/秒）。用中位數而不是最大值：
// 真實步態本來就有少數幾格是高角速度，被那幾格帶走就會誤報。
export function kneeChangeRate(frames, key, fps) {
  const steps = [];
  for (let i = 1; i < (frames?.length || 0); i++) {
    const a = frames[i - 1]?.metrics?.[key]?.value, b = frames[i]?.metrics?.[key]?.value;
    if (Number.isFinite(a) && Number.isFinite(b)) steps.push(Math.abs(b - a));
  }
  if (steps.length < 8 || !Number.isFinite(fps) || fps <= 0) return null;
  return percentile(steps, 0.5) * fps;
}

export function diagnoseCapture(report) {
  const s = report?.summary;
  if (!s) return [];
  const set = report.settings || {}, out = [];
  const add = (level, title, cause, action) => out.push({level, title, cause, action});

  const sampleFps = Number(set.sampleFps);
  if (Number.isFinite(sampleFps) && sampleFps < MIN_SCREENING_FPS)
    add('blocker', `分析取樣 ${sampleFps} fps，不足以篩查騰空`,
        `40 ms 的騰空在 ${sampleFps} fps 下只有 ${Math.max(1, Math.round(40 / (1000 / sampleFps)))} 個取樣點，短騰空會直接漏掉。`,
        '提高分析取樣 fps；若原始影片本身低於 120 fps，需重拍。膝角仍可參考。');

  const c = Number(s.continuity);
  if (Number.isFinite(c) && c < VERY_LOW_CONTINUITY)
    add('blocker', `追蹤連續率 ${(c * 100).toFixed(1)}%`,
        '多數影格沒有可靠配對，角度是空的；圖上的斜線留白就是這些影格。',
        '選手在畫面裡太小、背景雜亂或同色、曝光不足。靠近或拉長焦距，讓選手佔畫面高度一半以上。');
  else if (Number.isFinite(c) && c < LOW_CONTINUITY)
    add('warn', `追蹤連續率 ${(c * 100).toFixed(1)}%`,
        '可用影格偏少，趨勢容易被少數幾格帶偏。',
        '同上：放大選手在畫面中的比例，並確認背景與服裝有對比。');

  const knees = [['左', s.minLeftKneeSupport], ['右', s.minRightKneeSupport]]
    .filter(([, v]) => Number.isFinite(v) && v < IMPLAUSIBLE_SUPPORT_KNEE);
  if (knees.length)
    add('warn', `支撐期最小角偏小（${knees.map(([k, v]) => `${k} ${v.toFixed(1)}°`).join('、')}）`,
        '合格競走選手支撐期的膝角接近伸直。量到這個值，最可能是機位不是正側面——離面角度會讓量到的膝角系統性偏小。',
        '把光軸調到垂直於行進方向。在確認機位之前，不要拿這個數字判讀選手。');

  if (s.supportPhases === 0)
    add('blocker', '沒有偵測到任何支撐期',
        'TR54 的彎膝規則只看觸地到通過垂直位置這一段。沒有支撐期就沒有可判讀的膝角。',
        '確認選手雙腳完整入鏡且未出框，並提高追蹤連續率。');
  else if (s.partialSupportPhases > 0)
    add('info', `${s.partialSupportPhases} 段支撐期未涵蓋垂直位置`,
        '這些段落的髖沒有通過踝的正上方（多半是選手提前出框），取值範圍比規則規定的大。',
        '讓選手在畫面中多停留一個完整步態週期再出框。');

  if (s.flightIntervals === 0)
    add('info', '未標記疑似雙腳離地',
        '這是「沒有證明」，不是「沒有騰空」。取樣幀率與連續率不足時，系統以漏報的形式失去靈敏度。',
        '要對騰空下任何結論，需要足夠的幀率與連續率。');

  const fps = Number(set.sampleFps);
  const rates = [['左', 'leftKnee'], ['右', 'rightKnee']]
    .map(([side, key]) => [side, kneeChangeRate(report.frames, key, fps)])
    .filter(([, r]) => Number.isFinite(r) && r > MAX_PLAUSIBLE_KNEE_RATE);
  if (rates.length)
    add('blocker', `膝角逐格跳動過大（${rates.map(([k, r]) => `${k} ${Math.round(r)}°/秒`).join('、')}）`,
        `真實步態的膝角尖峰角速度約 ${MAX_PLAUSIBLE_KNEE_RATE}°/秒，而且一步只擺盪一次。中位數就超過這個量級，代表曲線在逐格跳動——側面視角下左右腳被交換是最常見的原因，關節點不穩也會。`,
        '這種曲線的最小角不能拿來判讀。提高選手在畫面中的比例與對比，讓兩腳可以被分開。');

  const wild = (report.flights || []).filter(f => Number(f.lowerMs) > MAX_PLAUSIBLE_FLIGHT_MS);
  if (wild.length)
    add('blocker', `${wild.length} 段疑似騰空長達 ${Math.round(Math.max(...wild.map(f => f.lowerMs)))} ms`,
        `競走的騰空是 20–40 ms 等級，短跑也只有約 120 ms。超過 ${MAX_PLAUSIBLE_FLIGHT_MS} ms 不是騰空，是足部關鍵點在那段時間遺失。`,
        '確認選手雙腳全程入鏡、未被其他人遮擋，且下半身沒有因為曝光或背景而糊掉。');

  const unprovable = (report.flights || []).filter(f => !(Number(f.lowerMs) > 0)).length;
  if (unprovable)
    add('info', `${unprovable} 段離地觀測無法證明任何長度`,
        '只觀察到單格雙腳離地時，取樣界線的下界是 0——這不構成證據，已與可證明的區間分開列示。',
        '提高分析取樣 fps 才能把這類觀測變成可證明的區間。');

  const missing = Number(s.frames) - Number(s.trackedFrames);
  const stop = report.trackingStop;
  if (stop && Number(stop.time) < .5 && Number.isFinite(c) && c < LOW_CONTINUITY)
    add('warn', `第 ${stop.time.toFixed(2)} 秒就失去配對`,
        '這麼早失聯，通常代表使用者確認的那一格骨架本身就不準；種子不準，後面全部跟著歪。',
        '先按「辨識目前畫面人物」，確認縮圖上的骨架貼得住，再開始分析。');

  if (!out.length && missing === 0)
    add('info', '沒有偵測到明顯的拍攝問題',
        '這只表示上列檢查都通過，不是量測準確度的保證——本工具尚未以實拍校準。',
        '仍請回看原片核對疊圖是否合理。');

  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
