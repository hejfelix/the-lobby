import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Chaos Breakout — everyone in the room shares one brick wall, but each
 * player gets their own paddle and can launch as many balls as they like.
 *
 * Authority model:
 *  - Host (lowest peer id) runs the ball / brick / power-up simulation and
 *    awards score to ball owners when bricks break.
 *  - Each peer broadcasts their paddle x position ~30Hz; everyone draws
 *    everyone else's paddle.
 *  - Host broadcasts a snapshot (balls + powerups + effects + wave) ~15Hz.
 *  - Brick breaks are sent as small deltas so the wall stays in sync without
 *    the full grid being in every snapshot.
 *  - On `sync-request` the host sends a full state dump so late joiners can
 *    catch up.
 *
 * Chaos comes from: unlimited concurrent balls, ball ownership swapping when
 * someone else's paddle hits your ball, paddle collisions push each other,
 * and a roster of disruptive power-ups (multiball, bomb, giant ball, fast,
 * slow, tiny paddles, scramble, refill).
 */

// ─────────── Field / physics constants ───────────
const FIELD_W = 1200;
const FIELD_H = 700;

const BRICK_COLS = 16;
const BRICK_ROWS = 8;
const BRICK_GAP = 4;
const BRICK_TOP = 50;
const BRICK_W = (FIELD_W - 40 - (BRICK_COLS - 1) * BRICK_GAP) / BRICK_COLS;
const BRICK_H = 26;
const BRICK_LEFT = 20;

const PADDLE_W = 110;
const PADDLE_H = 14;
const PADDLE_Y = 660;

const BALL_R = 9;
const BALL_BASE_SPEED = 460;
const BALL_MAX_SPEED = 1200;
const BALL_MIN_SPEED = 220;
const MAX_BALLS_PER_PLAYER = 12;
const BALL_TTL_MS = 60_000; // hard cap so abandoned balls don't accumulate

const POWERUP_DROP_CHANCE = 0.22;
const POWERUP_FALL_SPEED = 160;
const POWERUP_R = 14;
const POWERUP_TTL_MS = 12_000;

const SNAPSHOT_HZ = 15;
const PADDLE_BROADCAST_HZ = 30;

// ─────────── Types ───────────

type PowerKind = "multi" | "giant" | "fast" | "slow" | "scramble" | "refill" | "bomb" | "tiny";

const POWER_META: Record<PowerKind, { label: string; color: string; desc: string }> = {
    multi:    { label: "M", color: "#4caf50", desc: "+2 balls from your paddle" },
    giant:    { label: "G", color: "#ff9800", desc: "your next balls are giant" },
    fast:     { label: "F", color: "#e91e63", desc: "all balls speed up (6s)" },
    slow:     { label: "S", color: "#2196f3", desc: "all balls slow down (6s)" },
    scramble: { label: "C", color: "#9c27b0", desc: "scrambles every ball's direction" },
    refill:   { label: "R", color: "#00bcd4", desc: "refills the brick wall" },
    bomb:     { label: "B", color: "#f44336", desc: "your next brick hit explodes 3×3" },
    tiny:     { label: "T", color: "#795548", desc: "shrinks every paddle (6s)" },
};

const POWER_KINDS: PowerKind[] = Object.keys(POWER_META) as PowerKind[];

interface Ball {
    id: string;
    ownerId: string;
    color: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
    bomb: boolean;       // explosive next-hit
    bornAt: number;      // host-clock ms
}

interface Brick {
    alive: boolean;
    color: string;
    points: number;
    power: PowerKind | null;
}

interface PowerUp {
    id: string;
    kind: PowerKind;
    x: number;
    y: number;
    spawnedAt: number;
}

interface Effects {
    speedMul: number;      // 1.0 normal; <1 slow, >1 fast
    speedUntil: number;    // host-clock ms when effect ends
    tinyUntil: number;     // host-clock ms when paddles return to normal
}

// ─────────── Network messages ───────────

interface PaddleMsg { x: number; }
interface LaunchMsg { x: number; giant: boolean; bomb: boolean; }
interface SnapshotMsg {
    t: number;            // host clock
    wave: number;
    balls: Array<[string, string, string, number, number, number, number, number, number]>;
    // [id, ownerId, color, x, y, vx, vy, r, bombFlag]
    powerups: Array<[string, PowerKind, number, number]>;
    // [id, kind, x, y]
    fx: Effects;
}
interface BrickBreakMsg { i: number; ownerId: string; explosion: number[] | null; }
interface BrickRefillMsg { bricks: Array<[string, number, PowerKind | null]>; wave: number; }
interface FullStateMsg {
    wave: number;
    balls: SnapshotMsg["balls"];
    powerups: SnapshotMsg["powerups"];
    fx: Effects;
    bricks: Array<[string, number, PowerKind | null] | 0>; // 0 = dead
}
interface PowerSpawnMsg { id: string; kind: PowerKind; x: number; y: number; }
interface PowerGoneMsg { id: string; catcherId: string | null; }
interface FlashMsg { msg: string; color: string; }

// ─────────── Game entry ───────────

export const BreakoutGame: Game = {
    id: "breakout",
    name: "Chaos Breakout",
    description: "Everyone gets a paddle. Everyone gets to launch balls. Power-ups make it weird.",
    badge: "<em>up to whatever many players · host-authoritative</em>",
    create(container, net): GameInstance {
        const inst = new BreakoutInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

// ─────────── Implementation ───────────

class BreakoutInstance {
    private net: Net;
    private ns: GameNamespace;
    private container: HTMLElement;

    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private scoreboard!: HTMLDivElement;
    private waveEl!: HTMLDivElement;
    private effectsEl!: HTMLDivElement;
    private flashEl!: HTMLDivElement;

    // Local view of world state. On the host this is the source of truth.
    // On non-hosts this is interpolated from snapshots.
    private bricks: Brick[] = [];
    private balls: Map<string, Ball> = new Map();
    private powerups: Map<string, PowerUp> = new Map();
    private fx: Effects = { speedMul: 1, speedUntil: 0, tinyUntil: 0 };
    private wave = 1;

    // Paddles for every player (including self), keyed by peer id.
    private paddles: Map<string, { x: number; lastUpdate: number }> = new Map();

    // Per-player held buffs (only meaningful on the host, but tracked locally
    // so you can see your own queued bomb indicator in the UI).
    private playerBuffs: Map<string, { giant: boolean; bomb: boolean }> = new Map();

    private rafId = 0;
    private lastFrameMs = 0;
    private lastSnapshotSent = 0;
    private lastPaddleSent = 0;
    private resizeObs: ResizeObserver | null = null;
    private unsubPeers: (() => void) | null = null;
    private audio: AudioContext | null = null;

    private flashTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("breakout");

        container.innerHTML = `
      <div class="game-layout breakout-layout">
        <aside class="toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint">
              Move your paddle with the mouse / finger. <b>Click or tap</b> to
              launch a new ball. You can have lots of balls at once. Break
              bricks to score — points go to whoever last hit the ball.
            </p>
            <p class="hint">
              <b>Paddles bump each other</b>. The whole room shares one wall.
              Catch falling power-ups for chaos.
            </p>
          </div>
          <div class="tool-group">
            <label>Wave</label>
            <div class="breakout-wave"></div>
          </div>
          <div class="tool-group">
            <label>Effects</label>
            <div class="breakout-effects"></div>
          </div>
          <div class="tool-group">
            <label>Scoreboard</label>
            <div class="breakout-scoreboard"></div>
          </div>
          <div class="tool-group">
            <label>Power-ups</label>
            <div class="breakout-legend">
              ${POWER_KINDS.map((k) => `
                <div class="breakout-legend-row">
                  <span class="breakout-token" style="background:${POWER_META[k].color}">${POWER_META[k].label}</span>
                  <span>${POWER_META[k].desc}</span>
                </div>`).join("")}
            </div>
          </div>
        </aside>
        <section class="hoops-stage breakout-stage">
          <canvas class="hoops-canvas breakout-canvas"></canvas>
          <div class="breakout-flash"></div>
        </section>
      </div>
    `;

        this.canvas = container.querySelector<HTMLCanvasElement>(".breakout-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.scoreboard = container.querySelector<HTMLDivElement>(".breakout-scoreboard")!;
        this.waveEl = container.querySelector<HTMLDivElement>(".breakout-wave")!;
        this.effectsEl = container.querySelector<HTMLDivElement>(".breakout-effects")!;
        this.flashEl = container.querySelector<HTMLDivElement>(".breakout-flash")!;

        // Seed self paddle.
        this.paddles.set(this.net.me.id, { x: FIELD_W / 2, lastUpdate: performance.now() });
        this.playerBuffs.set(this.net.me.id, { giant: false, bomb: false });

        this.registerNetwork();
        this.attachInput();
        this.startResizeWatcher();
        this.renderScoreboard();

        this.unsubPeers = this.net.on("peers", () => {
            // Initialise paddles for any newly seen peers.
            for (const id of this.net.peers.keys()) {
                if (!this.paddles.has(id)) {
                    this.paddles.set(id, { x: FIELD_W / 2, lastUpdate: performance.now() });
                }
            }
            // Drop paddles for departed peers (keep self).
            const live = new Set<string>([this.net.me.id, ...this.net.peers.keys()]);
            for (const id of [...this.paddles.keys()]) {
                if (!live.has(id)) this.paddles.delete(id);
            }
            this.renderScoreboard();

            // If I just became the host (because the old host left) and the
            // bricks are still empty, seed a fresh wave so play continues.
            if (this.isHost() && this.bricks.length === 0) {
                this.initWave(this.wave);
                this.broadcastFullState();
            }
        });

        // Host election: whichever peer is host on mount sets up the wall.
        if (this.isHost()) {
            this.initWave(1);
        } else {
            // Ask the host for current state.
            this.ns.send("sync-request", {});
        }

        this.lastFrameMs = performance.now();
        this.loop();
    }

    destroy(): void {
        cancelAnimationFrame(this.rafId);
        this.resizeObs?.disconnect();
        this.unsubPeers?.();
        if (this.flashTimer) clearTimeout(this.flashTimer);
        this.audio?.close().catch(() => { /* ignore */ });
        this.ns.close();
        this.container.innerHTML = "";
    }

    // ────────────────── Host election ──────────────────

    private hostId(): string {
        const ids = [this.net.me.id, ...this.net.peers.keys()];
        return [...new Set(ids)].sort()[0];
    }
    private isHost(): boolean { return this.hostId() === this.net.me.id; }

    // ────────────────── Networking ──────────────────

    private registerNetwork(): void {
        this.ns.on<PaddleMsg>("paddle", (msg, peerId) => {
            if (!msg || typeof msg.x !== "number") return;
            const x = clamp(Number(msg.x), 0, FIELD_W);
            const p = this.paddles.get(peerId);
            if (p) {
                p.x = x;
                p.lastUpdate = performance.now();
            } else {
                this.paddles.set(peerId, { x, lastUpdate: performance.now() });
            }
        });

        this.ns.on<LaunchMsg>("launch", (msg, peerId) => {
            // Only the host actually spawns balls (single source of truth).
            if (!this.isHost() || !msg) return;
            this.spawnLaunchedBall(peerId, Number(msg.x) || FIELD_W / 2, !!msg.giant, !!msg.bomb);
        });

        this.ns.on<SnapshotMsg>("snap", (msg, peerId) => {
            if (this.isHost()) return; // ignore stray snapshots if we became host
            if (peerId !== this.hostId()) return; // only trust the host
            if (!msg) return;
            this.applySnapshot(msg);
        });

        this.ns.on<BrickBreakMsg>("brick", (msg, peerId) => {
            if (this.isHost()) return;
            if (peerId !== this.hostId()) return;
            if (!msg || typeof msg.i !== "number") return;
            this.applyBrickBreak(msg);
        });

        this.ns.on<BrickRefillMsg>("refill", (msg, peerId) => {
            if (this.isHost()) return;
            if (peerId !== this.hostId()) return;
            if (!msg) return;
            this.applyRefill(msg);
        });

        this.ns.on<PowerSpawnMsg>("pspawn", (msg, peerId) => {
            if (this.isHost()) return;
            if (peerId !== this.hostId()) return;
            if (!msg) return;
            this.powerups.set(msg.id, {
                id: msg.id, kind: msg.kind,
                x: Number(msg.x) || 0, y: Number(msg.y) || 0,
                spawnedAt: performance.now(),
            });
        });

        this.ns.on<PowerGoneMsg>("pgone", (msg, peerId) => {
            if (!msg) return;
            if (this.isHost() && peerId !== this.net.me.id) return;
            this.powerups.delete(msg.id);
        });

        this.ns.on<FlashMsg>("flash", (msg) => {
            if (!msg) return;
            this.flash(String(msg.msg ?? ""), String(msg.color ?? "#fff"));
        });

        this.ns.on<Record<string, never>>("sync-request", (_msg, peerId) => {
            if (!this.isHost()) return;
            this.ns.send("full", this.buildFullState(), peerId);
        });

        this.ns.on<FullStateMsg>("full", (msg, peerId) => {
            if (this.isHost()) return;
            if (peerId !== this.hostId()) return;
            if (!msg) return;
            this.applyFullState(msg);
        });
    }

    private buildFullState(): FullStateMsg {
        return {
            wave: this.wave,
            balls: [...this.balls.values()].map(serializeBall),
            powerups: [...this.powerups.values()].map((p) => [p.id, p.kind, p.x, p.y] as [string, PowerKind, number, number]),
            fx: { ...this.fx },
            bricks: this.bricks.map((b) => b.alive ? [b.color, b.points, b.power] as [string, number, PowerKind | null] : 0),
        };
    }

    private applyFullState(msg: FullStateMsg): void {
        this.wave = Math.max(1, Math.floor(Number(msg.wave) || 1));
        this.balls = new Map((msg.balls ?? []).map((b) => {
            const ball = deserializeBall(b);
            return [ball.id, ball];
        }));
        this.powerups = new Map((msg.powerups ?? []).map(([id, kind, x, y]) => {
            return [id, { id, kind, x: Number(x) || 0, y: Number(y) || 0, spawnedAt: performance.now() }];
        }));
        this.fx = sanitizeFx(msg.fx);
        this.bricks = new Array(BRICK_COLS * BRICK_ROWS).fill(null).map((_, i) => {
            const cell = msg.bricks?.[i];
            if (cell === 0 || !cell) return { alive: false, color: "#000", points: 0, power: null };
            const [color, points, power] = cell;
            return {
                alive: true,
                color: String(color || "#fff"),
                points: Number(points) || 0,
                power: power && (POWER_KINDS as string[]).includes(power) ? power : null,
            };
        });
    }

    private applySnapshot(msg: SnapshotMsg): void {
        this.wave = Math.max(1, Math.floor(Number(msg.wave) || 1));
        this.fx = sanitizeFx(msg.fx);
        const seen = new Set<string>();
        for (const b of msg.balls ?? []) {
            const ball = deserializeBall(b);
            seen.add(ball.id);
            this.balls.set(ball.id, ball);
        }
        for (const id of [...this.balls.keys()]) {
            if (!seen.has(id)) this.balls.delete(id);
        }
        const pSeen = new Set<string>();
        for (const [id, kind, x, y] of msg.powerups ?? []) {
            pSeen.add(id);
            const existing = this.powerups.get(id);
            if (existing) {
                existing.x = x; existing.y = y;
            } else {
                this.powerups.set(id, { id, kind, x, y, spawnedAt: performance.now() });
            }
        }
        for (const id of [...this.powerups.keys()]) {
            if (!pSeen.has(id)) this.powerups.delete(id);
        }
    }

    private applyBrickBreak(msg: BrickBreakMsg): void {
        const idxs = [msg.i, ...(msg.explosion ?? [])];
        for (const i of idxs) {
            const b = this.bricks[i];
            if (b && b.alive) b.alive = false;
        }
    }

    private applyRefill(msg: BrickRefillMsg): void {
        this.wave = Math.max(1, Math.floor(Number(msg.wave) || 1));
        this.bricks = new Array(BRICK_COLS * BRICK_ROWS).fill(null).map((_, i) => {
            const cell = msg.bricks?.[i];
            if (!cell) return { alive: false, color: "#000", points: 0, power: null };
            const [color, points, power] = cell;
            return {
                alive: true,
                color: String(color || "#fff"),
                points: Number(points) || 0,
                power: power && (POWER_KINDS as string[]).includes(power) ? power : null,
            };
        });
    }

    // ────────────────── Input ──────────────────

    private attachInput(): void {
        const onMove = (e: PointerEvent) => {
            const { x } = this.toField(e);
            const me = this.paddles.get(this.net.me.id);
            if (me) me.x = clamp(x, 0, FIELD_W);
        };
        const onDown = (e: PointerEvent) => {
            if (e.button !== undefined && e.button !== 0) return;
            this.ensureAudio();
            const { x } = this.toField(e);
            const me = this.paddles.get(this.net.me.id);
            if (me) me.x = clamp(x, 0, FIELD_W);
            this.requestLaunch();
        };
        this.canvas.addEventListener("pointermove", onMove);
        this.canvas.addEventListener("pointerdown", onDown);
        // Keyboard: space also launches.
        const onKey = (e: KeyboardEvent) => {
            if (e.key === " " || e.code === "Space") {
                e.preventDefault();
                this.ensureAudio();
                this.requestLaunch();
            }
        };
        window.addEventListener("keydown", onKey);
        this.resizeObs = new ResizeObserver(() => this.fitCanvas());
        this.resizeObs.observe(this.canvas);
        // Clean up keydown when game unmounts.
        const origDestroy = this.destroy.bind(this);
        this.destroy = () => { window.removeEventListener("keydown", onKey); origDestroy(); };
    }

    private requestLaunch(): void {
        const buffs = this.playerBuffs.get(this.net.me.id) ?? { giant: false, bomb: false };
        const me = this.paddles.get(this.net.me.id);
        const x = clamp(me?.x ?? FIELD_W / 2, 0, FIELD_W);
        if (this.isHost()) {
            this.spawnLaunchedBall(this.net.me.id, x, buffs.giant, buffs.bomb);
        } else {
            this.ns.send<LaunchMsg>("launch", { x, giant: buffs.giant, bomb: buffs.bomb });
            // Buffs are spent server-side; speculatively clear locally so UI updates.
            buffs.giant = false;
            buffs.bomb = false;
            this.playerBuffs.set(this.net.me.id, buffs);
        }
    }

    private toField(e: PointerEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        return { x: px * FIELD_W, y: py * FIELD_H };
    }

    private startResizeWatcher(): void {
        this.fitCanvas();
    }

    private fitCanvas(): void {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
    }

    // ────────────────── Loop ──────────────────

    private loop = (): void => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.lastFrameMs) / 1000);
        this.lastFrameMs = now;
        if (this.isHost()) {
            this.stepHost(dt, now);
        } else {
            this.stepClient(dt, now);
        }
        this.maybeBroadcastPaddle(now);
        this.draw();
        this.rafId = requestAnimationFrame(this.loop);
    };

    // ────────────────── Host simulation ──────────────────

    private initWave(wave: number): void {
        this.wave = wave;
        this.bricks = new Array(BRICK_COLS * BRICK_ROWS).fill(null).map((_, idx) => {
            const row = Math.floor(idx / BRICK_COLS);
            // Points scale with row (top rows = more points).
            const points = (BRICK_ROWS - row) * 5;
            const hue = (row * 37) % 360;
            const color = `hsl(${hue} 70% 55%)`;
            const power: PowerKind | null = Math.random() < POWERUP_DROP_CHANCE
                ? POWER_KINDS[Math.floor(Math.random() * POWER_KINDS.length)]
                : null;
            return { alive: true, color, points, power };
        });
    }

    private spawnLaunchedBall(ownerId: string, fromX: number, giant: boolean, bomb: boolean): void {
        // Cap balls per player to keep things tractable.
        let owned = 0;
        for (const b of this.balls.values()) if (b.ownerId === ownerId) owned++;
        if (owned >= MAX_BALLS_PER_PLAYER) return;
        const peer = this.net.peers.get(ownerId);
        const color = peer?.color ?? this.net.me.color ?? "#888";
        // Random-ish launch angle, biased upward.
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.9;
        const speed = BALL_BASE_SPEED * (giant ? 1.15 : 1);
        const r = giant ? BALL_R * 1.7 : BALL_R;
        const ball: Ball = {
            id: crypto.randomUUID(),
            ownerId,
            color,
            x: clamp(fromX, 20, FIELD_W - 20),
            y: PADDLE_Y - r - 4,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            r,
            bomb,
            bornAt: performance.now(),
        };
        this.balls.set(ball.id, ball);
        if (giant || bomb) {
            const buffs = this.playerBuffs.get(ownerId) ?? { giant: false, bomb: false };
            buffs.giant = false;
            buffs.bomb = false;
            this.playerBuffs.set(ownerId, buffs);
        }
    }

    private stepHost(dt: number, now: number): void {
        // Effects expire.
        if (now > this.fx.speedUntil) this.fx.speedMul = 1;

        const speedMul = this.fx.speedMul;
        const broken: BrickBreakMsg[] = [];

        // Step balls.
        for (const [id, ball] of [...this.balls.entries()]) {
            if (now - ball.bornAt > BALL_TTL_MS) { this.balls.delete(id); continue; }

            const mvx = ball.vx * speedMul;
            const mvy = ball.vy * speedMul;
            ball.x += mvx * dt;
            ball.y += mvy * dt;

            // Wall bounces.
            if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
            if (ball.x + ball.r > FIELD_W) { ball.x = FIELD_W - ball.r; ball.vx = -Math.abs(ball.vx); }
            if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); }

            // Fell off bottom — kill (and ding owner score a little).
            if (ball.y - ball.r > FIELD_H) {
                this.balls.delete(id);
                // Tiny penalty, but not below 0 logic — Net.awardScore handles raw deltas.
                if (this.net.peers.has(ball.ownerId)) {
                    this.net.awardScore(ball.ownerId, -1);
                }
                continue;
            }

            // Paddle collisions (any player's paddle).
            const tinyMul = (now < this.fx.tinyUntil) ? 0.55 : 1;
            const halfW = (PADDLE_W * tinyMul) / 2;
            for (const [pid, pad] of this.paddles) {
                if (ball.vy <= 0) break; // only when descending
                const py = PADDLE_Y;
                if (
                    ball.y + ball.r >= py &&
                    ball.y + ball.r <= py + PADDLE_H + 6 &&
                    ball.x >= pad.x - halfW - ball.r &&
                    ball.x <= pad.x + halfW + ball.r
                ) {
                    // English: hit position on paddle modulates new angle.
                    const offset = (ball.x - pad.x) / halfW; // -1 .. 1
                    const speed = clamp(Math.hypot(ball.vx, ball.vy), BALL_MIN_SPEED, BALL_MAX_SPEED);
                    const angle = -Math.PI / 2 + offset * (Math.PI / 3);
                    ball.vx = Math.cos(angle) * speed;
                    ball.vy = Math.sin(angle) * speed;
                    ball.y = py - ball.r - 0.5;
                    // Ownership swaps to whoever paddled it (if known peer).
                    if (this.net.peers.has(pid) || pid === this.net.me.id) {
                        ball.ownerId = pid;
                        const peer = pid === this.net.me.id
                            ? { color: this.net.me.color }
                            : this.net.peers.get(pid);
                        if (peer?.color) ball.color = peer.color;
                    }
                    break;
                }
            }

            // Brick collisions.
            const hit = this.hitBrick(ball);
            if (hit !== -1) {
                const brick = this.bricks[hit];
                brick.alive = false;
                let explosion: number[] | null = null;
                if (ball.bomb) {
                    ball.bomb = false;
                    explosion = [];
                    const row = Math.floor(hit / BRICK_COLS);
                    const col = hit % BRICK_COLS;
                    for (let dr = -1; dr <= 1; dr++) {
                        for (let dc = -1; dc <= 1; dc++) {
                            if (dr === 0 && dc === 0) continue;
                            const r2 = row + dr; const c2 = col + dc;
                            if (r2 < 0 || r2 >= BRICK_ROWS || c2 < 0 || c2 >= BRICK_COLS) continue;
                            const i2 = r2 * BRICK_COLS + c2;
                            const nb = this.bricks[i2];
                            if (nb?.alive) { nb.alive = false; explosion.push(i2); }
                        }
                    }
                }
                // Score: ball owner gets points for this brick + any explosion bricks.
                let total = brick.points;
                if (explosion) {
                    for (const i2 of explosion) total += this.bricks[i2] ? this.bricks[i2].points : 0;
                }
                if (this.net.peers.has(ball.ownerId) || ball.ownerId === this.net.me.id) {
                    this.net.awardScore(ball.ownerId, total);
                }
                // Drop power-up?
                const dropKind = brick.power
                    ?? (Math.random() < POWERUP_DROP_CHANCE / 2 ? POWER_KINDS[Math.floor(Math.random() * POWER_KINDS.length)] : null);
                if (dropKind) {
                    const pid = crypto.randomUUID();
                    const cell = brickRect(hit);
                    const pu: PowerUp = {
                        id: pid, kind: dropKind,
                        x: cell.x + cell.w / 2,
                        y: cell.y + cell.h / 2,
                        spawnedAt: now,
                    };
                    this.powerups.set(pid, pu);
                    this.ns.send<PowerSpawnMsg>("pspawn", { id: pid, kind: dropKind, x: pu.x, y: pu.y });
                }
                // Bounce direction: flip vy if hit was top/bottom, vx if side.
                bounceOffBrick(ball, hit);
                broken.push({ i: hit, ownerId: ball.ownerId, explosion });
            }
        }

        // Step power-ups (fall, expire, paddle catch).
        for (const [pid, pu] of [...this.powerups.entries()]) {
            pu.y += POWERUP_FALL_SPEED * dt;
            if (pu.y > FIELD_H + POWERUP_R || now - pu.spawnedAt > POWERUP_TTL_MS) {
                this.powerups.delete(pid);
                this.ns.send<PowerGoneMsg>("pgone", { id: pid, catcherId: null });
                continue;
            }
            // Check paddle catch.
            const tinyMul = (now < this.fx.tinyUntil) ? 0.55 : 1;
            const halfW = (PADDLE_W * tinyMul) / 2;
            for (const [paddleId, pad] of this.paddles) {
                if (
                    pu.y + POWERUP_R >= PADDLE_Y &&
                    pu.y - POWERUP_R <= PADDLE_Y + PADDLE_H &&
                    pu.x >= pad.x - halfW - POWERUP_R &&
                    pu.x <= pad.x + halfW + POWERUP_R
                ) {
                    this.powerups.delete(pid);
                    this.ns.send<PowerGoneMsg>("pgone", { id: pid, catcherId: paddleId });
                    this.applyPowerUp(paddleId, pu.kind, pad.x, now);
                    break;
                }
            }
        }

        // Paddle vs paddle collisions: push horizontally.
        const ids = [...this.paddles.keys()];
        const tinyMul = (now < this.fx.tinyUntil) ? 0.55 : 1;
        const w = PADDLE_W * tinyMul;
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = this.paddles.get(ids[i])!;
                const b = this.paddles.get(ids[j])!;
                const dx = b.x - a.x;
                const minDist = w;
                const overlap = minDist - Math.abs(dx);
                if (overlap > 0) {
                    const push = overlap / 2 * (dx >= 0 ? 1 : -1);
                    a.x = clamp(a.x - push, w / 2, FIELD_W - w / 2);
                    b.x = clamp(b.x + push, w / 2, FIELD_W - w / 2);
                }
            }
        }

        // Wave clear → next wave.
        if (this.bricks.length > 0 && this.bricks.every((b) => !b.alive)) {
            this.initWave(this.wave + 1);
            this.broadcastRefill();
            this.flash(`Wave ${this.wave}!`, "#ffd54f");
            this.ns.send<FlashMsg>("flash", { msg: `Wave ${this.wave}!`, color: "#ffd54f" });
        }

        // Send brick break deltas as we accumulated them.
        for (const b of broken) {
            this.ns.send<BrickBreakMsg>("brick", b);
        }

        // Throttled snapshot broadcast.
        if (now - this.lastSnapshotSent >= 1000 / SNAPSHOT_HZ) {
            this.lastSnapshotSent = now;
            this.broadcastSnapshot();
        }
    }

    private stepClient(_dt: number, now: number): void {
        // Predict balls between snapshots so motion is smooth.
        const dt = _dt;
        const mul = this.fx.speedMul ?? 1;
        for (const ball of this.balls.values()) {
            ball.x += ball.vx * mul * dt;
            ball.y += ball.vy * mul * dt;
        }
        for (const pu of this.powerups.values()) {
            pu.y += POWERUP_FALL_SPEED * dt;
        }
        void now;
    }

    private applyPowerUp(catcherId: string, kind: PowerKind, paddleX: number, now: number): void {
        const buffs = this.playerBuffs.get(catcherId) ?? { giant: false, bomb: false };
        const peerName = catcherId === this.net.me.id
            ? this.net.me.name
            : (this.net.peers.get(catcherId)?.name ?? "someone");
        const tagColor = POWER_META[kind].color;
        const announce = (text: string) => {
            this.flash(text, tagColor);
            this.ns.send<FlashMsg>("flash", { msg: text, color: tagColor });
        };
        switch (kind) {
            case "multi": {
                // Spawn 2 extra balls from this paddle, regardless of cap (small bypass).
                for (let i = 0; i < 2; i++) {
                    const peer = catcherId === this.net.me.id
                        ? { color: this.net.me.color }
                        : this.net.peers.get(catcherId);
                    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
                    const ball: Ball = {
                        id: crypto.randomUUID(),
                        ownerId: catcherId,
                        color: peer?.color ?? "#888",
                        x: clamp(paddleX, 20, FIELD_W - 20),
                        y: PADDLE_Y - BALL_R - 4,
                        vx: Math.cos(angle) * BALL_BASE_SPEED,
                        vy: Math.sin(angle) * BALL_BASE_SPEED,
                        r: BALL_R,
                        bomb: false,
                        bornAt: now,
                    };
                    this.balls.set(ball.id, ball);
                }
                announce(`${peerName}: MULTIBALL`);
                break;
            }
            case "giant":
                buffs.giant = true;
                announce(`${peerName}: GIANT`);
                break;
            case "bomb":
                buffs.bomb = true;
                announce(`${peerName}: BOMB armed`);
                break;
            case "fast":
                this.fx.speedMul = 1.6;
                this.fx.speedUntil = now + 6000;
                announce("FAST");
                break;
            case "slow":
                this.fx.speedMul = 0.55;
                this.fx.speedUntil = now + 6000;
                announce("SLOW-MO");
                break;
            case "scramble":
                for (const ball of this.balls.values()) {
                    const speed = clamp(Math.hypot(ball.vx, ball.vy), BALL_MIN_SPEED, BALL_MAX_SPEED);
                    const ang = Math.random() * Math.PI * 2;
                    ball.vx = Math.cos(ang) * speed;
                    ball.vy = Math.sin(ang) * speed;
                }
                announce("SCRAMBLE!");
                break;
            case "refill":
                this.initWave(this.wave);
                this.broadcastRefill();
                announce(`${peerName}: REFILL`);
                break;
            case "tiny":
                this.fx.tinyUntil = now + 6000;
                announce("TINY PADDLES");
                break;
        }
        this.playerBuffs.set(catcherId, buffs);
    }

    private broadcastSnapshot(): void {
        const msg: SnapshotMsg = {
            t: performance.now(),
            wave: this.wave,
            balls: [...this.balls.values()].map(serializeBall),
            powerups: [...this.powerups.values()].map((p) => [p.id, p.kind, p.x, p.y] as [string, PowerKind, number, number]),
            fx: { ...this.fx },
        };
        this.ns.send("snap", msg);
    }

    private broadcastRefill(): void {
        const msg: BrickRefillMsg = {
            wave: this.wave,
            bricks: this.bricks.map((b) => [b.color, b.points, b.power] as [string, number, PowerKind | null]),
        };
        this.ns.send("refill", msg);
    }

    private broadcastFullState(): void {
        this.ns.send("full", this.buildFullState());
    }

    private maybeBroadcastPaddle(now: number): void {
        if (now - this.lastPaddleSent < 1000 / PADDLE_BROADCAST_HZ) return;
        this.lastPaddleSent = now;
        const me = this.paddles.get(this.net.me.id);
        if (!me) return;
        this.ns.send<PaddleMsg>("paddle", { x: me.x });
    }

    private hitBrick(ball: Ball): number {
        // Quick AABB-circle check against grid (only test cells within range).
        const minCol = Math.max(0, Math.floor((ball.x - ball.r - BRICK_LEFT) / (BRICK_W + BRICK_GAP)) - 1);
        const maxCol = Math.min(BRICK_COLS - 1, Math.floor((ball.x + ball.r - BRICK_LEFT) / (BRICK_W + BRICK_GAP)) + 1);
        const minRow = Math.max(0, Math.floor((ball.y - ball.r - BRICK_TOP) / (BRICK_H + BRICK_GAP)) - 1);
        const maxRow = Math.min(BRICK_ROWS - 1, Math.floor((ball.y + ball.r - BRICK_TOP) / (BRICK_H + BRICK_GAP)) + 1);
        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const i = r * BRICK_COLS + c;
                if (!this.bricks[i]?.alive) continue;
                const rect = brickRect(i);
                if (circleIntersectsRect(ball.x, ball.y, ball.r, rect.x, rect.y, rect.w, rect.h)) {
                    return i;
                }
            }
        }
        return -1;
    }

    // ────────────────── Rendering ──────────────────

    private draw(): void {
        const ctx = this.ctx;
        const W = this.canvas.width;
        const H = this.canvas.height;
        ctx.save();
        ctx.scale(W / FIELD_W, H / FIELD_H);
        // background
        ctx.fillStyle = "#11141a";
        ctx.fillRect(0, 0, FIELD_W, FIELD_H);
        // top boundary stripe
        ctx.fillStyle = "#1c2230";
        ctx.fillRect(0, 0, FIELD_W, BRICK_TOP - 8);

        // bricks
        for (let i = 0; i < this.bricks.length; i++) {
            const b = this.bricks[i];
            if (!b.alive) continue;
            const rect = brickRect(i);
            ctx.fillStyle = b.color;
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
            // subtle highlight
            ctx.fillStyle = "rgba(255,255,255,0.18)";
            ctx.fillRect(rect.x, rect.y, rect.w, 4);
            if (b.power) {
                ctx.fillStyle = "rgba(0,0,0,0.55)";
                ctx.font = "bold 14px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(POWER_META[b.power].label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
            }
        }

        // powerups
        for (const pu of this.powerups.values()) {
            ctx.beginPath();
            ctx.arc(pu.x, pu.y, POWERUP_R, 0, Math.PI * 2);
            ctx.fillStyle = POWER_META[pu.kind].color;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "rgba(0,0,0,0.4)";
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 14px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(POWER_META[pu.kind].label, pu.x, pu.y + 1);
        }

        // paddles
        const now = performance.now();
        const tinyMul = (now < this.fx.tinyUntil) ? 0.55 : 1;
        const pw = PADDLE_W * tinyMul;
        for (const [id, pad] of this.paddles) {
            const peer = id === this.net.me.id
                ? { color: this.net.me.color, name: this.net.me.name + " (you)" }
                : this.net.peers.get(id);
            if (!peer) continue;
            ctx.fillStyle = peer.color;
            const px = pad.x - pw / 2;
            ctx.fillRect(px, PADDLE_Y, pw, PADDLE_H);
            ctx.fillStyle = "rgba(255,255,255,0.25)";
            ctx.fillRect(px, PADDLE_Y, pw, 3);
            // Name above paddle
            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(peer.name, pad.x, PADDLE_Y - 4);
        }

        // balls
        for (const ball of this.balls.values()) {
            ctx.beginPath();
            ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
            ctx.fillStyle = ball.color;
            ctx.fill();
            if (ball.bomb) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = "#fff";
                ctx.stroke();
            }
        }

        // host indicator
        ctx.fillStyle = this.isHost() ? "#7ed957" : "#888";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(this.isHost() ? "host" : "client", FIELD_W - 8, 14);

        ctx.restore();
        this.renderEffects();
        this.renderWave();
    }

    private renderWave(): void {
        this.waveEl.textContent = `Wave ${this.wave} · ${this.bricks.filter((b) => b.alive).length} bricks left`;
    }

    private renderEffects(): void {
        const now = performance.now();
        const parts: string[] = [];
        if (now < this.fx.speedUntil) {
            const remain = Math.ceil((this.fx.speedUntil - now) / 1000);
            parts.push(this.fx.speedMul > 1 ? `FAST ${remain}s` : `SLOW ${remain}s`);
        }
        if (now < this.fx.tinyUntil) {
            const remain = Math.ceil((this.fx.tinyUntil - now) / 1000);
            parts.push(`TINY ${remain}s`);
        }
        const buffs = this.playerBuffs.get(this.net.me.id);
        if (buffs?.giant) parts.push("YOU: GIANT next ball");
        if (buffs?.bomb) parts.push("YOU: BOMB armed");
        this.effectsEl.innerHTML = parts.length
            ? parts.map((p) => `<div class="breakout-effect-tag">${p}</div>`).join("")
            : `<span class="hint">(none)</span>`;
    }

    private renderScoreboard = (): void => {
        const rows: string[] = [];
        const me = this.net.peers.get(this.net.me.id);
        const all = [
            { id: this.net.me.id, name: this.net.me.name + " (you)", color: this.net.me.color, score: me?.score ?? 0 },
            ...[...this.net.peers.entries()].filter(([id]) => id !== this.net.me.id).map(([id, p]) => ({
                id, name: p.name, color: p.color, score: p.score,
            })),
        ].sort((a, b) => b.score - a.score);
        for (const p of all) {
            rows.push(`
              <div class="hoops-row">
                <div class="hoops-row-head">
                  <span class="hoops-dot" style="background:${p.color}"></span>
                  <span>${escapeHtml(p.name)}</span>
                  <span class="hoops-score">${p.score}</span>
                </div>
              </div>
            `);
        }
        this.scoreboard.innerHTML = rows.join("");
    };

    private ensureAudio(): AudioContext | null {
        if (this.audio) return this.audio;
        try {
            const Ctor = window.AudioContext
                ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return null;
            this.audio = new Ctor();
            return this.audio;
        } catch { return null; }
    }

    private flash(text: string, color: string): void {
        this.flashEl.textContent = text;
        this.flashEl.style.color = color;
        this.flashEl.classList.add("breakout-flash-on");
        if (this.flashTimer) clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => {
            this.flashEl.classList.remove("breakout-flash-on");
        }, 900);
    }
}

// ────────────────── Helpers ──────────────────

function brickRect(idx: number): { x: number; y: number; w: number; h: number } {
    const row = Math.floor(idx / BRICK_COLS);
    const col = idx % BRICK_COLS;
    return {
        x: BRICK_LEFT + col * (BRICK_W + BRICK_GAP),
        y: BRICK_TOP + row * (BRICK_H + BRICK_GAP),
        w: BRICK_W,
        h: BRICK_H,
    };
}

function circleIntersectsRect(cx: number, cy: number, r: number, rx: number, ry: number, rw: number, rh: number): boolean {
    const nx = clamp(cx, rx, rx + rw);
    const ny = clamp(cy, ry, ry + rh);
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy <= r * r;
}

function bounceOffBrick(ball: Ball, idx: number): void {
    const rect = brickRect(idx);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const dx = ball.x - cx;
    const dy = ball.y - cy;
    // Compare which axis penetrated less; flip that velocity component.
    const overlapX = rect.w / 2 + ball.r - Math.abs(dx);
    const overlapY = rect.h / 2 + ball.r - Math.abs(dy);
    if (overlapX < overlapY) {
        ball.vx = dx >= 0 ? Math.abs(ball.vx) : -Math.abs(ball.vx);
        ball.x += dx >= 0 ? overlapX : -overlapX;
    } else {
        ball.vy = dy >= 0 ? Math.abs(ball.vy) : -Math.abs(ball.vy);
        ball.y += dy >= 0 ? overlapY : -overlapY;
    }
    // Keep speed sane.
    const speed = clamp(Math.hypot(ball.vx, ball.vy), BALL_MIN_SPEED, BALL_MAX_SPEED);
    const ang = Math.atan2(ball.vy, ball.vx);
    ball.vx = Math.cos(ang) * speed;
    ball.vy = Math.sin(ang) * speed;
}

function serializeBall(b: Ball): SnapshotMsg["balls"][number] {
    return [b.id, b.ownerId, b.color, round2(b.x), round2(b.y), round2(b.vx), round2(b.vy), b.r, b.bomb ? 1 : 0];
}

function deserializeBall(arr: SnapshotMsg["balls"][number]): Ball {
    const [id, ownerId, color, x, y, vx, vy, r, bomb] = arr;
    return {
        id: String(id),
        ownerId: String(ownerId),
        color: String(color || "#888"),
        x: Number(x) || 0,
        y: Number(y) || 0,
        vx: Number(vx) || 0,
        vy: Number(vy) || 0,
        r: Number(r) || BALL_R,
        bomb: !!bomb,
        bornAt: performance.now(),
    };
}

function sanitizeFx(fx: unknown): Effects {
    const f = (fx ?? {}) as Partial<Effects>;
    return {
        speedMul: typeof f.speedMul === "number" ? f.speedMul : 1,
        speedUntil: typeof f.speedUntil === "number" ? f.speedUntil : 0,
        tinyUntil: typeof f.tinyUntil === "number" ? f.tinyUntil : 0,
    };
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
