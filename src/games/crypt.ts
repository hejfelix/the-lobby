import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Crypt Crawlers — Vampire-Survivors-style co-op auto-shooter.
 *
 * Everyone fights together in a shared arena against waves of enemies for a
 * fixed-length round. Weapons auto-fire at the nearest enemy. Kills drop XP
 * gems; collecting gems levels you up; each level lets you pick one of three
 * random upgrades. Round ends when the timer expires (everyone wins) or
 * when all players are downed (shared loss). State resets between rounds —
 * meta-progression is intentionally absent so the lobby stays drop-in.
 *
 * Authority model: fully host-authoritative. The peer with the lowest id
 * runs the entire simulation (player movement, enemies, projectiles, XP,
 * damage, level-ups) and broadcasts ~10Hz snapshots. Other peers send
 * only their input vector and locally predict their own position so the
 * controls feel responsive. Late joiners get a snapshot via "sync-request".
 * If the host disconnects the next-lowest peer takes over; one snapshot
 * cycle of jitter is expected.
 */

// ─── Tuning ─────────────────────────────────────────────────────────

const FIELD_W = 1600;
const FIELD_H = 900;
const ARENA_PAD = 24;

const ROUND_SECONDS = 240;
const SNAPSHOT_HZ = 12;
const INPUT_HZ = 20;
const RESTART_DELAY_MS = 5000;

const PLAYER_RADIUS = 14;
const PLAYER_BASE_SPEED = 200;
const PLAYER_BASE_HP = 100;
const PLAYER_TOUCH_DMG_PER_S = 18;
const PLAYER_IFRAMES_MS = 250;
const GEM_MAGNET_BASE = 60;
const GEM_VALUE = 1;

const ENEMY_RADIUS = 13;
const ENEMY_SPEED = 70;
const ENEMY_HP = 8;
const ENEMY_SPAWN_BASE_S = 1.2;
const ENEMY_SPAWN_MIN_S = 0.18;
const ENEMY_RAMP_PER_SEC = 0.0055; // spawn cadence decreases over the round.
const ENEMY_CAP = 110;

const PROJECTILE_RADIUS = 5;
const PROJECTILE_SPEED = 460;
const PROJECTILE_LIFETIME_S = 1.6;
const WEAPON_BASE_DMG = 5;
const WEAPON_BASE_COOLDOWN_S = 0.95;
const WEAPON_BASE_RANGE = 520;

const KILL_SCORE = 1;
const SURVIVAL_SCORE = 25; // awarded at round end to everyone still alive.

// ─── Upgrade catalogue ──────────────────────────────────────────────

type UpgradeId =
    | "dmg"
    | "rate"
    | "multi"
    | "hp"
    | "speed"
    | "magnet"
    | "range";

interface UpgradeDef {
    id: UpgradeId;
    name: string;
    desc: string;
    maxLevel: number;
}

const UPGRADES: Record<UpgradeId, UpgradeDef> = {
    dmg: { id: "dmg", name: "Sharpened Sigils", desc: "+25% projectile damage.", maxLevel: 6 },
    rate: { id: "rate", name: "Quicker Hands", desc: "−15% weapon cooldown.", maxLevel: 6 },
    multi: { id: "multi", name: "Extra Shot", desc: "+1 projectile per volley.", maxLevel: 4 },
    hp: { id: "hp", name: "Vital Ward", desc: "+25 max HP and full heal.", maxLevel: 4 },
    speed: { id: "speed", name: "Soft Boots", desc: "+10% move speed.", maxLevel: 4 },
    magnet: { id: "magnet", name: "Gem Magnet", desc: "+60 px pickup radius.", maxLevel: 4 },
    range: { id: "range", name: "Long Sight", desc: "+25% weapon range.", maxLevel: 4 },
};

const ALL_UPGRADE_IDS = Object.keys(UPGRADES) as UpgradeId[];

// ─── State types ────────────────────────────────────────────────────

interface PlayerLoadout {
    dmg: number;
    rate: number;
    multi: number;
    hp: number;
    speed: number;
    magnet: number;
    range: number;
}

interface PlayerState {
    id: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    xp: number;
    level: number;
    loadout: PlayerLoadout;
    /** Pending choice id awaiting their pick. Null = no menu open. */
    pendingChoiceId: string | null;
    /** Last damage time (host clock) for iframes. */
    lastHurtAt: number;
    /** Next weapon-fire time (host clock). */
    nextFireAt: number;
    /** Last seen input vector (already normalised). */
    inputDx: number;
    inputDy: number;
    /** Last time we got fresh input from this peer (host clock). */
    lastInputAt: number;
}

interface EnemyState {
    id: number;
    x: number;
    y: number;
    hp: number;
}

interface GemState {
    id: number;
    x: number;
    y: number;
    value: number;
}

interface ProjectileState {
    id: number;
    ownerId: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    dmg: number;
    lifeLeft: number;
}

type RoundStatus = "play" | "win" | "loss";

// ─── Wire types ─────────────────────────────────────────────────────

interface InputMsg {
    dx: number;
    dy: number;
    round: number;
    t: number;
}

interface SnapPlayer {
    id: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    xp: number;
    level: number;
    nextLevelXp: number;
    loadout: PlayerLoadout;
}

interface SnapEnemy { id: number; x: number; y: number; hp: number; }
interface SnapGem { id: number; x: number; y: number; }
interface SnapProjectile { id: number; x: number; y: number; ownerId: string; }

interface SnapMsg {
    round: number;
    status: RoundStatus;
    timeLeft: number;
    t: number;
    players: SnapPlayer[];
    enemies: SnapEnemy[];
    gems: SnapGem[];
    projectiles: SnapProjectile[];
}

interface LevelUpMsg {
    choiceId: string;
    level: number;
    choices: UpgradeId[];
    round: number;
}

interface PickMsg {
    choiceId: string;
    upgrade: UpgradeId;
    round: number;
}

interface RoundEventMsg {
    round: number;
    status: RoundStatus;
    nextRoundAt: number;
}

interface ChatEventMsg {
    text: string;
}

// ─── Game registration ──────────────────────────────────────────────

export const CryptCrawlersGame: Game = {
    id: "crypt",
    name: "Crypt Crawlers",
    description:
        "Co-op roguelike auto-shooter. Move; weapons fire on their own. Collect gems to level up, pick upgrades, survive 4 minutes.",
    badge: "<em>co-op vs. horde · 4-minute runs</em>",
    create(container, net): GameInstance {
        const inst = new CryptInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

// ─── Implementation ─────────────────────────────────────────────────

class CryptInstance {
    private net: Net;
    private ns: GameNamespace;
    private container: HTMLElement;

    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private statusEl!: HTMLDivElement;
    private rosterEl!: HTMLDivElement;
    private overlayEl!: HTMLDivElement;

    private resizeObs: ResizeObserver | null = null;
    private unsubPeers: (() => void) | null = null;
    private rafId = 0;
    private lastFrameMs = 0;
    private lastInputSentAt = 0;
    private lastSnapAt = 0;
    private audio: AudioContext | null = null;

    // Local input (own player).
    private keysDown = new Set<string>();

    // Round / world.
    private round = 1;
    private status: RoundStatus = "play";
    private timeLeft = ROUND_SECONDS;
    private nextRoundAt = 0;

    private players: Map<string, PlayerState> = new Map();
    private enemies: Map<number, EnemyState> = new Map();
    private gems: Map<number, GemState> = new Map();
    private projectiles: Map<number, ProjectileState> = new Map();

    // Host bookkeeping.
    private nextEntityId = 1;
    private enemySpawnAccum = 0;
    private elapsedInRound = 0;
    private pendingChoices = new Map<string, { peerId: string; choices: UpgradeId[]; level: number }>();

    // Client-side: my latest unsent input.
    private myInputDx = 0;
    private myInputDy = 0;

    // Client-side: my open level-up choice.
    private myChoice: { choiceId: string; choices: UpgradeId[]; level: number } | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("crypt");

        container.innerHTML = `
      <div class="game-layout crypt-layout">
        <aside class="toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint"><b>WASD</b> or arrow keys to move. Weapons auto-fire at the closest enemy.</p>
            <p class="hint">Pick up gems for XP. Level up to choose an upgrade. Survive 4 minutes together.</p>
          </div>
          <div class="tool-group">
            <label>Round</label>
            <div class="crypt-status"></div>
          </div>
          <div class="tool-group">
            <label>Party</label>
            <div class="crypt-roster"></div>
          </div>
        </aside>
        <section class="hoops-stage crypt-stage">
          <canvas class="hoops-canvas crypt-canvas"></canvas>
          <div class="crypt-overlay"></div>
        </section>
      </div>
    `;
        this.canvas = container.querySelector<HTMLCanvasElement>(".crypt-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.statusEl = container.querySelector<HTMLDivElement>(".crypt-status")!;
        this.rosterEl = container.querySelector<HTMLDivElement>(".crypt-roster")!;
        this.overlayEl = container.querySelector<HTMLDivElement>(".crypt-overlay")!;

        this.registerNetwork();
        this.attachInput();
        this.fitCanvas();
        this.resizeObs = new ResizeObserver(() => this.fitCanvas());
        this.resizeObs.observe(this.canvas);

        this.unsubPeers = this.net.on("peers", () => this.renderRoster());
        this.renderRoster();

        if (this.isHost()) {
            this.hostStartRound(1);
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
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        this.audio?.close().catch(() => { /* ignore */ });
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
        this.ns.on<InputMsg>("input", (msg, peerId) => {
            if (!this.isHost() || !msg) return;
            if (msg.round !== this.round) return;
            const p = this.players.get(peerId);
            if (!p) return;
            const dx = clamp(Number(msg.dx) || 0, -1, 1);
            const dy = clamp(Number(msg.dy) || 0, -1, 1);
            const mag = Math.hypot(dx, dy);
            if (mag > 1) { p.inputDx = dx / mag; p.inputDy = dy / mag; }
            else { p.inputDx = dx; p.inputDy = dy; }
            p.lastInputAt = performance.now();
        });

        this.ns.on<SnapMsg>("snap", (msg, peerId) => {
            if (peerId !== this.hostId() || !msg) return;
            this.applySnap(msg);
        });

        this.ns.on<RoundEventMsg>("round", (msg, peerId) => {
            if (peerId !== this.hostId() || !msg) return;
            this.round = Math.max(1, Math.floor(Number(msg.round) || 1));
            this.status = msg.status;
            this.nextRoundAt = Number(msg.nextRoundAt) || 0;
            // Close any open level-up dialog if a new round begins.
            if (msg.status === "play") {
                this.myChoice = null;
                this.renderOverlay();
            }
        });

        this.ns.on<LevelUpMsg>("levelup", (msg, peerId) => {
            if (peerId !== this.hostId() || !msg) return;
            if (msg.round !== this.round) return;
            this.myChoice = { choiceId: msg.choiceId, choices: msg.choices, level: msg.level };
            this.renderOverlay();
            this.playLevelUp();
        });

        this.ns.on<PickMsg>("pick", (msg, peerId) => {
            if (!this.isHost() || !msg) return;
            const pending = this.pendingChoices.get(msg.choiceId);
            if (!pending || pending.peerId !== peerId) return;
            if (!pending.choices.includes(msg.upgrade)) return;
            const p = this.players.get(peerId);
            if (!p) return;
            this.applyUpgrade(p, msg.upgrade);
            this.pendingChoices.delete(msg.choiceId);
            p.pendingChoiceId = null;
        });

        this.ns.on<ChatEventMsg>("event", (msg, peerId) => {
            if (peerId !== this.hostId() || !msg) return;
            if (typeof msg.text === "string" && msg.text.length > 0) {
                this.net.pushSystem(msg.text);
            }
        });

        this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
            if (!this.isHost()) return;
            this.hostEnsurePlayer(peerId);
            this.broadcastSnap(true, peerId);
        });
    }

    // ─── Input ──────────────────────────────────────────────────────

    private onKeyDown = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        if (this.myChoice && (k === "1" || k === "2" || k === "3")) {
            const idx = Number(k) - 1;
            const choice = this.myChoice.choices[idx];
            if (choice) this.submitPick(choice);
            e.preventDefault();
            return;
        }
        if (this.isMoveKey(k)) {
            this.keysDown.add(k);
            this.ensureAudio();
            this.updateMyInput();
            e.preventDefault();
        }
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        if (this.isMoveKey(k)) {
            this.keysDown.delete(k);
            this.updateMyInput();
            e.preventDefault();
        }
    };

    private isMoveKey(k: string): boolean {
        return k === "w" || k === "a" || k === "s" || k === "d"
            || k === "arrowup" || k === "arrowdown" || k === "arrowleft" || k === "arrowright";
    }

    private attachInput(): void {
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        this.canvas.tabIndex = 0;
        this.canvas.addEventListener("pointerdown", () => {
            this.ensureAudio();
            this.canvas.focus();
        });
    }

    private updateMyInput(): void {
        let dx = 0, dy = 0;
        if (this.keysDown.has("a") || this.keysDown.has("arrowleft")) dx -= 1;
        if (this.keysDown.has("d") || this.keysDown.has("arrowright")) dx += 1;
        if (this.keysDown.has("w") || this.keysDown.has("arrowup")) dy -= 1;
        if (this.keysDown.has("s") || this.keysDown.has("arrowdown")) dy += 1;
        const mag = Math.hypot(dx, dy);
        if (mag > 0) { dx /= mag; dy /= mag; }
        this.myInputDx = dx;
        this.myInputDy = dy;
    }

    private submitPick(upgrade: UpgradeId): void {
        if (!this.myChoice) return;
        const choiceId = this.myChoice.choiceId;
        this.myChoice = null;
        this.renderOverlay();
        if (this.isHost()) {
            // Apply locally without round-trip.
            const pending = this.pendingChoices.get(choiceId);
            const p = this.players.get(this.net.me.id);
            if (pending && p) {
                this.applyUpgrade(p, upgrade);
                this.pendingChoices.delete(choiceId);
                p.pendingChoiceId = null;
            }
        } else {
            this.ns.send<PickMsg>("pick", { choiceId, upgrade, round: this.round });
        }
    }

    // ─── Main loop ──────────────────────────────────────────────────

    private loop = (): void => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.lastFrameMs) / 1000);
        this.lastFrameMs = now;

        if (this.isHost()) {
            this.hostStep(dt, now);
        } else {
            this.clientPredictOwnPos(dt);
        }

        // Send my input at INPUT_HZ (clients) — host already has it locally.
        if (!this.isHost() && now - this.lastInputSentAt >= 1000 / INPUT_HZ) {
            this.lastInputSentAt = now;
            this.ns.send<InputMsg>("input", {
                dx: this.myInputDx,
                dy: this.myInputDy,
                round: this.round,
                t: now,
            });
        }

        // Host broadcasts snapshots.
        if (this.isHost() && now - this.lastSnapAt >= 1000 / SNAPSHOT_HZ) {
            this.lastSnapAt = now;
            this.broadcastSnap(false);
        }

        this.draw(now);
        this.updateStatus();
        this.rafId = requestAnimationFrame(this.loop);
    };

    // ─── Host simulation ────────────────────────────────────────────

    private hostStep(dt: number, now: number): void {
        // Make sure roster matches connected peers.
        this.hostEnsurePlayer(this.net.me.id);
        for (const peerId of this.net.peers.keys()) this.hostEnsurePlayer(peerId);
        // Reap players for peers who left.
        for (const id of [...this.players.keys()]) {
            if (id !== this.net.me.id && !this.net.peers.has(id)) {
                this.players.delete(id);
            }
        }

        // Inject local input into the host's own player.
        const me = this.players.get(this.net.me.id);
        if (me) {
            me.inputDx = this.myInputDx;
            me.inputDy = this.myInputDy;
            me.lastInputAt = now;
        }

        if (this.status === "play") {
            this.elapsedInRound += dt;
            this.timeLeft = Math.max(0, ROUND_SECONDS - this.elapsedInRound);

            this.hostStepPlayers(dt, now);
            this.hostStepEnemies(dt);
            this.hostStepProjectiles(dt);
            this.hostStepGems(dt);
            this.hostSpawnEnemies(dt);
            this.hostFireWeapons(dt, now);
            this.hostCheckRoundEnd(now);
        } else if (now >= this.nextRoundAt && this.nextRoundAt > 0) {
            this.hostStartRound(this.round + 1);
        }
    }

    private hostEnsurePlayer(id: string): void {
        if (this.players.has(id)) return;
        const spawn = this.spawnPointForNewPlayer();
        const p: PlayerState = {
            id,
            x: spawn.x,
            y: spawn.y,
            hp: PLAYER_BASE_HP,
            maxHp: PLAYER_BASE_HP,
            alive: this.status === "play",
            xp: 0,
            level: 1,
            loadout: { dmg: 0, rate: 0, multi: 0, hp: 0, speed: 0, magnet: 0, range: 0 },
            pendingChoiceId: null,
            lastHurtAt: 0,
            nextFireAt: performance.now() + 500,
            inputDx: 0,
            inputDy: 0,
            lastInputAt: 0,
        };
        this.players.set(id, p);
    }

    private spawnPointForNewPlayer(): { x: number; y: number } {
        const cx = FIELD_W / 2;
        const cy = FIELD_H / 2;
        const idx = this.players.size;
        const ang = (idx / Math.max(1, this.players.size + 1)) * Math.PI * 2;
        return { x: cx + Math.cos(ang) * 80, y: cy + Math.sin(ang) * 80 };
    }

    private hostStepPlayers(dt: number, now: number): void {
        for (const p of this.players.values()) {
            if (!p.alive) continue;
            const speed = PLAYER_BASE_SPEED * (1 + 0.10 * p.loadout.speed);
            p.x += p.inputDx * speed * dt;
            p.y += p.inputDy * speed * dt;
            p.x = clamp(p.x, ARENA_PAD + PLAYER_RADIUS, FIELD_W - ARENA_PAD - PLAYER_RADIUS);
            p.y = clamp(p.y, ARENA_PAD + PLAYER_RADIUS, FIELD_H - ARENA_PAD - PLAYER_RADIUS);

            // Enemy contact damage with iframes.
            if (now - p.lastHurtAt >= PLAYER_IFRAMES_MS) {
                let touched = false;
                for (const e of this.enemies.values()) {
                    const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
                    const r = PLAYER_RADIUS + ENEMY_RADIUS;
                    if (d2 < r * r) { touched = true; break; }
                }
                if (touched) {
                    p.hp -= PLAYER_TOUCH_DMG_PER_S * (PLAYER_IFRAMES_MS / 1000);
                    p.lastHurtAt = now;
                    if (p.hp <= 0) {
                        p.hp = 0;
                        p.alive = false;
                        const name = this.nameFor(p.id);
                        this.hostBroadcastEvent(`${name} was downed.`);
                    }
                }
            }
        }
    }

    private hostStepEnemies(dt: number): void {
        for (const e of this.enemies.values()) {
            const target = this.nearestAlivePlayer(e.x, e.y);
            if (!target) continue;
            const dx = target.x - e.x;
            const dy = target.y - e.y;
            const len = Math.hypot(dx, dy) || 1;
            e.x += (dx / len) * ENEMY_SPEED * dt;
            e.y += (dy / len) * ENEMY_SPEED * dt;
        }
    }

    private hostStepProjectiles(dt: number): void {
        for (const [id, pr] of this.projectiles) {
            pr.x += pr.vx * dt;
            pr.y += pr.vy * dt;
            pr.lifeLeft -= dt;
            if (pr.lifeLeft <= 0
                || pr.x < 0 || pr.x > FIELD_W
                || pr.y < 0 || pr.y > FIELD_H) {
                this.projectiles.delete(id);
                continue;
            }
            // Enemy hit.
            for (const [eid, e] of this.enemies) {
                const dx = e.x - pr.x;
                const dy = e.y - pr.y;
                const r = ENEMY_RADIUS + PROJECTILE_RADIUS;
                if (dx * dx + dy * dy < r * r) {
                    e.hp -= pr.dmg;
                    this.projectiles.delete(id);
                    if (e.hp <= 0) {
                        this.enemies.delete(eid);
                        // Drop gem.
                        const gid = this.nextEntityId++;
                        this.gems.set(gid, { id: gid, x: e.x, y: e.y, value: GEM_VALUE });
                        // Score the killer.
                        const killer = this.players.get(pr.ownerId);
                        if (killer) this.net.awardScore(pr.ownerId, KILL_SCORE);
                    }
                    break;
                }
            }
        }
    }

    private hostStepGems(_dt: number): void {
        for (const [gid, g] of this.gems) {
            // Magnet toward nearest alive player within range, then pickup.
            const target = this.nearestAlivePlayer(g.x, g.y);
            if (!target) continue;
            const dx = target.x - g.x;
            const dy = target.y - g.y;
            const dist = Math.hypot(dx, dy);
            const magnetR = GEM_MAGNET_BASE + 60 * target.loadout.magnet;
            const pickupR = PLAYER_RADIUS + 6;
            if (dist <= pickupR) {
                this.hostGivePlayerXp(target, g.value);
                this.gems.delete(gid);
                continue;
            }
            if (dist <= magnetR && dist > 0) {
                const pull = 260;
                g.x += (dx / dist) * pull * _dt;
                g.y += (dy / dist) * pull * _dt;
            }
        }
    }

    private hostGivePlayerXp(p: PlayerState, amount: number): void {
        p.xp += amount;
        // Level up while XP exceeds threshold (allow chained level-ups).
        // Only open ONE picker at a time; if one is already pending, defer.
        while (p.xp >= xpForLevel(p.level + 1) && !p.pendingChoiceId) {
            p.level += 1;
            this.hostOpenLevelUpFor(p);
        }
    }

    private hostOpenLevelUpFor(p: PlayerState): void {
        const choices = this.hostPickChoices(p);
        if (choices.length === 0) return; // fully maxed; skip.
        const choiceId = `${p.id}:${p.level}:${this.nextEntityId++}`;
        p.pendingChoiceId = choiceId;
        this.pendingChoices.set(choiceId, { peerId: p.id, choices, level: p.level });
        if (p.id === this.net.me.id) {
            this.myChoice = { choiceId, choices, level: p.level };
            this.renderOverlay();
            this.playLevelUp();
        } else {
            this.ns.send<LevelUpMsg>("levelup", {
                choiceId, choices, level: p.level, round: this.round,
            }, p.id);
        }
    }

    private hostPickChoices(p: PlayerState): UpgradeId[] {
        const available = ALL_UPGRADE_IDS.filter((id) => p.loadout[id] < UPGRADES[id].maxLevel);
        // Shuffle and take up to 3.
        for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
        }
        return available.slice(0, 3);
    }

    private applyUpgrade(p: PlayerState, upgrade: UpgradeId): void {
        const cur = p.loadout[upgrade];
        const def = UPGRADES[upgrade];
        if (cur >= def.maxLevel) return;
        p.loadout[upgrade] = cur + 1;
        // Side effects.
        if (upgrade === "hp") {
            p.maxHp += 25;
            p.hp = p.maxHp;
        }
    }

    private hostSpawnEnemies(dt: number): void {
        if (this.enemies.size >= ENEMY_CAP) return;
        if (this.aliveCount() === 0) return;
        this.enemySpawnAccum += dt;
        const cadence = Math.max(
            ENEMY_SPAWN_MIN_S,
            ENEMY_SPAWN_BASE_S - ENEMY_RAMP_PER_SEC * this.elapsedInRound,
        );
        while (this.enemySpawnAccum >= cadence) {
            this.enemySpawnAccum -= cadence;
            this.spawnOneEnemy();
        }
    }

    private spawnOneEnemy(): void {
        // Spawn just outside the arena edge, biased toward a random player.
        const edge = Math.floor(Math.random() * 4);
        let x = 0, y = 0;
        if (edge === 0) { x = Math.random() * FIELD_W; y = ARENA_PAD - 8; }
        else if (edge === 1) { x = Math.random() * FIELD_W; y = FIELD_H - ARENA_PAD + 8; }
        else if (edge === 2) { x = ARENA_PAD - 8; y = Math.random() * FIELD_H; }
        else { x = FIELD_W - ARENA_PAD + 8; y = Math.random() * FIELD_H; }
        const id = this.nextEntityId++;
        this.enemies.set(id, { id, x, y, hp: ENEMY_HP });
    }

    private hostFireWeapons(_dt: number, now: number): void {
        for (const p of this.players.values()) {
            if (!p.alive) continue;
            if (now < p.nextFireAt) continue;
            const range = WEAPON_BASE_RANGE * (1 + 0.25 * p.loadout.range);
            const dmg = WEAPON_BASE_DMG * (1 + 0.25 * p.loadout.dmg);
            const cooldown = WEAPON_BASE_COOLDOWN_S * Math.pow(0.85, p.loadout.rate);
            const count = 1 + p.loadout.multi;
            const targets = this.nearestEnemiesTo(p.x, p.y, count, range);
            if (targets.length === 0) {
                // Idle; try again shortly.
                p.nextFireAt = now + 200;
                continue;
            }
            for (const tgt of targets) {
                const dx = tgt.x - p.x;
                const dy = tgt.y - p.y;
                const len = Math.hypot(dx, dy) || 1;
                const pid = this.nextEntityId++;
                this.projectiles.set(pid, {
                    id: pid,
                    ownerId: p.id,
                    x: p.x,
                    y: p.y,
                    vx: (dx / len) * PROJECTILE_SPEED,
                    vy: (dy / len) * PROJECTILE_SPEED,
                    dmg,
                    lifeLeft: PROJECTILE_LIFETIME_S,
                });
            }
            p.nextFireAt = now + cooldown * 1000;
        }
    }

    private hostCheckRoundEnd(now: number): void {
        if (this.timeLeft <= 0) {
            // Win — anyone alive gets survival bonus.
            for (const p of this.players.values()) {
                if (p.alive) this.net.awardScore(p.id, SURVIVAL_SCORE);
            }
            this.hostEndRound("win", now);
            return;
        }
        if (this.players.size > 0 && this.aliveCount() === 0) {
            this.hostEndRound("loss", now);
        }
    }

    private hostEndRound(status: RoundStatus, now: number): void {
        this.status = status;
        this.nextRoundAt = now + RESTART_DELAY_MS;
        const msg = status === "win"
            ? `Round ${this.round} survived! +${SURVIVAL_SCORE} to survivors.`
            : `Round ${this.round} wiped. Regrouping…`;
        this.net.pushSystem(msg);
        this.ns.send<ChatEventMsg>("event", { text: msg });
        this.ns.send<RoundEventMsg>("round", {
            round: this.round, status, nextRoundAt: this.nextRoundAt,
        });
    }

    private hostStartRound(round: number): void {
        this.round = round;
        this.status = "play";
        this.timeLeft = ROUND_SECONDS;
        this.elapsedInRound = 0;
        this.nextRoundAt = 0;
        this.enemies.clear();
        this.gems.clear();
        this.projectiles.clear();
        this.pendingChoices.clear();
        this.myChoice = null;
        this.renderOverlay();
        // Reset everyone.
        const ids = [...new Set([this.net.me.id, ...this.net.peers.keys()])];
        this.players.clear();
        for (const id of ids) this.hostEnsurePlayer(id);
        for (const p of this.players.values()) p.alive = true;
        this.ns.send<RoundEventMsg>("round", { round, status: "play", nextRoundAt: 0 });
        this.broadcastSnap(true);
    }

    private hostBroadcastEvent(text: string): void {
        this.net.pushSystem(text);
        this.ns.send<ChatEventMsg>("event", { text });
    }

    // ─── Snapshots ──────────────────────────────────────────────────

    private broadcastSnap(full: boolean, target?: string): void {
        const players: SnapPlayer[] = [...this.players.values()].map((p) => ({
            id: p.id,
            x: p.x, y: p.y,
            hp: p.hp, maxHp: p.maxHp,
            alive: p.alive,
            xp: p.xp, level: p.level,
            nextLevelXp: xpForLevel(p.level + 1),
            loadout: { ...p.loadout },
        }));
        const enemies: SnapEnemy[] = [...this.enemies.values()].map((e) => ({
            id: e.id, x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.hp),
        }));
        const gems: SnapGem[] = [...this.gems.values()].map((g) => ({
            id: g.id, x: Math.round(g.x), y: Math.round(g.y),
        }));
        const projectiles: SnapProjectile[] = [...this.projectiles.values()].map((pr) => ({
            id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), ownerId: pr.ownerId,
        }));
        const snap: SnapMsg = {
            round: this.round,
            status: this.status,
            timeLeft: this.timeLeft,
            t: performance.now(),
            players, enemies, gems, projectiles,
        };
        if (target) this.ns.send("snap", snap, target);
        else this.ns.send("snap", snap);
        // Mark unused so eslint/tsc happy.
        void full;
    }

    private applySnap(msg: SnapMsg): void {
        if (msg.round < this.round) return;
        this.round = msg.round;
        this.status = msg.status;
        this.timeLeft = msg.timeLeft;

        // Players: replace fully, but preserve my own predicted x/y unless drift is large.
        const myPrev = this.players.get(this.net.me.id);
        const myPrevX = myPrev?.x;
        const myPrevY = myPrev?.y;
        const next: Map<string, PlayerState> = new Map();
        for (const sp of msg.players) {
            const existing = this.players.get(sp.id);
            const p: PlayerState = existing ?? {
                id: sp.id,
                x: sp.x, y: sp.y,
                hp: sp.hp, maxHp: sp.maxHp,
                alive: sp.alive,
                xp: sp.xp, level: sp.level,
                loadout: { ...sp.loadout },
                pendingChoiceId: null,
                lastHurtAt: 0,
                nextFireAt: 0,
                inputDx: 0, inputDy: 0,
                lastInputAt: 0,
            };
            p.hp = sp.hp;
            p.maxHp = sp.maxHp;
            p.alive = sp.alive;
            p.xp = sp.xp;
            p.level = sp.level;
            p.loadout = { ...sp.loadout };
            if (sp.id === this.net.me.id) {
                // Reconcile own pos: snap to host if drift > 60px, else trust prediction.
                if (myPrevX === undefined || myPrevY === undefined) {
                    p.x = sp.x; p.y = sp.y;
                } else {
                    const drift = Math.hypot(sp.x - myPrevX, sp.y - myPrevY);
                    if (drift > 60 || !p.alive) {
                        p.x = sp.x; p.y = sp.y;
                    } else {
                        p.x = myPrevX; p.y = myPrevY;
                    }
                }
            } else {
                p.x = sp.x; p.y = sp.y;
            }
            next.set(sp.id, p);
        }
        this.players = next;

        // Enemies, gems, projectiles: replace from snap.
        this.enemies.clear();
        for (const e of msg.enemies) {
            this.enemies.set(e.id, { id: e.id, x: e.x, y: e.y, hp: e.hp });
        }
        this.gems.clear();
        for (const g of msg.gems) {
            this.gems.set(g.id, { id: g.id, x: g.x, y: g.y, value: GEM_VALUE });
        }
        this.projectiles.clear();
        for (const pr of msg.projectiles) {
            this.projectiles.set(pr.id, {
                id: pr.id, x: pr.x, y: pr.y, vx: 0, vy: 0,
                ownerId: pr.ownerId, dmg: 0, lifeLeft: 0,
            });
        }
    }

    private clientPredictOwnPos(dt: number): void {
        if (this.status !== "play") return;
        const me = this.players.get(this.net.me.id);
        if (!me || !me.alive) return;
        const speed = PLAYER_BASE_SPEED * (1 + 0.10 * me.loadout.speed);
        me.x += this.myInputDx * speed * dt;
        me.y += this.myInputDy * speed * dt;
        me.x = clamp(me.x, ARENA_PAD + PLAYER_RADIUS, FIELD_W - ARENA_PAD - PLAYER_RADIUS);
        me.y = clamp(me.y, ARENA_PAD + PLAYER_RADIUS, FIELD_H - ARENA_PAD - PLAYER_RADIUS);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    private aliveCount(): number {
        let n = 0;
        for (const p of this.players.values()) if (p.alive) n++;
        return n;
    }

    private nearestAlivePlayer(x: number, y: number): PlayerState | null {
        let best: PlayerState | null = null;
        let bestD = Infinity;
        for (const p of this.players.values()) {
            if (!p.alive) continue;
            const d = (p.x - x) ** 2 + (p.y - y) ** 2;
            if (d < bestD) { bestD = d; best = p; }
        }
        return best;
    }

    private nearestEnemiesTo(x: number, y: number, count: number, maxRange: number): EnemyState[] {
        const max2 = maxRange * maxRange;
        const candidates: Array<{ e: EnemyState; d: number }> = [];
        for (const e of this.enemies.values()) {
            const d = (e.x - x) ** 2 + (e.y - y) ** 2;
            if (d <= max2) candidates.push({ e, d });
        }
        candidates.sort((a, b) => a.d - b.d);
        return candidates.slice(0, count).map((c) => c.e);
    }

    private nameFor(id: string): string {
        if (id === this.net.me.id) return this.net.me.name;
        return this.net.peers.get(id)?.name ?? "someone";
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

    private draw(_now: number): void {
        const ctx = this.ctx;
        ctx.save();
        ctx.scale(this.canvas.width / FIELD_W, this.canvas.height / FIELD_H);

        // Background.
        ctx.fillStyle = "#0a0712";
        ctx.fillRect(0, 0, FIELD_W, FIELD_H);
        ctx.strokeStyle = "rgba(120, 60, 200, 0.10)";
        ctx.lineWidth = 1;
        for (let x = 0; x <= FIELD_W; x += 80) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, FIELD_H); ctx.stroke();
        }
        for (let y = 0; y <= FIELD_H; y += 80) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(FIELD_W, y); ctx.stroke();
        }
        // Border.
        ctx.strokeStyle = "#6a3cb4";
        ctx.lineWidth = 3;
        ctx.strokeRect(ARENA_PAD, ARENA_PAD, FIELD_W - ARENA_PAD * 2, FIELD_H - ARENA_PAD * 2);

        // Gems.
        for (const g of this.gems.values()) {
            ctx.fillStyle = "#7fffd4";
            ctx.shadowColor = "#7fffd4";
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(g.x, g.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // Enemies.
        for (const e of this.enemies.values()) {
            ctx.fillStyle = "#b03030";
            ctx.strokeStyle = "#ffb0b0";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(e.x, e.y, ENEMY_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            // HP bar above when damaged.
            if (e.hp < ENEMY_HP) {
                const w = 22;
                const frac = Math.max(0, e.hp / ENEMY_HP);
                ctx.fillStyle = "rgba(0,0,0,0.6)";
                ctx.fillRect(e.x - w / 2, e.y - ENEMY_RADIUS - 7, w, 3);
                ctx.fillStyle = "#7ed957";
                ctx.fillRect(e.x - w / 2, e.y - ENEMY_RADIUS - 7, w * frac, 3);
            }
        }

        // Projectiles.
        for (const pr of this.projectiles.values()) {
            const color = this.colorFor(pr.ownerId);
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(pr.x, pr.y, PROJECTILE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // Players.
        for (const p of this.players.values()) {
            const color = this.colorFor(p.id);
            const isMe = p.id === this.net.me.id;
            ctx.fillStyle = p.alive ? color : "rgba(60,60,60,0.7)";
            ctx.strokeStyle = isMe ? "#fff" : "rgba(255,255,255,0.6)";
            ctx.lineWidth = isMe ? 2 : 1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            // HP bar above.
            const w = 32;
            const frac = Math.max(0, p.hp / p.maxHp);
            ctx.fillStyle = "rgba(0,0,0,0.7)";
            ctx.fillRect(p.x - w / 2, p.y - PLAYER_RADIUS - 10, w, 4);
            ctx.fillStyle = frac > 0.5 ? "#7ed957" : frac > 0.25 ? "#e9b54a" : "#e05a5a";
            ctx.fillRect(p.x - w / 2, p.y - PLAYER_RADIUS - 10, w * frac, 4);
            // Name + level.
            ctx.fillStyle = "rgba(255,255,255,0.85)";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            const label = `${this.nameFor(p.id)} · L${p.level}${isMe ? " (you)" : ""}`;
            ctx.fillText(label, p.x, p.y - PLAYER_RADIUS - 14);
        }

        ctx.restore();
    }

    private updateStatus(): void {
        const alive = this.aliveCount();
        const total = this.players.size;
        const m = Math.floor(this.timeLeft / 60);
        const s = Math.floor(this.timeLeft % 60).toString().padStart(2, "0");
        let line = `Round ${this.round} · ${m}:${s} · ${alive}/${total} alive · ${this.enemies.size} enemies`;
        if (this.status !== "play") {
            const secs = Math.max(0, Math.ceil((this.nextRoundAt - performance.now()) / 1000));
            line += this.status === "win" ? ` · SURVIVED — next in ${secs}s` : ` · WIPED — next in ${secs}s`;
        }
        this.statusEl.textContent = line;
    }

    private renderRoster = (): void => {
        const me = this.players.get(this.net.me.id);
        const rows: string[] = [];
        const sorted = [...this.players.values()].sort((a, b) => b.level - a.level);
        if (sorted.length === 0 && me) sorted.push(me);
        for (const p of sorted) {
            const color = this.colorFor(p.id);
            const name = this.nameFor(p.id) + (p.id === this.net.me.id ? " (you)" : "");
            const lvlPct = Math.min(100, Math.round((p.xp / Math.max(1, xpForLevel(p.level + 1))) * 100));
            rows.push(`
                <div class="crypt-row">
                  <span class="hoops-dot" style="background:${color}"></span>
                  <div class="crypt-rowbody">
                    <div class="crypt-rowtop">
                      <span class="crypt-name">${escapeHtml(name)}</span>
                      <span class="crypt-lvl">L${p.level}</span>
                    </div>
                    <div class="crypt-xpbar"><div class="crypt-xpbar-fill" style="width:${lvlPct}%"></div></div>
                  </div>
                </div>
            `);
        }
        // If host hasn't created my player yet, also show me + my peers.
        if (rows.length === 0) {
            const ids = [this.net.me.id, ...this.net.peers.keys()];
            for (const id of ids) {
                rows.push(`<div class="crypt-row"><span class="hoops-dot" style="background:${this.colorFor(id)}"></span><span>${escapeHtml(this.nameFor(id))}</span></div>`);
            }
        }
        this.rosterEl.innerHTML = rows.join("");
    };

    private renderOverlay(): void {
        if (!this.myChoice) {
            this.overlayEl.innerHTML = "";
            this.overlayEl.classList.remove("visible");
            return;
        }
        const cards = this.myChoice.choices.map((id, i) => {
            const def = UPGRADES[id];
            const me = this.players.get(this.net.me.id);
            const cur = me?.loadout[id] ?? 0;
            return `
                <button class="crypt-card" data-upgrade="${id}">
                  <div class="crypt-card-key">${i + 1}</div>
                  <div class="crypt-card-name">${escapeHtml(def.name)}</div>
                  <div class="crypt-card-desc">${escapeHtml(def.desc)}</div>
                  <div class="crypt-card-meta">Stack ${cur + 1}/${def.maxLevel}</div>
                </button>
            `;
        }).join("");
        this.overlayEl.innerHTML = `
            <div class="crypt-overlay-inner">
              <h3>Level ${this.myChoice.level} — pick an upgrade</h3>
              <p class="hint">Press <b>1 / 2 / 3</b> or click a card.</p>
              <div class="crypt-cards">${cards}</div>
            </div>
        `;
        this.overlayEl.classList.add("visible");
        for (const btn of this.overlayEl.querySelectorAll<HTMLButtonElement>(".crypt-card")) {
            btn.addEventListener("click", () => {
                const id = btn.dataset.upgrade as UpgradeId | undefined;
                if (id) this.submitPick(id);
            });
        }
    }

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

    private playLevelUp(): void {
        const ctx = this.ensureAudio();
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
        const t0 = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "triangle";
        o.frequency.setValueAtTime(440, t0);
        o.frequency.linearRampToValueAtTime(880, t0 + 0.18);
        g.gain.setValueAtTime(0.22, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
        o.connect(g).connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + 0.42);
    }
}

// ─── Free helpers ───────────────────────────────────────────────────

function xpForLevel(level: number): number {
    // Cumulative XP needed to BE at `level`. Level 1 = 0. Quadratic ramp.
    if (level <= 1) return 0;
    const n = level - 1;
    return 5 * n * n + 3 * n;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
