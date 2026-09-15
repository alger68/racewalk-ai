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

export function footContact(landmarks, side, groundY, threshold = 0.018) {
  if (!landmarks || groundY == null) return 'unknown';
  const ids = side === 'L' ? [27, 29, 31] : [28, 30, 32];
  const pts = ids.map(i => landmarks[i]).filter(p => p && (p.visibility ?? 1) > 0.3);
  if (pts.length < 2) return 'unknown';
  const lowest = Math.max(...pts.map(p => p.y));
  const gap = groundY - lowest;
  return gap <= threshold && gap >= -threshold * 1.4 ? 'contact' : 'off';
}

export function flightIntervals(frames, groundY, fps, threshold = 0.018) {
  const out = [];
  let start = null;
  const dt = 1000 / Math.max(1, fps);
  for (let i = 0; i < frames.length; i++) {
    const l = footContact(frames[i].landmarks, 'L', groundY, threshold);
    const r = footContact(frames[i].landmarks, 'R', groundY, threshold);
    const bothOff = l === 'off' && r === 'off';
    if (bothOff && start == null) start = i;
    if ((!bothOff || i === frames.length - 1) && start != null) {
      const end = bothOff && i === frames.length - 1 ? i : i - 1;
      const n = end - start + 1;
      out.push({
        startIndex: start,
        endIndex: end,
        startTime: frames[start].t,
        endTime: frames[end].t,
        frames: n,
        lowerMs: Math.max(0, (n - 1) * dt),
        upperMs: (n + 1) * dt,
      });
      start = null;
    }
  }
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
