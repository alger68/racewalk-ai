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
