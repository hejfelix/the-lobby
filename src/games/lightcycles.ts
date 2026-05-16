import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Lightcycles — Tron-style trail racer. Every player rides a bike that
 * always moves forward. WASD/arrows turn instantly to absolute directions.
 * Crashing into any trail (yours or anyone else's) or the wall = dead.
 * Last cycle standing wins the round.
 *
 * Authority model:
 *  - Each peer owns their own bike: position, direction, alive flag.
 *  - Trails are reconstructed from a list of "turn points" sent on each
 *    turn (and rebroadcast in periodic snapshots for late joiners).
 *  - Each peer detects their own crashes locally and broadcasts a "dead"
 *    event. The host (lowest peer id) orchestrates round endings and
 *    awards score (+5 per surviving opponent + 5 survival bonus per kill
 *    in the trail — simplified to: +SURVIVE_SCORE for being last alive).
 */

const FIELD_W = 1200;
const FIELD_H = 700;
const ARENA_PAD = 16;
const SPEED = 230;            // px/s, constant
const TURN_THROTTLE_MS = 80;  // anti-spam between turns
const HEAD_SAFE_DIST = 6;     // skip the last few px of own trail for self-collision
const POS_BROADCAST_HZ = 8;   // low-rate position correction (turns are authoritative)
const SURVIVE_SCORE = 20;
const KILL_BONUS = 5;
const ROUND_RESTART_DELAY_MS = 3500;

// ─── Types ───────────────────────────────────────────────────────────

type Dir = 0 | 1 | 2 | 3; // right, down, left, up

interface TurnPoint { x: number; y: number; dir: Dir; t: number; }

interface BikeState {
    color: string;
    /** Ordered turn points; first = spawn, last = current heading start. */
    trail: TurnPoint[];
    /** Current head position (derived from last turn + elapsed time). */
    x: number;
    y: number;
    dir: Dir;
    alive: boolean;
    /** Whose trail/wall killed me (local death cause). */
    killer?: string | null;
}

interface TurnMsg { x: number; y: number; dir: Dir; t: number; round: number; }
interface PosMsg { x: number; y: number; dir: Dir; alive: boolean; round: number; }
interface DeadMsg { killer: string | null; round: number; }
interface RoundMsg { round: number; spawns: Array<{ id: string; x: number; y: number; dir: Dir; }>; }
interface FullStateMsg {
    round: number;
    bikes: Array<{ id: string; alive: boolean; trail: TurnPoint[]; x: number; y: number; dir: Dir; }>;
    roundStartedAt: number;
}

// ─── Game entry ──────────────────────────────────────────────────────

export const LightcyclesGame: Game = {
    id: "lightcycles",
    name: "Lightcycles",
    description: "Tron-style trail racing. WASD or arrows to turn. Don't crash. Last cycle wins the round.",
    badge: "<em>action chaos · 60-second rounds</em>",
    create(container, net): GameInstance {
        const inst = new LightcyclesInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

// ─── Implementation ─────────────────────────────────────────────────

class LightcyclesInstance {
    private net: Net;
    private ns: GameNamespace;
    private container: HTMLElement;

    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private scoreboard!: HTMLDivElement;
    private statusEl!: HTMLDivElement;

    private bikes: Map<string, BikeState> = new Map();
    private round = 1;
    private roundStartedAt = 0;
    /** When > 0, schedule a fresh round at this time. */
    private nextRoundAt = 0;
    private lastTurnAt = 0;
    private lastPosBroadcast = 0;
    private rafId = 0;
    private lastFrameMs = 0;

    private unsubPeers: (() => void) | null = null;
    private resizeObs: ResizeObserver | null = null;
    private audio: AudioContext | null = null;
    private deadAnnounced = false;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("lightcycles");

        container.innerHTML = `
      <div class="game-layout lc-layout">
        <aside class="toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint"><b>WASD</b> or arrow keys turn your bike. You can't stop, can't reverse.</p>
            <p class="hint">Hit any trail or the wall and you crash. Last cycle alive gets <b>+${SURVIVE_SCORE}</b> per kill in the round.</p>
          </div>
          <div class="tool-group">
            <label>Round</label>
            <div class="lc-status"></div>
          </div>
          <div class="tool-group">
            <label>Scoreboard</label>
            <div class="lc-scoreboard"></div>
          </div>
        </aside>
        <section class="hoops-stage lc-stage">
          <canvas class="hoops-canvas lc-canvas"></canvas>
        </section>
      </div>
    `;
        this.canvas = container.querySelector<HTMLCanvasElement>(".lc-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.scoreboard = container.querySelector<HTMLDivElement>(".lc-scoreboard")!;
        this.statusEl = container.querySelector<HTMLDivElement>(".lc-status")!;

        this.registerNetwork();
        this.attachInput();
        this.fitCanvas();
        this.resizeObs = new ResizeObserver(() => this.fitCanvas());
        this.resizeObs.observe(this.canvas);

        this.unsubPeers = this.net.on("peers", () => {
            this.renderScoreboard();
            // If a peer left and the round can now end, host will detect on next tick.
        });
        this.renderScoreboard();

        // Host starts the first round; clients ask for current state.
        if (this.isHost()) {
            this.startRound(1);
        } else {
            this.ns.send("sync-request", {});
        }

        this.lastFrameMs = performance.now();
        this.loop();
    }

    destroy(): void {
        cancelAnimationFrame(this.rafId);
        this.resizeObs?.disconnect();
        this.unsubPeers?.();
        this.audio?.close().catch(() => { /* ignore */ });
        window.removeEventListener("keydown", this.onKeyDown);
        this.ns.close();
        this.container.innerHTML = "";
    }

    // ─── Host election ──────────────────────────────────────────────

    private hostId(): string {
        return [...new Set([this.net.me.id, ...this.net.peers.keys()])].sort()[0];
    }
    private isHost(): boolean { return this.hostId() === this.net.me.id; }

    // ─── Network ────────────────────────────────────────────────────

    private registerNetwork(): void {
        this.ns.on<TurnMsg>("turn", (msg, peerId) => {
            if (!msg || msg.round !== this.round) return;
            const bike = this.bikes.get(peerId);
            if (!bike || !bike.alive) return;
            const dir = sanitizeDir(msg.dir);
            // Reject 180° reversals.
            if (isOpposite(bike.dir, dir)) return;
            const tp: TurnPoint = {
                x: Number(msg.x) || bike.x,
                y: Number(msg.y) || bike.y,
                dir,
                t: Number(msg.t) || performance.now(),
            };
            bike.trail.push(tp);
            bike.x = tp.x;
            bike.y = tp.y;
            bike.dir = dir;
        });

        this.ns.on<PosMsg>("pos", (msg, peerId) => {
            if (!msg || msg.round !== this.round) return;
            const bike = this.bikes.get(peerId);
            if (!bike) return;
            // Soft correction: snap head if drift is large.
            const ex = Number(msg.x) || bike.x;
            const ey = Number(msg.y) || bike.y;
            const drift = Math.hypot(ex - bike.x, ey - bike.y);
            if (drift > 30) { bike.x = ex; bike.y = ey; }
            bike.alive = !!msg.alive;
            bike.dir = sanitizeDir(msg.dir);
        });

        this.ns.on<DeadMsg>("dead", (msg, peerId) => {
            if (!msg || msg.round !== this.round) return;
            const bike = this.bikes.get(peerId);
            if (!bike) return;
            bike.alive = false;
            this.playCrash();
            const k = msg.killer;
            if (k) {
                const kn = k === this.net.me.id ? this.net.me.name : this.net.peers.get(k)?.name;
                const vn = peerId === this.net.me.id ? this.net.me.name : this.net.peers.get(peerId)?.name;
                this.net.pushSystem(`${vn ?? "someone"} crashed into ${kn ?? "a wall"}.`);
                if (this.isHost() && k !== peerId && (this.net.peers.has(k) || k === this.net.me.id)) {
                    this.net.awardScore(k, KILL_BONUS);
                }
            }
            // Host: maybe end the round.
            if (this.isHost()) this.maybeEndRound();
        });

        this.ns.on<RoundMsg>("round", (msg, peerId) => {
            if (peerId !== this.hostId()) return;
            if (!msg) return;
            this.applyRound(msg);
        });

        this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
            if (!this.isHost()) return;
            const full: FullStateMsg = {
                round: this.round,
                roundStartedAt: this.roundStartedAt,
                bikes: [...this.bikes.entries()].map(([id, b]) => ({
                    id, alive: b.alive, trail: b.trail, x: b.x, y: b.y, dir: b.dir,
                })),
            };
            this.ns.send("full", full, peerId);
        });

        this.ns.on<FullStateMsg>("full", (msg, peerId) => {
            if (peerId !== this.hostId() || !msg) return;
            this.round = Math.max(1, Math.floor(Number(msg.round) || 1));
            this.roundStartedAt = Number(msg.roundStartedAt) || performance.now();
            this.bikes.clear();
            for (const b of msg.bikes ?? []) {
                this.bikes.set(b.id, {
                    color: this.colorFor(b.id),
                    trail: (b.trail ?? []).map((tp) => ({
                        x: Number(tp.x) || 0,
                        y: Number(tp.y) || 0,
                        dir: sanitizeDir(tp.dir),
                        t: Number(tp.t) || 0,
                    })),
                    x: Number(b.x) || 0,
                    y: Number(b.y) || 0,
                    dir: sanitizeDir(b.dir),
                    alive: !!b.alive,
                });
            }
            // Make sure I exist (if I joined just now and host hasn't spawned me).
            if (!this.bikes.has(this.net.me.id) && this.isHost()) {
                // unreachable; host shouldn't take this branch.
            }
            this.deadAnnounced = false;
        });
    }

    private applyRound(msg: RoundMsg): void {
        this.round = Math.max(1, Math.floor(Number(msg.round) || 1));
        this.roundStartedAt = performance.now();
        this.nextRoundAt = 0;
        this.deadAnnounced = false;
        this.bikes.clear();
        for (const sp of msg.spawns) {
            const dir = sanitizeDir(sp.dir);
            this.bikes.set(sp.id, {
                color: this.colorFor(sp.id),
                trail: [{ x: sp.x, y: sp.y, dir, t: this.roundStartedAt }],
                x: sp.x, y: sp.y, dir, alive: true,
            });
        }
    }

    // ─── Input ──────────────────────────────────────────────────────

    private onKeyDown = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        let dir: Dir | null = null;
        if (k === "w" || k === "arrowup") dir = 3;
        else if (k === "s" || k === "arrowdown") dir = 1;
        else if (k === "a" || k === "arrowleft") dir = 2;
        else if (k === "d" || k === "arrowright") dir = 0;
        if (dir === null) return;
        e.preventDefault();
        this.ensureAudio();
        this.tryTurn(dir);
    };

    private attachInput(): void {
        window.addEventListener("keydown", this.onKeyDown);
        this.canvas.tabIndex = 0;
        this.canvas.addEventListener("pointerdown", () => {
            this.ensureAudio();
            this.canvas.focus();
        });
    }

    private tryTurn(dir: Dir): void {
        const now = performance.now();
        if (now - this.lastTurnAt < TURN_THROTTLE_MS) return;
        const me = this.bikes.get(this.net.me.id);
        if (!me || !me.alive) return;
        if (me.dir === dir || isOpposite(me.dir, dir)) return;
        this.lastTurnAt = now;
        const tp: TurnPoint = { x: me.x, y: me.y, dir, t: now };
        me.trail.push(tp);
        me.dir = dir;
        this.ns.send<TurnMsg>("turn", { x: tp.x, y: tp.y, dir, t: now, round: this.round });
    }

    // ─── Sim loop ───────────────────────────────────────────────────

    private loop = (): void => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.lastFrameMs) / 1000);
        this.lastFrameMs = now;
        this.step(dt, now);
        this.draw(now);
        this.rafId = requestAnimationFrame(this.loop);
    };

    private step(dt: number, now: number): void {
        // Host schedules next round.
        if (this.isHost() && this.nextRoundAt > 0 && now >= this.nextRoundAt) {
            this.startRound(this.round + 1);
        }

        for (const bike of this.bikes.values()) {
            if (!bike.alive) continue;
            switch (bike.dir) {
                case 0: bike.x += SPEED * dt; break;
                case 1: bike.y += SPEED * dt; break;
                case 2: bike.x -= SPEED * dt; break;
                case 3: bike.y -= SPEED * dt; break;
            }
        }

        // Local crash detection for my bike.
        const me = this.bikes.get(this.net.me.id);
        if (me && me.alive && !this.deadAnnounced) {
            // Wall.
            if (me.x < ARENA_PAD || me.x > FIELD_W - ARENA_PAD || me.y < ARENA_PAD || me.y > FIELD_H - ARENA_PAD) {
                this.declareDead(null);
            } else {
                const killer = this.findTrailCollision(me);
                if (killer !== undefined) this.declareDead(killer);
            }
        }

        // Periodic position correction (in case remote bikes drift after long straightaways).
        if (now - this.lastPosBroadcast >= 1000 / POS_BROADCAST_HZ) {
            this.lastPosBroadcast = now;
            const meBike = this.bikes.get(this.net.me.id);
            if (meBike) {
                this.ns.send<PosMsg>("pos", {
                    x: meBike.x, y: meBike.y, dir: meBike.dir,
                    alive: meBike.alive, round: this.round,
                });
            }
        }
    }

    private declareDead(killerId: string | null): void {
        const me = this.bikes.get(this.net.me.id);
        if (!me) return;
        me.alive = false;
        this.deadAnnounced = true;
        this.playCrash();
        this.ns.send<DeadMsg>("dead", { killer: killerId, round: this.round });
        if (killerId && killerId !== this.net.me.id && this.net.peers.has(killerId)) {
            // Score awarded by host on their machine. Don't double-award.
        }
        // Trystero doesn't echo messages back to the sender, so the host's
        // "dead" handler never fires for the host's own death. Run the
        // round-end check locally so solo play (and host self-crashes)
        // still schedule the next round.
        if (this.isHost()) this.maybeEndRound();
    }

    /**
     * Returns the id of whoever's trail my head just crossed, or null for
     * walls, or undefined if no collision. Used to attribute kills.
     */
    private findTrailCollision(me: BikeState): string | null | undefined {
        for (const [id, bike] of this.bikes) {
            const isSelf = id === this.net.me.id;
            const segs = bike.trail;
            const headIdx = segs.length - 1;
            for (let i = 0; i < segs.length; i++) {
                const a = segs[i];
                // End of this segment: either the next turn point or, for the
                // last segment, the bike's current head position.
                const b = i + 1 < segs.length ? segs[i + 1] : { x: bike.x, y: bike.y };
                // Skip the part of my own trail immediately behind my head.
                if (isSelf && i === headIdx) {
                    // The active segment is the line from `a` to my own head.
                    // Trim its end so I don't insta-die on my own bike.
                    const trimmed = trimSegmentEnd(a, b, HEAD_SAFE_DIST);
                    if (!trimmed) continue;
                    if (pointHitsSegment(me.x, me.y, a, trimmed, 2)) return id;
                    continue;
                }
                // Just-turned: the segment leading INTO the latest turn point
                // ends exactly where the head currently is, which would trigger
                // a false self-collision on the very next frame. Trim its end
                // for the same reason as the active segment above.
                if (isSelf && i === headIdx - 1) {
                    const trimmed = trimSegmentEnd(a, b, HEAD_SAFE_DIST);
                    if (!trimmed) continue;
                    if (pointHitsSegment(me.x, me.y, a, trimmed, 2)) return id;
                    continue;
                }
                if (pointHitsSegment(me.x, me.y, a, b, 2)) return id;
            }
        }
        return undefined;
    }

    // ─── Host: round lifecycle ──────────────────────────────────────

    private maybeEndRound(): void {
        const alive = [...this.bikes.values()].filter((b) => b.alive);
        const total = this.bikes.size;
        // Need >=2 players for a "winner"; with 1 player keep playing solo.
        if (total >= 2 && alive.length <= 1) {
            if (alive.length === 1) {
                const winnerId = [...this.bikes.entries()].find(([, b]) => b.alive)?.[0];
                if (winnerId && (this.net.peers.has(winnerId) || winnerId === this.net.me.id)) {
                    this.net.awardScore(winnerId, SURVIVE_SCORE);
                    const wn = winnerId === this.net.me.id ? this.net.me.name : this.net.peers.get(winnerId)?.name;
                    this.net.pushSystem(`${wn ?? "?"} wins round ${this.round}! +${SURVIVE_SCORE}`);
                }
            } else {
                this.net.pushSystem(`Round ${this.round} ended in mutual destruction.`);
            }
            this.nextRoundAt = performance.now() + ROUND_RESTART_DELAY_MS;
        } else if (total < 2 && alive.length === 0) {
            // Solo crash → just respawn soon.
            this.nextRoundAt = performance.now() + ROUND_RESTART_DELAY_MS;
        }
    }

    private startRound(round: number): void {
        this.round = round;
        this.roundStartedAt = performance.now();
        this.nextRoundAt = 0;
        this.deadAnnounced = false;
        const ids = [...new Set([this.net.me.id, ...this.net.peers.keys()])];
        const spawns: RoundMsg["spawns"] = ids.map((id, i) => {
            // Spread spawns around the arena, all facing inward.
            const angles = ids.length;
            const ang = (i / Math.max(1, angles)) * Math.PI * 2;
            const cx = FIELD_W / 2;
            const cy = FIELD_H / 2;
            const rx = Math.cos(ang) * 350;
            const ry = Math.sin(ang) * 200;
            const sx = cx + rx;
            const sy = cy + ry;
            // Face toward center: pick the dominant inward axis.
            let dir: Dir;
            if (Math.abs(rx) > Math.abs(ry)) dir = rx > 0 ? 2 : 0;
            else dir = ry > 0 ? 3 : 1;
            return { id, x: sx, y: sy, dir };
        });
        this.applyRound({ round, spawns });
        this.ns.send<RoundMsg>("round", { round, spawns });
    }

    private colorFor(id: string): string {
        if (id === this.net.me.id) return this.net.me.color;
        return this.net.peers.get(id)?.color ?? "#888";
    }

    // ─── Rendering ──────────────────────────────────────────────────

    private fitCanvas(): void {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
    }

    private draw(now: number): void {
        const ctx = this.ctx;
        ctx.save();
        ctx.scale(this.canvas.width / FIELD_W, this.canvas.height / FIELD_H);

        // Background grid.
        ctx.fillStyle = "#080d18";
        ctx.fillRect(0, 0, FIELD_W, FIELD_H);
        ctx.strokeStyle = "rgba(50, 110, 180, 0.15)";
        ctx.lineWidth = 1;
        for (let x = 0; x <= FIELD_W; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, FIELD_H); ctx.stroke();
        }
        for (let y = 0; y <= FIELD_H; y += 40) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(FIELD_W, y); ctx.stroke();
        }

        // Arena border.
        ctx.strokeStyle = "#2a8cff";
        ctx.lineWidth = 3;
        ctx.strokeRect(ARENA_PAD, ARENA_PAD, FIELD_W - ARENA_PAD * 2, FIELD_H - ARENA_PAD * 2);

        // Trails.
        for (const bike of this.bikes.values()) {
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.lineWidth = 3;
            ctx.strokeStyle = bike.color;
            ctx.shadowColor = bike.color;
            ctx.shadowBlur = 8;
            ctx.beginPath();
            const segs = bike.trail;
            if (segs.length > 0) {
                ctx.moveTo(segs[0].x, segs[0].y);
                for (let i = 1; i < segs.length; i++) ctx.lineTo(segs[i].x, segs[i].y);
                ctx.lineTo(bike.x, bike.y);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;
        }

        // Bikes.
        for (const [id, bike] of this.bikes) {
            const peer = id === this.net.me.id
                ? { name: this.net.me.name + " (you)", color: this.net.me.color }
                : this.net.peers.get(id);
            if (!peer) continue;
            ctx.save();
            ctx.translate(bike.x, bike.y);
            ctx.rotate(dirToRad(bike.dir));
            ctx.fillStyle = bike.alive ? peer.color : "rgba(80,80,80,0.7)";
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(10, 0);
            ctx.lineTo(-6, 5);
            ctx.lineTo(-6, -5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
            // Name above.
            ctx.fillStyle = "rgba(255,255,255,0.85)";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(peer.name, bike.x, bike.y - 12);
        }

        ctx.restore();

        // Status line.
        const me = this.bikes.get(this.net.me.id);
        const alive = [...this.bikes.values()].filter((b) => b.alive).length;
        let status = `Round ${this.round} · ${alive} alive`;
        if (this.nextRoundAt > 0) {
            const remain = Math.max(0, Math.ceil((this.nextRoundAt - now) / 1000));
            status += ` · next round in ${remain}s`;
        } else if (me && !me.alive) {
            status += " · YOU CRASHED";
        }
        this.statusEl.textContent = status;
    }

    private renderScoreboard = (): void => {
        const me = this.net.peers.get(this.net.me.id);
        const all = [
            { id: this.net.me.id, name: this.net.me.name + " (you)", color: this.net.me.color, score: me?.score ?? 0 },
            ...[...this.net.peers.entries()].filter(([id]) => id !== this.net.me.id).map(([id, p]) => ({
                id, name: p.name, color: p.color, score: p.score,
            })),
        ].sort((a, b) => b.score - a.score);
        this.scoreboard.innerHTML = all.map((p) => `
            <div class="hoops-row">
              <div class="hoops-row-head">
                <span class="hoops-dot" style="background:${p.color}"></span>
                <span>${escapeHtml(p.name)}</span>
                <span class="hoops-score">${p.score}</span>
              </div>
            </div>
        `).join("");
    };

    // ─── Audio ──────────────────────────────────────────────────────

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

    private playCrash(): void {
        const ctx = this.ensureAudio();
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
        const t0 = ctx.currentTime;
        const len = Math.floor(ctx.sampleRate * 0.4);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(2000, t0);
        filter.frequency.exponentialRampToValueAtTime(200, t0 + 0.4);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.4, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
        src.connect(filter).connect(g).connect(ctx.destination);
        src.start(t0);
        src.stop(t0 + 0.42);
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function sanitizeDir(d: unknown): Dir {
    const n = Number(d);
    if (n === 0 || n === 1 || n === 2 || n === 3) return n as Dir;
    return 0;
}

function isOpposite(a: Dir, b: Dir): boolean {
    return (a + 2) % 4 === b;
}

function dirToRad(d: Dir): number {
    return (d * Math.PI) / 2;
}

function pointHitsSegment(
    px: number, py: number,
    a: { x: number; y: number }, b: { x: number; y: number },
    tol: number,
): boolean {
    // Axis-aligned trails only — quick AABB hit test.
    const minX = Math.min(a.x, b.x) - tol;
    const maxX = Math.max(a.x, b.x) + tol;
    const minY = Math.min(a.y, b.y) - tol;
    const maxY = Math.max(a.y, b.y) + tol;
    return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/** Trim the last `dist` px off segment a→b. Returns the new end point, or null if segment too short. */
function trimSegmentEnd(
    a: { x: number; y: number },
    b: { x: number; y: number },
    dist: number,
): { x: number; y: number } | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= dist) return null;
    const k = (len - dist) / len;
    return { x: a.x + dx * k, y: a.y + dy * k };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
