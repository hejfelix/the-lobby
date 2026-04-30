import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Group Construction — cooperative incremental.
 * Everyone in the room lays bricks toward a shared structure. Complete one,
 * advance to the next bigger one. Personal coins (1 per brick you produce)
 * buy upgrades that boost your output. On completion everyone who contributed
 * gets a score bonus.
 */

interface Structure {
  name: string;
  cost: number;
  reward: number;
  shape: "shed" | "cottage" | "hall" | "lighthouse" | "cathedral" | "pyramid" | "skyscraper" | "elevator";
}

const STRUCTURES: Structure[] = [
  { name: "Garden Shed",      cost: 50,       reward: 5,    shape: "shed" },
  { name: "Cottage",          cost: 200,      reward: 10,   shape: "cottage" },
  { name: "Town Hall",        cost: 800,      reward: 25,   shape: "hall" },
  { name: "Lighthouse",       cost: 3000,     reward: 50,   shape: "lighthouse" },
  { name: "Cathedral",        cost: 12000,    reward: 100,  shape: "cathedral" },
  { name: "Great Pyramid",    cost: 50000,    reward: 200,  shape: "pyramid" },
  { name: "Skyscraper",       cost: 200000,   reward: 500,  shape: "skyscraper" },
  { name: "Space Elevator",   cost: 1000000,  reward: 1500, shape: "elevator" },
];

interface Upgrade {
  id: string;
  name: string;
  desc: string;
  baseCost: number;
  growth: number;
  /** Either passive bricks/sec or extra bricks/click. */
  bps?: number;
  perClick?: number;
}

const UPGRADES: Upgrade[] = [
  { id: "trowel",   name: "Better Trowel", desc: "+1 brick per click",          baseCost: 25,     growth: 1.7,  perClick: 1 },
  { id: "apprentice", name: "Apprentice",  desc: "+0.5 bricks/sec",             baseCost: 50,     growth: 1.5,  bps: 0.5 },
  { id: "builder",  name: "Builder",       desc: "+3 bricks/sec",               baseCost: 400,    growth: 1.55, bps: 3 },
  { id: "crew",     name: "Crew",          desc: "+15 bricks/sec",              baseCost: 4000,   growth: 1.6,  bps: 15 },
  { id: "foreman",  name: "Foreman",       desc: "+80 bricks/sec",              baseCost: 40000,  growth: 1.65, bps: 80 },
  { id: "architect",name: "Architect",     desc: "+500 bricks/sec",             baseCost: 400000, growth: 1.7,  bps: 500 },
];

const STORAGE_KEY = "pfg-construct";
const FLUSH_MS = 333;

interface LocalState {
  coins: number;
  levels: Record<string, number>;
  lifetime: number;
}

interface SharedState {
  round: number; // index into STRUCTURES; wraps via modulo if exceeded
  bricks: number; // contributed to current structure
}

export const ConstructionGame: Game = {
  id: "construction",
  name: "Group Construction",
  description: "Lay bricks together. Build sheds, towers, pyramids. Bigger together.",
  create(container, net): GameInstance {
    const inst = new ConstructionInstance(container, net);
    return { unmount: () => inst.destroy() };
  },
};

class ConstructionInstance {
  private container: HTMLElement;
  private net: Net;
  private ns: GameNamespace;

  private local: LocalState;
  private shared: SharedState;
  /** Bricks I personally contributed to the current structure. */
  private myContribThisRound = 0;
  /** Bricks each peer has contributed to current structure (incl. me). */
  private contribs: Map<string, number> = new Map();

  private rafId: number | null = null;
  private lastTick = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private pendingDelta = 0;

  // DOM
  private buildEl!: HTMLDivElement;
  private nameEl!: HTMLDivElement;
  private progressFillEl!: HTMLDivElement;
  private progressTextEl!: HTMLDivElement;
  private brickBtn!: HTMLButtonElement;
  private statsEl!: HTMLDivElement;
  private upgradesEl!: HTMLDivElement;
  private contribsEl!: HTMLDivElement;
  private floatsEl!: HTMLDivElement;

  private unsubPeers: (() => void) | null = null;

  constructor(container: HTMLElement, net: Net) {
    this.container = container;
    this.net = net;
    this.ns = net.namespace("construct");

    this.local = loadLocal(net.roomName);
    this.shared = { round: 0, bricks: 0 };

    container.innerHTML = `
      <div class="game-layout construct-layout">
        <aside class="toolbar construct-shop">
          <div class="tool-group">
            <label>Crew</label>
            <div class="construct-upgrades"></div>
          </div>
        </aside>
        <section class="construct-stage">
          <div class="construct-name"></div>
          <div class="construct-build">
            <div class="construct-floats"></div>
          </div>
          <div class="construct-progress">
            <div class="construct-progress-bar"><div class="construct-progress-fill"></div></div>
            <div class="construct-progress-text"></div>
          </div>
          <div class="construct-button-row">
            <button class="construct-brick" type="button">
              <span class="construct-brick-label">Lay brick</span>
            </button>
          </div>
          <div class="construct-stats"></div>
          <div class="construct-contribs-wrap">
            <h3>Contributions this build</h3>
            <div class="construct-contribs"></div>
          </div>
        </section>
      </div>
    `;

    const q = <T extends Element>(s: string) => container.querySelector(s) as T;
    this.buildEl = q<HTMLDivElement>(".construct-build");
    this.nameEl = q<HTMLDivElement>(".construct-name");
    this.progressFillEl = q<HTMLDivElement>(".construct-progress-fill");
    this.progressTextEl = q<HTMLDivElement>(".construct-progress-text");
    this.brickBtn = q<HTMLButtonElement>(".construct-brick");
    this.statsEl = q<HTMLDivElement>(".construct-stats");
    this.upgradesEl = q<HTMLDivElement>(".construct-upgrades");
    this.contribsEl = q<HTMLDivElement>(".construct-contribs");
    this.floatsEl = q<HTMLDivElement>(".construct-floats");

    this.brickBtn.onclick = (e) => this.layBricks(this.perClick(), e);

    this.registerNetwork();
    this.unsubPeers = this.net.on("peers", () => this.renderContribs());
    this.ns.send("sync-request", {});

    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    // Refresh stats + upgrade affordability on a slow cadence so passive
    // ticks don't constantly recreate the upgrade buttons (which would
    // eat clicks).
    this.uiTimer = setInterval(() => {
      this.renderProgress();
      this.renderStats();
      this.renderUpgrades();
    }, 500);
    this.lastTick = performance.now();
    const tick = (now: number) => {
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      const bps = this.bps();
      if (bps > 0) {
        const auto = bps * dt;
        if (auto > 0) this.layBricks(auto, null, true);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);

    this.renderAll();
  }

  // ── derived values ───────────────────────────────────────────────────────

  private perClick(): number {
    return 1 + (this.local.levels.trowel ?? 0);
  }
  private bps(): number {
    let total = 0;
    for (const u of UPGRADES) {
      if (!u.bps) continue;
      total += (this.local.levels[u.id] ?? 0) * u.bps;
    }
    return total;
  }
  private upgradePrice(u: Upgrade): number {
    const lvl = this.local.levels[u.id] ?? 0;
    return Math.ceil(u.baseCost * Math.pow(u.growth, lvl));
  }
  private currentStructure(): Structure {
    return STRUCTURES[Math.min(this.shared.round, STRUCTURES.length - 1)];
  }

  // ── actions ──────────────────────────────────────────────────────────────

  private layBricks(amount: number, ev: MouseEvent | null, silent = false) {
    if (amount <= 0) return;
    // Earn coins, pile bricks.
    this.local.coins += amount;
    this.local.lifetime += amount;
    this.shared.bricks += amount;
    this.myContribThisRound += amount;
    this.contribs.set(this.net.me.id, (this.contribs.get(this.net.me.id) ?? 0) + amount);
    this.pendingDelta += amount;

    // Floating "+N" on real clicks.
    if (!silent && ev) {
      this.spawnFloat(ev, `+${this.fmt(amount)}`);
      this.brickBtn.classList.remove("punch");
      // Force reflow to retrigger animation.
      void this.brickBtn.offsetWidth;
      this.brickBtn.classList.add("punch");
    }

    if (this.shared.bricks >= this.currentStructure().cost) {
      this.completeRound();
    }

    saveLocal(this.net.roomName, this.local);
    // On manual clicks redraw immediately for snappy feedback. Passive
    // ticks rely on the slower uiTimer so we don't recreate buttons mid-click.
    if (!silent) {
      this.renderProgress();
      this.renderStats();
      this.renderUpgrades();
    }
  }

  private flush() {
    if (this.pendingDelta <= 0) return;
    const delta = this.pendingDelta;
    this.pendingDelta = 0;
    this.ns.send("brick", { round: this.shared.round, delta });
  }

  private completeRound() {
    const struct = this.currentStructure();
    // Award score if we contributed at least 1 brick.
    if (this.myContribThisRound > 0) {
      this.net.awardScore(this.net.me.id, struct.reward);
    }
    // Flush any pending bricks for this round before advancing.
    this.flush();
    this.ns.send("complete", { round: this.shared.round });
    this.advance(this.shared.round + 1);
  }

  private advance(nextRound: number) {
    this.shared.round = Math.min(nextRound, STRUCTURES.length - 1);
    this.shared.bricks = 0;
    this.myContribThisRound = 0;
    this.contribs.clear();
    this.renderAll();
  }

  private buyUpgrade(u: Upgrade) {
    const price = this.upgradePrice(u);
    if (this.local.coins < price) return;
    this.local.coins -= price;
    this.local.levels[u.id] = (this.local.levels[u.id] ?? 0) + 1;
    saveLocal(this.net.roomName, this.local);
    this.renderUpgrades();
    this.renderStats();
  }

  // ── network ──────────────────────────────────────────────────────────────

  private registerNetwork() {
    this.ns.on<{ round: number; delta: number }>("brick", (data, peerId) => {
      if (!data || typeof data.round !== "number" || typeof data.delta !== "number") return;
      if (data.round !== this.shared.round) return;
      const d = Math.max(0, Math.min(1e9, data.delta));
      this.shared.bricks += d;
      this.contribs.set(peerId, (this.contribs.get(peerId) ?? 0) + d);
      if (this.shared.bricks >= this.currentStructure().cost) {
        // Don't award us — this completion was driven by peer bricks; if we
        // also contributed we'll still get our share via our own threshold
        // race, but to keep things deterministic just advance.
        const wasMine = this.myContribThisRound > 0;
        if (wasMine) this.net.awardScore(this.net.me.id, this.currentStructure().reward);
        this.advance(this.shared.round + 1);
      } else {
        this.renderProgress();
        this.renderContribs();
      }
    });

    this.ns.on<{ round: number }>("complete", (data) => {
      if (!data || typeof data.round !== "number") return;
      if (data.round >= this.shared.round) {
        // Sync forward without re-awarding (we already would have if local).
        this.advance(data.round + 1);
      }
    });

    this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
      this.ns.send("sync", { round: this.shared.round, bricks: Math.floor(this.shared.bricks) }, peerId);
    });

    this.ns.on<{ round: number; bricks: number }>("sync", (data) => {
      if (!data || typeof data.round !== "number") return;
      // Only adopt if remote is further along, or same round with more bricks.
      if (data.round > this.shared.round) {
        this.advance(data.round);
        this.shared.bricks = Math.max(0, Math.min(this.currentStructure().cost - 1, Number(data.bricks) || 0));
      } else if (data.round === this.shared.round) {
        const remote = Math.max(0, Math.min(this.currentStructure().cost - 1, Number(data.bricks) || 0));
        if (remote > this.shared.bricks) this.shared.bricks = remote;
      }
      this.renderAll();
    });
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private renderAll() {
    this.renderStructure();
    this.renderProgress();
    this.renderStats();
    this.renderUpgrades();
    this.renderContribs();
  }

  private renderStructure() {
    const s = this.currentStructure();
    this.nameEl.textContent = `#${this.shared.round + 1} · ${s.name}`;
    // Persistent floats div
    const floats = this.floatsEl;
    this.buildEl.innerHTML = "";
    this.buildEl.appendChild(floats);
    const svg = renderStructureSvg(s.shape);
    const wrap = document.createElement("div");
    wrap.className = "construct-build-svg";
    wrap.innerHTML = svg;
    this.buildEl.appendChild(wrap);
  }

  private renderProgress() {
    const s = this.currentStructure();
    const pct = Math.min(100, (this.shared.bricks / s.cost) * 100);
    this.progressFillEl.style.width = `${pct.toFixed(2)}%`;
    this.progressTextEl.textContent = `${this.fmt(this.shared.bricks)} / ${this.fmt(s.cost)} bricks`;
    // Update the SVG's fill rect via a CSS variable on the SVG wrapper.
    const svgWrap = this.buildEl.querySelector<HTMLElement>(".construct-build-svg");
    if (svgWrap) svgWrap.style.setProperty("--fill", `${pct.toFixed(2)}%`);
  }

  private renderStats() {
    const stats: Array<[string, string]> = [
      ["Coins", this.fmt(this.local.coins)],
      ["Per click", this.fmt(this.perClick())],
      ["Per sec", this.fmt(this.bps())],
      ["My bricks (build)", this.fmt(this.myContribThisRound)],
      ["Lifetime bricks", this.fmt(this.local.lifetime)],
    ];
    this.statsEl.innerHTML = stats
      .map(
        ([l, v]) => `
      <div class="construct-stat">
        <div class="construct-stat-label">${l}</div>
        <div class="construct-stat-value">${v}</div>
      </div>`,
      )
      .join("");
  }

  private renderUpgrades() {
    this.upgradesEl.innerHTML = "";
    for (const u of UPGRADES) {
      const lvl = this.local.levels[u.id] ?? 0;
      const price = this.upgradePrice(u);
      const affordable = this.local.coins >= price;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "construct-upgrade" + (affordable ? "" : " locked");
      btn.disabled = !affordable;
      btn.innerHTML = `
        <div class="construct-upgrade-head">
          <span class="construct-upgrade-name">${escapeHtml(u.name)}</span>
          <span class="construct-upgrade-level">Lv ${lvl}</span>
        </div>
        <div class="construct-upgrade-desc">${escapeHtml(u.desc)}</div>
        <div class="construct-upgrade-price">${this.fmt(price)} coins</div>
      `;
      btn.onclick = () => this.buyUpgrade(u);
      this.upgradesEl.appendChild(btn);
    }
  }

  private renderContribs() {
    const rows = [...this.contribs.entries()]
      .map(([id, b]) => ({ id, b, peer: this.net.peers.get(id) }))
      .filter((r) => r.peer)
      .sort((a, b) => b.b - a.b);
    if (rows.length === 0) {
      this.contribsEl.innerHTML = `<div class="construct-empty">No bricks laid yet — be the first.</div>`;
      return;
    }
    this.contribsEl.innerHTML = "";
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const row = document.createElement("div");
      row.className = "construct-row";
      if (r.id === this.net.me.id) row.classList.add("mine");
      row.innerHTML = `
        <span class="construct-rank">${i + 1}</span>
        <span class="construct-dot" style="background:${r.peer!.color}"></span>
        <span class="construct-row-name">${escapeHtml(r.peer!.name)}</span>
        <span class="construct-row-score">${this.fmt(r.b)}</span>
      `;
      this.contribsEl.appendChild(row);
    }
  }

  private spawnFloat(ev: MouseEvent, text: string) {
    const rect = this.brickBtn.getBoundingClientRect();
    const wrapRect = this.buildEl.getBoundingClientRect();
    const x = ev.clientX - wrapRect.left;
    const y = rect.top - wrapRect.top;
    const el = document.createElement("span");
    el.className = "construct-float";
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.color = this.net.me.color;
    this.floatsEl.appendChild(el);
    let t = 0;
    const animate = () => {
      t += 16;
      const p = t / 800;
      el.style.transform = `translate(-50%, ${-p * 60}px)`;
      el.style.opacity = String(1 - p);
      if (p < 1) requestAnimationFrame(animate);
      else el.remove();
    };
    requestAnimationFrame(animate);
  }

  private fmt(n: number): string {
    if (!isFinite(n)) return "∞";
    if (n < 1000) return n < 10 ? n.toFixed(n % 1 === 0 ? 0 : 1) : Math.floor(n).toString();
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 2 : 1) + "k";
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + "M";
    if (n < 1e12) return (n / 1e9).toFixed(2) + "B";
    return n.toExponential(2);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.flush();
    this.unsubPeers?.();
    this.ns.close();
    this.container.innerHTML = "";
  }
}

// ── persistence ────────────────────────────────────────────────────────────

function loadLocal(roomName: string): LocalState {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${roomName}`);
    if (!raw) return { coins: 0, levels: {}, lifetime: 0 };
    const parsed = JSON.parse(raw) as Partial<LocalState>;
    return {
      coins: Number(parsed.coins) || 0,
      levels: (parsed.levels && typeof parsed.levels === "object" ? parsed.levels : {}) as Record<string, number>,
      lifetime: Number(parsed.lifetime) || 0,
    };
  } catch {
    return { coins: 0, levels: {}, lifetime: 0 };
  }
}

function saveLocal(roomName: string, state: LocalState) {
  try {
    localStorage.setItem(`${STORAGE_KEY}:${roomName}`, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// ── SVG silhouettes ────────────────────────────────────────────────────────
//
// Each renders a structure outline with a fill that grows from the bottom
// using clip-path tied to the CSS var --fill (set on the wrapper).

function renderStructureSvg(shape: Structure["shape"]): string {
  // viewBox 100x100; we mirror the shape twice — once as outline, once as
  // filled silhouette clipped from the bottom up.
  const paths = SHAPES[shape];
  const stroke = "var(--text)";
  const fill = "var(--accent)";
  const outline = paths
    .map((p) => `<path d="${p}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`)
    .join("");
  const filled = paths
    .map((p) => `<path d="${p}" fill="${fill}"/>`)
    .join("");
  return `
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"
         xmlns="http://www.w3.org/2000/svg" class="construct-svg">
      <g class="construct-svg-outline">${outline}</g>
      <g class="construct-svg-fill">${filled}</g>
    </svg>
  `;
}

const SHAPES: Record<Structure["shape"], string[]> = {
  shed: [
    // Small square hut + simple roof
    "M30 60 L30 90 L70 90 L70 60 Z",
    "M25 60 L50 42 L75 60 Z",
    "M45 70 L45 90 L55 90 L55 70 Z", // door
  ],
  cottage: [
    "M22 55 L22 90 L78 90 L78 55 Z",
    "M16 55 L50 30 L84 55 Z",
    "M44 70 L44 90 L56 90 L56 70 Z",
    "M30 60 L38 60 L38 68 L30 68 Z", // window
    "M62 60 L70 60 L70 68 L62 68 Z",
  ],
  hall: [
    "M16 50 L16 90 L84 90 L84 50 Z",
    "M10 50 L50 22 L90 50 Z",
    "M44 65 L44 90 L56 90 L56 65 Z",
    "M22 60 L30 60 L30 70 L22 70 Z",
    "M70 60 L78 60 L78 70 L70 70 Z",
    "M30 40 L50 28 L70 40 Z", // pediment detail
  ],
  lighthouse: [
    // Tall tapering tower with cap
    "M40 90 L60 90 L58 30 L42 30 Z",
    "M37 30 L63 30 L60 22 L40 22 Z",
    "M44 22 L56 22 L56 12 L44 12 Z",
    "M46 12 L54 12 L54 6 L46 6 Z",
    "M40 50 L60 50",
    "M40 70 L60 70",
  ],
  cathedral: [
    "M20 50 L20 90 L80 90 L80 50 Z",
    "M44 90 L44 60 Q50 50 56 60 L56 90 Z", // arched door
    "M30 55 L36 55 L36 70 Q33 65 30 70 Z", // side window
    "M64 55 L70 55 L70 70 Q67 65 64 70 Z",
    "M40 50 L50 30 L60 50 Z", // central peak
    "M48 30 L52 30 L52 14 L48 14 Z", // spire base
    "M48 14 L52 14 L50 6 Z", // cross top
    "M46 18 L54 18", // crossbar
  ],
  pyramid: [
    "M10 90 L90 90 L50 18 Z",
    "M50 18 L50 90", // ridge
    "M30 60 L70 60", // course line
    "M22 75 L78 75",
  ],
  skyscraper: [
    "M30 90 L30 14 L70 14 L70 90 Z",
    "M50 14 L50 6", // antenna
    "M36 22 L44 22 L44 28 L36 28 Z",
    "M56 22 L64 22 L64 28 L56 28 Z",
    "M36 36 L44 36 L44 42 L36 42 Z",
    "M56 36 L64 36 L64 42 L56 42 Z",
    "M36 50 L44 50 L44 56 L36 56 Z",
    "M56 50 L64 50 L64 56 L56 56 Z",
    "M36 64 L44 64 L44 70 L36 70 Z",
    "M56 64 L64 64 L64 70 L56 70 Z",
    "M44 78 L56 78 L56 90 L44 90 Z", // entrance
  ],
  elevator: [
    "M46 90 L54 90 L52 6 L48 6 Z",
    "M46 90 L40 90 L40 80 L46 80 Z", // base left
    "M54 90 L60 90 L60 80 L54 80 Z", // base right
    "M48 70 L52 70",
    "M48 50 L52 50",
    "M48 30 L52 30",
    "M48 14 L52 14",
    "M50 6 L50 2", // tip into space
  ],
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}
