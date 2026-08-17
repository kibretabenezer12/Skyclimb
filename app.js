/* ============================================================
   Aviator — frontend

   GitHub Pages + Wispbyte: set BACKEND_URL to your HTTPS API base
   (must be https so WebSocket becomes wss — required by Telegram).
   ============================================================ */
const BACKEND_URL = (function () {
  // >>> REQUIRED when frontend is on GitHub Pages <<<
  return "https://avaitoret.wisp.uno";  // no trailing slash

  // Auto: same origin (only when UI is served by the FastAPI process)
  if (typeof location !== "undefined" && location.origin && location.origin !== "null") {
    return location.origin;
  }
  return "http://127.0.0.1:8000";
})();

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

/** Real mode → BIRR; demo mode → pts */
function currencyLabel(mode) {
  return (mode || state.mode) === "demo" ? "pts" : "BIRR";
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

  // Body
  ctx.fillStyle = "#f85149";
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.quadraticCurveTo(8, -5, -10, -3);
  ctx.lineTo(-14, 0);
  ctx.lineTo(-10, 3);
  ctx.quadraticCurveTo(8, 5, 18, 0);
  ctx.closePath();
  ctx.fill();

  // Wing
  ctx.fillStyle = "#da3633";
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(-4, -12);
  ctx.lineTo(-8, -11);
  ctx.lineTo(-2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(-4, 12);
  ctx.lineTo(-8, 11);
  ctx.lineTo(-2, 0);
  ctx.closePath();
  ctx.fill();

  // Tail
  ctx.fillStyle = "#f85149";
  ctx.beginPath();
  ctx.moveTo(-10, -1);
  ctx.lineTo(-16, -8);
  ctx.lineTo(-14, -1);
  ctx.closePath();
  ctx.fill();

  // Cockpit window
  ctx.fillStyle = "#58a6ff";
  ctx.beginPath();
  ctx.ellipse(10, -1, 3.5, 2.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawFrame() {
  const ctx = canvas.ctx;
  if (!ctx) { requestAnimationFrame(drawFrame); return; }

  ctx.clearRect(0, 0, canvas.w, canvas.h);

  // Sky scrolls downward as the plane climbs (stronger parallax = "going up" feel)
  if (flight.flying && !flight.crashed) {
    flight.skyScroll += 0.0028 + flight.progress * 0.007;
  }

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

  // Flight path trail
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
    grad.addColorStop(0.6, "rgba(248, 81, 73, 0.45)");
    grad.addColorStop(1, "rgba(248, 81, 73, 0.9)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Soft glow under trail
    ctx.strokeStyle = "rgba(248, 81, 73, 0.15)";
    ctx.lineWidth = 12;
    ctx.stroke();
  }

  // Plane (larger scale)
  const PLANE_SCALE = 2.75;
  if (flight.flying || flight.crashed) {
    const t = Math.min(1, flight.progress);
    const pt = pathPoint(t);
    const angle = pathTangent(t);
    flight.planeAngle = angle;

    if (!flight.crashed) {
      drawPlane(ctx, pt.x, pt.y, angle, PLANE_SCALE);
    } else {
      // Fly off screen after crash
      const off = pathPoint(Math.min(1.15, t + 0.08));
      drawPlane(ctx, off.x, off.y, angle - 0.15, PLANE_SCALE * 0.95);
    }
  } else {
    // Waiting: plane sits at start
    const pt = pathPoint(0);
    drawPlane(ctx, pt.x, pt.y, pathTangent(0), PLANE_SCALE * 0.95);
  }

  requestAnimationFrame(drawFrame);
}

function setFlightProgress(mult) {
  // Map multiplier → visual path progress. Higher coefficient = plane moves farther
  // along the path at the same mult (numbers unchanged; only animation is faster).
  // ~2.5x ≈ mid path, ~8x near end
  const p = 1 - Math.exp(-(mult - 1) * 0.38);
  flight.progress = Math.min(0.98, p);
  const pt = pathPoint(flight.progress);
  flight.trail.push(pt);
  if (flight.trail.length > 80) flight.trail.shift();
}

function resetFlight() {
  flight.progress = 0;
  flight.flying = false;
  flight.skyScroll = 0;
  flight.crashed = false;
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
  if (result === "crash") return "CRASHED";
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
      // Active bet on this flight → cash out
      stakeInput.disabled = true;
      btn.textContent = "CASHOUT";
      btn.classList.add("cashout");
      btn.disabled = false;
      resultBox.textContent = `${entry.stake} ${currencyLabel(entry.mode)} in flight`;
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
        resetFlight();
        hideCrashBanner();
        setMultiplierDisplay(1.0, false);
        // Only clear log when a brand-new round starts (no entries yet is fine)
        if (!(msg.entries && msg.entries.length)) {
          document.getElementById("logList").innerHTML = '<p class="empty">No bets this round yet.</p>';
        }
        setStatus("Place your bets");
        sound.stopHum();
      } else if (msg.phase === "flying") {
        startFlight();
        setFlightProgress(state.multiplier);
        setMultiplierDisplay(state.multiplier, false);
        hideCrashBanner();
        setStatus("Flying… cash out before it disappears");
        sound.startHum();
      } else if (msg.phase === "resolved") {
        crashFlight();
        setMultiplierDisplay(msg.crash_point || state.multiplier, true);
        showCrashBanner(msg.crash_point || state.multiplier);
        setStatus(`Crashed @ ${(msg.crash_point || 0).toFixed(2)}×`);
        sound.stopHum();
        sound.thud();
        renderHistory();
      }
      renderAllTerminals();
      break;

    case "countdown":
      setStatus(`Next round in ${msg.seconds_left.toFixed(1)}s — place bets`);
      break;

    case "tick":
      state.multiplier = msg.multiplier;
      setMultiplierDisplay(msg.multiplier, false);
      setFlightProgress(msg.multiplier);
      sound.updateHum(msg.multiplier);
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
      input.value = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
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
      const stake = Math.max(1, parseInt(stakeInput.value, 10) || 1);
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
      const stake = Math.max(1, parseInt(stakeInput.value, 10) || 1);
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
    if (!res.ok) throw new Error("auth failed");
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
    setStatus("Couldn't reach the backend — check BACKEND_URL in app.js.");
  }
}

document.addEventListener("DOMContentLoaded", boot);
