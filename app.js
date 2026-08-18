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

/** Same curve as server game_engine.multiplier_at — for smooth UI only.
 *  Larger divisor = slower climb / longer fly time to any given mult.
 */
function multiplierAt(tSec) {
  if (tSec <= 0) return 1.0;
  return Math.round((1.0 + Math.pow(tSec / 4.8, 1.35)) * 100) / 100;
}

function timeToReachMult(target) {
  if (target <= 1.0) return 0;
  return 4.8 * Math.pow(target - 1.0, 1 / 1.35);
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
  let lastTerminalMs = 0;
  const step = () => {
    if (state.phase !== "flying") {
      state._multRaf = 0;
      return;
    }
    const t = (performance.now() - (state.flightStartPerf || performance.now())) / 1000;
    // Smooth display (same curve as server). Server still settles cashout.
    const m = multiplierAt(t);
    state.multiplier = m;
    setMultiplierDisplay(m, false);
    setFlightProgress(m);
    sound.updateHum(m);
    // Cashout label ~10 Hz so phones stay smooth
    const now = performance.now();
    if (now - lastTerminalMs >= 100) {
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
}

function startSmoothCountdown(secondsLeft) {
  stopSmoothCountdown();
  const endAt = performance.now() + Math.max(0, Number(secondsLeft) || 0) * 1000;
  state._waitEndAt = endAt;
  const paint = () => {
    if (state.phase !== "waiting") {
      stopSmoothCountdown();
      return;
    }
    const left = Math.max(0, (state._waitEndAt - performance.now()) / 1000);
    setStatus(`Next round in ${left.toFixed(1)}s — place bets`);
    if (left <= 0) stopSmoothCountdown();
  };
  paint();
  state._cdTimer = setInterval(paint, 50); // smooth 20 Hz UI, no server spam
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
  click() { this.tone(320, 0.08, "square", 0.07); },
  chime() { this.tone(660, 0.18, "sine", 0.11); setTimeout(() => this.tone(880, 0.24, "sine", 0.11), 90); },
  thud() { this.tone(85, 0.4, "sawtooth", 0.16); },
  startHum() {
    // Always kill any previous hum first (prevents stacked oscillators that never stop)
    this.stopHum(true);
    if (!this.enabled) return;
    this.ensure();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = 55;
    gain.gain.value = 0.015;
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    this.humOsc = osc;
    this.humGain = gain;
  },
  updateHum(mult) {
    if (!this.enabled || !this.humOsc) return;
    try {
      this.humOsc.frequency.setTargetAtTime(55 + (mult - 1) * 18, this.ctx.currentTime, 0.1);
    } catch (_) { /* ignore */ }
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
const flight = {
  progress: 0,          // 0..1 visual progress along the path
  flying: false,
  crashed: false,
  flyOff: 0,            // 0..1 extra progress after "flew away"
  trail: [],            // recent points for the vapor trail
  planeAngle: -0.35,
  stars: [],
  skyScroll: 0,         // continuous downward drift of the starfield
  propAngle: 0,         // spinning propeller
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
  t = Math.max(0, Math.min(1, t));
  const x = 0.08 + 0.82 * t;
  const y = 0.88 - 0.72 * Math.pow(t, 1.5);
  return { x: x * canvas.w, y: y * canvas.h };
}

function pathTangent(t) {
  t = Math.max(0, Math.min(1, t));
  // x = 0.08 + 0.82 t  → dx/dt = 0.82
  // y = 0.88 - 0.72 t^1.5 → dy/dt = -0.72 * 1.5 * t^0.5 = -1.08 * sqrt(t)
  const dx = 0.82;
  const dy = t <= 0 ? 0 : -1.08 * Math.sqrt(t);
  return Math.atan2(dy, dx);
}

function drawPlane(ctx, x, y, angle, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  // Soft under-glow (matches real Aviator look)
  ctx.fillStyle = "rgba(248, 81, 73, 0.18)";
  ctx.beginPath();
  ctx.ellipse(2, 4, 22, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Main fuselage (sleek red body like Spribe screenshots)
  ctx.fillStyle = "#e63e3e";
  ctx.beginPath();
  ctx.moveTo(22, 0);                    // nose tip
  ctx.quadraticCurveTo(14, -6, 4, -5);
  ctx.lineTo(-12, -4);
  ctx.quadraticCurveTo(-18, -3, -20, 0);
  ctx.quadraticCurveTo(-18, 3, -12, 4);
  ctx.lineTo(4, 5);
  ctx.quadraticCurveTo(14, 6, 22, 0);
  ctx.closePath();
  ctx.fill();

  // Darker lower body shade
  ctx.fillStyle = "#c62828";
  ctx.beginPath();
  ctx.moveTo(18, 1);
  ctx.quadraticCurveTo(10, 5, 0, 4.5);
  ctx.lineTo(-12, 3.5);
  ctx.quadraticCurveTo(-16, 2, -18, 0);
  ctx.lineTo(-12, 1);
  ctx.lineTo(4, 2);
  ctx.closePath();
  ctx.fill();

  // Upper wing
  ctx.fillStyle = "#d32f2f";
  ctx.beginPath();
  ctx.moveTo(4, -1);
  ctx.lineTo(-2, -14);
  ctx.lineTo(-9, -13);
  ctx.lineTo(-4, -1);
  ctx.closePath();
  ctx.fill();

  // Lower wing
  ctx.beginPath();
  ctx.moveTo(4, 1);
  ctx.lineTo(-2, 14);
  ctx.lineTo(-9, 13);
  ctx.lineTo(-4, 1);
  ctx.closePath();
  ctx.fill();

  // Tail fin
  ctx.fillStyle = "#e63e3e";
  ctx.beginPath();
  ctx.moveTo(-12, -2);
  ctx.lineTo(-18, -12);
  ctx.lineTo(-15, -2);
  ctx.closePath();
  ctx.fill();
  // Horizontal stabilizer
  ctx.beginPath();
  ctx.moveTo(-13, 0);
  ctx.lineTo(-19, -5);
  ctx.lineTo(-19, 5);
  ctx.lineTo(-13, 0);
  ctx.closePath();
  ctx.fill();

  // Cockpit canopy
  ctx.fillStyle = "#7ec8ff";
  ctx.beginPath();
  ctx.ellipse(8, -2.2, 5, 2.8, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(9.5, -2.8, 2.2, 1.2, -0.15, 0, Math.PI * 2);
  ctx.fill();

  // Spinning propeller (front)
  ctx.save();
  ctx.translate(22, 0);
  ctx.rotate(flight.propAngle);
  // Prop disc blur
  ctx.fillStyle = "rgba(180, 40, 40, 0.25)";
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, Math.PI * 2);
  ctx.fill();
  // Blades
  ctx.fillStyle = "#b71c1c";
  for (let i = 0; i < 3; i++) {
    ctx.rotate((Math.PI * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(1.5, -8);
    ctx.lineTo(-1.5, -8);
    ctx.closePath();
    ctx.fill();
  }
  // Hub
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

function drawFrame() {
  const ctx = canvas.ctx;
  if (!ctx) { requestAnimationFrame(drawFrame); return; }

  ctx.clearRect(0, 0, canvas.w, canvas.h);

  // Continuous prop spin (smooth, independent of frame rate feel)
  flight.propAngle += 0.42;

  // Sky scrolls more gently (smoother, less "too many frames" feeling)
  if (flight.flying && !flight.crashed) {
    flight.skyScroll += 0.0014 + flight.progress * 0.0035;
  } else if (flight.crashed) {
    // Keep a little drift while it flies away
    flight.skyScroll += 0.002;
    flight.flyOff = Math.min(1, flight.flyOff + 0.012);
  }

  // Climb progress drives most of the motion; continuous drift keeps it alive between ticks
  const scrollBase = flight.progress * 1.05 + flight.skyScroll;

  // Radial sunburst / rays (like real Aviator screenshots) centered near plane path
  const cx = canvas.w * 0.55;
  const cy = canvas.h * 0.45;
  const rayCount = 18;
  for (let i = 0; i < rayCount; i++) {
    const a = (i / rayCount) * Math.PI * 2 + scrollBase * 0.15;
    const len = Math.max(canvas.w, canvas.h) * 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.strokeStyle = i % 2 === 0
      ? "rgba(40, 20, 60, 0.35)"
      : "rgba(20, 10, 40, 0.22)";
    ctx.lineWidth = 28 + (i % 3) * 8;
    ctx.stroke();
  }
  // Soft radial vignette over rays
  const rg = ctx.createRadialGradient(cx, cy, 20, cx, cy, Math.max(canvas.w, canvas.h) * 0.7);
  rg.addColorStop(0, "rgba(10, 8, 25, 0)");
  rg.addColorStop(0.55, "rgba(8, 6, 20, 0.25)");
  rg.addColorStop(1, "rgba(5, 4, 15, 0.55)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, canvas.w, canvas.h);

  // Horizontal grid lines drifting downward (subtle)
  ctx.strokeStyle = "rgba(88, 166, 255, 0.06)";
  ctx.lineWidth = 1;
  const gridStep = canvas.h / 6;
  const gridOff = (scrollBase * canvas.h * 0.45) % gridStep;
  for (let i = -1; i < 10; i++) {
    const y = i * gridStep + gridOff;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.w, y);
    ctx.stroke();
  }

  // Sky parallax stars
  for (const s of flight.stars) {
    const d = s.depth;
    let sy = s.y + scrollBase * d;
    sy = sy - Math.floor(sy);
    let sx = s.x - scrollBase * d * 0.55;
    sx = sx - Math.floor(sx);
    const px = sx * canvas.w;
    const py = sy * canvas.h;
    ctx.beginPath();
    ctx.arc(px, py, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(200, 220, 255, ${s.a * 0.85})`;
    ctx.fill();
  }

  // Flight path trail (red vapor)
  if (flight.trail.length > 1) {
    ctx.beginPath();
    ctx.moveTo(flight.trail[0].x, flight.trail[0].y);
    for (let i = 1; i < flight.trail.length; i++) {
      ctx.lineTo(flight.trail[i].x, flight.trail[i].y);
    }
    const grad = ctx.createLinearGradient(
      flight.trail[0].x, flight.trail[0].y,
      flight.trail[flight.trail.length - 1].x, flight.trail[flight.trail.length - 1].y
    );
    grad.addColorStop(0, "rgba(248, 81, 73, 0)");
    grad.addColorStop(0.55, "rgba(248, 81, 73, 0.4)");
    grad.addColorStop(1, "rgba(248, 81, 73, 0.95)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.stroke();

    // Soft glow under trail
    ctx.strokeStyle = "rgba(248, 81, 73, 0.12)";
    ctx.lineWidth = 11;
    ctx.stroke();
  }

  // Plane
  const PLANE_SCALE = 2.85;
  if (flight.flying || flight.crashed) {
    // After "flew away" keep advancing along / past the path
    const t = Math.min(1.25, flight.progress + flight.flyOff * 0.35);
    const pt = pathPoint(Math.min(1, t));
    // Extra offset once past the path end so it truly leaves the screen
    let extraX = 0, extraY = 0;
    if (t > 1) {
      const over = t - 1;
      extraX = over * canvas.w * 0.55;
      extraY = -over * canvas.h * 0.35;
    }
    const angle = pathTangent(Math.min(1, t)) - flight.flyOff * 0.25;
    flight.planeAngle = angle;

    const alpha = flight.crashed ? Math.max(0, 1 - flight.flyOff * 0.85) : 1;
    ctx.globalAlpha = alpha;
    drawPlane(ctx, pt.x + extraX, pt.y + extraY, angle, PLANE_SCALE * (1 - flight.flyOff * 0.15));
    ctx.globalAlpha = 1;
  } else {
    // Waiting: plane sits at start
    const pt = pathPoint(0);
    drawPlane(ctx, pt.x, pt.y, pathTangent(0), PLANE_SCALE * 0.95);
  }

  requestAnimationFrame(drawFrame);
}

function setFlightProgress(mult) {
  // Map multiplier → visual path progress.
  // Smaller coefficient + slower mult curve = plane climbs more gradually (matches longer fly time).
  // ~3x ≈ mid path, higher mults stretch toward the edge without rushing.
  const p = 1 - Math.exp(-(mult - 1) * 0.26);
  flight.progress = Math.min(0.97, p);
  const pt = pathPoint(flight.progress);
  flight.trail.push(pt);
  if (flight.trail.length > 100) flight.trail.shift();
}

function resetFlight() {
  flight.progress = 0;
  flight.flying = false;
  flight.skyScroll = 0;
  flight.crashed = false;
  flight.flyOff = 0;
  flight.trail = [];
}

function startFlight() {
  flight.flying = true;
  flight.crashed = false;
  flight.flyOff = 0;
  flight.trail = [];
  flight.progress = 0;
}

function crashFlight() {
  flight.crashed = true;
  flight.flying = false;
  // flyOff continues in drawFrame so the plane smoothly leaves the screen
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
  document.getElementById("crashText").textContent = "FLEW AWAY!";
  document.getElementById("crashMult").textContent = `${crashMult.toFixed(2)}×`;
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
        // Only clear log when a brand-new round starts (no entries yet is fine)
        if (!(msg.entries && msg.entries.length)) {
          document.getElementById("logList").innerHTML = '<p class="empty">No bets this round yet.</p>';
        }
        setStatus("Place your bets");
        sound.stopHum();
      } else if (msg.phase === "flying") {
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
        sound.thud();
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
        else sound.thud();
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
