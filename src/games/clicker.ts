import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

// ---------------- progression model ----------------

interface Upgrade {
  id: string;
  name: string;
  desc: string;
  /** Base price; each subsequent purchase scales by `priceGrowth`. */
  basePrice: number;
  priceGrowth: number;
  /** Effect description for UI. */
  effect: string;
  /** What kind of upgrade — affects calculations. */
  kind: "click-multiplier" | "auto-clicker";
  /** How much the upgrade contributes per level. */
  perLevel: number;
}

const UPGRADES: Upgrade[] = [
  {
    id: "stronger-fingers",
    name: "Stronger Fingers",
    desc: "Each click counts for more.",
    basePrice: 25,
    priceGrowth: 1.6,
    effect: "+1 per click",
    kind: "click-multiplier",
    perLevel: 1,
  },
  {
    id: "auto-tapper",
    name: "Auto-Tapper",
    desc: "A tireless little machine that taps for you.",
    basePrice: 100,
    priceGrowth: 1.5,
    effect: "+1 click / sec",
    kind: "auto-clicker",
    perLevel: 1,
  },
  {
    id: "factory",
    name: "Click Factory",
    desc: "Industrial-scale clicking.",
    basePrice: 1500,
    priceGrowth: 1.55,
    effect: "+10 clicks / sec",
    kind: "auto-clicker",
    perLevel: 10,
  },
  {
    id: "cosmic-finger",
    name: "Cosmic Finger",
    desc: "Each click resonates through dimensions.",
    basePrice: 8000,
    priceGrowth: 1.7,
    effect: "+15 per click",
    kind: "click-multiplier",
    perLevel: 15,
  },
  {
    id: "mega-factory",
    name: "Mega Factory",
    desc: "It is just so many clicks.",
    basePrice: 50000,
    priceGrowth: 1.6,
    effect: "+100 clicks / sec",
    kind: "auto-clicker",
    perLevel: 100,
  },
];

interface ClickerState {
  /** Total clicks ever (this is the score). */
  total: number;
  /** Currently spendable clicks. */
  bank: number;
  /** Levels by upgrade id. */
  levels: Record<string, number>;
}

const STORAGE_KEY = "pfg-clicker-state";

function loadState(): ClickerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClickerState>;
      return {
        total: Number(parsed.total) || 0,
        bank: Number(parsed.bank) || 0,
        levels: typeof parsed.levels === "object" && parsed.levels ? (parsed.levels as Record<string, number>) : {},
      };
    }
  } catch {
    /* ignore */
  }
  return { total: 0, bank: 0, levels: {} };
}

function saveState(s: ClickerState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function levelOf(state: ClickerState, id: string): number {
  return state.levels[id] ?? 0;
}

function priceFor(upgrade: Upgrade, currentLevel: number): number {
  return Math.ceil(upgrade.basePrice * Math.pow(upgrade.priceGrowth, currentLevel));
}

function clickValue(state: ClickerState): number {
  let v = 1;
  for (const u of UPGRADES) if (u.kind === "click-multiplier") v += levelOf(state, u.id) * u.perLevel;
  return v;
}

function autoRate(state: ClickerState): number {
  let r = 0;
  for (const u of UPGRADES) if (u.kind === "auto-clicker") r += levelOf(state, u.id) * u.perLevel;
  return r;
}

function formatNumber(n: number): string {
  if (n < 1000) return Math.floor(n).toString();
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

// ---------------- game ----------------

export const ClickerGame: Game = {
  id: "clicker",
  name: "Clicker",
  description: "Click the button. Buy upgrades. Out-click your friends.",
  create(container, net): GameInstance {
    const inst = new ClickerInstance(container, net);
    return { unmount: () => inst.destroy() };
  },
};

interface FloatLabel {
  id: number;
  x: number;
  y: number;
  value: number;
  startedAt: number;
}

class ClickerInstance {
  private net: Net;
  private ns: GameNamespace;
  private state: ClickerState;
  private bigButton!: HTMLButtonElement;
  private statTotal!: HTMLSpanElement;
  private statBank!: HTMLSpanElement;
  private statPerClick!: HTMLSpanElement;
  private statPerSec!: HTMLSpanElement;
  private upgradesEl!: HTMLDivElement;
  private leaderboardEl!: HTMLDivElement;
  private floatHost!: HTMLDivElement;

  private floats: FloatLabel[] = [];
  private floatId = 0;

  /** Score deltas waiting to be broadcast. */
  private pendingDelta = 0;
  /** When we last broadcast (ms). */
  private lastBroadcast = 0;
  /** Last animation frame timestamp for auto-clicker accumulation. */
  private lastFrameTime = 0;
  /** Sub-second auto-clicker accumulator. */
  private autoAccum = 0;

  private rafId = 0;
  private unsubPeers: (() => void) | null = null;

  constructor(container: HTMLElement, net: Net) {
    this.net = net;
    this.ns = net.namespace("clicker");
    this.state = loadState();

    container.innerHTML = `
      <div class="game-layout clicker-layout">
        <aside class="toolbar clicker-shop">
          <div class="tool-group">
            <label>Upgrades</label>
            <p class="hint">Spend clicks to buy upgrades. They make you click harder, or click for you.</p>
            <div class="clicker-upgrades"></div>
          </div>
        </aside>
        <section class="clicker-stage">
          <div class="clicker-stats">
            <div class="clicker-stat">
              <span class="clicker-stat-label">Total clicks</span>
              <span class="clicker-stat-value" data-stat="total">0</span>
            </div>
            <div class="clicker-stat">
              <span class="clicker-stat-label">Bank</span>
              <span class="clicker-stat-value" data-stat="bank">0</span>
            </div>
            <div class="clicker-stat">
              <span class="clicker-stat-label">Per click</span>
              <span class="clicker-stat-value" data-stat="perClick">1</span>
            </div>
            <div class="clicker-stat">
              <span class="clicker-stat-label">Per second</span>
              <span class="clicker-stat-value" data-stat="perSec">0</span>
            </div>
          </div>
          <div class="clicker-button-wrap">
            <button class="clicker-button" type="button" aria-label="Click me">
              <span class="clicker-button-inner"></span>
            </button>
            <div class="clicker-floats"></div>
          </div>
          <div class="clicker-leaderboard-wrap">
            <h3>Leaderboard</h3>
            <div class="clicker-leaderboard"></div>
          </div>
        </section>
      </div>
    `;

    const q = <T extends Element>(s: string) => container.querySelector(s) as T;
    this.bigButton = q<HTMLButtonElement>(".clicker-button");
    this.statTotal = q<HTMLSpanElement>('[data-stat="total"]');
    this.statBank = q<HTMLSpanElement>('[data-stat="bank"]');
    this.statPerClick = q<HTMLSpanElement>('[data-stat="perClick"]');
    this.statPerSec = q<HTMLSpanElement>('[data-stat="perSec"]');
    this.upgradesEl = q<HTMLDivElement>(".clicker-upgrades");
    this.leaderboardEl = q<HTMLDivElement>(".clicker-leaderboard");
    this.floatHost = q<HTMLDivElement>(".clicker-floats");

    this.bigButton.addEventListener("pointerdown", this.handleClick);
    this.bigButton.style.color = this.net.me.color;

    this.unsubPeers = this.net.on("peers", this.renderLeaderboard);

    // Sync our local total with the shared score on join.
    // Our local total is the source of truth — push any difference up.
    const knownScore = this.net.peers.get(this.net.me.id)?.score ?? 0;
    if (this.state.total > knownScore) {
      this.net.awardScore(this.net.me.id, this.state.total - knownScore);
    }

    this.renderAll();
    this.lastFrameTime = performance.now();
    this.loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.bigButton.removeEventListener("pointerdown", this.handleClick);
    this.unsubPeers?.();
    // Flush any pending broadcast.
    if (this.pendingDelta > 0) {
      this.net.awardScore(this.net.me.id, this.pendingDelta);
      this.pendingDelta = 0;
    }
    saveState(this.state);
    this.ns.close();
  }

  // ---------- click handling ----------

  private handleClick = (e: PointerEvent) => {
    if (e.button !== undefined && e.button !== 0) return;
    const value = clickValue(this.state);
    this.gainClicks(value);
    // Visual punch.
    this.bigButton.classList.remove("punch");
    void this.bigButton.offsetWidth; // restart animation
    this.bigButton.classList.add("punch");
    // Floating "+N" label.
    const rect = this.floatHost.getBoundingClientRect();
    const btn = this.bigButton.getBoundingClientRect();
    this.floats.push({
      id: ++this.floatId,
      x: btn.left + btn.width / 2 - rect.left + (Math.random() * 40 - 20),
      y: btn.top + btn.height / 2 - rect.top + (Math.random() * 20 - 10),
      value,
      startedAt: performance.now(),
    });
  };

  private gainClicks(amount: number) {
    if (amount <= 0) return;
    this.state.total += amount;
    this.state.bank += amount;
    this.pendingDelta += amount;
    this.updateStats();
    this.updateUpgradeAvailability();
  }

  private buyUpgrade(u: Upgrade) {
    const lvl = levelOf(this.state, u.id);
    const price = priceFor(u, lvl);
    if (this.state.bank < price) return;
    this.state.bank -= price;
    this.state.levels[u.id] = lvl + 1;
    this.renderUpgrades();
    this.updateStats();
    saveState(this.state);
  }

  // ---------- main loop ----------

  private loop = () => {
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    // Auto-clicker accumulation.
    const rate = autoRate(this.state);
    if (rate > 0) {
      this.autoAccum += rate * dt;
      const whole = Math.floor(this.autoAccum);
      if (whole > 0) {
        this.autoAccum -= whole;
        this.gainClicks(whole);
      }
    }

    // Broadcast queued delta at most ~3x per second.
    if (this.pendingDelta > 0 && now - this.lastBroadcast > 333) {
      this.net.awardScore(this.net.me.id, this.pendingDelta);
      this.pendingDelta = 0;
      this.lastBroadcast = now;
    }

    // Animate floating labels.
    if (this.floats.length > 0) {
      const FLOAT_LIFE = 900;
      this.floats = this.floats.filter((f) => now - f.startedAt < FLOAT_LIFE);
      this.renderFloats(now);
    }

    // Persist state every ~3 seconds.
    if (Math.floor(now / 3000) !== Math.floor((now - dt * 1000) / 3000)) {
      saveState(this.state);
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  // ---------- rendering ----------

  private renderAll() {
    this.updateStats();
    this.renderUpgrades();
    this.renderLeaderboard();
  }

  private updateStats = () => {
    this.statTotal.textContent = formatNumber(this.state.total);
    this.statBank.textContent = formatNumber(this.state.bank);
    this.statPerClick.textContent = formatNumber(clickValue(this.state));
    this.statPerSec.textContent = formatNumber(autoRate(this.state));
  };

  private renderUpgrades() {
    this.upgradesEl.innerHTML = "";
    for (const u of UPGRADES) {
      const lvl = levelOf(this.state, u.id);
      const price = priceFor(u, lvl);
      const affordable = this.state.bank >= price;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "clicker-upgrade" + (affordable ? "" : " locked");
      card.disabled = !affordable;
      card.innerHTML = `
        <div class="clicker-upgrade-head">
          <span class="clicker-upgrade-name">${escapeHtml(u.name)}</span>
          <span class="clicker-upgrade-level">Lv ${lvl}</span>
        </div>
        <div class="clicker-upgrade-desc">${escapeHtml(u.desc)}</div>
        <div class="clicker-upgrade-effect">${escapeHtml(u.effect)}</div>
        <div class="clicker-upgrade-price">${formatNumber(price)} clicks</div>
      `;
      card.onclick = () => this.buyUpgrade(u);
      this.upgradesEl.appendChild(card);
    }
  }

  private updateUpgradeAvailability = () => {
    // Cheap path: just toggle the affordable class without re-rendering everything.
    const cards = this.upgradesEl.querySelectorAll<HTMLButtonElement>(".clicker-upgrade");
    UPGRADES.forEach((u, i) => {
      const card = cards[i];
      if (!card) return;
      const lvl = levelOf(this.state, u.id);
      const price = priceFor(u, lvl);
      const affordable = this.state.bank >= price;
      card.classList.toggle("locked", !affordable);
      card.disabled = !affordable;
    });
  };

  private renderLeaderboard = () => {
    const rows = [...this.net.peers.entries()]
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 12);
    this.leaderboardEl.innerHTML = rows
      .map((r, i) => `
        <div class="clicker-row${r.id === this.net.me.id ? " mine" : ""}">
          <span class="clicker-rank">${i + 1}</span>
          <span class="clicker-dot" style="background:${escapeAttr(r.color)}"></span>
          <span class="clicker-row-name">${escapeHtml(r.name)}${r.id === this.net.me.id ? " (you)" : ""}</span>
          <span class="clicker-row-score">${formatNumber(r.score)}</span>
        </div>
      `)
      .join("");
  };

  private renderFloats(now: number) {
    // Simple full re-render of the float layer; cheap because it's small.
    let html = "";
    for (const f of this.floats) {
      const age = (now - f.startedAt) / 900; // 0..1
      const dy = -age * 60;
      const opacity = 1 - age;
      html += `<span class="clicker-float" style="left:${f.x}px;top:${f.y + dy}px;opacity:${opacity};color:${this.net.me.color}">+${formatNumber(f.value)}</span>`;
    }
    this.floatHost.innerHTML = html;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
