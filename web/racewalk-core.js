/**
 * 競走步態分析核心演算法 — JavaScript 版。
 *
 * 這是 racewalk/ 下 Python 實作的移植，行為必須逐數值一致。
 * tools/verify-port.mjs 會用同一組合成軌跡比對兩邊的輸出，
 * 任何一邊改動而另一邊沒跟上，驗證就會失敗。
 *
 * 對應關係：
 *   signal.py      → Signal
 *   capability.py  → Capability
 *   gait/events.py → Events
 *   gait/features.py → Features
 *   synth.py       → Synth（僅供驗證與示範用）
 *
 * 不依賴 DOM，可以在瀏覽器與 Node 兩邊跑。
 */

// ---------------------------------------------------------------- Signal

export const Signal = {
  /** 二階 Butterworth 低通的 biquad 係數（雙線性轉換）。 */
  butter2Lowpass(cutoffHz, fs) {
    if (!(cutoffHz > 0 && cutoffHz < fs / 2)) {
      throw new RangeError(`截止頻率 ${cutoffHz} Hz 必須介於 0 與 Nyquist (${fs / 2}) 之間`);
    }
    const wc = Math.tan((Math.PI * cutoffHz) / fs);
    const k1 = Math.SQRT2 * wc;
    const k2 = wc * wc;
    const a0 = 1 + k1 + k2;
    return {
      b: [k2 / a0, (2 * k2) / a0, k2 / a0],
      a: [1, (2 * (k2 - 1)) / a0, (1 - k1 + k2) / a0],
    };
  },

  /**
   * Direct form I，單向。
   *
   * 狀態以 x[0] 為基準而非零。足部座標的 DC 偏移動輒數百像素，
   * 若讓狀態從零開始，輸出會在開頭衝出一段幅度數百像素的假訊號。
   */
  lfilter(b, a, x) {
    const offset = x.length ? x[0] : 0;
    const xs = x.map((v) => v - offset);
    const y = new Array(xs.length).fill(0);

    for (let n = 0; n < xs.length; n++) {
      let acc = b[0] * xs[n];
      if (n >= 1) acc += b[1] * xs[n - 1] - a[1] * y[n - 1];
      if (n >= 2) acc += b[2] * xs[n - 2] - a[2] * y[n - 2];
      y[n] = acc;
    }
    return y.map((v) => v + offset);
  },

  /**
   * 零相位低通：前向 + 後向各濾一次。
   *
   * 邊界用鏡像填補。奇對稱反射會把雜訊汙染的端點放大兩倍灌進濾波器，
   * 實測尾端殘差 0.35 vs 鏡像的 0.09。
   */
  filtfilt(x, cutoffHz, fs, pad = 12) {
    if (x.length < 4) return [...x];
    const { b, a } = Signal.butter2Lowpass(cutoffHz, fs);

    const p = Math.min(pad, x.length - 1);
    const head = [];
    for (let i = p; i >= 1; i--) head.push(x[i]);
    // 取 p 個元素：索引 len-2 往下數到 len-1-p（含）。
    // 邊界差一個元素就會讓後向濾波的暫態不同，低幀率下造成約 1e-4 ms 的偏差。
    const tail = [];
    for (let i = x.length - 2; i >= x.length - 1 - p && i >= 0; i--) tail.push(x[i]);

    const padded = [...head, ...x, ...tail];
    const forward = Signal.lfilter(b, a, padded);
    const backward = Signal.lfilter(b, a, [...forward].reverse()).reverse();

    return backward.slice(p, p + x.length);
  },

  /** 中央差分；兩端退回單邊差分。 */
  derivative(x, dt) {
    const n = x.length;
    if (n < 2) return new Array(n).fill(0);
    const out = new Array(n).fill(0);
    out[0] = (x[1] - x[0]) / dt;
    out[n - 1] = (x[n - 1] - x[n - 2]) / dt;
    for (let i = 1; i < n - 1; i++) out[i] = (x[i + 1] - x[i - 1]) / (2 * dt);
    return out;
  },

  /** 線性內插的百分位數（q 為 0–100）。 */
  percentile(x, q) {
    if (!x.length) throw new RangeError("空序列沒有百分位數");
    const s = [...x].sort((m, n) => m - n);
    if (s.length === 1) return s[0];
    const pos = (q / 100) * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, s.length - 1);
    const frac = pos - lo;
    return s[lo] * (1 - frac) + s[hi] * frac;
  },

  /**
   * 把不可信的區段以線性內插填補。
   *
   * 為什麼不能直接沿用前一格的值：那會造出一段水平的平台，而水平平台正是
   * 「腳踩在地上」的特徵。遮擋一發生就生出一次假觸地，這比沒有資料更糟。
   *
   * 內插不會讓遮擋期間的資料變成真的——事件仍須由信心度守門。這一步只是
   * 避免把垃圾餵進濾波器汙染鄰近的影格。
   */
  interpolateGaps(x, valid) {
    if (x.length !== valid.length) throw new RangeError("valid 遮罩與序列長度必須一致");
    if (!valid.some(Boolean)) return [...x];

    const out = [...x];
    const n = x.length;
    const first = valid.indexOf(true);
    const last = valid.lastIndexOf(true);

    // 頭尾的無效區段無法內插，只能延伸最近的有效值
    for (let i = 0; i < first; i++) out[i] = x[first];
    for (let i = last + 1; i < n; i++) out[i] = x[last];

    let i = first;
    while (i <= last) {
      if (valid[i]) { i += 1; continue; }
      const gapStart = i;
      while (i <= last && !valid[i]) i += 1;
      const gapEnd = i;
      const y0 = x[gapStart - 1];
      const y1 = x[gapEnd];
      const span = gapEnd - (gapStart - 1);
      for (let k = gapStart; k < gapEnd; k++) {
        out[k] = y0 + ((y1 - y0) * (k - (gapStart - 1))) / span;
      }
    }
    return out;
  },

  /**
   * 門檻交越位置，回傳次幀精度的浮點索引。
   *
   * 若只回整數索引，IC/TO 的誤差下限就是一個影格（240fps 下 4.2ms），
   * 對 40ms 的判定來說太粗。
   */
  crossings(x, threshold, rising) {
    const out = [];
    for (let i = 0; i < x.length - 1; i++) {
      const a = x[i];
      const b = x[i + 1];
      const hit = rising ? a < threshold && threshold <= b : a >= threshold && threshold > b;
      if (!hit) continue;
      out.push(b === a ? i : i + (threshold - a) / (b - a));
    }
    return out;
  },
};

// ------------------------------------------------------------ Capability

/**
 * 人眼可見性門檻的預設值（毫秒）。
 *
 * 這是可調參數，不是物理常數——規則寫的是「肉眼可見的騰空」，
 * 而「可見」沒有官方數值定義。40ms 是起始假設，須以裁判對照校準。
 */
export const DEFAULT_VISIBILITY_THRESHOLD_MS = 40;
export const MIN_FPS_FOR_FLIGHT = 120;
export const FPS_FOR_FULL_CONFIDENCE = 240;

export const Capability = {
  assess(fps) {
    if (!(fps > 0)) throw new RangeError(`幀率必須為正數，收到 ${fps}`);

    const frameIntervalMs = 1000 / fps;
    let tier;
    if (fps >= FPS_FOR_FULL_CONFIDENCE) tier = "full";
    else if (fps >= MIN_FPS_FOR_FLIGHT) tier = "reduced";
    else tier = "gait_only";

    return {
      fps,
      tier,
      frameIntervalMs,
      flightUncertaintyMs: frameIntervalMs * 0.5,
      flightTimeReliable: tier !== "gait_only",
    };
  },

  describe(cap) {
    const head = `${formatNum(cap.fps)} fps（每幀 ${cap.frameIntervalMs.toFixed(1)} ms）`;
    if (cap.tier === "full") return `${head} — 騰空量測可靠`;
    if (cap.tier === "reduced") {
      return `${head} — 騰空量測可用，但不確定度達 ±${cap.flightUncertaintyMs.toFixed(
        1
      )} ms，判讀時務必連同誤差一起看`;
    }
    return `${head} — 幀率不足，不輸出騰空時間；僅提供膝角、步頻、步長`;
  },

  /**
   * 把騰空時間對應到結論。
   *
   * 回傳值永遠是「疑似」而非「犯規」。系統不做判罰，判定權屬於裁判。
   */
  flightVerdict(flightMs, cap, thresholdMs = DEFAULT_VISIBILITY_THRESHOLD_MS) {
    if (!cap.flightTimeReliable) return "unreliable";
    const u = cap.flightUncertaintyMs;
    if (flightMs - u > thresholdMs) return "suspected";
    if (flightMs + u < thresholdMs) return "within_tolerance";
    return "inconclusive";
  },
};

// ---------------------------------------------------------------- Events

export const DEFAULT_CUTOFF_HZ = 50;
export const MAX_CUTOFF_RATIO = 0.4;
export const DEFAULT_CONTACT_BAND = 0.06;
export const MIN_CONTACT_MS = 60;
export const MIN_SWING_MS = 100;
export const MIN_AMPLITUDE_PX = 1;

// 關鍵點信心度的下限。低於此值的影格視為沒有觀察到，不參與地面高度與
// 振幅的估計，落在其中的交越也不會成為事件。
export const MIN_KEYPOINT_CONFIDENCE = 0.5;

// 整段軌跡至少要有這個比例的可信影格，否則直接放棄。
// 比賽的集團畫面常常連這條都過不了——那是畫面的限制，不是演算法的問題，
// 此時回報「量不了」遠比給出一組看似精確的數字誠實。
export const MIN_CONFIDENT_FRACTION = 0.5;

// 判定交越是否落在可信區間時，往前後各檢查幾格。
export const CONFIDENCE_MARGIN_FRAMES = 2;
export const NOISE_MARGIN = 6;

export const Events = {
  /**
   * 估計序列中殘留的高頻雜訊（像素標準差）。
   *
   * 量的是「濾波後還剩多少」而非「濾掉了多少」：低幀率影片的截止頻率
   * 會被 Nyquist 夾得很高，濾波器其實沒濾掉多少東西。
   */
  residualNoisePx(y) {
    if (y.length < 3) return 0;
    const rough = [];
    for (let i = 1; i < y.length - 1; i++) rough.push(y[i] - (y[i - 1] + y[i + 1]) / 2);
    const n = rough.length;
    const mean = rough.reduce((s, v) => s + v, 0) / n;
    const variance = rough.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
    return Math.sqrt(variance) / 1.2247;
  },

  /**
   * 依實測雜訊放寬觸地門檻。
   *
   * 門檻一旦落進雜訊振幅範圍，雜訊自己就會製造假交越，結果從「稍微不準」
   * 直接崩壞成「完全錯誤」。雜訊小時維持高精度，雜訊大時寧可犧牲精度。
   */
  adaptiveBand(filtered, amplitude, floor) {
    if (amplitude <= 0) return floor;
    return Math.max(floor, (NOISE_MARGIN * Events.residualNoisePx(filtered)) / amplitude);
  },

  /**
   * 偵測單腳的觸地 (IC) / 離地 (TO) 事件。
   *
   * 門檻寬度是最關鍵的參數：門檻必然設在地面之上，使 TO 偏晚、IC 偏早，
   * 而騰空時間夾在兩者之間，會被系統性低估兩倍偏差。實測門檻 0.25 造成
   * ±11ms 偏差，0.06 則小於 1ms。
   */
  /**
   * 共用的前處理：信心度守門、濾波、地面高度與觸地門檻。
   *
   * 事件偵測與 contactMask() 必須用同一組門檻，否則「這一格算不算踩在地上」
   * 在兩邊會給出不同答案。
   */
  _prepare(track, fps, cutoffHz = DEFAULT_CUTOFF_HZ, contactBand = DEFAULT_CONTACT_BAND) {
    const n = track.y.length;
    if (n < 8) return null;

    // 信心度守門。比賽的集團畫面裡，被追蹤選手的腳會週期性被別人擋住，
    // 那些影格的關鍵點座標是垃圾。若讓它們參與地面高度與振幅的估計，
    // 整條軌跡的門檻都會跟著跑掉。
    const confs = track.confidence ?? new Array(n).fill(1);
    const valid = confs.map((c) => c >= MIN_KEYPOINT_CONFIDENCE);
    if (valid.filter(Boolean).length < n * MIN_CONFIDENT_FRACTION) return null;

    const y = Signal.filtfilt(
      Signal.interpolateGaps(track.y, valid),
      Math.min(cutoffHz, fps * MAX_CUTOFF_RATIO),
      fps
    );

    // 影像座標 y 向下為正 → 腳踩在地上時 y 最大。只取可信的影格來估地面與振幅。
    const confidentY = y.filter((_, i) => valid[i]);
    const ground = Signal.percentile(confidentY, 95);
    const amplitude = ground - Signal.percentile(confidentY, 5);
    if (amplitude < MIN_AMPLITUDE_PX) return null;

    const band = Events.adaptiveBand(y, amplitude, contactBand);
    return { y, valid, ground, amplitude, threshold: ground - amplitude * band };
  },

  /**
   * 逐格回答「這隻腳在地面上嗎」。true = 在地面，false = 離地，null = 不知道。
   *
   * null 不可以當成 false。把「不知道」誤讀成「離地」會憑空生出騰空。
   */
  contactMask(track, fps, opts = {}) {
    const prepared = Events._prepare(track, fps, opts.cutoffHz, opts.contactBand);
    if (!prepared) return new Array(track.y.length).fill(null);
    return prepared.y.map((v, i) => (prepared.valid[i] ? v >= prepared.threshold : null));
  },

  detect(track, fps, opts = {}) {
    const { cutoffHz = DEFAULT_CUTOFF_HZ, contactBand = DEFAULT_CONTACT_BAND,
            minContactMs = MIN_CONTACT_MS } = opts;

    const prepared = Events._prepare(track, fps, cutoffHz, contactBand);
    if (!prepared) return [];

    const dtMs = 1000 / fps;
    const { y, valid, threshold } = prepared;

    const velocity = Signal.derivative(y, dtMs / 1000);
    const conf = (idx) => Events._confidence(track, velocity, idx);

    let events = [
      ...Signal.crossings(y, threshold, true).map((idx) => ({ idx, kind: "IC" })),
      ...Signal.crossings(y, threshold, false).map((idx) => ({ idx, kind: "TO" })),
    ]
      // 落在遮擋區間裡的交越是內插的產物，不是觀察到的事件
      .filter(({ idx }) => Events._inConfidentRegion(valid, idx))
      .map(({ idx, kind }) => ({
        foot: track.foot,
        kind,
        tMs: idx * dtMs,
        confidence: conf(idx),
      }));

    events.sort((a, b) => a.tMs - b.tMs);
    events = Events._mergeShortGaps(events, MIN_SWING_MS);
    return Events._dropShortContacts(events, minContactMs);
  },

  /**
   * 交越點前後 margin 格是否都可信。
   *
   * 只檢查交越點那一格是不夠的：遮擋的邊緣正是關鍵點開始飄移的地方，
   * 而飄移本身就會製造交越。
   */
  _inConfidentRegion(valid, idx, margin = CONFIDENCE_MARGIN_FRAMES) {
    const lo = Math.max(0, Math.trunc(idx) - margin);
    const hi = Math.min(valid.length, Math.trunc(idx) + margin + 2);
    for (let i = lo; i < hi; i++) if (!valid[i]) return false;
    return true;
  },

  _confidence(track, velocity, idx) {
    const i = Math.min(Math.trunc(idx), velocity.length - 1);
    const kpConf = track.confidence && i < track.confidence.length ? track.confidence[i] : 1;
    const speed = Math.abs(velocity[i]);
    const reference = Math.max(...velocity.map(Math.abs)) || 1;
    const sharpness = reference ? Math.min(1, speed / (reference * 0.1)) : 0;
    return Math.round(kpConf * (0.5 + 0.5 * sharpness) * 1e4) / 1e4;
  },

  /**
   * 把單腳觸地期間的短暫掉格補回去。
   *
   * 物理約束：一隻腳離地後必須向前擺盪再落下，不可能在幾毫秒內回到地面。
   * 不會誤刪真正的騰空——真正的騰空發生在不同腳之間，這裡只看單腳序列。
   */
  _mergeShortGaps(events, minSwingMs) {
    const kept = [];
    let i = 0;
    while (i < events.length) {
      const cur = events[i];
      const next = events[i + 1];
      if (cur.kind === "TO" && next && next.kind === "IC" && next.tMs - cur.tMs < minSwingMs) {
        i += 2;
        continue;
      }
      kept.push(cur);
      i += 1;
    }
    return kept;
  },

  _dropShortContacts(events, minContactMs) {
    const kept = [];
    let i = 0;
    while (i < events.length) {
      const cur = events[i];
      const next = events[i + 1];
      if (cur.kind === "IC" && next && next.kind === "TO" && next.tMs - cur.tMs < minContactMs) {
        i += 2;
        continue;
      }
      kept.push(cur);
      i += 1;
    }
    return kept;
  },

  /**
   * 配對成觸地區間。只取完整的 IC→TO。
   *
   * 影片開頭已踩在地上、或結尾還沒抬腳的半段，無法得知真正起訖時間，
   * 寧可捨棄也不要猜。
   */
  toContacts(events, foot) {
    const intervals = [];
    let pending = null;
    for (const ev of events) {
      if (ev.foot !== foot) continue;
      if (ev.kind === "IC") pending = ev.tMs;
      else if (ev.kind === "TO" && pending !== null) {
        intervals.push({ foot, startMs: pending, endMs: ev.tMs, durationMs: ev.tMs - pending });
        pending = null;
      }
    }
    return intervals;
  },
};

// -------------------------------------------------------------- Features

export const Features = {
  /** 合併成「至少有一腳在地面」的區間。 */
  mergeContacts(contacts) {
    if (!contacts.length) return [];
    const spans = contacts.map((c) => [c.startMs, c.endMs]).sort((a, b) => a[0] - b[0]);
    const merged = [[...spans[0]]];
    for (const [start, end] of spans.slice(1)) {
      if (start <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return merged;
  },

  /**
   * 雙腳皆離地的區間。
   *
   * 只取被兩側觸地夾住的空隙——序列最前與最後的空檔可能只是影片還沒
   * 拍到腳，不是真的騰空。
   */
  findFlights(contacts, cap, thresholdMs = DEFAULT_VISIBILITY_THRESHOLD_MS) {
    const merged = Features.mergeContacts(contacts);
    const flights = [];
    for (let i = 0; i + 1 < merged.length; i++) {
      const startMs = merged[i][1];
      const endMs = merged[i + 1][0];
      const durationMs = endMs - startMs;
      if (durationMs <= 0) continue;
      flights.push({
        startMs,
        endMs,
        durationMs,
        verdict: Capability.flightVerdict(durationMs, cap, thresholdMs),
      });
    }
    return flights;
  },

  /** 步頻（每分鐘步數），由相鄰觸地起點間隔的中位數推算。 */
  cadenceSpm(contacts) {
    const starts = contacts.map((c) => c.startMs).sort((a, b) => a - b);
    if (starts.length < 2) return null;
    const gaps = [];
    for (let i = 0; i + 1 < starts.length; i++) gaps.push(starts[i + 1] - starts[i]);
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    if (median <= 0) return null;
    return Math.round((60000 / median) * 100) / 100;
  },

  /**
   * 膝關節角度（度）。180° 為完全伸直。
   *
   * 回傳 null 表示關鍵點無效或肢段長度為零——此時不該猜一個數字出來。
   */
  kneeAngle(hip, knee, ankle) {
    for (const p of [hip, knee, ankle]) {
      if (!p || (p.confidence !== undefined && p.confidence <= 0)) return null;
    }
    const ux = hip.x - knee.x;
    const uy = hip.y - knee.y;
    const vx = ankle.x - knee.x;
    const vy = ankle.y - knee.y;
    const nu = Math.hypot(ux, uy);
    const nv = Math.hypot(vx, vy);
    if (nu === 0 || nv === 0) return null;
    const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)));
    return (Math.acos(cosine) * 180) / Math.PI;
  },

  /**
   * 髖關節通過踝關節正上方的影格索引（垂直支撐位置）。
   *
   * 這是 TR54 彎膝規則的區間終點：前導腳自觸地起到通過身體垂直位置為止。
   */
  verticalSupportIndex(hips, ankles, startIdx) {
    const n = Math.min(hips.length, ankles.length) - 1;
    for (let i = Math.max(0, startIdx); i < n; i++) {
      const cur = hips[i].x - ankles[i].x;
      const nxt = hips[i + 1].x - ankles[i + 1].x;
      if (cur === 0 || cur * nxt < 0) return i;
    }
    return null;
  },

  /** 觸地到通過垂直支撐位置期間的最小膝角。 */
  minKneeAngleDuringSupport(hips, knees, ankles, startIdx, endIdx) {
    const angles = [];
    const end = Math.min(endIdx + 1, knees.length);
    for (let i = Math.max(0, startIdx); i < end; i++) {
      const a = Features.kneeAngle(hips[i], knees[i], ankles[i]);
      if (a !== null) angles.push(a);
    }
    return angles.length ? Math.min(...angles) : null;
  },

  buildReport(fps, contacts, cap, thresholdMs = DEFAULT_VISIBILITY_THRESHOLD_MS) {
    const notes = [];
    if (!cap.flightTimeReliable) {
      notes.push(
        `幀率 ${formatNum(fps)} fps 低於騰空判定所需的 120 fps，` +
          `騰空時間僅供參考，不可作為任何判讀依據。`
      );
    }
    if (!contacts.length) {
      notes.push("未偵測到任何完整的觸地區間，請檢查追蹤與姿態估計的結果。");
    }
    return {
      fps,
      contacts,
      flights: Features.findFlights(contacts, cap, thresholdMs),
      cadenceSpm: Features.cadenceSpm(contacts),
      notes,
    };
  },
};

// ----------------------------------------------------------------- Synth

const SWING_SHARPNESS = 0.6;

/** 可重現的亂數（移植驗證需要與 Python 無關的自有序列）。 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const Synth = {
  /** 合成左右腳軌跡與真值觸地區間，供驗證與示範使用。 */
  tracks({
    fps = 240,
    nCycles = 4,
    contactMs = 300,
    flightMs = 30,
    ground = 500,
    amplitude = 120,
    noisePx = 0,
    seed = 0,
  } = {}) {
    const rand = mulberry32(seed);
    const gauss = () => {
      const u = Math.max(rand(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };

    const period = contactMs + flightMs;
    const swingMs = contactMs + 2 * flightMs;
    const leadMs = swingMs;

    const left = [];
    const right = [];
    for (let k = 0; k < nCycles; k++) {
      const base = 2 * k * period + leadMs;
      left.push([base, base + contactMs]);
      right.push([base + period, base + period + contactMs]);
    }

    const durationMs = right[right.length - 1][1] + swingMs;

    const trajectory = (schedule, foot) => {
      const dtMs = 1000 / fps;
      const nFrames = Math.trunc(durationMs / dtMs) + 1;
      const firstStart = schedule[0][0];
      const lastEnd = schedule[schedule.length - 1][1];
      const y = [];

      for (let i = 0; i < nFrames; i++) {
        const t = i * dtMs;
        let value = ground;

        if (!schedule.some(([s, e]) => s <= t && t <= e)) {
          const ends = schedule.filter(([, e]) => e <= t).map(([, e]) => e);
          const starts = schedule.filter(([s]) => s >= t).map(([s]) => s);
          const prevEnd = ends.length ? Math.max(...ends) : firstStart - swingMs;
          const nextStart = starts.length ? Math.min(...starts) : lastEnd + swingMs;
          if (nextStart > prevEnd) {
            // 夾在 [0,1]：虛擬擺動期可能讓 t 落在區間外，sin 為負時取分數次方會是 NaN
            const u = Math.min(1, Math.max(0, (t - prevEnd) / (nextStart - prevEnd)));
            value = ground - amplitude * Math.sin(Math.PI * u) ** SWING_SHARPNESS;
          }
        }

        if (noisePx) value += gauss() * noisePx;
        y.push(value);
      }
      return { foot, y, confidence: new Array(y.length).fill(1) };
    };

    const truth = [
      ...left.map(([s, e]) => ({ foot: "L", startMs: s, endMs: e })),
      ...right.map(([s, e]) => ({ foot: "R", startMs: s, endMs: e })),
    ].sort((a, b) => a.startMs - b.startMs);

    return { left: trajectory(left, "L"), right: trajectory(right, "R"), truth };
  },
};

// ---------------------------------------------------------------- Screen
//
// 可疑片段粗篩。移植自 racewalk/screen.py，行為必須逐數值一致。
//
// 粗篩回答的問題和精確量測不同：不是「騰空幾毫秒」，而是「哪幾秒鐘值得
// 人親自看一眼」。核心手法是界線而非估計——若觀察到連續 k 格雙腳都離地，
// 取樣間隔 Δ，且前後各有一格確定踩地，則騰空時間必然落在
// ((k-1)·Δ, (k+1)·Δ)。這是取樣推出的邏輯界線，任何幀率下都成立。

export const DEFAULT_KNEE_THRESHOLD_DEG = 168;
export const KNEE_SCORE_SPAN_DEG = 12;
export const RHYTHM_MAD_THRESHOLD = 3;
export const LOW_COVERAGE_FRACTION = 0.7;

export const Screen = {
  /**
   * 由「連續幾格雙腳離地」推出騰空時間的上下界（毫秒）。
   * k=1 時下界為 0——只看到一格，什麼都證明不了。
   */
  flightBounds(airborneFrames, fps) {
    if (airborneFrames < 1) throw new RangeError("離地影格數必須至少為 1");
    const dtMs = 1000 / fps;
    return [(airborneFrames - 1) * dtMs, (airborneFrames + 1) * dtMs];
  },

  /**
   * 找出雙腳皆「確定」離地的連續區段，且前後各有一格確定踩地。
   * 任一腳為 null（不知道）就中斷——把不知道當成離地會憑空生出騰空。
   */
  airborneRuns(left, right) {
    const n = Math.min(left.length, right.length);
    const runs = [];
    let i = 0;

    while (i < n) {
      if (!(left[i] === false && right[i] === false)) { i += 1; continue; }
      const start = i;
      while (i < n && left[i] === false && right[i] === false) i += 1;
      const end = i;

      const beforeOk = start > 0 && (left[start - 1] === true || right[start - 1] === true);
      const afterOk = end < n && (left[end] === true || right[end] === true);
      if (beforeOk && afterOk) runs.push([start, end]);
    }
    return runs;
  },

  _windowQuality(left, right, startIdx, endIdx) {
    const lo = Math.max(0, startIdx);
    const hi = Math.min(left.confidence.length, endIdx + 1);
    if (hi <= lo) return 0;
    const values = [...left.confidence.slice(lo, hi), ...right.confidence.slice(lo, hi)];
    return values.reduce((s, v) => s + v, 0) / values.length;
  },

  /**
   * 標出「可以斷言騰空超過門檻」的片段。
   * 只在下界超過門檻時標記——這種陳述不依賴任何精度假設。
   */
  flights(left, right, fps, thresholdMs = DEFAULT_VISIBILITY_THRESHOLD_MS) {
    const leftMask = Events.contactMask(left, fps);
    const rightMask = Events.contactMask(right, fps);
    const dtMs = 1000 / fps;
    const findings = [];

    for (const [start, end] of Screen.airborneRuns(leftMask, rightMask)) {
      const k = end - start;
      const [lower, upper] = Screen.flightBounds(k, fps);
      if (lower <= thresholdMs) continue;

      findings.push({
        signal: "visible_flight",
        startMs: start * dtMs,
        endMs: end * dtMs,
        score: Math.min(1, (lower - thresholdMs) / thresholdMs),
        quality: Screen._windowQuality(left, right, start, end),
        headline: `騰空至少 ${lower.toFixed(0)} ms`,
        detail:
          `連續 ${k} 格觀察到雙腳皆離地。取樣間隔 ${dtMs.toFixed(1)} ms，` +
          `因此騰空時間必定介於 ${lower.toFixed(0)}–${upper.toFixed(0)} ms 之間，` +
          `下界已超過 ${thresholdMs.toFixed(0)} ms 門檻。`,
        metrics: { airborneFrames: k, lowerMs: lower, upperMs: upper },
      });
    }
    return findings;
  },

  /** 標出支撐期膝角明顯彎曲的觸地。膝角是幾何量，低幀率下仍然可用。 */
  knee(contacts, joints, fps, left, right, kneeThresholdDeg = DEFAULT_KNEE_THRESHOLD_DEG) {
    const dtMs = 1000 / fps;
    const findings = [];

    for (const contact of contacts) {
      const legs = joints[contact.foot];
      if (!legs) continue;
      const { hip, knee, ankle } = legs;

      const startIdx = Math.round(contact.startMs / dtMs);
      const supportIdx = Features.verticalSupportIndex(hip, ankle, startIdx);
      const endIdx = supportIdx ?? Math.round(contact.endMs / dtMs);

      const angle = Features.minKneeAngleDuringSupport(hip, knee, ankle, startIdx, endIdx);
      if (angle === null || angle >= kneeThresholdDeg) continue;

      findings.push({
        signal: "bent_knee",
        startMs: contact.startMs,
        endMs: Math.min(contact.endMs, endIdx * dtMs),
        score: Math.min(1, (kneeThresholdDeg - angle) / KNEE_SCORE_SPAN_DEG),
        quality: Screen._windowQuality(left, right, startIdx, endIdx),
        headline: `${contact.foot} 腳支撐期最小膝角 ${angle.toFixed(0)}°`,
        detail:
          `觸地到通過垂直支撐位置期間，膝關節最小角度 ${angle.toFixed(1)}°，` +
          `低於 ${kneeThresholdDeg.toFixed(0)}° 的檢視門檻。` +
          `注意非矢狀面拍攝會讓角度偏小，請以影片複核。`,
        metrics: { minKneeAngleDeg: angle },
      });
    }
    return findings;
  },

  /** 標出觸地時間明顯偏離該選手自身節奏的步伐（相對比較，對拍攝條件不敏感）。 */
  rhythm(contacts, left, right, fps, madThreshold = RHYTHM_MAD_THRESHOLD) {
    if (contacts.length < 5) return [];

    const dtMs = 1000 / fps;
    const median = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    const med = median(contacts.map((c) => c.durationMs));
    const mad = median(contacts.map((c) => Math.abs(c.durationMs - med)));
    if (mad <= 0) return [];

    const findings = [];
    for (const contact of contacts) {
      const z = Math.abs(contact.durationMs - med) / mad;
      if (z < madThreshold) continue;

      findings.push({
        signal: "irregular_rhythm",
        startMs: contact.startMs,
        endMs: contact.endMs,
        score: Math.min(1, (z - madThreshold) / madThreshold),
        quality: Screen._windowQuality(
          left, right, Math.round(contact.startMs / dtMs), Math.round(contact.endMs / dtMs)
        ),
        headline: `${contact.foot} 腳觸地 ${contact.durationMs.toFixed(0)} ms，偏離節奏`,
        detail:
          `這一步的觸地時間與該選手中位數 ${med.toFixed(0)} ms 相差 ` +
          `${Math.abs(contact.durationMs - med).toFixed(0)} ms（${z.toFixed(1)} 倍 MAD）。` +
          `節奏斷裂本身不是犯規，但常伴隨犯規出現。`,
        metrics: { contactMs: contact.durationMs, medianMs: med, z },
      });
    }
    return findings;
  },

  coverage(left, right, fps) {
    const masks = [...Events.contactMask(left, fps), ...Events.contactMask(right, fps)];
    if (!masks.length) return 0;
    return masks.filter((m) => m !== null).length / masks.length;
  },

  /** 跑完所有粗篩訊號，依 score × quality 排序。 */
  run(left, right, fps, { contacts = null, joints = null,
                          thresholdMs = DEFAULT_VISIBILITY_THRESHOLD_MS,
                          kneeThresholdDeg = DEFAULT_KNEE_THRESHOLD_DEG } = {}) {
    const cap = Capability.assess(fps);
    let findings = Screen.flights(left, right, fps, thresholdMs);

    if (contacts && contacts.length) {
      findings = findings.concat(Screen.rhythm(contacts, left, right, fps));
      if (joints) {
        findings = findings.concat(
          Screen.knee(contacts, joints, fps, left, right, kneeThresholdDeg)
        );
      }
    }

    // 訊號再強，資料不可信就不該排前面
    const priority = (f) => f.score * f.quality;
    findings.sort((a, b) => priority(b) - priority(a));

    const coverage = Screen.coverage(left, right, fps);
    const notes = [];

    if (coverage < LOW_COVERAGE_FRACTION) {
      notes.push(
        `只有 ${(coverage * 100).toFixed(0)}% 的影格可信，其餘多半是遮擋。` +
        `粗篩只在可信的片段上進行，沒被標記不代表沒有問題——也可能只是那段看不到。`
      );
    }
    if (!cap.flightTimeReliable) {
      notes.push(
        `${formatNum(fps)} fps 無法量出精確的騰空時間，騰空標記改用取樣界線：` +
        `只在「無論取樣落在哪裡，騰空都超過 ${thresholdMs.toFixed(0)} ms」時才標記。` +
        `靈敏度因此偏低——小幅度的騰空在這個幀率下無法分辨。`
      );
    }
    if (!findings.length) {
      notes.push("沒有片段達到標記門檻。這代表沒有明顯到能被證明的問題，不代表完全合規。");
    }

    return { fps, findings, coverage, notes };
  },
};

// ------------------------------------------------------------- 管線入口

/** 由左右腳軌跡跑完 N6 → N7，回傳完整報告。 */
export function analyseTracks(left, right, fps, thresholdMs = DEFAULT_VISIBILITY_THRESHOLD_MS) {
  const detected = [...Events.detect(left, fps), ...Events.detect(right, fps)];
  const contacts = [...Events.toContacts(detected, "L"), ...Events.toContacts(detected, "R")].sort(
    (a, b) => a.startMs - b.startMs
  );
  return Features.buildReport(fps, contacts, Capability.assess(fps), thresholdMs);
}

function formatNum(v) {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
}
