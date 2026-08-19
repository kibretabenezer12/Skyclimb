/* ============================================================
   Aviator — frontend

   GitHub Pages + Wispbyte: set BACKEND_URL to your HTTPS API base
   (must be https so WebSocket becomes wss — required by Telegram).
   ============================================================ */
const BACKEND_URL = (function () {
  // GitHub Pages: set your Wispbyte HTTPS URL (trailing slash is stripped)
  let url = "https://avaitoret.wisp.uno"; // <-- your API host
  // Auto same-origin only if you did NOT set a manual URL above:
  // let url = (typeof location !== "undefined" && location.origin) ? location.origin : "http://127.0.0.1:8000";
  return String(url || "").replace(/\/+$/, "");
})();

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

/** Real mode → BIRR; demo mode → pts */
function currencyLabel(mode) {
  return (mode || state.mode) === "demo" ? "pts" : "BIRR";
}

/** Same curve as server game_engine.multiplier_at — for smooth UI only. */
function multiplierAt(tSec) {
  if (tSec <= 0) return 1.0;
  return Math.round((1.0 + Math.pow(tSec / 2.2, 1.35)) * 100) / 100;
}

function timeToReachMult(target) {
  if (target <= 1.0) return 0;
  return 2.2 * Math.pow(target - 1.0, 1 / 1.35);
}

function syncFlightClockFromMult(mult) {
  // Align local clock so multiplierAt(elapsed) matches server mult
  const t = timeToReachMult(Number(mult) || 1);
  state.flightStartPerf = performance.now() - t * 1000;
}

function stopSmoothMult() {
  if (state._multRaf) {
    cancelAnimationFrame(state._multRaf);
    state._multRaf = 0;
  }
}

function startSmoothMult() {
  stopSmoothMult();
  let lastPaintMs = 0;
  let lastTerminalMs = 0;
  // Display refresh ~8 Hz so the odd counter is easier for the eye (plane still OK)
  const MULT_FRAME_MS = 120;
  const step = () => {
    if (state.phase !== "flying") {
      state._multRaf = 0;
      return;
    }
    const now = performance.now();
    const t = (now - (state.flightStartPerf || now)) / 1000;
    const m = multiplierAt(t);
    state.multiplier = m;
    if (now - lastPaintMs >= MULT_FRAME_MS) {
      lastPaintMs = now;
      setMultiplierDisplay(m, false);
      setFlightProgress(m);
      sound.updateHum(m);
    }
    if (now - lastTerminalMs >= 150) {
      lastTerminalMs = now;
      if (state.myEntries[1] || state.myEntries[2]) renderAllTerminals();
    }
    state._multRaf = requestAnimationFrame(step);
  };
  state._multRaf = requestAnimationFrame(step);
}

function stopSmoothCountdown() {
  if (state._cdTimer) {
    clearInterval(state._cdTimer);
    state._cdTimer = 0;
  }
  const wrap = document.getElementById("waitBarWrap");
  if (wrap) wrap.classList.remove("active");
  state._waitEndAt = 0;
  state._waitTotal = 0;
}

function startSmoothCountdown(secondsLeft) {
  const sec = Math.max(0.05, Number(secondsLeft) || 0);
  const now = performance.now();
  const proposedEnd = now + sec * 1000;
  // Re-anchor only if missing or drifted — stops bar going back and forth
  if (!state._waitEndAt || Math.abs(state._waitEndAt - proposedEnd) > 450) {
    state._waitEndAt = proposedEnd;
    state._waitStartAt = now;
    state._waitTotal = sec;
  }
  const barWrap = document.getElementById("waitBarWrap");
  const bar = document.getElementById("waitBar");
  if (barWrap) barWrap.classList.add("active");

  if (state._cdTimer) return; // already painting calmly

  const paint = () => {
    if (state.phase !== "waiting") {
      stopSmoothCountdown();
      return;
    }
    const left = Math.max(0, (state._waitEndAt - performance.now()) / 1000);
    const total = state._waitTotal || 7;
    const frac = Math.max(0, Math.min(1, left / total)); // only shrinks 1 → 0
    setStatus("Place your bets");
    if (bar) bar.style.transform = `scaleX(${frac})`;
    if (left <= 0) {
      if (bar) bar.style.transform = "scaleX(0)";
      stopSmoothCountdown();
    }
  };
  paint();
  state._cdTimer = setInterval(paint, 40);
}



// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
const state = {
  token: null,
  userId: null,
  username: null,
  mode: "real",
  balance: 0,
  demoBalance: 0,
  phase: "waiting",
  multiplier: 1.0,
  crashPoint: null,
  myEntries: { 1: null, 2: null },   // current-round bets
  myPending: { 1: null, 2: null },   // next-round bets placed while flying
  history: [],
  ws: null,
  reconnectAttempts: 0,
};

// ---------------------------------------------------------------
// Sound
// ---------------------------------------------------------------
const sound = {
  ctx: null,
  enabled: true,
  humOsc: null,
  humGain: null,
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
  },
  tone(freq, duration, type, gainVal) {
    if (!this.enabled) return;
    this.ensure();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = gainVal;
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  },
  click() { this.tone(420, 0.06, "sine", 0.05); },
  chime() { this.tone(520, 0.15, "sine", 0.08); setTimeout(() => this.tone(780, 0.2, "sine", 0.07), 100); },
  thud() { this.tone(70, 0.35, "sine", 0.1); },
  flyAway() {
    if (!this.enabled) return;
    this.ensure();
    const now = this.ctx.currentTime;
    // Low engine whoosh — not a toy beep
    const osc = this.ctx.createOscillator();
    const filt = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.9);
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(400, now);
    filt.frequency.exponentialRampToValueAtTime(1800, now + 0.85);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.05);
    osc.connect(filt); filt.connect(gain); gain.connect(this.ctx.destination);
    osc.start(now); osc.stop(now + 1.1);
    // Soft noise bed
    try {
      const n = this.ctx.createBufferSource();
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 1.0, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.4;
      n.buffer = buf;
      const ng = this.ctx.createGain();
      const nf = this.ctx.createBiquadFilter();
      nf.type = "bandpass"; nf.frequency.value = 600;
      ng.gain.setValueAtTime(0.03, now);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);
      n.connect(nf); nf.connect(ng); ng.connect(this.ctx.destination);
      n.start(now); n.stop(now + 1.0);
    } catch (_) {}
  },
  startHum() {
    if (!this.enabled) return;
    this.stopHum(true);
    this.ensure();
    const osc = this.ctx.createOscillator();
    const filt = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = 70;
    filt.type = "lowpass";
    filt.frequency.value = 280;
    gain.gain.value = 0.035;
    osc.connect(filt); filt.connect(gain); gain.connect(this.ctx.destination);
    osc.start();
    this.humOsc = osc;
    this.humGain = gain;
    this.humFilt = filt;
  },
  updateHum(mult) {
    if (!this.humOsc || !this.humGain) return;
    try {
      const m = Math.max(1, mult || 1);
      const now = this.ctx.currentTime;
      this.humOsc.frequency.setTargetAtTime(70 + Math.min(90, (m - 1) * 12), now, 0.08);
      if (this.humFilt) this.humFilt.frequency.setTargetAtTime(280 + Math.min(400, (m - 1) * 40), now, 0.1);
      this.humGain.gain.setTargetAtTime(0.028 + Math.min(0.04, (m - 1) * 0.004), now, 0.1);
    } catch (_) {}
  },
  stopHum(immediate) {
    const osc = this.humOsc;
    const gain = this.humGain;
    this.humOsc = null;
    this.humGain = null;
    if (!osc) return;
    try {
      if (this.ctx && gain) {
        const now = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        if (immediate) {
          gain.gain.setValueAtTime(0, now);
          osc.stop(now + 0.02);
        } else {
          gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
          osc.stop(now + 0.15);
        }
      } else {
        osc.stop();
      }
    } catch (_) {
      try { osc.stop(); } catch (__) { /* already stopped */ }
    }
  },
};

// ---------------------------------------------------------------
// Canvas flight animation
// ---------------------------------------------------------------
const canvas = { el: null, ctx: null, w: 400, h: 280, dpr: 1 };
const planeSprite = { img: null, ready: false };
(function loadPlaneSprite() {
  const img = new Image();
  img.onload = () => { planeSprite.img = img; planeSprite.ready = true; };
  img.src = "assets/plane-v3.png";
})();
const flight = {
  progress: 0,          // 0..1 visual progress along the path
  flying: false,
  crashed: false,
  trail: [],            // recent points for the vapor trail
  planeAngle: -0.35,
  stars: [],
  skyScroll: 0,         // continuous downward drift of the starfield
};

function initCanvas() {
  canvas.el = document.getElementById("flightCanvas");
  canvas.ctx = canvas.el.getContext("2d");
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  // Pre-generate background stars across the full sky
  for (let i = 0; i < 90; i++) {
    flight.stars.push({
      x: Math.random(),
      y: Math.random(),
      r: 0.5 + Math.random() * 2.0,
      a: 0.2 + Math.random() * 0.55,
      // Parallax depth only — direction is always synced left+down with the plane
      depth: 0.35 + Math.random() * 1.0,
    });
  }
  requestAnimationFrame(drawFrame);
}

function resizeCanvas() {
  const stage = document.getElementById("flightStage");
  const rect = stage.getBoundingClientRect();
  canvas.dpr = window.devicePixelRatio || 1;
  canvas.w = rect.width;
  canvas.h = rect.height;
  canvas.el.width = canvas.w * canvas.dpr;
  canvas.el.height = canvas.h * canvas.dpr;
  canvas.el.style.width = canvas.w + "px";
  canvas.el.style.height = canvas.h + "px";
  canvas.ctx.setTransform(canvas.dpr, 0, 0, canvas.dpr, 0, 0);
}

/** Climb path: y ∝ t^1.5 — starts flatter than linear, steepens less aggressively than t².
 */
function pathPoint(t) {
  // Upper parabola-ish climb: y ∝ t^1.5 (not t² — less aggressive)
  t = Math.max(0, Math.min(1, t));
  const x = 0.06 + 0.84 * t;
  const y = 0.82 - 0.62 * Math.pow(t, 1.5);
  return { x: x * canvas.w, y: y * canvas.h };
}

function pathTangent(t) {
  t = Math.max(0, Math.min(1, t));
  const dx = 0.84;
  // d/dt [t^1.5] = 1.5 * t^0.5
  const dy = t <= 0 ? 0 : -0.62 * 1.5 * Math.sqrt(t);
  return Math.atan2(dy, dx);
}


function drawPlane(ctx, x, y, angle, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const s = scale * 0.72;
  if (planeSprite.ready && planeSprite.img) {
    const img = planeSprite.img;
    const w = 56 * s;
    const h = (img.height / img.width) * w;
    // PNG alpha only — no dark plate behind the sprite
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowColor = "rgba(255, 40, 40, 0.45)";
    ctx.shadowBlur = 8;
    ctx.drawImage(img, -w * 0.45, -h * 0.55, w, h);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = "#ff1a1a";
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.quadraticCurveTo(10, -5, -8, -3);
    ctx.lineTo(-14, 0);
    ctx.lineTo(-8, 3);
    ctx.quadraticCurveTo(10, 5, 18, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}


function planeAngleFromProgress(progress) {
  const p = Math.max(0, Math.min(1, progress || 0));
  let deg;
  if (p < 0.45) {
    // Before middle of sky: gentle climb 6° → 18°
    deg = 6 + (p / 0.45) * 12;
  } else {
    // Past middle: ease toward 25–28° (slightly nose-down vs steep climb)
    const u = (p - 0.45) / 0.55;
    deg = 18 + u * 10; // 18° → 28°
  }
  return (-deg * Math.PI) / 180;
}

function planeAngleFromMult(mult) {
  // Map mult → approx progress used for angle (matches faster path)
  const p = 1 - Math.exp(-(Math.max(1, mult) - 1) * 0.38 * 2.5);
  return planeAngleFromProgress(Math.min(0.98, p));
}

function drawFrame() {
  const ctx = canvas.ctx;
  if (!ctx) { requestAnimationFrame(drawFrame); return; }

  ctx.clearRect(0, 0, canvas.w, canvas.h);

  // Sky scrolls downward as the plane climbs (stronger parallax = "going up" feel)
  if (flight.flying && !flight.crashed) {
    flight.skyScroll += 0.0045 + flight.progress * 0.012; // a bit faster with plane
  }

  // Camera: shift world so plane stays near vertical middle
  let camY = 0;
  if (flight.flying || flight.crashed) {
    const tCam = Math.min(1, flight.progress + (flight.flyAwayT || 0));
    const planePt = pathPoint(Math.min(0.98, tCam));
    camY = cameraOffsetY(planePt.y);
  }
  ctx.save();
  ctx.translate(0, camY);


  // Climb progress drives most of the motion; continuous drift keeps it alive between ticks
  const scrollBase = flight.progress * 1.15 + flight.skyScroll;

  // Horizontal grid lines drifting downward
  ctx.strokeStyle = "rgba(88, 166, 255, 0.08)";
  ctx.lineWidth = 1;
  const gridStep = canvas.h / 6;
  const gridOff = (scrollBase * canvas.h * 0.55) % gridStep;
  for (let i = -1; i < 10; i++) {
    const y = i * gridStep + gridOff;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.w, y);
    ctx.stroke();
  }

  // Sky parallax: opposite of plane motion (plane goes up-right → sky slides left-down)
  // Ratio ~ matches path: dx≈0.82, dy≈ climb → horizontal component ~0.55 of vertical
  for (const s of flight.stars) {
    const d = s.depth;
    let sy = s.y + scrollBase * d;
    sy = sy - Math.floor(sy);
    let sx = s.x - scrollBase * d * 0.55; // leftward, synced with downward
    sx = sx - Math.floor(sx);
    const px = sx * canvas.w;
    const py = sy * canvas.h;
    ctx.beginPath();
    ctx.arc(px, py, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(200, 220, 255, ${s.a})`;
    ctx.fill();
  }

  // Spribe-style filled red trail under the flight path
  if (flight.trail.length > 1) {
    const last = flight.trail[flight.trail.length - 1];
    const first = flight.trail[0];
    // Fill wedge (ground → curve)
    ctx.beginPath();
    ctx.moveTo(first.x, canvas.h);
    ctx.lineTo(first.x, first.y);
    for (let i = 1; i < flight.trail.length; i++) {
      ctx.lineTo(flight.trail[i].x, flight.trail[i].y);
    }
    ctx.lineTo(last.x, canvas.h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, 0, canvas.h);
    fill.addColorStop(0, "rgba(255, 30, 30, 0.55)");
    fill.addColorStop(0.55, "rgba(200, 0, 0, 0.28)");
    fill.addColorStop(1, "rgba(120, 0, 0, 0.08)");
    ctx.fillStyle = fill;
    ctx.fill();

    // Bright edge line on the curve
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < flight.trail.length; i++) {
      ctx.lineTo(flight.trail[i].x, flight.trail[i].y);
    }
    ctx.strokeStyle = "rgba(255, 60, 60, 0.95)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 80, 80, 0.25)";
    ctx.lineWidth = 10;
    ctx.stroke();
  }

  // Plane
  const PLANE_SCALE = 1.85;
  const multNow = state.multiplier || 1;
  if (flight.flying || flight.crashed) {
    let t = Math.min(1, flight.progress);
    if (flight.crashed) {
      // Continue outward (fly away)
      t = Math.min(1.35, t + (flight.flyAwayT || 0));
      flight.flyAwayT = (flight.flyAwayT || 0) + 0.012;
    }
    const pt = pathPoint(Math.min(1, t));
    // Past end of path: shoot off top-right
    let px = pt.x;
    let py = pt.y;
    if (t > 1) {
      const extra = t - 1;
      px = pt.x + extra * canvas.w * 0.55;
      py = pt.y - extra * canvas.h * 0.45;
    }
    const angle = planeAngleFromProgress(Math.min(1, flight.progress + (flight.flyAwayT || 0))) + (flight.crashed ? -0.12 : 0);
    flight.planeAngle = angle;
    drawPlane(ctx, px, py, angle, PLANE_SCALE);
  } else {
    const pt = pathPoint(0);
    drawPlane(ctx, pt.x, pt.y, planeAngleFromMult(1), PLANE_SCALE * 0.95);
  }

  ctx.restore();
  requestAnimationFrame(drawFrame);
}

function setFlightProgress(mult) {
  // ~2.5× faster travel along the path for the same multiplier
  const p = 1 - Math.exp(-(mult - 1) * 0.38 * 2.5);
  flight.progress = Math.min(0.98, p);
  const steps = Math.max(2, Math.floor(flight.progress * 72));
  flight.trail = [];
  for (let i = 0; i <= steps; i++) {
    flight.trail.push(pathPoint((i / steps) * flight.progress));
  }
}

/** Camera offset: keep plane near vertical center of the stage. */
function cameraOffsetY(planeY) {
  const mid = canvas.h * 0.50;
  // Pull view so plane sits around mid; clamp so sky still moves
  const raw = mid - planeY;
  return Math.max(-canvas.h * 0.22, Math.min(canvas.h * 0.28, raw * 0.85));
}

function resetFlight() {
  flight.progress = 0;
  flight.flying = false;
  flight.skyScroll = 0;
  flight.crashed = false;
  flight.flyAwayT = 0;
  flight.trail = [];
}

function startFlight() {
  flight.flying = true;
  flight.crashed = false;
  flight.trail = [];
  flight.progress = 0;
}

function crashFlight() {
  flight.crashed = true;
  flight.flying = false;
  flight.flyAwayT = 0;
}

// ---------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------
function setStatus(text, isError) {
  const el = document.getElementById("statusOverlay");
  el.textContent = text;
  el.classList.toggle("status-error", !!isError);
}

function renderBalance() {
  const val = state.mode === "real" ? state.balance : state.demoBalance;
  document.getElementById("balanceValue").textContent = Math.floor(val).toLocaleString();
  const unit = document.getElementById("balanceUnit");
  if (unit) unit.textContent = currencyLabel(state.mode);
}

function renderHistory() {
  const bar = document.getElementById("historyBar");
  bar.innerHTML = "";
  const items = (state.history || []).slice().reverse();
  items.forEach((m) => {
    const pill = document.createElement("span");
    pill.className = "hist-pill";
    if (m < 2) pill.classList.add("low");
    else if (m < 10) pill.classList.add("mid");
    else pill.classList.add("high");
    pill.textContent = m.toFixed(2) + "×";
    bar.appendChild(pill);
  });
}

function setMultiplierDisplay(mult, crashed) {
  const el = document.getElementById("multValue");
  const wrap = document.getElementById("multiplierDisplay");
  el.textContent = mult.toFixed(2);
  wrap.classList.toggle("crashed", !!crashed);
}

function showCrashBanner(crashMult) {
  const banner = document.getElementById("crashBanner");
  document.getElementById("crashText").textContent = "FLEW AWAY";
  document.getElementById("crashMult").textContent = `@ ${crashMult.toFixed(2)}×`;
  banner.classList.remove("hidden");
}

function hideCrashBanner() {
  document.getElementById("crashBanner").classList.add("hidden");
}

function resultLabel(result) {
  if (result === "win") return "CASHED OUT";
  if (result === "crash") return "FLEW AWAY";
  return "—";
}

function showResult(t, entry) {
  const resultBox = document.getElementById(`result${t}`);
  const num = (v) => (typeof v === "number" ? v.toFixed(2) : "?");
  if (entry.result === "win") {
    resultBox.textContent = `+${num(entry.payout)} ${currencyLabel(entry.mode)} @ ${num(entry.stopValue)}×`;
    resultBox.className = "terminal-result win";
  } else {
    resultBox.textContent = `−${entry.stake} ${currencyLabel(entry.mode)}`;
    resultBox.className = "terminal-result loss";
  }
}

function renderTerminal(t) {
  const btn = document.getElementById(`lever${t}`);
  const stakeInput = document.getElementById(`stake${t}`);
  const resultBox = document.getElementById(`result${t}`);
  const entry = state.myEntries[t];
  const pending = state.myPending[t];

  btn.className = "action-btn";
  resultBox.className = "terminal-result";

  if (state.phase === "waiting") {
    // Pending from previous flight has been promoted into myEntries by server
    stakeInput.disabled = !!entry;
    if (entry) {
      btn.textContent = "BET PLACED";
      btn.classList.add("staked");
      btn.disabled = true;
      resultBox.textContent = `${entry.stake} ${currencyLabel(entry.mode)}`;
    } else {
      btn.textContent = "BET";
      btn.classList.add("bet");
      btn.disabled = false;
      resultBox.textContent = "";
    }
  } else if (state.phase === "flying") {
    if (entry && !entry.landed) {
      // Active bet on this flight → cash out (live potential = stake × mult)
      stakeInput.disabled = true;
      const pot = entry.stake * (state.multiplier || 1);
      btn.textContent = `CASHOUT ${pot.toFixed(2)}`;
      btn.classList.add("cashout");
      btn.disabled = false;
      resultBox.textContent = `${entry.stake} → ${pot.toFixed(2)} ${currencyLabel(entry.mode)}`;
      resultBox.className = "terminal-result cashout-live";
    } else if (entry && entry.landed) {
      stakeInput.disabled = true;
      btn.textContent = resultLabel(entry.result);
      btn.classList.add(entry.result === "win" ? "won" : "lost");
      btn.disabled = true;
      showResult(t, entry);
    } else if (pending) {
      // Next-round bet already locked
      stakeInput.disabled = true;
      btn.textContent = "WAITING FOR NEXT ROUND";
      btn.classList.add("waiting-next");
      btn.disabled = true;
      resultBox.textContent = `${pending.stake} ${currencyLabel(pending.mode)} queued`;
      resultBox.className = "terminal-result pending";
    } else {
      // No current bet → allow betting for the NEXT round
      stakeInput.disabled = false;
      btn.textContent = "BET (NEXT ROUND)";
      btn.classList.add("bet");
      btn.disabled = false;
      resultBox.textContent = "";
    }
  } else {
    // resolved
    if (entry) {
      stakeInput.disabled = true;
      btn.textContent = resultLabel(entry.result);
      btn.classList.add(entry.result === "win" ? "won" : "lost");
      btn.disabled = true;
      showResult(t, entry);
    } else if (pending) {
      stakeInput.disabled = true;
      btn.textContent = "WAITING FOR NEXT ROUND";
      btn.classList.add("waiting-next");
      btn.disabled = true;
      resultBox.textContent = `${pending.stake} ${currencyLabel(pending.mode)} queued`;
      resultBox.className = "terminal-result pending";
    } else {
      stakeInput.disabled = false;
      btn.textContent = "BET (NEXT ROUND)";
      btn.classList.add("bet");
      btn.disabled = false;
      resultBox.textContent = "";
    }
  }
}

function renderAllTerminals() {
  renderTerminal(1);
  renderTerminal(2);
}

function addLogRow(username, terminal, stake, mode, result, payout, stopValue) {
  const list = document.getElementById("logList");
  const empty = list.querySelector(".empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "log-row";
  const payoutClass = result === "win" ? "win" : "loss";
  const payoutText = result === "win" ? `+${payout.toFixed(2)} @ ${stopValue.toFixed(2)}×` : "0";
  row.innerHTML = `
    <span>
      <span class="name">${escapeHtml(username)}</span>
      <span class="meta"> · B${terminal} · ${stake} ${currencyLabel(mode)}</span>
    </span>
    <span class="payout ${payoutClass}">${payoutText}</span>`;
  list.prepend(row);
  while (list.children.length > 40) list.removeChild(list.lastChild);
}

function addBetLogRow(username, terminal, stake, mode, pending) {
  const list = document.getElementById("logList");
  const empty = list.querySelector(".empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "log-row";
  const tag = pending ? "next round" : "this round";
  row.innerHTML = `
    <span>
      <span class="name">${escapeHtml(username)}</span>
      <span class="meta"> · B${terminal} · ${stake} ${currencyLabel(mode)}</span>
    </span>
    <span class="payout bet">${tag}</span>`;
  list.prepend(row);
  while (list.children.length > 40) list.removeChild(list.lastChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refreshLeaderboard() { /* removed */ }

// ---------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------
function connectWs() {
  const base = BACKEND_URL.replace(/^http/, "ws");
  const ws = new WebSocket(`${base}/ws/game?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.onopen = () => { state.reconnectAttempts = 0; setStatus("Connected — waiting for next round"); };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    sound.stopHum(true);
    setStatus("Reconnecting…");
    const delay = Math.min(1000 * 2 ** state.reconnectAttempts, 10000);
    state.reconnectAttempts++;
    setTimeout(connectWs, delay);
  };

  ws.onerror = () => ws.close();
}

function handleMessage(msg) {
  switch (msg.type) {
    case "round_state":
      state.phase = msg.phase;
      state.multiplier = msg.multiplier || 1.0;
      state.crashPoint = msg.crash_point;
      if (msg.history) {
        state.history = msg.history;
        renderHistory();
      }

      // Always reconcile own entries from server (current + next-round pending)
      state.myEntries = { 1: null, 2: null };
      state.myPending = { 1: null, 2: null };
      (msg.entries || []).forEach((e) => {
        if (String(e.user_id) !== String(state.userId)) return;
        const row = {
          joined: true,
          landed: e.stop_value != null,
          stake: e.stake,
          mode: e.mode,
          result: e.result,
          payout: e.payout,
          stopValue: e.stop_value,
        };
        if (e.pending) state.myPending[e.terminal] = row;
        else state.myEntries[e.terminal] = row;
      });

      if (msg.phase === "waiting") {
        stopSmoothMult();
        resetFlight();
        hideCrashBanner();
        setMultiplierDisplay(1.0, false);
        // Prefer server seconds_left if present; else default wait window
        startSmoothCountdown(msg.seconds_left != null ? msg.seconds_left : 7);
        setStatus("Place your bets");
        // Only clear log when a brand-new round starts (no entries yet is fine)
        if (!(msg.entries && msg.entries.length)) {
          document.getElementById("logList").innerHTML = '<p class="empty">No bets this round yet.</p>';
        }
        setStatus("Place your bets");
        sound.stopHum();
      } else if (msg.phase === "flying") {
        stopSmoothCountdown();
        stopSmoothCountdown();
        startFlight();
        syncFlightClockFromMult(state.multiplier || 1);
        startSmoothMult();
        setFlightProgress(state.multiplier);
        setMultiplierDisplay(state.multiplier, false);
        hideCrashBanner();
        setStatus("Flying… cash out before it disappears");
        sound.startHum();
      } else if (msg.phase === "resolved") {
        stopSmoothCountdown();
        stopSmoothMult();
        crashFlight();
        setMultiplierDisplay(msg.crash_point || state.multiplier, true);
        showCrashBanner(msg.crash_point || state.multiplier);
        setStatus(`Flew away @ ${(msg.crash_point || 0).toFixed(2)}×`);
        sound.stopHum();
        sound.flyAway();
        renderHistory();
      }
      renderAllTerminals();
      break;

    case "countdown":
      // Re-anchor smooth local countdown (avoids 0.3–0.5s jumps)
      startSmoothCountdown(msg.seconds_left);
      break;

    case "tick":
      // Soft re-sync only (RAF keeps the counter smooth between server ticks)
      syncFlightClockFromMult(msg.multiplier);
      if (state.phase === "flying" && !state._multRaf) startSmoothMult();
      break;

    case "landed":
      addLogRow(msg.username, msg.terminal, msg.stake, msg.mode, msg.result, msg.payout, msg.stop_value);
      if (msg.user_id === state.userId) {
        state.myEntries[msg.terminal] = {
          ...state.myEntries[msg.terminal],
          landed: true,
          result: msg.result,
          payout: msg.payout,
          stopValue: msg.stop_value,
        };
        renderTerminal(msg.terminal);
        if (msg.result === "win") sound.chime();
        else sound.flyAway();
      }
      break;

    case "join_result":
      if (msg.ok) {
        sound.click();
        const stakeVal = Number(document.getElementById(`stake${msg.terminal}`).value);
        const row = { joined: true, landed: false, stake: stakeVal, mode: state.mode, result: null };
        if (msg.pending) {
          state.myPending[msg.terminal] = row;
        } else {
          state.myEntries[msg.terminal] = row;
        }
      } else {
        const reason = msg.reason || "try again";
        const resultBox = document.getElementById(`result${msg.terminal}`);
        if (reason === "insufficient_balance") {
          setStatus("Insufficient balance", true);
          if (resultBox) {
            resultBox.textContent = "Insufficient balance";
            resultBox.className = "terminal-result insufficient";
          }
        } else {
          setStatus(`Couldn't place bet ${msg.terminal}: ${reason}`);
        }
      }
      renderAllTerminals();
      // Re-apply insufficient message after render (render clears result when empty)
      if (!msg.ok && msg.reason === "insufficient_balance") {
        const resultBox = document.getElementById(`result${msg.terminal}`);
        if (resultBox) {
          resultBox.textContent = "Insufficient balance";
          resultBox.className = "terminal-result insufficient";
        }
      }
      break;

    case "bet_placed":
      addBetLogRow(msg.username, msg.terminal, msg.stake, msg.mode, msg.pending);
      break;

    case "land_result":
      if (!msg.ok) setStatus(`Couldn't cash out: ${msg.reason || "try again"}`);
      break;

    case "balances":
      state.balance = msg.balance;
      state.demoBalance = msg.demo_balance;
      renderBalance();
      break;

    case "error":
      if (msg.reason === "slow_down") setStatus("Slow down a bit…");
      break;
  }
}

function send(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------
function wireStakeControls(t) {
  const input = document.getElementById(`stake${t}`);
  document.querySelectorAll(`.stake-btn[data-terminal="${t}"]`).forEach((btn) => {
    btn.addEventListener("click", () => {
      const delta = btn.dataset.op === "plus" ? 1 : -1;
      input.value = Math.max(2, Math.min(5000, (parseInt(input.value, 10) || 2) + delta));
    });
  });
  document.querySelectorAll(`.quick-stakes[data-terminal="${t}"] button`).forEach((btn) => {
    btn.addEventListener("click", () => { input.value = btn.dataset.amt; });
  });
}

function wireLever(t) {
  document.getElementById(`lever${t}`).addEventListener("click", () => {
    const entry = state.myEntries[t];
    const pending = state.myPending[t];
    if (state.phase === "waiting" && !entry) {
      const stakeInput = document.getElementById(`stake${t}`);
      const stake = Math.max(2, Math.min(5000, parseInt(stakeInput.value, 10) || 2));
      stakeInput.disabled = true;
      send({ action: "join", terminal: t, stake, mode: state.mode });
    } else if (state.phase === "flying" && entry && !entry.landed) {
      send({ action: "land", terminal: t });
    } else if (
      (state.phase === "flying" || state.phase === "resolved") &&
      !entry && !pending
    ) {
      // Bet for the next round while current flight is running / just crashed
      const stakeInput = document.getElementById(`stake${t}`);
      const stake = Math.max(2, Math.min(5000, parseInt(stakeInput.value, 10) || 2));
      stakeInput.disabled = true;
      send({ action: "join", terminal: t, stake, mode: state.mode });
    }
  });
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((x) => x.classList.add("hidden"));
      tab.classList.add("active");
      document.getElementById(`panel-${tab.dataset.tab}`).classList.remove("hidden");
    });
  });
}

function wireModeToggle() {
  document.getElementById("modeToggle").addEventListener("click", () => {
    state.mode = state.mode === "real" ? "demo" : "real";
    const btn = document.getElementById("modeToggle");
    btn.dataset.mode = state.mode;
    document.getElementById("modeLabel").textContent = state.mode.toUpperCase();
    renderBalance();
  });
}

function wireSoundToggle() {
  document.getElementById("soundToggle").addEventListener("click", () => {
    sound.enabled = !sound.enabled;
    document.getElementById("soundToggle").classList.toggle("muted", !sound.enabled);
    document.getElementById("soundToggle").textContent = sound.enabled ? "🔊" : "🔇";
    if (!sound.enabled) {
      sound.stopHum(true); // silence engine hum right away
    } else {
      sound.ensure();
      // Resume hum only if a flight is currently in progress
      if (state.phase === "flying") sound.startHum();
    }
  });
}

function wireDailyClaim() { /* removed */ }

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
function lockApp(message) {
  setStatus(message, true);
  const app = document.getElementById("app");
  if (app) app.classList.add("locked");
  // Disable all bet controls
  document.querySelectorAll(".action-btn, .stake-btn, .stake-input, .quick-stakes button, .mode-toggle").forEach((el) => {
    el.disabled = true;
  });
}

async function boot() {
  initCanvas();
  wireStakeControls(1); wireStakeControls(2);
  wireLever(1); wireLever(2);
  wireTabs(); wireModeToggle(); wireSoundToggle();

  // Strict: must be Telegram WebApp with signed initData
  if (!tg) {
    lockApp("Open this Mini App from Telegram only.");
    return;
  }
  try { tg.ready(); tg.expand(); } catch (_) {}

  const initData = tg.initData || "";
  if (!initData || initData.length < 20) {
    lockApp("Open this from your Telegram bot menu — not in a normal browser.");
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: initData }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch (_) {}
      setStatus(
        res.status === 401
          ? "Telegram login failed — check BOT_TOKEN matches this bot."
          : `Auth error ${res.status}${detail ? ": " + detail : ""}`,
        true
      );
      return;
    }
    const data = await res.json();
    state.token = data.token;
    state.userId = data.user_id;
    state.username = data.username;
    state.balance = data.balance;
    state.demoBalance = data.demo_balance;
    renderBalance();
    connectWs();
  } catch (e) {
    console.error(e);
    setStatus(
      "Network/CORS error — is ALLOWED_ORIGIN set to your GitHub Pages origin on Wispbyte?",
      true
    );
  }
}

document.addEventListener("DOMContentLoaded", boot);
