import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Lobby Dash
 * ──────────
 * A Chrome-dinosaur-style endless runner where every peer plays the
 * **same** deterministic level at the same time. The host (lowest peer
 * id) picks a seed and a synchronised start timestamp, broadcasts a
 * round message, and everyone counts down from 3 together.
 *
 * Each peer simulates locally and broadcasts their on-screen Y / ducking
 * state ~10 Hz so others can render them as semi-transparent ghosts
 * sharing the same X position. When you die you become a spectator
 * until the round ends; once everyone is dead the host kicks off the
 * next round (after a short pause).
 *
 * Controls:
 *   Space / ↑ / W      jump (tap again mid-air for a double-jump)
 *   ↓ / S              duck
 */

// ── World constants ────────────────────────────────────────────────────────
const WORLD_W = 720;
const WORLD_H = 260;
const GROUND_Y = 220;
const PLAYER_X = 110;
const PLAYER_W = 28;
const PLAYER_H = 40;
const DUCK_H = 22;

const GRAVITY = 2200;            // px/s^2
const JUMP_VY = -780;            // px/s — first jump
const DOUBLE_JUMP_VY = -680;     // px/s — second jump (slightly weaker)

const BASE_SPEED = 280;          // px/s at t=0
const SPEED_MULT_PER_STEP = 1.35;
const SPEED_STEP_SECONDS = 10;
const MAX_SPEED = 1400;

// Obstacle layout
const MIN_GAP_TIME = 0.7;        // seconds at current speed
const MAX_GAP_TIME = 1.5;

// Cactus sizes
const CACTUS_MIN_W = 14;
const CACTUS_MAX_W = 34;
const CACTUS_MIN_H = 26;
const CACTUS_MAX_H = 50;

// Bird heights (relative to ground). Low birds force a duck.
const BIRD_HEIGHTS = [40, 70, 100]; // px above ground

// Network
const BROADCAST_INTERVAL_MS = 100;
const COUNTDOWN_MS = 3_000;
const INTERMISSION_MS = 4_000;   // wait between rounds

interface RoundMsg {
    roundId: number;
    seed: number;
    /** Date.now() at which the world starts scrolling. */
    startAt: number;
}

interface PosMsg {
    roundId: number;
    y: number;          // 0..1 normalised (0 = top, 1 = ground)
    ducking: boolean;
    alive: boolean;
}

interface DiedMsg {
    roundId: number;
    survivedMs: number;
}

interface SyncReqMsg { _: 0; }

type ObstacleKind = "cactus" | "bird";
interface Obstacle {
    /** Cumulative world distance (px) at which this obstacle stands. */
    worldX: number;
    kind: ObstacleKind;
    w: number;
    h: number;
    /** Y of top edge (relative to GROUND_Y); cacti sit on ground. */
    topY: number;
}

interface GhostState {
    /** 0..1 normalised screen Y. */
    y: number;
    ducking: boolean;
    alive: boolean;
    lastUpdate: number;
}

type Phase = "waiting" | "countdown" | "running" | "spectating" | "intermission";

export const DashGame: Game = {
    id: "dash",
    name: "Lobby Dash",
    description:
        "Same seed, same obstacles, everyone runs together. Jump, double-jump, duck. Last one alive wins the round.",
    create(container, net): GameInstance {
        const inst = new DashInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

// ── Seeded RNG (mulberry32) ────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class DashInstance {
    private container: HTMLElement;
    private net: Net;
    private ns: GameNamespace;

    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private statusEl!: HTMLDivElement;
    private scoreEl!: HTMLDivElement;
    private bestEl!: HTMLDivElement;
    private speedEl!: HTMLDivElement;
    private leaderEl!: HTMLDivElement;

    private phase: Phase = "waiting";
    private roundId = 0;
    private seed = 0;
    private startAt = 0;          // Date.now() at scroll-start
    private intermissionUntil = 0;

    /** Player physics — screen-space y (px from top), vy in px/s. */
    private py = GROUND_Y - PLAYER_H;
    private vy = 0;
    private jumpsUsed = 0;        // 0, 1, or 2
    private ducking = false;
    private alive = false;
    private diedAt = 0;
    private best = 0;

    /** Deterministic obstacle stream (sorted by worldX). */
    private obstacles: Obstacle[] = [];
    private obstacleCursor = 0;   // next index to spawn into `obstacles`
    private nextSpawnWorldX = 0;
    private rng: () => number = Math.random;

    /** peerId → ghost (only contains *other* peers). */
    private ghosts: Map<string, GhostState> = new Map();
    /** peerId → alive in current round (used for "round over" detection). */
    private aliveSet: Set<string> = new Set();

    private rafId: number | null = null;
    private lastFrame = 0;
    private lastBroadcast = 0;
    private detachKeys: (() => void)[] = [];
    private unsubPeers: (() => void) | null = null;
    private leaderTimer: ReturnType<typeof setInterval> | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("dash");

        container.innerHTML = `
      <div class="game-layout flappy-layout dash-layout">
        <aside class="toolbar flappy-toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint">
              <strong>Space</strong> / <strong>↑</strong> to jump (tap again
              mid-air to double-jump). <strong>↓</strong> to duck under
              birds. Everyone runs the same level — survive longest to
              win the round.
            </p>
          </div>
          <div class="tool-group">
            <label>This run</label>
            <div class="flappy-stat-row">
              <span>Survived</span>
              <span class="flappy-stat-val" data-role="score">0.0s</span>
            </div>
            <div class="flappy-stat-row">
              <span>Best</span>
              <span class="flappy-stat-val" data-role="best">0.0s</span>
            </div>
            <div class="flappy-stat-row">
              <span>Speed ×</span>
              <span class="flappy-stat-val" data-role="speed">1.00</span>
            </div>
          </div>
          <div class="tool-group flappy-leader-wrap">
            <h3>Round status</h3>
            <div class="flappy-leader" data-role="leader"></div>
          </div>
        </aside>
        <div class="stage flappy-stage">
          <div class="flappy-status" data-role="status">Waiting for round…</div>
          <canvas class="flappy-canvas dash-canvas" width="${WORLD_W}" height="${WORLD_H}"></canvas>
        </div>
      </div>
    `;

        this.canvas = container.querySelector<HTMLCanvasElement>("canvas.dash-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.statusEl = container.querySelector<HTMLDivElement>('[data-role="status"]')!;
        this.scoreEl = container.querySelector<HTMLDivElement>('[data-role="score"]')!;
        this.bestEl = container.querySelector<HTMLDivElement>('[data-role="best"]')!;
        this.speedEl = container.querySelector<HTMLDivElement>('[data-role="speed"]')!;
        this.leaderEl = container.querySelector<HTMLDivElement>('[data-role="leader"]')!;
        this.bestEl.textContent = this.formatSeconds(this.best);

        this.attachInput();
        this.registerNetwork();

        this.unsubPeers = this.net.on("peers", () => {
            for (const id of [...this.ghosts.keys()]) {
                if (!this.net.peers.has(id)) {
                    this.ghosts.delete(id);
                    this.aliveSet.delete(id);
                }
            }
            this.renderLeaderboard();
            // If host left during intermission, re-check whether *we* should start a round.
            this.maybeHostStartRound();
        });

        this.leaderTimer = setInterval(() => this.renderLeaderboard(), 500);

        // Late-join: ask anyone (host will respond).
        this.ns.send<SyncReqMsg>("sync-request", { _: 0 });

        // Solo case: if there are no peers we'll never get a sync response,
        // so just start a round ourselves after a brief moment.
        setTimeout(() => this.maybeHostStartRound(), 600);

        this.lastFrame = performance.now();
        this.loop();
    }

    destroy(): void {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        if (this.leaderTimer) clearInterval(this.leaderTimer);
        this.unsubPeers?.();
        for (const fn of this.detachKeys) fn();
        this.detachKeys = [];
        this.ns.close();
        this.container.innerHTML = "";
    }

    // ── Input ─────────────────────────────────────────────────────────────
    private attachInput(): void {
        const isTyping = (target: EventTarget | null): boolean => {
            const el = target as HTMLElement | null;
            return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (isTyping(e.target)) return;
            if (!this.container.isConnected) return;
            if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
                e.preventDefault();
                this.tryJump();
            } else if (e.code === "ArrowDown" || e.code === "KeyS") {
                e.preventDefault();
                this.ducking = true;
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.code === "ArrowDown" || e.code === "KeyS") {
                this.ducking = false;
            }
        };
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        this.detachKeys.push(() => window.removeEventListener("keydown", onKeyDown));
        this.detachKeys.push(() => window.removeEventListener("keyup", onKeyUp));

        // Touch controls: tap top half = jump, tap bottom half = duck (hold).
        const onPointerDown = (e: PointerEvent) => {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const y = e.clientY - rect.top;
            if (y < rect.height * 0.6) this.tryJump();
            else this.ducking = true;
        };
        const onPointerUp = () => { this.ducking = false; };
        this.canvas.addEventListener("pointerdown", onPointerDown);
        this.canvas.addEventListener("pointerup", onPointerUp);
        this.canvas.addEventListener("pointercancel", onPointerUp);
        this.canvas.addEventListener("pointerleave", onPointerUp);
    }

    private tryJump(): void {
        if (this.phase !== "running" || !this.alive) return;
        if (this.jumpsUsed === 0) {
            this.vy = JUMP_VY;
            this.jumpsUsed = 1;
        } else if (this.jumpsUsed === 1) {
            this.vy = DOUBLE_JUMP_VY;
            this.jumpsUsed = 2;
        }
    }

    // ── Networking ────────────────────────────────────────────────────────
    private registerNetwork(): void {
        this.ns.on<RoundMsg>("round", (data, peerId) => {
            // Accept rounds from the host only (lowest peer id at the time).
            const host = this.currentHostId();
            if (peerId !== host) return;
            if (data.roundId <= this.roundId && this.phase !== "waiting") return;
            this.beginRound(data);
        });

        this.ns.on<PosMsg>("pos", (data, peerId) => {
            if (peerId === this.net.me.id) return;
            if (data.roundId !== this.roundId) return;
            this.ghosts.set(peerId, {
                y: data.y,
                ducking: data.ducking,
                alive: data.alive,
                lastUpdate: performance.now(),
            });
            if (data.alive) this.aliveSet.add(peerId);
            else this.aliveSet.delete(peerId);
        });

        this.ns.on<DiedMsg>("died", (data, peerId) => {
            if (data.roundId !== this.roundId) return;
            this.aliveSet.delete(peerId);
            const peer = this.net.peers.get(peerId);
            if (peer) {
                this.net.pushSystem(
                    `${peer.name} fell at ${this.formatSeconds(data.survivedMs / 1000)}.`,
                );
            }
        });

        this.ns.on<SyncReqMsg>("sync-request", (_d, peerId) => {
            if (peerId === this.net.me.id) return;
            if (!this.isHost()) return;
            if (this.roundId === 0) return;
            this.ns.send<RoundMsg>(
                "round",
                { roundId: this.roundId, seed: this.seed, startAt: this.startAt },
                peerId,
            );
        });
    }

    /** Host = lowest peer id (including self). */
    private isHost(): boolean {
        const ids = [this.net.me.id, ...this.net.peers.keys()];
        return [...new Set(ids)].sort()[0] === this.net.me.id;
    }

    private currentHostId(): string {
        const ids = [this.net.me.id, ...this.net.peers.keys()];
        return [...new Set(ids)].sort()[0];
    }

    private maybeHostStartRound(): void {
        if (!this.isHost()) return;
        if (this.phase === "countdown" || this.phase === "running") return;
        const now = Date.now();
        if (this.phase === "intermission" && now < this.intermissionUntil) return;
        // Spectating but host? Means we're the only one left somehow.
        this.hostStartRound();
    }

    private hostStartRound(): void {
        const seed = (Math.random() * 0x7fffffff) | 0;
        const startAt = Date.now() + COUNTDOWN_MS;
        const msg: RoundMsg = {
            roundId: this.roundId + 1,
            seed,
            startAt,
        };
        this.ns.send<RoundMsg>("round", msg);
        this.beginRound(msg);
    }

    private beginRound(msg: RoundMsg): void {
        this.roundId = msg.roundId;
        this.seed = msg.seed;
        this.startAt = msg.startAt;
        this.rng = mulberry32(msg.seed);
        this.obstacles = [];
        this.obstacleCursor = 0;
        this.nextSpawnWorldX = 320; // first obstacle a beat after start
        this.ghosts.clear();
        this.aliveSet.clear();
        this.aliveSet.add(this.net.me.id);
        this.py = GROUND_Y - PLAYER_H;
        this.vy = 0;
        this.jumpsUsed = 0;
        this.ducking = false;
        this.alive = true;
        this.diedAt = 0;
        this.phase = "countdown";
        this.scoreEl.textContent = "0.0s";
        this.speedEl.textContent = "1.00";
        this.renderLeaderboard();
    }

    private die(): void {
        if (!this.alive) return;
        this.alive = false;
        this.diedAt = Date.now();
        const survivedMs = Math.max(0, this.diedAt - this.startAt);
        this.aliveSet.delete(this.net.me.id);
        this.phase = "spectating";
        const survivedS = survivedMs / 1000;
        if (survivedS > this.best) {
            const delta = Math.floor(survivedS) - Math.floor(this.best);
            this.best = survivedS;
            this.bestEl.textContent = this.formatSeconds(this.best);
            if (delta > 0) this.net.awardScore(this.net.me.id, delta);
        }
        this.ns.send<DiedMsg>("died", { roundId: this.roundId, survivedMs });
        this.broadcastPos(true); // final position update (alive=false)
    }

    // ── Game loop ─────────────────────────────────────────────────────────
    private loop = (ts?: number): void => {
        const now = ts ?? performance.now();
        const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
        this.lastFrame = now;

        this.tick(dt, now);
        this.draw();

        if (now - this.lastBroadcast > BROADCAST_INTERVAL_MS) {
            this.broadcastPos(false);
            this.lastBroadcast = now;
        }

        this.rafId = requestAnimationFrame(this.loop);
    };

    private tick(dt: number, nowPerf: number): void {
        const wallNow = Date.now();

        if (this.phase === "countdown") {
            this.statusEl.textContent = this.countdownLabel(wallNow);
            if (wallNow >= this.startAt) {
                this.phase = "running";
                this.statusEl.textContent = "GO!";
            }
        }

        if (this.phase === "running" || this.phase === "spectating") {
            const elapsed = Math.max(0, (wallNow - this.startAt) / 1000);
            const speed = this.currentSpeed(elapsed);
            const worldX = this.worldDistance(elapsed);

            // Spawn deterministic obstacles up to a little ahead of the camera.
            this.ensureObstacles(worldX + WORLD_W);

            if (this.phase === "running") {
                this.updatePlayer(dt);
                this.checkCollisions(worldX);
                this.scoreEl.textContent = this.formatSeconds(elapsed);
                this.speedEl.textContent = (speed / BASE_SPEED).toFixed(2);
                if (this.alive) this.statusEl.textContent = "";
            } else {
                this.scoreEl.textContent = this.formatSeconds(
                    Math.max(0, (this.diedAt - this.startAt) / 1000),
                );
                this.speedEl.textContent = (speed / BASE_SPEED).toFixed(2);
                const alive = this.aliveSet.size;
                this.statusEl.textContent =
                    alive > 0
                        ? `You're spectating — ${alive} player${alive === 1 ? "" : "s"} still alive`
                        : "Round over — preparing next round…";
            }

            // Round-over detection: nobody alive on this peer's view.
            // Host kicks off intermission → next round.
            if (
                this.aliveSet.size === 0 &&
                (this.phase === "running" || this.phase === "spectating")
            ) {
                this.phase = "intermission";
                this.intermissionUntil = wallNow + INTERMISSION_MS;
            }
        }

        if (this.phase === "intermission") {
            const remain = Math.max(0, this.intermissionUntil - wallNow);
            this.statusEl.textContent =
                remain > 0
                    ? `Next round in ${(remain / 1000).toFixed(1)}s…`
                    : "Starting next round…";
            if (remain <= 0 && this.isHost()) {
                this.hostStartRound();
            }
        }

        // Drop stale ghosts that haven't updated in a while (peer left mid-round).
        const STALE_MS = 4_000;
        for (const [id, g] of this.ghosts) {
            if (nowPerf - g.lastUpdate > STALE_MS) {
                this.ghosts.delete(id);
                this.aliveSet.delete(id);
            }
        }
    }

    private currentSpeed(elapsedSeconds: number): number {
        const step = Math.floor(elapsedSeconds / SPEED_STEP_SECONDS);
        const s = BASE_SPEED * Math.pow(SPEED_MULT_PER_STEP, step);
        return Math.min(s, MAX_SPEED);
    }

    /** Integral of speed(t) dt from 0 to elapsed → cumulative world distance. */
    private worldDistance(elapsedSeconds: number): number {
        let dist = 0;
        let remaining = elapsedSeconds;
        let step = 0;
        while (remaining > 0) {
            const slice = Math.min(remaining, SPEED_STEP_SECONDS);
            const s = Math.min(BASE_SPEED * Math.pow(SPEED_MULT_PER_STEP, step), MAX_SPEED);
            dist += s * slice;
            remaining -= slice;
            step += 1;
        }
        return dist;
    }

    private updatePlayer(dt: number): void {
        if (!this.alive) return;
        this.vy += GRAVITY * dt;
        this.py += this.vy * dt;
        const groundY = GROUND_Y - this.currentPlayerH();
        if (this.py >= groundY) {
            this.py = groundY;
            this.vy = 0;
            this.jumpsUsed = 0;
        }
    }

    private currentPlayerH(): number {
        // Only allow ducking while on the ground.
        const onGround = this.py >= GROUND_Y - PLAYER_H - 0.5;
        return this.ducking && onGround ? DUCK_H : PLAYER_H;
    }

    private ensureObstacles(maxWorldX: number): void {
        while (this.nextSpawnWorldX <= maxWorldX) {
            // Pick obstacle type & shape from seeded RNG.
            const r = this.rng();
            let ob: Obstacle;
            if (r < 0.7) {
                // Cactus
                const w = CACTUS_MIN_W + this.rng() * (CACTUS_MAX_W - CACTUS_MIN_W);
                const h = CACTUS_MIN_H + this.rng() * (CACTUS_MAX_H - CACTUS_MIN_H);
                ob = {
                    worldX: this.nextSpawnWorldX,
                    kind: "cactus",
                    w,
                    h,
                    topY: GROUND_Y - h,
                };
            } else {
                // Bird
                const heightIdx = Math.floor(this.rng() * BIRD_HEIGHTS.length);
                const top = GROUND_Y - BIRD_HEIGHTS[heightIdx] - 18;
                ob = {
                    worldX: this.nextSpawnWorldX,
                    kind: "bird",
                    w: 34,
                    h: 22,
                    topY: top,
                };
            }
            this.obstacles.push(ob);
            this.obstacleCursor += 1;

            // Next gap (in seconds of *current* speed, converted to px).
            const gapTime = MIN_GAP_TIME + this.rng() * (MAX_GAP_TIME - MIN_GAP_TIME);
            // Use a reference speed equal to the speed at the spawn distance.
            // We don't know elapsed easily, so approximate via mid-table speed
            // → simpler: use BASE_SPEED * factor based on how far in we are.
            const factor = 1 + this.nextSpawnWorldX / 3500;
            const gapPx = gapTime * BASE_SPEED * factor;
            this.nextSpawnWorldX += Math.max(120, gapPx);
        }
    }

    private checkCollisions(worldX: number): void {
        const ph = this.currentPlayerH();
        const px = PLAYER_X;
        const py = this.py;
        const pw = PLAYER_W;
        for (const ob of this.obstacles) {
            const ox = ob.worldX - worldX + PLAYER_X;
            if (ox + ob.w < px) continue;
            if (ox > px + pw) break; // sorted by worldX
            // AABB overlap.
            if (
                ox < px + pw &&
                ox + ob.w > px &&
                ob.topY < py + ph &&
                ob.topY + ob.h > py
            ) {
                this.die();
                return;
            }
        }
    }

    // ── Drawing ───────────────────────────────────────────────────────────
    private draw(): void {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, WORLD_W, WORLD_H);

        // Sky / background
        ctx.fillStyle = "#f4ecd8";
        ctx.fillRect(0, 0, WORLD_W, WORLD_H);

        // Compute world offset (if we have a started round, else 0).
        let worldX = 0;
        if (this.phase === "running" || this.phase === "spectating" || this.phase === "intermission") {
            const elapsed = Math.max(0, (Date.now() - this.startAt) / 1000);
            worldX = this.worldDistance(elapsed);
        }

        // Ground
        ctx.strokeStyle = "#5a4a36";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, GROUND_Y + 0.5);
        ctx.lineTo(WORLD_W, GROUND_Y + 0.5);
        ctx.stroke();

        // Pebble dashes on ground (parallax for motion cue)
        ctx.fillStyle = "#a89a82";
        const pebbleStride = 60;
        const pebbleOffset = worldX % pebbleStride;
        for (let x = -pebbleOffset; x < WORLD_W; x += pebbleStride) {
            ctx.fillRect(x, GROUND_Y + 6, 4, 2);
            ctx.fillRect(x + 22, GROUND_Y + 12, 6, 2);
        }

        // Obstacles
        for (const ob of this.obstacles) {
            const sx = ob.worldX - worldX + PLAYER_X;
            if (sx + ob.w < 0) continue;
            if (sx > WORLD_W) break;
            if (ob.kind === "cactus") {
                ctx.fillStyle = "#3d6b3d";
                ctx.fillRect(sx, ob.topY, ob.w, ob.h);
                ctx.fillStyle = "#2a4f2a";
                ctx.fillRect(sx + 2, ob.topY + 4, 3, ob.h - 8);
            } else {
                // Bird — simple animated triangle pair
                ctx.fillStyle = "#3a3a3a";
                const flap = Math.floor((Date.now() / 150) % 2);
                const cy = ob.topY + ob.h / 2;
                ctx.beginPath();
                ctx.moveTo(sx, cy);
                ctx.lineTo(sx + ob.w, cy);
                ctx.lineTo(sx + ob.w / 2, cy + (flap === 0 ? -10 : 10));
                ctx.closePath();
                ctx.fill();
                ctx.fillRect(sx + ob.w * 0.55, cy - 2, 6, 4);
            }
        }

        // Ghosts (other peers) — semi-transparent silhouettes.
        for (const [peerId, g] of this.ghosts) {
            const peer = this.net.peers.get(peerId);
            if (!peer) continue;
            const h = g.ducking ? DUCK_H : PLAYER_H;
            const gy = g.y * (GROUND_Y - h) || GROUND_Y - h;
            ctx.globalAlpha = g.alive ? 0.35 : 0.12;
            ctx.fillStyle = peer.color || "#888";
            ctx.fillRect(PLAYER_X, gy, PLAYER_W, h);
            ctx.globalAlpha = 1;
        }

        // Self — only render if we're in a round (alive or dead).
        if (this.phase !== "waiting") {
            const h = this.currentPlayerH();
            ctx.fillStyle = this.alive ? this.net.me.color : "#999";
            ctx.globalAlpha = this.alive ? 1 : 0.5;
            ctx.fillRect(PLAYER_X, this.py, PLAYER_W, h);
            ctx.globalAlpha = 1;
            // Eye
            ctx.fillStyle = "#fff";
            ctx.fillRect(PLAYER_X + PLAYER_W - 8, this.py + 6, 4, 4);
            ctx.fillStyle = "#000";
            ctx.fillRect(PLAYER_X + PLAYER_W - 6, this.py + 7, 2, 2);
        }

        // Countdown overlay
        if (this.phase === "countdown") {
            const remain = Math.max(0, this.startAt - Date.now());
            const sec = Math.ceil(remain / 1000);
            const label = sec > 0 ? String(sec) : "GO!";
            ctx.fillStyle = "rgba(0,0,0,0.35)";
            ctx.fillRect(0, 0, WORLD_W, WORLD_H);
            ctx.fillStyle = "#fff";
            ctx.font = "bold 72px ui-sans-serif, system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, WORLD_W / 2, WORLD_H / 2);
            ctx.textAlign = "start";
            ctx.textBaseline = "alphabetic";
        }

        // "Waiting" overlay
        if (this.phase === "waiting") {
            ctx.fillStyle = "rgba(0,0,0,0.25)";
            ctx.fillRect(0, 0, WORLD_W, WORLD_H);
            ctx.fillStyle = "#fff";
            ctx.font = "bold 22px ui-sans-serif, system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("Waiting for round…", WORLD_W / 2, WORLD_H / 2);
            ctx.textAlign = "start";
        }
    }

    // ── Sidebar / leaderboard ─────────────────────────────────────────────
    private renderLeaderboard(): void {
        const ids = [this.net.me.id, ...this.net.peers.keys()];
        const unique = [...new Set(ids)];
        const rows = unique
            .map((id) => {
                const peer =
                    id === this.net.me.id
                        ? { name: this.net.me.name, color: this.net.me.color }
                        : this.net.peers.get(id);
                if (!peer) return null;
                const alive =
                    id === this.net.me.id
                        ? this.alive && this.phase === "running"
                        : this.aliveSet.has(id);
                return { id, name: peer.name, color: peer.color, alive };
            })
            .filter((r): r is { id: string; name: string; color: string; alive: boolean } => r !== null)
            .sort((a, b) => {
                if (a.alive !== b.alive) return a.alive ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

        this.leaderEl.innerHTML = rows
            .map((r, i) => {
                const mine = r.id === this.net.me.id ? " mine" : "";
                const status = r.alive
                    ? `<span class="flappy-live">alive</span>`
                    : `<span style="color: var(--muted);">out</span>`;
                return `
          <div class="flappy-leader-row${mine}">
            <span class="flappy-rank">${i + 1}</span>
            <span class="flappy-dot" style="background:${r.color}"></span>
            <span class="flappy-leader-name">${escapeHtml(r.name)}</span>
            <span class="flappy-leader-score">${status}</span>
          </div>
        `;
            })
            .join("");
    }

    // ── Broadcast ─────────────────────────────────────────────────────────
    private broadcastPos(force: boolean): void {
        if (!force && this.phase !== "running" && this.phase !== "spectating") return;
        if (this.roundId === 0) return;
        const yNorm = this.py / (GROUND_Y - PLAYER_H || 1);
        this.ns.send<PosMsg>("pos", {
            roundId: this.roundId,
            y: Math.max(0, Math.min(1, yNorm)),
            ducking: this.ducking && this.alive,
            alive: this.alive,
        });
    }

    private countdownLabel(now: number): string {
        const remain = Math.max(0, this.startAt - now);
        const sec = Math.ceil(remain / 1000);
        return sec > 0 ? `Round ${this.roundId} starts in ${sec}…` : "GO!";
    }

    private formatSeconds(s: number): string {
        return `${s.toFixed(1)}s`;
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
}
