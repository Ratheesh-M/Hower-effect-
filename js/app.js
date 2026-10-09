(() => {
  'use strict';

  const stage  = document.getElementById('stage');
  const canvas = document.getElementById('reveal');
  const ctx    = canvas.getContext('2d');

  // Offscreen mask: white where the night scene shows through
  const mask  = document.createElement('canvas');
  const mctx  = mask.getContext('2d');

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp  = (v, a, b) => (v < a ? a : v > b ? b : v);
  const TAU    = Math.PI * 2;
  const rnd    = (a, b) => a + Math.random() * (b - a);

  /* ---------- Tunables (these set the "feel" from the reference video) ---------- */
  const SPACING = 12;      // px between stored stroke points -> angular, torn edge
  const HOLD    = 650;     // ms a fresh stroke stays at full width
  const DECAY   = 2300;    // ms it then takes to erode away, tail first
  const HEAD_K  = 1.00;    // head radius  (x base radius)
  const BODY_K  = 0.70;    // stroke half-width at birth (x base radius)
  const MAX_PTS = 260;

  let W = stage.clientWidth || innerWidth, H = stage.clientHeight || innerHeight, dpr = 1;
  let engageT = -1e9;                  // when the current stroke began (head grows in from here)
  const nightBuf = document.createElement('canvas');   // night image pre-scaled 1:1 to the canvas
  let scale = 1;                       // wheel zoom
  let running = false;
  let last = 0;
  let dragId = null;
  let shownState = '';
  let clock = 0;

  // Night image + where object-fit:cover puts it (same geometry as the CSS)
  const night = new Image();
  night.decoding = 'async';
  let NW = 1672, NH = 941;
  let ix = 0, iy = 0, iw = NW, ih = NH;

  let strokes = [];                    // each hover/drag paints its own stroke (oldest -> newest points)
  let pts = null;                      // the stroke currently being painted
  const cur = { x: W / 2, y: H / 2, e: 0, dx: 1, dy: 0 };
  const tgt = { x: W / 2, y: H / 2, active: false, moved: false };
  let lastMoveT = -1e9;                // when the pointer last actually moved
  let prevBox = null;

  const baseR = () => clamp(Math.min(W, H) * 0.22, 92, 240) * scale;

  /* ---------- Sizing ---------- */
  function sizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    for (const c of [canvas, mask]) {
      c.width  = Math.max(1, Math.round(W * dpr));
      c.height = Math.max(1, Math.round(H * dpr));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = Math.max(W / NW, H / NH);
    iw = NW * s; ih = NH * s;
    ix = (W - iw) * 0.5;
    iy = (H - ih) * 0.4;            // object-position: 50% 40%
    buildNight();
    prevBox = null;
  }

  function buildNight() {
    nightBuf.width = canvas.width; nightBuf.height = canvas.height;
    if (!(night.complete && night.naturalWidth)) return;
    const b = nightBuf.getContext('2d');
    b.imageSmoothingQuality = 'high';
    b.drawImage(night, ix * dpr, iy * dpr, iw * dpr, ih * dpr);
  }

  /* ---------- Stroke life ---------- */
  // 1 while fresh, then eases to 0 as the stroke dries out
  function life(age) {
    if (reduce) return age < 1200 ? 1 : 0;
    const a = (age - HOLD) / DECAY;
    if (a <= 0) return 1;
    if (a >= 1) return 0;
    const l = 1 - a;
    return l * l * (3 - 2 * l);          // smoothstep: eases in and out, no kink
  }

  function addPoint(now) {
    if (!pts) return;
    const jag = last => {
      let v = rnd(0.80, 1.22);
      if (Math.random() < 0.05) v *= rnd(0.55, 0.75);   // bite
      if (Math.random() < 0.04) v *= rnd(1.18, 1.35);   // spur
      return last ? last * 0.55 + v * 0.45 : v;
    };
    // Fill in every SPACING px between the last stored point and the pointer,
    // so fast sweeps stay as smooth as slow ones instead of becoming long straight chords.
    let p = pts.length ? pts[pts.length - 1] : null;
    if (!p) {
      pts.push({ x: cur.x, y: cur.y, t: now, rl: jag(0), rr: jag(0) });
      return;
    }
    const dx = cur.x - p.x, dy = cur.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < SPACING) return;
    const steps = Math.min(40, Math.floor(dist / SPACING));
    const t0 = p.t;
    for (let k = 1; k <= steps; k++) {
      const f = k * SPACING / dist;
      const q = { x: p.x + dx * f, y: p.y + dy * f, t: t0 + (now - t0) * f,
                  rl: jag(pts[pts.length - 1].rl), rr: jag(pts[pts.length - 1].rr) };
      pts.push(q);
    }
    while (pts.length > MAX_PTS) pts.shift();
  }

  /* ---------- Geometry ---------- */
  let bx0, by0, bx1, by1;
  const grow = (x, y) => {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  };

  // Soft round brush sprite: solid core, feathered rim. Stamped along the path so
  // overlapping stamps merge into one smooth, continuous stroke (no jagged edges, no holes).
  const stamp = document.createElement('canvas');
  stamp.width = stamp.height = 256;
  (() => {
    const c = stamp.getContext('2d');
    const gr = c.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0.00, 'rgba(255,255,255,1)');
    gr.addColorStop(0.62, 'rgba(255,255,255,1)');
    gr.addColorStop(0.80, 'rgba(255,255,255,.55)');
    gr.addColorStop(0.92, 'rgba(255,255,255,.15)');
    gr.addColorStop(1.00, 'rgba(255,255,255,0)');
    c.fillStyle = gr; c.fillRect(0, 0, 256, 256);
  })();

  // Collect every brush stamp (x, y, radius) for this frame and grow the bounding box
  function collect(now, R, out) {
    const FEATHER = 1.04;   // sprite rim is part of the radius
    const push = (x, y, r) => {
      if (r < 1.5) return;
      out.push(x, y, r);
      grow(x - r, y - r); grow(x + r, y + r);
    };
    for (const st of strokes) {
      const live = st === pts;
      const n0 = st.length;
      if (n0 < 1 && !live) continue;
      const sp = st.map(p => ({ x: p.x, y: p.y, age: now - p.t }));
      if (live) sp.push({ x: cur.x, y: cur.y, age: now - lastMoveT });
      const n = sp.length;
      if (n < 2) continue;

      // gently smooth the raw pointer path so the ribbon curves sweep
      const sm = sp.map(p => ({ x: p.x, y: p.y }));
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < n - 1; i++) {
          sm[i].x = (sm[i - 1].x + sp[i].x * 2 + sm[i + 1].x) * 0.25;
          sm[i].y = (sm[i - 1].y + sp[i].y * 2 + sm[i + 1].y) * 0.25;
        }
      }
      let pr = 0, px = 0, py = 0;
      for (let i = 0; i < n; i++) {
        const along = Math.min(1, (i + 1) / 8);
        const r = R * BODY_K * life(sp[i].age) * along * FEATHER;
        if (i) push((px + sm[i].x) / 2, (py + sm[i].y) / 2, (pr + r) / 2);   // midpoint: no beading
        push(sm[i].x, sm[i].y, r);
        pr = r; px = sm[i].x; py = sm[i].y;
      }
    }
    // the head: a round, soft blob under the pointer
    if (pts) {
      const lf = life(now - lastMoveT);
      if (lf > 0.02) {
        const g0 = reduce ? 1 : clamp((now - engageT) / 260, 0, 1);
        push(cur.x, cur.y, R * HEAD_K * lf * (g0 * g0 * (3 - 2 * g0)) * FEATHER);
      }
    }
    return out.length > 0;
  }

  /* ---------- Render ---------- */
  function render(now) {
    const R = baseR();
    bx0 = 1e9; by0 = 1e9; bx1 = -1e9; by1 = -1e9;

    const list = [];
    const visible = collect(now, R, list);

    let box = null;
    if (visible) {
      const m = 4;
      box = {
        x: Math.max(0, Math.floor(bx0 - m)), y: Math.max(0, Math.floor(by0 - m)),
        r: Math.min(W, Math.ceil(bx1 + m)),  b: Math.min(H, Math.ceil(by1 + m))
      };
    }
    // Repaint the union of where we were and where we are now
    let dirty = box;
    if (prevBox) {
      dirty = box ? {
        x: Math.min(box.x, prevBox.x), y: Math.min(box.y, prevBox.y),
        r: Math.max(box.r, prevBox.r), b: Math.max(box.b, prevBox.b)
      } : prevBox;
    }

    if (dirty) {
      const dw = dirty.r - dirty.x, dh = dirty.b - dirty.y;
      if (dw > 0 && dh > 0) {
        // work in whole device pixels so rect edges never leave seams at fractional DPR
        const sx = Math.max(0, Math.floor(dirty.x * dpr) - 1), sy = Math.max(0, Math.floor(dirty.y * dpr) - 1);
        const sw = Math.min(canvas.width,  Math.ceil(dirty.r * dpr) + 1) - sx;
        const sh = Math.min(canvas.height, Math.ceil(dirty.b * dpr) + 1) - sy;

        // 1. mask
        mctx.save();
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        mctx.beginPath(); mctx.rect(sx, sy, sw, sh); mctx.clip();
        mctx.clearRect(sx, sy, sw, sh);
        mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (visible) {
          for (let i = 0; i < list.length; i += 3) {
            const r = list[i + 2];
            mctx.drawImage(stamp, list[i] - r, list[i + 1] - r, r * 2, r * 2);
          }
        }
        mctx.restore();

        // 2. night image (pre-scaled), cut by the mask - 1:1 blits of just the dirty rect
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
        ctx.clearRect(sx, sy, sw, sh);
        if (visible && nightBuf.width) {
          ctx.drawImage(nightBuf, sx, sy, sw, sh, sx, sy, sw, sh);
          ctx.globalCompositeOperation = 'destination-in';
          ctx.drawImage(mask, sx, sy, sw, sh, sx, sy, sw, sh);
        }
        ctx.restore();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    prevBox = box;

    const st = visible ? 'active' : 'idle';
    if (st !== shownState) { shownState = st; stage.dataset.state = st; }
    return visible;
  }

  /* ---------- Frame loop ---------- */
  function kick() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function tick(now) {
    const dt = clamp((now - last) / 1000, 0.001, 0.05);
    last = now;
    if (!reduce) clock += dt;

    // Follow the pointer with a little weight so the stroke sweeps in curves
    const px = cur.x, py = cur.y;
    const kPos = reduce ? 1 : 1 - Math.exp(-dt * 16);
    cur.x += (tgt.x - cur.x) * kPos;
    cur.y += (tgt.y - cur.y) * kPos;

    const vx = (cur.x - px) / dt, vy = (cur.y - py) / dt;
    const speed = Math.hypot(vx, vy);
    const e = clamp(speed / 1400, 0, 1);
    cur.e += (e - cur.e) * (1 - Math.exp(-dt * 7));
    if (speed > 40) {
      const k = 1 - Math.exp(-dt * 9);
      let dx = cur.dx + (vx / speed - cur.dx) * k;
      let dy = cur.dy + (vy / speed - cur.dy) * k;
      const m = Math.hypot(dx, dy) || 1;
      cur.dx = dx / m; cur.dy = dy / m;
    }

    if (tgt.active && speed > 20) {
      lastMoveT = now;
      addPoint(now);
    }

    // Drop points that have fully dried out
    for (const st of strokes) while (st.length && life(now - st[0].t) <= 0) st.shift();
    strokes = strokes.filter(st => st === pts || st.length);

    const visible = render(now);

    const moving = Math.abs(tgt.x - cur.x) > 0.3 || Math.abs(tgt.y - cur.y) > 0.3;
    if (visible || moving) requestAnimationFrame(tick);
    else { running = false; strokes = strokes.filter(st => st === pts || st.length); }
  }

  /* ---------- Input ---------- */
  function engage() {
    if (!tgt.active) {
      // a fresh hover/drag: new stroke, starting exactly under the pointer
      cur.x = tgt.x; cur.y = tgt.y;
      pts = [];
      strokes.push(pts);
      engageT = performance.now();
    }
    tgt.active = true;
  }

  function setPos(e) {
    tgt.x = clamp(e.clientX, 0, W);
    let y = e.clientY;
    // On touch, lift the head above the finger so it is never hidden by it
    if (e.pointerType !== 'mouse') y -= Math.min(90, baseR() * 0.7);
    tgt.y = clamp(y, 0, H);
  }

  stage.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse') return;
    setPos(e); engage(); kick();
  });

  stage.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') {
      setPos(e); engage(); kick();
    } else if (dragId === e.pointerId) {
      setPos(e); kick();
    }
  });

  // Leaving the window just stops painting; what is already there dries out on its own
  stage.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    tgt.active = false; kick();
  });

  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    dragId = e.pointerId;
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    setPos(e); engage();
    kick();
  });

  const endTouch = e => {
    if (dragId !== e.pointerId) return;
    dragId = null;
    tgt.active = false; kick();
  };
  stage.addEventListener('pointerup', endTouch);
  stage.addEventListener('pointercancel', endTouch);

  // Mouse wheel resizes the brush
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    scale = clamp(scale * (e.deltaY < 0 ? 1.08 : 0.93), 0.5, 2.2);
    kick();
  }, { passive: false });

  /* ---------- Keyboard ---------- */
  let keyT = 0;
  stage.addEventListener('keydown', e => {
    if (e.target !== stage) return;
    const step = Math.max(W, H) * 0.06;
    switch (e.key) {
      case 'ArrowLeft':  tgt.x -= step; break;
      case 'ArrowRight': tgt.x += step; break;
      case 'ArrowUp':    tgt.y -= step; break;
      case 'ArrowDown':  tgt.y += step; break;
      default: return;
    }
    e.preventDefault();
    tgt.x = clamp(tgt.x, 0, W);
    tgt.y = clamp(tgt.y, 0, H);
    engage();
    clearTimeout(keyT);
    keyT = setTimeout(() => { tgt.active = false; }, 600);
    kick();
  });

  addEventListener('resize', () => {
    W = stage.clientWidth || innerWidth; H = stage.clientHeight || innerHeight;
    tgt.x = clamp(tgt.x, 0, W);
    tgt.y = clamp(tgt.y, 0, H);
    cur.x = clamp(cur.x, 0, W); cur.y = clamp(cur.y, 0, H);
    strokes = []; pts = null;
    // keep painting if the pointer is still down/hovering (previously it went dead until re-entering)
    if (tgt.active) { pts = []; strokes.push(pts); engageT = performance.now(); }
    sizeCanvas();
    kick();
  });

  /* ---------- Boot ---------- */
  let ready = false;
  function boot() {
    ready = true;
    if (night.naturalWidth) { NW = night.naturalWidth; NH = night.naturalHeight; }
    sizeCanvas();
    shownState = 'idle';
    stage.dataset.state = 'idle';
    stage.classList.add('ready');
  }

  const dayImg = stage.querySelector('.base img');
  const waits = [
    new Promise(res => {
      night.onload = () => { res(); if (ready) { buildNight(); prevBox = null; } };
      night.onerror = () => { night.onerror = res; night.src = 'img/night.jpg'; };
      night.src = 'img/night.webp';
    }),
    dayImg && dayImg.decode ? dayImg.decode().catch(() => {}) : Promise.resolve()
  ];
  Promise.race([Promise.all(waits), new Promise(res => setTimeout(res, 4000))]).then(boot);
})();
