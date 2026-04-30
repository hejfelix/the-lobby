import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Stock Market
 * ────────────
 * A shared random-walk price chart that everyone watches at the same time.
 *
 * - One peer (the "host" — deterministically the lowest peer id in the room
 *   including yourself) runs the simulation and broadcasts price ticks at
 *   ~10 Hz. Other peers just render what they receive.
 * - Each player starts with $1000 cash + 10 shares. Pressing space toggles:
 *   if you hold shares you sell them all at the latest price; if you hold
 *   cash you buy as many shares as fit. Portfolio value = cash + shares*price.
 * - Two power buttons (PUMP / TANK), each on a 10s cooldown, broadcast a 5s
 *   bias to the simulation. Pumps push drift up, tanks push it down. They
 *   stack across players (multiple pumps = bigger pump), so coordinate.
 *
 * Network actions on the "market" namespace:
 *   - tick      (host → all)  : { p, t }
 *   - influence (any → all)   : { kind, t } — applied on the host
 *   - state     (any → all)   : { cash, shares } — broadcast on every trade
 *   - sync-req  (joiner → all): {} — ask peers for their current portfolio
 */

const START_CASH = 1000;
const START_SHARES = 10;
const TICK_HZ = 10;
const TICK_MS = 1000 / TICK_HZ;
const HISTORY_SECONDS = 60;
const HISTORY_SIZE = HISTORY_SECONDS * TICK_HZ;
/** Random walk parameters (per second). */
const VOL_PER_SEC = 6; // standard deviation of per-second price change
const MEAN_REVERSION = 0.04; // pulls price slowly back to BASE
const BASE_PRICE = 100;
const MIN_PRICE = 1;

const INFLUENCE_DURATION_MS = 5000;
const INFLUENCE_COOLDOWN_MS = 10_000;
const PUMP_DRIFT = 14; // price units per second while a single pump is active
const TANK_DRIFT = -14;

/** Force a buy/sell toggle if the player hasn't acted in this long. */
const INACTIVITY_LIMIT_MS = 30_000;

interface TickMsg {
  /** Latest price. */
  p: number;
  /** Wall-clock timestamp (ms) of this tick. */
  t: number;
}

interface InfluenceMsg {
  kind: "pump" | "tank";
  /** Wall-clock start time. */
  t: number;
}

interface StateMsg {
  cash: number;
  shares: number;
}

interface ActiveInfluence {
  kind: "pump" | "tank";
  ownerId: string;
  start: number; // wall-clock ms
}

export const MarketGame: Game = {
  id: "market",
  name: "Stock Market",
  description:
    "Shared price chart. Press space to toggle between holding shares and cash. PUMP and TANK to swing the market.",
  create(container, net): GameInstance {
    const inst = new MarketInstance(container, net);
    return { unmount: () => inst.destroy() };
  },
};

class MarketInstance {
  private net: Net;
  private ns: GameNamespace;

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private priceEl!: HTMLDivElement;
  private positionEl!: HTMLDivElement;
  private valueEl!: HTMLDivElement;
  private leaderboardEl!: HTMLDivElement;
  private pumpBtn!: HTMLButtonElement;
  private tankBtn!: HTMLButtonElement;
  private inactivityEl!: HTMLDivElement;
  private tradeBtn!: HTMLButtonElement;
  private timerRing!: SVGCircleElement;
  private timerLabel!: SVGTextElement;
  private timerWrap!: HTMLDivElement;
  private audio: AudioContext | null = null;
  private lastBeepSecond = -1;

  /** Latest known price, updated by host ticks (or simulated locally if host). */
  private price = BASE_PRICE;
  /** Ring buffer of recent prices for charting. */
  private history: number[] = [];
  private historyAnchorT = 0;

  /** Per-peer reported portfolio. */
  private portfolios: Map<string, StateMsg> = new Map();
  /** Active influences (from any peer). */
  private influences: ActiveInfluence[] = [];

  /** This player's own state. */
  private cash = START_CASH;
  private shares = START_SHARES;

  /** Cooldown end times (wall-clock ms). */
  private pumpReadyAt = 0;
  private tankReadyAt = 0;
  /** Wall-clock ms of the last buy/sell action by this player. */
  private lastTradeAt = 0;

  /** Host simulation timer. */
  private hostTimer: ReturnType<typeof setInterval> | null = null;
  /** UI redraw timer. */
  private rafId = 0;
  /** Last host-side simulation tick wall time. */
  private lastSimT = 0;

  private resizeObs: ResizeObserver | null = null;
  private unsubPeers: (() => void) | null = null;

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== "Space") return;
    // Don't steal space from chat input or other text fields.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    this.ensureAudio();
    this.toggleTrade();
  };

  constructor(container: HTMLElement, net: Net) {
    this.net = net;
    this.ns = net.namespace("market");

    container.innerHTML = `
      <div class="game-layout market-layout">
        <aside class="toolbar market-toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint">
              Press <kbd>space</kbd> to toggle between holding shares and holding cash.
              The market drifts randomly. Use PUMP and TANK to swing it &mdash;
              effects are global and stack across players.
            </p>
          </div>
          <div class="tool-group">
            <label>Your portfolio</label>
            <div class="market-position"></div>
            <div class="market-value"></div>
            <div class="market-inactivity"></div>
          </div>
          <div class="tool-group">
            <label>Powers</label>
            <div class="market-powers">
              <button type="button" class="market-pump">PUMP</button>
              <button type="button" class="market-tank">TANK</button>
            </div>
            <p class="hint">5s effect, 10s cooldown each.</p>
          </div>
          <div class="tool-group">
            <label>Leaderboard <span class="muted">(portfolio value)</span></label>
            <div class="market-leaderboard"></div>
          </div>
        </aside>
        <section class="market-stage">
          <div class="market-price"></div>
          <canvas class="market-canvas"></canvas>
          <div class="market-actionbar">
            <div class="market-timer">
              <svg viewBox="0 0 80 80" width="80" height="80">
                <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="6" />
                <circle class="market-timer-ring" cx="40" cy="40" r="34"
                  fill="none" stroke="#2d5a4f" stroke-width="6"
                  stroke-linecap="round"
                  stroke-dasharray="213.628" stroke-dashoffset="0"
                  transform="rotate(-90 40 40)" />
                <text class="market-timer-label" x="40" y="46" text-anchor="middle"
                  font-family="ui-monospace, monospace" font-size="22" font-weight="700" fill="#2d5a4f">30</text>
              </svg>
            </div>
            <button type="button" class="market-trade">SELL</button>
          </div>
        </section>
      </div>
    `;

    this.canvas = container.querySelector<HTMLCanvasElement>(".market-canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.priceEl = container.querySelector<HTMLDivElement>(".market-price")!;
    this.positionEl = container.querySelector<HTMLDivElement>(".market-position")!;
    this.valueEl = container.querySelector<HTMLDivElement>(".market-value")!;
    this.leaderboardEl = container.querySelector<HTMLDivElement>(".market-leaderboard")!;
    this.pumpBtn = container.querySelector<HTMLButtonElement>(".market-pump")!;
    this.tankBtn = container.querySelector<HTMLButtonElement>(".market-tank")!;
    this.inactivityEl = container.querySelector<HTMLDivElement>(".market-inactivity")!;
    this.tradeBtn = container.querySelector<HTMLButtonElement>(".market-trade")!;
    this.timerWrap = container.querySelector<HTMLDivElement>(".market-timer")!;
    this.timerRing = container.querySelector<SVGCircleElement>(".market-timer-ring")!;
    this.timerLabel = container.querySelector<SVGTextElement>(".market-timer-label")!;

    this.tradeBtn.addEventListener("click", () => {
      this.ensureAudio();
      this.toggleTrade();
    });

    this.pumpBtn.addEventListener("click", () => { this.ensureAudio(); this.fireInfluence("pump"); });
    this.tankBtn.addEventListener("click", () => { this.ensureAudio(); this.fireInfluence("tank"); });
    window.addEventListener("keydown", this.onKey);

    this.history = new Array(HISTORY_SIZE).fill(BASE_PRICE);
    this.historyAnchorT = Date.now();

    this.registerNetwork();
    this.startResizeWatcher();
    this.broadcastState();
    this.ns.send("sync-req", {});

    this.unsubPeers = this.net.on("peers", () => {
      this.maybeStartHost();
      this.renderSidebar();
    });
    this.maybeStartHost();
    this.renderSidebar();

    this.lastSimT = Date.now();
    this.lastTradeAt = Date.now();
    const loop = () => {
      this.checkInactivity();
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    if (this.hostTimer) clearInterval(this.hostTimer);
    this.resizeObs?.disconnect();
    this.unsubPeers?.();
    window.removeEventListener("keydown", this.onKey);
    this.audio?.close().catch(() => { /* ignore */ });
    this.ns.close();
  }

  // ---------- networking ----------

  private registerNetwork() {
    this.ns.on<TickMsg>("tick", (msg, peerId) => {
      if (!msg || typeof msg.p !== "number") return;
      // Only accept ticks from the current host (or if we have no host yet).
      const host = this.hostId();
      if (host && peerId !== host) return;
      const p = clampPrice(msg.p);
      this.price = p;
      this.pushHistory(p, msg.t || Date.now());
    });
    this.ns.on<InfluenceMsg>("influence", (msg, peerId) => {
      if (!msg || (msg.kind !== "pump" && msg.kind !== "tank")) return;
      this.influences.push({ kind: msg.kind, ownerId: peerId, start: msg.t || Date.now() });
      this.pruneInfluences();
    });
    this.ns.on<StateMsg>("state", (msg, peerId) => {
      if (!msg) return;
      this.portfolios.set(peerId, sanitizeState(msg));
      this.renderSidebar();
    });
    this.ns.on<Record<string, never>>("sync-req", (_d, peerId) => {
      this.ns.send("state", { cash: this.cash, shares: this.shares }, peerId);
    });
  }

  // ---------- host election & simulation ----------

  /** Lowest peer id among me + connected peers acts as the host. */
  private hostId(): string {
    const all = [this.net.me.id, ...this.net.peers.keys()];
    all.sort();
    return all[0];
  }

  private isHost(): boolean {
    return this.hostId() === this.net.me.id;
  }

  private maybeStartHost() {
    const shouldHost = this.isHost();
    if (shouldHost && !this.hostTimer) {
      this.lastSimT = Date.now();
      this.hostTimer = setInterval(() => this.simulateTick(), TICK_MS);
    } else if (!shouldHost && this.hostTimer) {
      clearInterval(this.hostTimer);
      this.hostTimer = null;
    }
  }

  private simulateTick() {
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastSimT) / 1000);
    this.lastSimT = now;

    // Sum active influence drift.
    this.pruneInfluences();
    let drift = 0;
    for (const inf of this.influences) {
      drift += inf.kind === "pump" ? PUMP_DRIFT : TANK_DRIFT;
    }
    // Mean reversion to BASE_PRICE.
    drift += (BASE_PRICE - this.price) * MEAN_REVERSION;
    // Random shock — Box-Muller would be nicer but uniform is plenty random.
    const shock = (Math.random() * 2 - 1) * VOL_PER_SEC;
    const next = clampPrice(this.price + (drift + shock) * dt);

    this.price = next;
    this.pushHistory(next, now);
    this.ns.send("tick", { p: next, t: now });
  }

  private pruneInfluences() {
    const cutoff = Date.now() - INFLUENCE_DURATION_MS;
    this.influences = this.influences.filter((i) => i.start > cutoff);
  }

  private pushHistory(p: number, t: number) {
    // Advance ring buffer based on elapsed time since the last tick.
    const elapsedSlots = Math.max(1, Math.round(((t - this.historyAnchorT) / TICK_MS)));
    if (elapsedSlots >= HISTORY_SIZE) {
      this.history.fill(p);
    } else {
      for (let i = 0; i < elapsedSlots; i++) {
        this.history.push(p);
      }
      while (this.history.length > HISTORY_SIZE) this.history.shift();
    }
    this.historyAnchorT = t;
  }

  // ---------- player actions ----------

  private toggleTrade(forced = false) {
    if (this.shares > 0) {
      // Sell everything.
      this.cash += this.shares * this.price;
      const sold = this.shares;
      this.shares = 0;
      this.net.pushSystem(
        `${this.net.me.name}${forced ? " was force-sold" : " sold"} ${sold} shares @ $${this.price.toFixed(2)}`,
      );
    } else {
      // Buy as many shares as fit.
      const qty = Math.floor(this.cash / this.price);
      if (qty <= 0) {
        this.net.pushSystem(`${this.net.me.name} can't afford any shares.`);
        // Still count this as activity so we don't spam the warning.
        this.lastTradeAt = Date.now();
        return;
      }
      this.cash -= qty * this.price;
      this.shares += qty;
      this.net.pushSystem(
        `${this.net.me.name}${forced ? " was force-bought" : " bought"} ${qty} shares @ $${this.price.toFixed(2)}`,
      );
    }
    this.lastTradeAt = Date.now();
    this.broadcastState();
    this.renderSidebar();
  }

  private fireInfluence(kind: "pump" | "tank") {
    const now = Date.now();
    const readyAt = kind === "pump" ? this.pumpReadyAt : this.tankReadyAt;
    if (now < readyAt) return;
    if (kind === "pump") this.pumpReadyAt = now + INFLUENCE_COOLDOWN_MS;
    else this.tankReadyAt = now + INFLUENCE_COOLDOWN_MS;
    // Apply locally so we see the effect immediately, then broadcast.
    this.influences.push({ kind, ownerId: this.net.me.id, start: now });
    this.ns.send("influence", { kind, t: now });
    this.renderSidebar();
  }

  private broadcastState() {
    this.portfolios.set(this.net.me.id, { cash: this.cash, shares: this.shares });
    this.ns.send("state", { cash: this.cash, shares: this.shares });
  }

  // ---------- rendering ----------

  private renderSidebar() {
    this.positionEl.innerHTML = `
      <div class="market-line"><span>Cash</span><span class="mono">$${this.cash.toFixed(2)}</span></div>
      <div class="market-line"><span>Shares</span><span class="mono">${this.shares}</span></div>
    `;
    const value = this.cash + this.shares * this.price;
    this.valueEl.innerHTML = `<div class="market-value-big mono">$${value.toFixed(2)}</div>`;

    // Leaderboard rows.
    const me = this.net.me;
    const rows: Array<{ id: string; name: string; color: string; value: number }> = [];
    const allIds = new Set<string>([me.id, ...this.net.peers.keys(), ...this.portfolios.keys()]);
    for (const id of allIds) {
      const port = this.portfolios.get(id) ?? (id === me.id ? { cash: this.cash, shares: this.shares } : undefined);
      if (!port) continue;
      const peer = id === me.id ? { name: me.name, color: me.color } : this.net.peers.get(id);
      if (!peer) continue;
      const v = port.cash + port.shares * this.price;
      rows.push({ id, name: peer.name, color: peer.color, value: v });
    }
    rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    this.leaderboardEl.innerHTML = rows
      .map(
        (r) => `
          <div class="market-row">
            <span class="market-dot" style="background:${escapeAttr(r.color)}"></span>
            <span class="market-name">${escapeHtml(r.name)}${r.id === me.id ? " (you)" : ""}</span>
            <span class="mono">$${r.value.toFixed(2)}</span>
          </div>
        `,
      )
      .join("");

    // Cooldown labels (recomputed continuously in draw() too).
    this.refreshPowerButtons();
  }

  private refreshPowerButtons() {
    const now = Date.now();
    const fmt = (readyAt: number) => {
      const remaining = Math.max(0, readyAt - now);
      return remaining > 0 ? ` (${(remaining / 1000).toFixed(1)}s)` : "";
    };
    const pumpText = "PUMP" + fmt(this.pumpReadyAt);
    const tankText = "TANK" + fmt(this.tankReadyAt);
    if (this.pumpBtn.textContent !== pumpText) this.pumpBtn.textContent = pumpText;
    if (this.tankBtn.textContent !== tankText) this.tankBtn.textContent = tankText;
    this.pumpBtn.disabled = now < this.pumpReadyAt;
    this.tankBtn.disabled = now < this.tankReadyAt;
  }

  private refreshInactivity() {
    const remaining = Math.max(0, this.lastTradeAt + INACTIVITY_LIMIT_MS - Date.now());
    const totalSec = INACTIVITY_LIMIT_MS / 1000;
    const remSec = remaining / 1000;
    const action = this.shares > 0 ? "SELL" : "BUY";
    const warn = remaining < 5_000;

    // Sidebar text.
    const text = `auto-${action.toLowerCase()} in ${remSec.toFixed(1)}s`;
    if (this.inactivityEl.textContent !== text) this.inactivityEl.textContent = text;
    this.inactivityEl.classList.toggle("market-inactivity-warn", warn);

    // Big trade button label.
    if (this.tradeBtn.textContent !== action) this.tradeBtn.textContent = action;
    this.tradeBtn.classList.toggle("market-trade-sell", action === "SELL");
    this.tradeBtn.classList.toggle("market-trade-buy", action === "BUY");

    // Circular timer.
    const CIRC = 2 * Math.PI * 34; // r=34
    const frac = remSec / totalSec;
    const offset = CIRC * (1 - frac);
    this.timerRing.setAttribute("stroke-dashoffset", offset.toFixed(2));
    this.timerRing.setAttribute("stroke", warn ? "#c2402a" : "#2d5a4f");
    this.timerLabel.setAttribute("fill", warn ? "#c2402a" : "#2d5a4f");
    this.timerLabel.textContent = Math.ceil(remSec).toString();
    this.timerWrap.classList.toggle("market-timer-warn", warn);

    // Beep on each new whole-second remaining while in warning zone.
    if (warn) {
      const sec = Math.ceil(remSec);
      if (sec > 0 && sec !== this.lastBeepSecond) {
        this.lastBeepSecond = sec;
        this.playBeep(sec === 1 ? 1200 : 880);
      }
    } else {
      this.lastBeepSecond = -1;
    }
  }

  private checkInactivity() {
    if (Date.now() - this.lastTradeAt >= INACTIVITY_LIMIT_MS) {
      this.toggleTrade(true);
    }
  }

  private ensureAudio(): AudioContext | null {
    if (this.audio) return this.audio;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.audio = new Ctor();
      return this.audio;
    } catch {
      return null;
    }
  }

  private playBeep(freq: number) {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.2);
  }

  private draw() {
    this.refreshPowerButtons();
    this.refreshInactivity();
    // Update price label.
    this.priceEl.textContent = `$${this.price.toFixed(2)}`;

    const c = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    c.clearRect(0, 0, w, h);

    if (this.history.length === 0) return;
    // Compute min/max with a little padding.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.history) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const pad = Math.max(2, (hi - lo) * 0.1);
    lo -= pad;
    hi += pad;
    const range = Math.max(0.01, hi - lo);

    // Grid lines.
    c.strokeStyle = "rgba(0,0,0,0.06)";
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }

    // Active-influence overlay (subtle background tint).
    this.pruneInfluences();
    let pumps = 0;
    let tanks = 0;
    for (const inf of this.influences) {
      if (inf.kind === "pump") pumps++;
      else tanks++;
    }
    if (pumps > 0 || tanks > 0) {
      const net = pumps - tanks;
      c.fillStyle = net > 0 ? `rgba(45,160,80,${Math.min(0.18, 0.05 * pumps)})` : `rgba(200,60,60,${Math.min(0.18, 0.05 * tanks)})`;
      c.fillRect(0, 0, w, h);
    }

    // Price line.
    const n = this.history.length;
    c.strokeStyle = "#2d5a4f";
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - ((this.history[i] - lo) / range) * h;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();

    // Latest price tick marker.
    const lastY = h - ((this.price - lo) / range) * h;
    c.fillStyle = "#2d5a4f";
    c.beginPath();
    c.arc(w - 2, lastY, 4, 0, Math.PI * 2);
    c.fill();

    // Influence indicator pill in top-left.
    if (pumps > 0 || tanks > 0) {
      const label = pumps > 0 ? `PUMP x${pumps}` : `TANK x${tanks}`;
      c.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      c.fillStyle = pumps > 0 ? "#2d8a4f" : "#b3401e";
      c.textAlign = "left";
      c.fillText(label, 8, 16);
    }
  }

  private startResizeWatcher() {
    const fit = () => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    fit();
    this.resizeObs = new ResizeObserver(fit);
    this.resizeObs.observe(this.canvas);
  }
}

function clampPrice(p: number): number {
  if (!Number.isFinite(p)) return BASE_PRICE;
  return Math.max(MIN_PRICE, p);
}

function sanitizeState(s: unknown): StateMsg {
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    cash: Math.max(0, num(o.cash, 0)),
    shares: Math.max(0, Math.floor(num(o.shares, 0))),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
