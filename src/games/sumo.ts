import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Sumo Brawl — top-down arena where everyone tries to shove everyone else
 * off a circular ring. WASD/arrows to move, Space to dash.
 *
 * Authority model: each peer is authoritative for its own position and its
 * own death. When you fall off, you broadcast a "kill" message naming the
 * peer that most recently shoved you (within 2s) and award them score via
 * `Net.awardScore`. Other peers only need to receive your position updates
 * and the kill notification.
 */

const FIELD_W = 1200;
const FIELD_H = 700;
const ARENA_CX = 600;
const ARENA_CY = 350;
const ARENA_R = 310;

const PLAYER_R = 28;
const ACCEL = 1600;          // px/s^2
const MAX_SPEED = 340;
const FRICTION_PER_SEC = 2.4; // exponential decay constant
const DASH_SPEED = 980;
const DASH_DURATION_MS = 200;
const DASH_COOLDOWN_MS = 1400;
const KILL_CREDIT_MS = 2000;
const KILL_SCORE = 10;
const RESPAWN_DELAY_MS = 3000;
const BROADCAST_HZ = 20;

// ─── Types ───────────────────────────────────────────────────────────

interface PlayerState {
    x: number;
    y: number;
    vx: number;
    vy: number;
    dashing: boolean;
    alive: boolean;
    respawnAt: number;
    color: string;
    /** Local-only: who last shoved me, and when. */
    lastPushedBy?: string;
    lastPushedAt?: number;
}

interface PosMsg {
    x: number; y: number; vx: number; vy: number;
    dashing: boolean; alive: boolean;
}
interface KillMsg { victim: string; killer: string | null; }

// ─── Game entry ──────────────────────────────────────────────────────

export const SumoGame: Game = {
    id: "sumo",
    name: "Sumo Brawl",
    description: "WASD to move, Space to dash. Shove rivals off the ring. Falling = 3s respawn.",
    badge: "<em>action chaos · any number of players</em>",
    create(container, net): GameInstance {
        const inst = new SumoInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

class SumoInstance {
    private net: Net;
    private ns: GameNamespace;
    private container: HTMLElement;

    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private scoreboard!: HTMLDivElement;
    private cooldownFill!: HTMLDivElement;

    private states: Map<string, PlayerState> = new Map();
    private keys: Set<string> = new Set();

    private rafId = 0;
    private lastFrameMs = 0;
    private lastBroadcast = 0;
    private dashEndAt = 0;
    private dashReadyAt = 0;

    private unsubPeers: (() => void) | null = null;
    private resizeObs: ResizeObserver | null = null;
    private audio: AudioContext | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("sumo");

        container.innerHTML = `
      <div class="game-layout sumo-layout">
        <aside class="toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint"><b>WASD</b> or arrow keys to move. <b>Space</b> to dash. Knock everyone else off the ring.</p>
            <p class="hint">+${KILL_SCORE} per shove-off. If you fall, you sit out for ${RESPAWN_DELAY_MS / 1000}s.</p>
          </div>
          <div class="tool-group">
            <label>Dash cooldown</label>
            <div class="sumo-cooldown"><div class="sumo-cooldown-fill"></div></div>
          </div>
          <div class="tool-group">
            <label>Scoreboard</label>
            <div class="sumo-scoreboard"></div>
          </div>
        </aside>
        <section class="hoops-stage sumo-stage">
          <canvas class="hoops-canvas sumo-canvas"></canvas>
        </section>
      </div>
    `;

        this.canvas = container.querySelector<HTMLCanvasElement>(".sumo-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.scoreboard = container.querySelector<HTMLDivElement>(".sumo-scoreboard")!;
        this.cooldownFill = container.querySelector<HTMLDivElement>(".sumo-cooldown-fill")!;

        this.spawnSelf();
        this.registerNetwork();
        this.attachInput();
        this.fitCanvas();
        this.resizeObs = new ResizeObserver(() => this.fitCanvas());
        this.resizeObs.observe(this.canvas);

        this.unsubPeers = this.net.on("peers", this.renderScoreboard);
        this.renderScoreboard();

        // Late-join: ask everyone for their current position.
        this.ns.send("sync-request", {});

        this.lastFrameMs = performance.now();
        this.loop();
    }

    destroy(): void {
        cancelAnimationFrame(this.rafId);
        this.resizeObs?.disconnect();
        this.unsubPeers?.();
        this.audio?.close().catch(() => { /* ignore */ });
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        this.ns.close();
        this.container.innerHTML = "";
    }

    private spawnSelf(): void {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * (ARENA_R * 0.6);
        this.states.set(this.net.me.id, {
            x: ARENA_CX + Math.cos(ang) * r,
            y: ARENA_CY + Math.sin(ang) * r,
            vx: 0, vy: 0,
            dashing: false, alive: true,
            respawnAt: 0,
            color: this.net.me.color,
        });
    }

    // ─── Networking ──────────────────────────────────────────────────

    private registerNetwork(): void {
        this.ns.on<PosMsg>("pos", (msg, peerId) => {
            if (!msg) return;
            let s = this.states.get(peerId);
            if (!s) {
                s = {
                    x: Number(msg.x) || 0, y: Number(msg.y) || 0,
                    vx: 0, vy: 0,
                    dashing: false, alive: true, respawnAt: 0,
                    color: this.net.peers.get(peerId)?.color ?? "#888",
                };
                this.states.set(peerId, s);
            }
            s.x = Number(msg.x) || 0;
            s.y = Number(msg.y) || 0;
            s.vx = Number(msg.vx) || 0;
            s.vy = Number(msg.vy) || 0;
            s.dashing = !!msg.dashing;
            s.alive = !!msg.alive;
            s.color = this.net.peers.get(peerId)?.color ?? s.color;
        });

        this.ns.on<KillMsg>("kill", (msg) => {
            if (!msg) return;
            const victim = this.states.get(msg.victim);
            if (victim) {
                victim.alive = false;
                victim.respawnAt = performance.now() + RESPAWN_DELAY_MS;
            }
            this.playThump();
            if (msg.killer) {
                const k = this.net.peers.get(msg.killer);
                const v = this.net.peers.get(msg.victim);
                const kn = k?.name ?? (msg.killer === this.net.me.id ? this.net.me.name : "someone");
                const vn = v?.name ?? (msg.victim === this.net.me.id ? this.net.me.name : "someone");
                this.net.pushSystem(`${kn} shoved ${vn} off the ring.`);
            }
        });

        this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
            const me = this.states.get(this.net.me.id);
            if (me) {
                this.ns.send<PosMsg>(
                    "pos",
                    { x: me.x, y: me.y, vx: me.vx, vy: me.vy, dashing: me.dashing, alive: me.alive },
                    peerId,
                );
            }
        });
    }

    // ─── Input ───────────────────────────────────────────────────────

    private onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === " " || e.code === "Space") {
            e.preventDefault();
            this.ensureAudio();
            this.tryDash();
            return;
        }
        const k = e.key.toLowerCase();
        if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
            e.preventDefault();
            this.keys.add(k);
        }
    };
    private onKeyUp = (e: KeyboardEvent): void => {
        this.keys.delete(e.key.toLowerCase());
    };

    private attachInput(): void {
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        // Click-to-focus and unlock audio.
        this.canvas.addEventListener("pointerdown", () => {
            this.ensureAudio();
            this.canvas.focus();
        });
        this.canvas.tabIndex = 0;
    }

    private tryDash(): void {
        const now = performance.now();
        if (now < this.dashReadyAt) return;
        const me = this.states.get(this.net.me.id);
        if (!me || !me.alive) return;

        let dx = 0, dy = 0;
        if (this.keys.has("w") || this.keys.has("arrowup")) dy -= 1;
        if (this.keys.has("s") || this.keys.has("arrowdown")) dy += 1;
        if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
        if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
        if (dx === 0 && dy === 0) {
            const sp = Math.hypot(me.vx, me.vy);
            if (sp < 1) { dx = 1; dy = 0; }
            else { dx = me.vx / sp; dy = me.vy / sp; }
        } else {
            const len = Math.hypot(dx, dy);
            dx /= len; dy /= len;
        }
        me.vx = dx * DASH_SPEED;
        me.vy = dy * DASH_SPEED;
        me.dashing = true;
        this.dashEndAt = now + DASH_DURATION_MS;
        this.dashReadyAt = now + DASH_COOLDOWN_MS;
        this.playWhoosh();
    }

    // ─── Sim loop ────────────────────────────────────────────────────

    private loop = (): void => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.lastFrameMs) / 1000);
        this.lastFrameMs = now;
        this.step(dt, now);
        this.draw(now);
        this.rafId = requestAnimationFrame(this.loop);
    };

    private step(dt: number, now: number): void {
        const me = this.states.get(this.net.me.id);
        if (!me) return;

        // Respawn.
        if (!me.alive && now >= me.respawnAt) {
            const ang = Math.random() * Math.PI * 2;
            const r = Math.random() * (ARENA_R * 0.5);
            me.x = ARENA_CX + Math.cos(ang) * r;
            me.y = ARENA_CY + Math.sin(ang) * r;
            me.vx = 0; me.vy = 0; me.alive = true;
            me.lastPushedBy = undefined;
        }

        if (me.dashing && now > this.dashEndAt) me.dashing = false;

        // Controls (suspended while dashing).
        if (me.alive && !me.dashing) {
            let dx = 0, dy = 0;
            if (this.keys.has("w") || this.keys.has("arrowup")) dy -= 1;
            if (this.keys.has("s") || this.keys.has("arrowdown")) dy += 1;
            if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
            if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
            if (dx !== 0 || dy !== 0) {
                const len = Math.hypot(dx, dy);
                me.vx += (dx / len) * ACCEL * dt;
                me.vy += (dy / len) * ACCEL * dt;
            }
            me.vx *= Math.exp(-FRICTION_PER_SEC * dt);
            me.vy *= Math.exp(-FRICTION_PER_SEC * dt);
            const sp = Math.hypot(me.vx, me.vy);
            if (sp > MAX_SPEED) {
                me.vx = me.vx / sp * MAX_SPEED;
                me.vy = me.vy / sp * MAX_SPEED;
            }
        }

        // Integrate everyone (extrapolate remotes between snapshots).
        for (const [id, s] of this.states) {
            if (!s.alive) continue;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            if (id !== this.net.me.id) {
                // Mild friction so old velocities don't fly off if updates are sparse.
                s.vx *= Math.exp(-FRICTION_PER_SEC * dt * 0.5);
                s.vy *= Math.exp(-FRICTION_PER_SEC * dt * 0.5);
            }
        }

        // Local collisions: resolve self vs every other player.
        if (me.alive) {
            for (const [id, other] of this.states) {
                if (id === this.net.me.id || !other.alive) continue;
                const dx = me.x - other.x;
                const dy = me.y - other.y;
                const dist = Math.hypot(dx, dy);
                const minD = PLAYER_R * 2;
                if (dist < minD && dist > 0.001) {
                    const nx = dx / dist;
                    const ny = dy / dist;
                    const overlap = minD - dist;
                    me.x += nx * overlap * 0.5;
                    me.y += ny * overlap * 0.5;
                    // Bounce (elastic-ish along normal).
                    const rel = (me.vx - other.vx) * nx + (me.vy - other.vy) * ny;
                    if (rel < 0) {
                        const j = -1.7 * rel;
                        me.vx += j * nx;
                        me.vy += j * ny;
                    }
                    const otherSp = Math.hypot(other.vx, other.vy);
                    const meSp = Math.hypot(me.vx, me.vy);
                    if (other.dashing || otherSp > meSp * 1.05) {
                        me.lastPushedBy = id;
                        me.lastPushedAt = now;
                    }
                }
            }

            // Out-of-ring check.
            const dxc = me.x - ARENA_CX;
            const dyc = me.y - ARENA_CY;
            const dc = Math.hypot(dxc, dyc);
            if (dc > ARENA_R + PLAYER_R * 0.5) {
                me.alive = false;
                me.respawnAt = now + RESPAWN_DELAY_MS;
                const killer = me.lastPushedAt && (now - me.lastPushedAt) < KILL_CREDIT_MS
                    ? me.lastPushedBy ?? null
                    : null;
                this.ns.send<KillMsg>("kill", { victim: this.net.me.id, killer });
                if (killer && killer !== this.net.me.id && this.net.peers.has(killer)) {
                    this.net.awardScore(killer, KILL_SCORE);
                }
                this.playThump();
            }
        }

        // Broadcast our state.
        if (now - this.lastBroadcast >= 1000 / BROADCAST_HZ) {
            this.lastBroadcast = now;
            this.ns.send<PosMsg>("pos", {
                x: me.x, y: me.y, vx: me.vx, vy: me.vy,
                dashing: me.dashing, alive: me.alive,
            });
        }
    }

    // ─── Rendering ───────────────────────────────────────────────────

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
        const W = this.canvas.width;
        const H = this.canvas.height;
        ctx.save();
        ctx.scale(W / FIELD_W, H / FIELD_H);

        // Floor.
        ctx.fillStyle = "#1a1d24";
        ctx.fillRect(0, 0, FIELD_W, FIELD_H);

        // Arena ring (sand).
        ctx.beginPath();
        ctx.arc(ARENA_CX, ARENA_CY, ARENA_R, 0, Math.PI * 2);
        ctx.fillStyle = "#d8b487";
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = "#8a6740";
        ctx.stroke();
        // Inner concentric lines for visual depth.
        for (let r = ARENA_R - 40; r > 40; r -= 60) {
            ctx.beginPath();
            ctx.arc(ARENA_CX, ARENA_CY, r, 0, Math.PI * 2);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(138, 103, 64, 0.25)";
            ctx.stroke();
        }

        // Players.
        for (const [id, s] of this.states) {
            const peer = id === this.net.me.id
                ? { name: this.net.me.name + " (you)", color: this.net.me.color }
                : this.net.peers.get(id);
            if (!peer) continue;
            const isMe = id === this.net.me.id;
            if (!s.alive) {
                // Ghost respawn indicator.
                const remain = Math.max(0, (s.respawnAt - now) / 1000);
                ctx.globalAlpha = 0.35;
                ctx.beginPath();
                ctx.arc(s.x, s.y, PLAYER_R, 0, Math.PI * 2);
                ctx.fillStyle = peer.color;
                ctx.fill();
                ctx.globalAlpha = 1;
                if (isMe) {
                    ctx.fillStyle = "#fff";
                    ctx.font = "bold 18px sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText(`Respawn ${remain.toFixed(1)}s`, FIELD_W / 2, 30);
                }
                continue;
            }
            // Dash flame tail.
            if (s.dashing) {
                const sp = Math.hypot(s.vx, s.vy);
                if (sp > 1) {
                    const tx = s.x - s.vx / sp * (PLAYER_R + 18);
                    const ty = s.y - s.vy / sp * (PLAYER_R + 18);
                    const grd = ctx.createLinearGradient(s.x, s.y, tx, ty);
                    grd.addColorStop(0, peer.color);
                    grd.addColorStop(1, "rgba(255,255,255,0)");
                    ctx.fillStyle = grd;
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, PLAYER_R + 6, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            // Body.
            ctx.beginPath();
            ctx.arc(s.x, s.y, PLAYER_R, 0, Math.PI * 2);
            ctx.fillStyle = peer.color;
            ctx.fill();
            ctx.lineWidth = isMe ? 3 : 2;
            ctx.strokeStyle = isMe ? "#fff" : "rgba(0,0,0,0.4)";
            ctx.stroke();
            // Velocity arrow.
            const sp = Math.hypot(s.vx, s.vy);
            if (sp > 30) {
                ctx.lineWidth = 3;
                ctx.strokeStyle = "rgba(255,255,255,0.7)";
                ctx.beginPath();
                ctx.moveTo(s.x, s.y);
                ctx.lineTo(s.x + s.vx / sp * (PLAYER_R - 4), s.y + s.vy / sp * (PLAYER_R - 4));
                ctx.stroke();
            }
            // Name tag.
            ctx.fillStyle = "rgba(255,255,255,0.85)";
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(peer.name, s.x, s.y - PLAYER_R - 6);
        }

        ctx.restore();

        // Cooldown bar.
        const ready = now >= this.dashReadyAt;
        const pct = ready ? 1 : 1 - (this.dashReadyAt - now) / DASH_COOLDOWN_MS;
        this.cooldownFill.style.width = `${Math.round(pct * 100)}%`;
        this.cooldownFill.style.background = ready ? "#7ed957" : "#e0a040";
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

    // ─── Audio ───────────────────────────────────────────────────────

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

    private playThump(): void {
        const ctx = this.ensureAudio();
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
        const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(180, t0);
        osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.25);
        gain.gain.setValueAtTime(0.4, t0);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.3);
    }

    private playWhoosh(): void {
        const ctx = this.ensureAudio();
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
        const t0 = ctx.currentTime;
        const len = Math.floor(ctx.sampleRate * 0.18);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(600, t0);
        filter.frequency.exponentialRampToValueAtTime(1800, t0 + 0.18);
        filter.Q.value = 2;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        src.connect(filter).connect(g).connect(ctx.destination);
        src.start(t0);
        src.stop(t0 + 0.22);
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
