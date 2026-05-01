import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Flappy Lobby
 * ────────────
 * A Flappy Bird clone with live ghost birds for everyone else in the
 * lobby. Each peer simulates their own world locally (their own pipes,
 * their own physics), and broadcasts a tiny position packet ~10 Hz so
 * other peers can render a ghost showing where they are vertically and
 * what their current run score is.
 *
 * Scoring: when your run ends, your session-best is awarded as lobby
 * score (delta vs previous best). No host election needed — everyone
 * runs their own sim, only their own self-reported best counts.
 */

const WORLD_W = 480;
const WORLD_H = 640;
const BIRD_X = 120;
const BIRD_R = 14;
const GRAVITY = 1400; // px/s^2
const FLAP_VY = -420; // px/s
const PIPE_W = 60;
const PIPE_GAP = 170;
const PIPE_SPACING = 240; // horizontal distance between pipe pairs
const PIPE_SPEED = 170; // px/s scroll speed
const GROUND_H = 60;

const STORAGE_KEY = "pfg-flappy-best";

interface Pipe {
    x: number;
    /** Y centre of the gap. */
    gapY: number;
    /** True once the bird has crossed it (for scoring). */
    passed: boolean;
}

type Phase = "ready" | "playing" | "dead";

interface GhostState {
    /** Normalised 0..1 vertical position. */
    y: number;
    score: number;
    alive: boolean;
    ts: number;
}

export const FlappyGame: Game = {
    id: "flappy",
    name: "Flappy Lobby",
    description: "Tap to flap. Don't hit the pipes. Watch the lobby ghost-fly alongside you.",
    create(container, net): GameInstance {
        const inst = new FlappyInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

class FlappyInstance {
    private container: HTMLElement;
    private net: Net;
    private ns: GameNamespace;

    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private statusEl!: HTMLDivElement;
    private scoreEl!: HTMLDivElement;
    private bestEl!: HTMLDivElement;
    private leaderEl!: HTMLDivElement;
    private restartBtn!: HTMLButtonElement;

    private phase: Phase = "ready";
    private birdY = WORLD_H / 2;
    private birdVy = 0;
    private pipes: Pipe[] = [];
    /** Distance scrolled, used for spawning pipes. */
    private dist = 0;
    private score = 0;
    private best = 0;

    /** peerId → most recent ghost packet. */
    private ghosts: Map<string, GhostState> = new Map();

    private rafId: number | null = null;
    private lastTs = 0;
    private lastBroadcast = 0;
    private detachKeys: (() => void)[] = [];
    private leaderTimer: ReturnType<typeof setInterval> | null = null;
    private unsubPeers: (() => void) | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("flappy");
        this.best = loadBest();

        container.innerHTML = `
      <div class="game-layout flappy-layout">
        <aside class="toolbar flappy-toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint">
              Tap, click or press <strong>Space</strong> to flap. Stay between
              the pipes. Each pipe you clear is +1.
            </p>
          </div>
          <div class="tool-group">
            <label>This run</label>
            <div class="flappy-stat-row">
              <span>Score</span><span class="flappy-stat-val" data-role="score">0</span>
            </div>
            <div class="flappy-stat-row">
              <span>Best</span><span class="flappy-stat-val" data-role="best">${this.best}</span>
            </div>
          </div>
          <div class="tool-group">
            <button class="flappy-restart" data-role="restart">Restart</button>
          </div>
          <div class="tool-group flappy-leader-wrap">
            <h3>Lobby leaderboard</h3>
            <div class="flappy-leader" data-role="leader"></div>
          </div>
        </aside>
        <div class="stage flappy-stage">
          <div class="flappy-status" data-role="status">Click or press Space to start</div>
          <canvas class="flappy-canvas" width="${WORLD_W}" height="${WORLD_H}"></canvas>
        </div>
      </div>
    `;

        this.canvas = container.querySelector("canvas.flappy-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.statusEl = container.querySelector('[data-role="status"]')!;
        this.scoreEl = container.querySelector('[data-role="score"]')!;
        this.bestEl = container.querySelector('[data-role="best"]')!;
        this.leaderEl = container.querySelector('[data-role="leader"]')!;
        this.restartBtn = container.querySelector('[data-role="restart"]')!;

        this.restartBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.reset();
        });

        // Input handlers
        const flap = (e: Event) => {
            // Don't consume clicks on the restart button.
            if (e.target instanceof HTMLElement && e.target.closest("button")) return;
            e.preventDefault();
            this.handleFlap();
        };
        this.canvas.addEventListener("pointerdown", flap);

        const onKey = (e: KeyboardEvent) => {
            if (e.code === "Space" || e.code === "ArrowUp") {
                // Only intercept when our stage is visible & not typing in chat.
                const target = e.target as HTMLElement | null;
                if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
                if (!container.isConnected) return;
                e.preventDefault();
                this.handleFlap();
            }
        };
        window.addEventListener("keydown", onKey);
        this.detachKeys.push(() => window.removeEventListener("keydown", onKey));

        // Network: receive ghost updates.
        this.ns.on<GhostState>("pos", (data, peerId) => {
            if (peerId === this.net.me.id) return;
            this.ghosts.set(peerId, { ...data, ts: performance.now() });
        });

        // Drop ghost entries when peers leave.
        this.unsubPeers = this.net.on("peers", () => {
            for (const id of [...this.ghosts.keys()]) {
                if (!this.net.peers.has(id)) this.ghosts.delete(id);
            }
            this.renderLeaderboard();
        });

        this.leaderTimer = setInterval(() => this.renderLeaderboard(), 500);

        this.reset();
        this.start();
    }

    private handleFlap() {
        if (this.phase === "ready") {
            this.phase = "playing";
            this.statusEl.textContent = "";
        }
        if (this.phase === "playing") {
            this.birdVy = FLAP_VY;
        } else if (this.phase === "dead") {
            this.reset();
        }
    }

    private reset() {
        this.phase = "ready";
        this.birdY = WORLD_H / 2;
        this.birdVy = 0;
        this.pipes = [];
        this.dist = 0;
        this.score = 0;
        this.scoreEl.textContent = "0";
        this.statusEl.textContent = "Click or press Space to start";
        this.broadcast(true);
    }

    private start() {
        const loop = (ts: number) => {
            const dt = this.lastTs === 0 ? 0 : Math.min(0.05, (ts - this.lastTs) / 1000);
            this.lastTs = ts;
            if (this.phase === "playing") this.update(dt);
            this.draw();
            if (ts - this.lastBroadcast > 100) {
                this.broadcast(this.phase !== "dead");
                this.lastBroadcast = ts;
            }
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    private update(dt: number) {
        // Physics
        this.birdVy += GRAVITY * dt;
        this.birdY += this.birdVy * dt;

        // Scroll pipes
        const ds = PIPE_SPEED * dt;
        this.dist += ds;
        for (const p of this.pipes) p.x -= ds;

        // Spawn pipes
        const lastX = this.pipes.length ? this.pipes[this.pipes.length - 1].x : -Infinity;
        if (lastX < WORLD_W - PIPE_SPACING) {
            this.pipes.push({
                x: WORLD_W + 20,
                gapY: 80 + Math.random() * (WORLD_H - GROUND_H - 160),
                passed: false,
            });
        }
        // Cull
        this.pipes = this.pipes.filter((p) => p.x + PIPE_W > -10);

        // Score
        for (const p of this.pipes) {
            if (!p.passed && p.x + PIPE_W < BIRD_X - BIRD_R) {
                p.passed = true;
                this.score += 1;
                this.scoreEl.textContent = String(this.score);
            }
        }

        // Collisions
        if (this.birdY + BIRD_R >= WORLD_H - GROUND_H || this.birdY - BIRD_R <= 0) {
            this.die();
            return;
        }
        for (const p of this.pipes) {
            if (p.x < BIRD_X + BIRD_R && p.x + PIPE_W > BIRD_X - BIRD_R) {
                if (this.birdY - BIRD_R < p.gapY - PIPE_GAP / 2 || this.birdY + BIRD_R > p.gapY + PIPE_GAP / 2) {
                    this.die();
                    return;
                }
            }
        }
    }

    private die() {
        if (this.phase !== "playing") return;
        this.phase = "dead";
        this.statusEl.textContent = `Game over — score ${this.score}. Click to retry.`;
        if (this.score > this.best) {
            const delta = this.score - this.best;
            this.best = this.score;
            this.bestEl.textContent = String(this.best);
            saveBest(this.best);
            this.net.awardScore(this.net.me.id, delta);
            this.net.pushSystem(`${this.net.me.name} set a new flappy best: ${this.best}`);
        }
        this.broadcast(false);
    }

    private broadcast(alive: boolean) {
        this.ns.send<GhostState>("pos", {
            y: this.birdY / WORLD_H,
            score: this.score,
            alive,
            ts: 0,
        });
    }

    private draw() {
        const ctx = this.ctx;
        // Sky
        const grad = ctx.createLinearGradient(0, 0, 0, WORLD_H);
        grad.addColorStop(0, "#7ec8e3");
        grad.addColorStop(1, "#cfe9f1");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, WORLD_W, WORLD_H);

        // Pipes
        ctx.fillStyle = "#4f8a4a";
        ctx.strokeStyle = "#2f5b2c";
        ctx.lineWidth = 2;
        for (const p of this.pipes) {
            const topH = p.gapY - PIPE_GAP / 2;
            const botY = p.gapY + PIPE_GAP / 2;
            ctx.fillRect(p.x, 0, PIPE_W, topH);
            ctx.strokeRect(p.x, 0, PIPE_W, topH);
            ctx.fillRect(p.x, botY, PIPE_W, WORLD_H - GROUND_H - botY);
            ctx.strokeRect(p.x, botY, PIPE_W, WORLD_H - GROUND_H - botY);
            // Lip
            ctx.fillRect(p.x - 4, topH - 14, PIPE_W + 8, 14);
            ctx.strokeRect(p.x - 4, topH - 14, PIPE_W + 8, 14);
            ctx.fillRect(p.x - 4, botY, PIPE_W + 8, 14);
            ctx.strokeRect(p.x - 4, botY, PIPE_W + 8, 14);
        }

        // Ground
        ctx.fillStyle = "#d9b97a";
        ctx.fillRect(0, WORLD_H - GROUND_H, WORLD_W, GROUND_H);
        ctx.fillStyle = "#a4894c";
        for (let x = (this.dist % 24) - 24; x < WORLD_W; x += 24) {
            ctx.fillRect(x, WORLD_H - GROUND_H + 8, 12, 4);
        }

        // Ghost birds
        const now = performance.now();
        for (const [id, g] of this.ghosts) {
            if (now - g.ts > 3000) continue;
            const peer = this.net.peers.get(id);
            if (!peer) continue;
            const gy = g.y * WORLD_H;
            ctx.globalAlpha = g.alive ? 0.45 : 0.2;
            drawBird(ctx, BIRD_X - 30, gy, peer.color);
            ctx.globalAlpha = 1;
            ctx.font = "11px system-ui, sans-serif";
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.textAlign = "center";
            ctx.fillText(`${peer.name} · ${g.score}`, BIRD_X - 30, gy - 18);
        }

        // Self bird
        drawBird(ctx, BIRD_X, this.birdY, this.net.me.color, this.birdVy);

        // Score (big)
        ctx.font = "bold 36px system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = 4;
        ctx.textAlign = "center";
        const txt = String(this.score);
        ctx.strokeText(txt, WORLD_W / 2, 60);
        ctx.fillText(txt, WORLD_W / 2, 60);

        if (this.phase === "dead") {
            ctx.fillStyle = "rgba(0,0,0,0.45)";
            ctx.fillRect(0, WORLD_H / 2 - 60, WORLD_W, 120);
            ctx.fillStyle = "#fff";
            ctx.font = "bold 32px system-ui, sans-serif";
            ctx.fillText("Game Over", WORLD_W / 2, WORLD_H / 2 - 8);
            ctx.font = "16px system-ui, sans-serif";
            ctx.fillText(`Score ${this.score} · Best ${this.best}`, WORLD_W / 2, WORLD_H / 2 + 24);
        }
    }

    private renderLeaderboard() {
        type Row = { id: string; name: string; color: string; best: number; live: number; alive: boolean };
        const rows: Row[] = [];
        rows.push({
            id: this.net.me.id,
            name: this.net.me.name + " (you)",
            color: this.net.me.color,
            best: this.best,
            live: this.score,
            alive: this.phase !== "dead",
        });
        const now = performance.now();
        for (const [id, g] of this.ghosts) {
            const peer = this.net.peers.get(id);
            if (!peer) continue;
            const stale = now - g.ts > 5000;
            rows.push({
                id,
                name: peer.name,
                color: peer.color,
                best: peer.score,
                live: g.score,
                alive: !stale && g.alive,
            });
        }
        rows.sort((a, b) => b.best - a.best || b.live - a.live);
        this.leaderEl.innerHTML = rows
            .map((r, i) => {
                const mine = r.id === this.net.me.id ? " mine" : "";
                const dot = `<span class="flappy-dot" style="background:${r.color}"></span>`;
                const live = r.alive ? `<span class="flappy-live">· ${r.live}</span>` : "";
                return `<div class="flappy-leader-row${mine}">
          <span class="flappy-rank">${i + 1}.</span>
          ${dot}
          <span class="flappy-leader-name">${escapeHtml(r.name)}</span>
          <span class="flappy-leader-score">${r.best}${live ? " " + live : ""}</span>
        </div>`;
            })
            .join("");
    }

    destroy() {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        for (const fn of this.detachKeys) fn();
        if (this.leaderTimer) clearInterval(this.leaderTimer);
        if (this.unsubPeers) this.unsubPeers();
        this.ns.close();
        this.container.innerHTML = "";
    }
}

function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, vy = 0) {
    const tilt = Math.max(-0.5, Math.min(0.9, vy / 600));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    // Body
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, BIRD_R + 2, BIRD_R, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Wing
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.ellipse(-2, 3, 7, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Eye
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(6, -4, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(7, -4, 2, 0, Math.PI * 2);
    ctx.fill();
    // Beak
    ctx.fillStyle = "#f4b400";
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(20, -2);
    ctx.lineTo(20, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function loadBest(): number {
    try {
        const v = Number(localStorage.getItem(STORAGE_KEY));
        return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
        return 0;
    }
}

function saveBest(v: number) {
    try {
        localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
        /* ignore */
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
