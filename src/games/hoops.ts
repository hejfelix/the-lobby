import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

// Logical playfield (independent of canvas pixel size).
const FIELD_W = 1200;
const FIELD_H = 600;
const GRAVITY = 1400; // px/s^2
const BALL_LIFETIME_MS = 4000;
// Maximum allowed launch speed (so peers can't exploit the slingshot).
const MAX_LAUNCH = 2200;

interface Difficulty {
  id: string;
  name: string;
  description: string;
  ballR: number;
  /** Half-width of the rim around its center. */
  rimHalfWidth: number;
  /** Base rim center position. */
  baseY: number;
  baseX: number;
  /** Horizontal oscillation amplitude (px) and period (seconds). 0 disables. */
  ampX: number;
  periodX: number;
  /** Vertical oscillation amplitude (px) and period (seconds). 0 disables. */
  ampY: number;
  periodY: number;
}

const DIFFICULTIES: Record<"easy" | "hard" | "extreme", Difficulty> = {
  easy: {
    id: "hoops-easy",
    name: "Hoops · Easy",
    description: "Big ball, wide hoop, fixed in place. Perfect for warming up.",
    ballR: 28,
    rimHalfWidth: 70,
    baseY: 240,
    baseX: 1055,
    ampX: 0,
    periodX: 1,
    ampY: 0,
    periodY: 1,
  },
  hard: {
    id: "hoops-hard",
    name: "Hoops · Hard",
    description: "Standard hoop that drifts side to side. Time your shots.",
    ballR: 20,
    rimHalfWidth: 42,
    baseY: 240,
    baseX: 1055,
    ampX: 90,
    periodX: 4.5,
    ampY: 0,
    periodY: 1,
  },
  extreme: {
    id: "hoops-extreme",
    name: "Hoops · Extreme",
    description: "Tiny ball, tight rim, hoop sways in two directions. Pray.",
    ballR: 14,
    rimHalfWidth: 28,
    baseY: 250,
    baseX: 1055,
    ampX: 130,
    periodX: 2.6,
    ampY: 70,
    periodY: 1.9,
  },
};

interface ThrowMsg {
  /** Random per-throw id so we can track scoring + dedupe. */
  id: string;
  /** Launch position in field coords. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Sender clock at launch (Date.now()). */
  t: number;
  /** Color for rendering remote balls without lookup. */
  color: string;
}

interface ActiveBall {
  id: string;
  ownerId: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Local performance.now() timestamp when launched. */
  startedAt: number;
  /** Has this ball already triggered a goal locally? (only the owner scores) */
  scored: boolean;
}

interface HoopStats {
  makes: number;
  misses: number;
  streak: number;
  longestStreak: number;
  missStreak: number;
  longestMissStreak: number;
}

function emptyStats(): HoopStats {
  return { makes: 0, misses: 0, streak: 0, longestStreak: 0, missStreak: 0, longestMissStreak: 0 };
}

export const HoopsEasyGame: Game = makeHoopsGame(DIFFICULTIES.easy);
export const HoopsHardGame: Game = makeHoopsGame(DIFFICULTIES.hard);
export const HoopsExtremeGame: Game = makeHoopsGame(DIFFICULTIES.extreme);
// Backwards-compatible alias.
export const HoopsGame: Game = HoopsHardGame;

function makeHoopsGame(diff: Difficulty): Game {
  return {
    id: diff.id,
    name: diff.name,
    description: diff.description,
    create(container, net): GameInstance {
      const inst = new HoopsInstance(container, net, diff);
      return { unmount: () => inst.destroy() };
    },
  };
}

class HoopsInstance {
  private net: Net;
  private ns: GameNamespace;
  private diff: Difficulty;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private scoreboard!: HTMLDivElement;
  private balls: Map<string, ActiveBall> = new Map();
  /** Per-peer hoops stats. */
  private stats: Map<string, HoopStats> = new Map();
  /** While the local player is dragging, this holds the in-progress ball. */
  private dragging: { startX: number; startY: number; curX: number; curY: number } | null = null;
  private lastFrameTime = 0;
  private rafId = 0;
  private resizeObs: ResizeObserver | null = null;
  private unsubscribePeers: (() => void) | null = null;
  private audio: AudioContext | null = null;

  constructor(container: HTMLElement, net: Net, diff: Difficulty) {
    this.net = net;
    this.ns = net.namespace(diff.id);
    this.diff = diff;

    container.innerHTML = `
      <div class="game-layout hoops-layout">
        <aside class="toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint">
              Press anywhere on the left half of the court, drag to aim, release to shoot.
              The further you drag away from the press point, the harder you throw.
            </p>
          </div>
          <div class="tool-group">
            <label>Scoreboard</label>
            <div class="hoops-scoreboard"></div>
          </div>
        </aside>
        <section class="hoops-stage">
          <canvas class="hoops-canvas"></canvas>
        </section>
      </div>
    `;

    this.canvas = container.querySelector<HTMLCanvasElement>(".hoops-canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.scoreboard = container.querySelector<HTMLDivElement>(".hoops-scoreboard")!;

    this.registerNetwork();
    this.attachInput();
    this.startResizeWatcher();
    this.renderScoreboard();
    this.unsubscribePeers = this.net.on("peers", this.renderScoreboard);
    // Ask peers for their hoops stats so we can show streaks for late joiners.
    this.ns.send("sync-request", {});

    this.lastFrameTime = performance.now();
    this.loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    this.unsubscribePeers?.();
    this.audio?.close().catch(() => { /* ignore */ });
    this.ns.close();
  }

  /** Lazy-init audio context (browsers require a user gesture; pointerdown counts). */
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

  /** Short upward chirp + filtered noise tail = "swish + ding". */
  private playSwish() {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
    const t0 = ctx.currentTime;

    // 1) Bright "ding" — two stacked sine tones.
    for (const [freq, level, dur] of [
      [880, 0.25, 0.18],
      [1320, 0.18, 0.22],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(level, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    // 2) Net swish — short burst of band-passed noise.
    const noiseLen = Math.floor(ctx.sampleRate * 0.25);
    const buf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(2000, t0 + 0.05);
    filter.frequency.exponentialRampToValueAtTime(700, t0 + 0.3);
    filter.Q.value = 4;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t0 + 0.04);
    noiseGain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.07);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    src.connect(filter).connect(noiseGain).connect(ctx.destination);
    src.start(t0 + 0.04);
    src.stop(t0 + 0.32);
  }

  /** Sad descending two-note "wah-wah" for a missed shot. */
  private playMiss() {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
    const t0 = ctx.currentTime;
    const notes: Array<[number, number, number]> = [
      // [frequency, startTime offset, duration]
      [330, 0.0, 0.18],
      [247, 0.18, 0.32],
    ];
    for (const [freq, off, dur] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, t0 + off);
      // Slight downward bend for a "wah" feel.
      osc.frequency.exponentialRampToValueAtTime(freq * 0.85, t0 + off + dur);
      gain.gain.setValueAtTime(0.0001, t0 + off);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + dur + 0.02);
    }
  }

  /** Current hoop geometry (rim segment + backboard). Time-varying. */
  private hoopState() {
    const t = Date.now() / 1000;
    const dx = this.diff.ampX === 0 ? 0 : Math.sin((t / this.diff.periodX) * Math.PI * 2) * this.diff.ampX;
    const dy = this.diff.ampY === 0 ? 0 : Math.sin((t / this.diff.periodY) * Math.PI * 2) * this.diff.ampY;
    const cx = this.diff.baseX + dx;
    const y = this.diff.baseY + dy;
    const x1 = cx - this.diff.rimHalfWidth;
    const x2 = cx + this.diff.rimHalfWidth;
    return {
      y,
      x1,
      x2,
      backboardX: x2 + 12,
      backboardY1: y - 100,
      backboardY2: y + 80,
    };
  }

  // ---------- network ----------

  private registerNetwork() {
    this.ns.on<ThrowMsg>("throw", (msg, peerId) => {
      if (!msg || typeof msg.x !== "number") return;
      // Don't trust remote vx/vy beyond reasonable limits.
      const speed = Math.hypot(msg.vx, msg.vy);
      if (speed > MAX_LAUNCH) return;
      const peer = this.net.peers.get(peerId);
      const color = peer?.color ?? msg.color ?? "#888";
      this.balls.set(msg.id, {
        id: msg.id,
        ownerId: peerId,
        color,
        x: msg.x,
        y: msg.y,
        vx: msg.vx,
        vy: msg.vy,
        startedAt: performance.now(),
        scored: true, // remote balls don't trigger our scoring
      });
    });
    this.ns.on<{ id: string; kind: "make" | "miss" }>("result", (msg, peerId) => {
      if (!msg || (msg.kind !== "make" && msg.kind !== "miss")) return;
      this.applyResult(peerId, msg.kind);
      if (msg.kind === "make") this.playSwish();
    });
    this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
      const mine = this.statsFor(this.net.me.id);
      this.ns.send("sync", mine, peerId);
    });
    this.ns.on<HoopStats>("sync", (msg, peerId) => {
      if (!msg) return;
      this.stats.set(peerId, sanitizeStats(msg));
      this.renderScoreboard();
    });
  }

  private broadcastThrow(ball: ActiveBall) {
    const msg: ThrowMsg = {
      id: ball.id,
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      t: Date.now(),
      color: ball.color,
    };
    this.ns.send("throw", msg);
  }

  // ---------- input ----------

  private attachInput() {
    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== undefined && e.button !== 0) return;
      this.ensureAudio(); // user gesture — unlock audio for later score sounds
      const { x, y } = this.toField(e);
      // Only allow grabbing from the left half (player's side).
      if (x > FIELD_W / 2) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.dragging = { startX: x, startY: y, curX: x, curY: y };
    };
    const handlePointerMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      const { x, y } = this.toField(e);
      this.dragging.curX = x;
      this.dragging.curY = y;
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (!this.dragging) return;
      const d = this.dragging;
      this.dragging = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      // Slingshot vector: launch in the opposite direction of the drag.
      const dx = d.startX - d.curX;
      const dy = d.startY - d.curY;
      const dist = Math.hypot(dx, dy);
      // Ignore tiny drags (taps).
      if (dist < 12) return;
      // Velocity scaled with drag distance, capped.
      const power = Math.min(MAX_LAUNCH, dist * 4.5);
      const vx = (dx / dist) * power;
      const vy = (dy / dist) * power;
      const ball: ActiveBall = {
        id: crypto.randomUUID(),
        ownerId: this.net.me.id,
        color: this.net.me.color,
        x: d.startX,
        y: d.startY,
        vx,
        vy,
        startedAt: performance.now(),
        scored: false,
      };
      this.balls.set(ball.id, ball);
      this.broadcastThrow(ball);
    };
    this.canvas.addEventListener("pointerdown", handlePointerDown);
    this.canvas.addEventListener("pointermove", handlePointerMove);
    this.canvas.addEventListener("pointerup", handlePointerUp);
    this.canvas.addEventListener("pointercancel", handlePointerUp);
  }

  private toField(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    return { x: px * FIELD_W, y: py * FIELD_H };
  }

  // ---------- physics & rendering ----------

  private loop = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.step(dt, now);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private step(dt: number, now: number) {
    const hoop = this.hoopState();
    const ballR = this.diff.ballR;
    for (const ball of this.balls.values()) {
      // Detect goal: ball center crosses the rim line going downward, between rim x bounds.
      const prevY = ball.y;
      ball.vy += GRAVITY * dt;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      // Backboard collision.
      if (
        ball.vx > 0 &&
        ball.x + ballR > hoop.backboardX &&
        ball.x + ballR < hoop.backboardX + 12 &&
        ball.y > hoop.backboardY1 &&
        ball.y < hoop.backboardY2
      ) {
        ball.x = hoop.backboardX - ballR;
        ball.vx = -Math.abs(ball.vx) * 0.55;
      }

      // Rim posts (left & right): treat as small circles to bounce off.
      this.bounceFromPost(ball, hoop.x1, hoop.y);
      this.bounceFromPost(ball, hoop.x2, hoop.y);

      // Score detection — only the owner of the ball decides.
      if (
        !ball.scored &&
        ball.ownerId === this.net.me.id &&
        ball.vy > 0 &&
        prevY < hoop.y &&
        ball.y >= hoop.y &&
        ball.x > hoop.x1 + 4 &&
        ball.x < hoop.x2 - 4
      ) {
        ball.scored = true;
        this.net.awardScore(this.net.me.id, 1);
        this.applyResult(this.net.me.id, "make");
        this.net.pushSystem(`${this.net.me.name} scored!`);
        this.playSwish();
        this.ns.send("result", { id: ball.id, kind: "make" });
      }
    }
    // Remove old balls.
    for (const [id, ball] of this.balls) {
      const offscreen = ball.x < -100 || ball.x > FIELD_W + 100 || ball.y > FIELD_H + 200;
      if (now - ball.startedAt > BALL_LIFETIME_MS || offscreen) {
        // If this was our own throw and we never scored, count it as a miss.
        if (ball.ownerId === this.net.me.id && !ball.scored) {
          this.applyResult(this.net.me.id, "miss");
          this.playMiss();
          this.ns.send("result", { id: ball.id, kind: "miss" });
        }
        this.balls.delete(id);
      }
    }
  }

  private bounceFromPost(ball: ActiveBall, px: number, py: number) {
    const dx = ball.x - px;
    const dy = ball.y - py;
    const d = Math.hypot(dx, dy);
    const minD = this.diff.ballR + 4;
    if (d < minD && d > 0.0001) {
      const nx = dx / d;
      const ny = dy / d;
      ball.x = px + nx * minD;
      ball.y = py + ny * minD;
      const dot = ball.vx * nx + ball.vy * ny;
      ball.vx -= 2 * dot * nx * 0.7;
      ball.vy -= 2 * dot * ny * 0.7;
    }
  }

  private draw() {
    const c = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const hoop = this.hoopState();
    c.save();
    c.scale(w / FIELD_W, h / FIELD_H);

    // Court background.
    c.fillStyle = "#f3ede1";
    c.fillRect(0, 0, FIELD_W, FIELD_H);

    // Center & half-court line.
    c.strokeStyle = "#d6cdb9";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(FIELD_W / 2, 0);
    c.lineTo(FIELD_W / 2, FIELD_H);
    c.stroke();

    // Throwing zone tint.
    c.fillStyle = "rgba(45, 90, 79, 0.04)";
    c.fillRect(0, 0, FIELD_W / 2, FIELD_H);
    c.fillStyle = "#9b8c70";
    c.font = "italic 18px ui-sans-serif, system-ui, sans-serif";
    c.textAlign = "center";
    c.fillText("Drag from anywhere here to throw", FIELD_W / 4, FIELD_H - 24);

    // Backboard.
    c.fillStyle = "#caa472";
    c.fillRect(hoop.backboardX, hoop.backboardY1, 12, hoop.backboardY2 - hoop.backboardY1);
    c.strokeStyle = "#8c6b3f";
    c.lineWidth = 2;
    c.strokeRect(hoop.backboardX, hoop.backboardY1, 12, hoop.backboardY2 - hoop.backboardY1);

    // Hoop rim.
    c.strokeStyle = "#c2542a";
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(hoop.x1, hoop.y);
    c.lineTo(hoop.x2, hoop.y);
    c.stroke();
    // Net (a few diagonal lines for charm).
    c.strokeStyle = "#aaa";
    c.lineWidth = 1;
    const netDepth = 36;
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const x = hoop.x1 + (hoop.x2 - hoop.x1) * t;
      const xb = hoop.x1 + 14 + (hoop.x2 - hoop.x1 - 28) * t;
      c.beginPath();
      c.moveTo(x, hoop.y);
      c.lineTo(xb, hoop.y + netDepth);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(hoop.x1 + 14, hoop.y + netDepth);
    c.lineTo(hoop.x2 - 14, hoop.y + netDepth);
    c.stroke();

    // Floor line.
    c.strokeStyle = "#d6cdb9";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, FIELD_H - 10);
    c.lineTo(FIELD_W, FIELD_H - 10);
    c.stroke();

    // Balls.
    for (const ball of this.balls.values()) {
      this.drawBall(ball.x, ball.y, ball.color);
      if (ball.ownerId !== this.net.me.id) {
        const name = this.net.peers.get(ball.ownerId)?.name ?? "anon";
        c.font = "600 13px ui-sans-serif, system-ui, sans-serif";
        c.textAlign = "center";
        const tx = ball.x;
        const ty = ball.y - this.diff.ballR - 10;
        const w = c.measureText(name).width + 10;
        c.fillStyle = "rgba(255,255,255,0.85)";
        c.strokeStyle = "rgba(0,0,0,0.1)";
        c.lineWidth = 1;
        const bx = tx - w / 2;
        const by = ty - 14;
        c.beginPath();
        // Rounded rect (small radius).
        const r = 4;
        c.moveTo(bx + r, by);
        c.lineTo(bx + w - r, by);
        c.quadraticCurveTo(bx + w, by, bx + w, by + r);
        c.lineTo(bx + w, by + 18 - r);
        c.quadraticCurveTo(bx + w, by + 18, bx + w - r, by + 18);
        c.lineTo(bx + r, by + 18);
        c.quadraticCurveTo(bx, by + 18, bx, by + 18 - r);
        c.lineTo(bx, by + r);
        c.quadraticCurveTo(bx, by, bx + r, by);
        c.closePath();
        c.fill();
        c.stroke();
        c.fillStyle = "#222";
        c.fillText(name, tx, by + 13);
      }
    }

    // Drag-aim arrow (slingshot preview).
    if (this.dragging) {
      const d = this.dragging;
      const dx = d.startX - d.curX;
      const dy = d.startY - d.curY;
      const dist = Math.hypot(dx, dy);
      // Ghost ball at the press position.
      this.drawBall(d.startX, d.startY, this.net.me.color, 0.7);
      // Pull-back indicator (thin line where finger is).
      c.strokeStyle = "rgba(0,0,0,0.25)";
      c.setLineDash([4, 4]);
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(d.startX, d.startY);
      c.lineTo(d.curX, d.curY);
      c.stroke();
      c.setLineDash([]);
      // Aim arrow (opposite direction = launch direction).
      if (dist > 12) {
        const ax = d.startX + dx * 0.5;
        const ay = d.startY + dy * 0.5;
        c.strokeStyle = this.net.me.color;
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(d.startX, d.startY);
        c.lineTo(ax, ay);
        c.stroke();
        // Arrowhead.
        const ang = Math.atan2(dy, dx);
        c.beginPath();
        c.moveTo(ax, ay);
        c.lineTo(ax - Math.cos(ang - 0.4) * 14, ay - Math.sin(ang - 0.4) * 14);
        c.moveTo(ax, ay);
        c.lineTo(ax - Math.cos(ang + 0.4) * 14, ay - Math.sin(ang + 0.4) * 14);
        c.stroke();
      }
    }

    c.restore();
  }

  private drawBall(x: number, y: number, color: string, alpha = 1) {
    const c = this.ctx;
    const r = this.diff.ballR;
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    // Subtle seam line for basketball feel.
    c.strokeStyle = "rgba(0,0,0,0.25)";
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(x - r, y);
    c.lineTo(x + r, y);
    c.stroke();
    c.restore();
  }

  // ---------- scoreboard ----------

  private statsFor(peerId: string): HoopStats {
    let s = this.stats.get(peerId);
    if (!s) {
      s = emptyStats();
      this.stats.set(peerId, s);
    }
    return s;
  }

  private applyResult(peerId: string, kind: "make" | "miss") {
    const s = this.statsFor(peerId);
    if (kind === "make") {
      s.makes++;
      s.streak++;
      if (s.streak > s.longestStreak) s.longestStreak = s.streak;
      s.missStreak = 0;
    } else {
      s.misses++;
      s.missStreak++;
      if (s.missStreak > s.longestMissStreak) s.longestMissStreak = s.missStreak;
      s.streak = 0;
    }
    this.renderScoreboard();
  }

  private renderScoreboard = () => {
    const rows = [...this.net.peers.entries()]
      .map(([id, p]) => ({ id, name: p.name, color: p.color, score: p.score, stats: this.stats.get(id) }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    this.scoreboard.innerHTML = rows
      .map((r) => {
        const s = r.stats ?? emptyStats();
        const total = s.makes + s.misses;
        const pct = total > 0 ? Math.round((s.makes / total) * 100) : 0;
        return `
          <div class="hoops-row">
            <div class="hoops-row-head">
              <span class="hoops-dot" style="background:${escapeAttr(r.color)}"></span>
              <span class="hoops-name">${escapeHtml(r.name)}${r.id === this.net.me.id ? " (you)" : ""}</span>
              <span class="hoops-score">${r.score}</span>
            </div>
            <div class="hoops-row-stats">
              <span title="Makes / misses">${s.makes} / ${s.misses} · ${pct}%</span>
              <span title="Current streak">▲ ${s.streak} (best ${s.longestStreak})</span>
              <span title="Current miss streak" class="hoops-miss-streak">▼ ${s.missStreak} (worst ${s.longestMissStreak})</span>
            </div>
          </div>
        `;
      })
      .join("");
  };

  // ---------- canvas sizing ----------

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function sanitizeStats(s: unknown): HoopStats {
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(1e6, Math.floor(n)) : 0;
  };
  return {
    makes: num(o.makes),
    misses: num(o.misses),
    streak: num(o.streak),
    longestStreak: num(o.longestStreak),
    missStreak: num(o.missStreak),
    longestMissStreak: num(o.longestMissStreak),
  };
}
