import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace, Avatar } from "../net";
import { renderAvatarSvg } from "../avatar";

// ── Field & physics ──────────────────────────────────────────────────────────
const FIELD_W = 1200;
const FIELD_H = 600;
const GRAVITY = 1800;
const GROUND_Y = 560;
const PLAYER_SPEED = 200;
const JUMP_VY = -600;

// ── HP & respawn ─────────────────────────────────────────────────────────────
const PLAYER_HP = 100;
const MOB_HP = 50;
const RESPAWN_DELAY_MS = 10_000;
const INVINCIBILITY_MS = 2_000;

// ── Mobs ─────────────────────────────────────────────────────────────────────
const MOB_SPEED = 80;
const MOB_ATTACK_DAMAGE = 10;
const MOB_ATTACK_COOLDOWN_MS = 1_000;
const MOB_ATTACK_RANGE = 40;
const SPAWN_INTERVAL_START_MS = 5_000;
const SPAWN_INTERVAL_ACCEL_MS = 500;
const SPAWN_INTERVAL_FLOOR_MS = 1_000;
const SPAWN_ACCEL_EVERY_MS = 30_000;

// ── Scoring ──────────────────────────────────────────────────────────────────
const MOB_KILL_POINTS = 10;
const PLAYER_KILL_POINTS = 25;

// ── Network rates ────────────────────────────────────────────────────────────
const BROADCAST_INTERVAL_MS = 50; // 20Hz

// ── Platforms (static scenery you can stand on) ──────────────────────────────
interface Platform { x: number; y: number; w: number; h: number; kind: "car" | "crate" | "dumpster"; color: string; crumbles: boolean; }
const PLATFORMS: Platform[] = [
    { x: 150, y: GROUND_Y - 45, w: 120, h: 45, kind: "car", color: "#3a6ea5", crumbles: false },
    { x: 500, y: GROUND_Y - 40, w: 80, h: 40, kind: "crate", color: "#8b6914", crumbles: false },
    { x: 750, y: GROUND_Y - 50, w: 130, h: 50, kind: "car", color: "#a63d40", crumbles: false },
    { x: 950, y: GROUND_Y - 35, w: 70, h: 35, kind: "dumpster", color: "#3d5c3a", crumbles: false },
    { x: 350, y: GROUND_Y - 110, w: 90, h: 20, kind: "crate", color: "#8b6914", crumbles: true },
    { x: 820, y: GROUND_Y - 120, w: 90, h: 20, kind: "crate", color: "#8b6914", crumbles: true },
    // Fixed stepping stones leading to L-platform from the right (never crumble)
    { x: 780, y: GROUND_Y - 150, w: 80, h: 16, kind: "crate", color: "#555555", crumbles: false },
    { x: 720, y: GROUND_Y - 250, w: 80, h: 16, kind: "crate", color: "#555555", crumbles: false },
];
const CRUMBLE_TIME_MS = 2_000;

// ── L-platform (trap) ───────────────────────────────────────────────────────
// Shape: capital "L" — tall vertical on the left, horizontal ledge at bottom-right
// Players stand on the horizontal ledge surface (top of the horizontal bar).
const L_PLAT_X = 540;           // left edge of vertical wall
const L_LEDGE_Y = 260;          // Y where players stand (top of horizontal bar)
const L_VERT_W = 20;            // width of vertical wall
const L_VERT_H = 120;           // height of vertical wall (rises above ledge)
const L_HORIZ_W = 140;          // width of horizontal ledge
const L_HORIZ_H = 16;           // thickness of horizontal ledge
const L_TRAP_MIN_MS = 5_000;
const L_TRAP_MAX_MS = 20_000;
const L_PUSH_SPEED = 300;
const L_PUSH_DISTANCE = 160;
const L_RESET_DELAY_MS = 3_000;

interface LPlatTrapMsg { trap: "push" | "trapdoor"; }
interface LPlatResetMsg { trap: "push" | "trapdoor"; }

// ── Health packs ─────────────────────────────────────────────────────────────
const HEALTH_PACK_HEAL = 25;
const HEALTH_PACK_INTERVAL_MS = 8_000;
const HEALTH_PACK_RADIUS = 12;
const HEALTH_PACK_EXPIRE_MS = 10_000;

// ── Flying mob ──────────────────────────────────────────────────────────────
const FLYING_MOB_HP = 35;
const FLYING_MOB_SPEED = 120;
const FLYING_MOB_Y = 200;

const PLAT_RESPAWN_DELAY_MS = 5_000;

interface HealthPackMsg { id: string; x: number; y: number; }
interface HealthPickupMsg { packId: string; }
interface PlatCrumbleMsg { idx: number; }
interface PlatGoneMsg { idx: number; }
interface PlatRespawnMsg { idx: number; x: number; y: number; w: number; }
interface ModeMsg { friendlyFire: boolean; }

// ── Attacks ──────────────────────────────────────────────────────────────────
interface AttackDef {
    damage: number;
    range: number;
    height: number;
    duration: number;
    cooldown: number;
    isAoe: boolean;
}

const ATTACKS: Record<string, AttackDef> = {
    punch:      { damage: 15, range: 50,  height: 80,  duration: 200,  cooldown: 0,     isAoe: false },
    kick:       { damage: 25, range: 70,  height: 70,  duration: 250,  cooldown: 0,     isAoe: false },
    roundhouse: { damage: 40, range: 100, height: 90,  duration: 350,  cooldown: 3_000, isAoe: false },
    power:      { damage: 80, range: 120, height: 120, duration: 400,  cooldown: 10_000, isAoe: true },
};

const KEY_TO_ATTACK: Record<string, string> = {
    z: "punch",
    x: "kick",
    c: "roundhouse",
    " ": "power",
};

// ── Weapons (droppable pickups) ─────────────────────────────────────────────
const WEAPON_DURABILITY = 10;
const WEAPON_SPAWN_INTERVAL_MS = 12_000;

interface WeaponDef {
    name: string;
    damage: number;
    range: number;
    height: number;
    duration: number;
    cooldown: number;
    isAoe: boolean;
    style: "melee" | "ranged" | "thrown";
}
const WEAPONS: Record<string, WeaponDef> = {
    bow:   { name: "Bow", damage: 30, range: 250, height: 20, duration: 600, cooldown: 500, isAoe: false, style: "ranged" },
    club:  { name: "Club", damage: 45, range: 80, height: 90, duration: 300, cooldown: 200, isAoe: false, style: "melee" },
    spear: { name: "Spear", damage: 35, range: 200, height: 30, duration: 350, cooldown: 600, isAoe: false, style: "thrown" },
    wand:  { name: "Wand", damage: 999, range: 0, height: 0, duration: 800, cooldown: 300, isAoe: true, style: "ranged" },
};
const WAND_DURABILITY = 5;
const WAND_MIN_TIME_MS = 60_000;
const WAND_SPAWN_CHANCE = 0.15;
const WEAPON_EXPIRE_MS = 12_000;
const ITEM_BLINK_MS = 3_000;

interface WeaponPickup { id: string; x: number; y: number; kind: string; spawnedAt: number; }
interface WeaponSpawnMsg { id: string; x: number; y: number; kind: string; }
interface WeaponPickedMsg { pickupId: string; playerId: string; }

// ── State types ──────────────────────────────────────────────────────────────
interface PlayerState {
    id: string;
    x: number; y: number; vx: number; vy: number;
    knockbackVx: number;
    facingRight: boolean;
    ducking: boolean;
    hp: number;
    dead: boolean;
    respawnAt: number | null;
    invincibleUntil: number;
    color: string;
    name: string;
    activeAttack: { key: string; startedAt: number; hitTargets: Set<string> } | null;
    cooldowns: Record<string, number>;
    weapon: { kind: string; durability: number } | null;
}

interface MobState {
    id: string;
    kind: "ground" | "flying";
    x: number; y: number; vx: number; vy: number;
    hp: number;
    dead: boolean;
    attackCooldownUntil: number;
    lastAttackAt: number;
}

type DamageMap = Map<string, Map<string, number>>;

// ── Network message types ────────────────────────────────────────────────────
interface InputMsg {
    x: number; y: number; vx: number; vy: number;
    facingRight: boolean; ducking: boolean; hp: number; dead: boolean;
}
interface AttackMsg {
    attackKey: string; originX: number; originY: number; facingRight: boolean;
}
interface HitMsg {
    attackerId: string; targetId: string; targetKind: "player" | "mob";
    attackKey: string; damage: number;
}
interface MobStateMsg {
    mobs: Array<{ id: string; x: number; y: number; hp: number; dead: boolean; kind: string }>;
}
interface MobSpawnMsg { id: string; x: number; y: number; kind: "ground" | "flying"; }
interface KillMsg {
    targetId: string; targetKind: "player" | "mob";
    damageMap: Array<[string, number]>;
}
interface RespawnMsg { x: number; y: number; }
interface SyncMsg {
    players: Array<{ id: string; x: number; y: number; vx: number; vy: number; facingRight: boolean; ducking: boolean; hp: number; dead: boolean; color: string; name: string }>;
    mobs: Array<{ id: string; x: number; y: number; hp: number; dead: boolean; kind: string }>;
    spawnIntervalMs: number;
    gameOver: boolean;
    scores: Array<[string, number]>;
    platformState: Array<{ x: number; y: number; w: number; gone: boolean }>;
    gameStartedAt: number;
}
interface GameOverMsg { scores: Array<[string, number]>; }

// ── Rect helper ──────────────────────────────────────────────────────────────
interface Rect { x: number; y: number; w: number; h: number; }
function rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ── Game export ──────────────────────────────────────────────────────────────
export const StickmanGame: Game = {
    id: "stickman",
    name: "Stickman Brawl",
    description: "Fight mobs and each other — last team standing wins!",
    badge: `Vibed by <img src="./images/TMTL_LOGO.png" alt="TMTL" style="height:48px;vertical-align:middle;margin-left:4px">`,
    create(container, net): GameInstance {
        const inst = new StickmanInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

// ── Main class ───────────────────────────────────────────────────────────────
class StickmanInstance {
    private net: Net;
    private ns: GameNamespace;
    private container: HTMLElement;
    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private hudEl!: HTMLDivElement;
    private gameOverEl!: HTMLDivElement;
    private modeToggleEl!: HTMLDivElement;

    private rafId = 0;
    private lastFrameTime = 0;
    private resizeObs: ResizeObserver | null = null;
    private unsubPeers: (() => void) | null = null;

    private players: Map<string, PlayerState> = new Map();
    private mobs: Map<string, MobState> = new Map();
    private damageMap: DamageMap = new Map();
    private avatarImgs: Map<string, { img: HTMLImageElement; url: string }> = new Map();

    private keysDown: Set<string> = new Set();
    private lastInputBroadcast = 0;
    private lastMobBroadcast = 0;
    private windowLights: Array<{ x: number; y: number }> = [];
    private healthPacks: Map<string, { x: number; y: number; spawnedAt: number }> = new Map();
    private nextHealthPackAt = 0;
    private platformCrumbleStart: Map<number, number> = new Map();
    private platformGone: Set<number> = new Set();
    private platformRespawnAt: Map<number, number> = new Map();
    private platforms: Platform[] = PLATFORMS.map(p => ({ ...p }));
    private friendlyFire = false;
    private gameStartedAt = 0;

    // Weapons
    private weaponPickups: Map<string, WeaponPickup> = new Map();
    private nextWeaponSpawnAt = 0;

    // Screen effects
    private screenShake = 0;
    private kapowEffects: Array<{ x: number; y: number; startedAt: number; text: string }> = [];

    // L-platform trap state
    private lPlatOccupiedSince = 0;
    private lPlatNextTrapAt = 0;
    private lPlatPushOffset = 0;
    private lPlatTrapdoorOpen = false;
    private lPlatResettingAt = 0;

    private spawnIntervalMs = SPAWN_INTERVAL_START_MS;
    private nextSpawnAt = 0;
    private lastAccelAt = 0;
    private gameOver = false;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("stickman");

        this.buildDom();
        this.startResizeWatcher();
        this.initLocalPlayer();
        this.registerNetwork();

        this.unsubPeers = this.net.on("peers", () => this.onPeersChanged());
        this.onPeersChanged(); // Pick up peers already in the room

        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("blur", this.onBlur);

        this.lastFrameTime = performance.now();
        this.gameStartedAt = performance.now();
        this.nextSpawnAt = performance.now() + this.spawnIntervalMs;
        this.lastAccelAt = performance.now();
        this.nextHealthPackAt = performance.now() + HEALTH_PACK_INTERVAL_MS;
        this.nextWeaponSpawnAt = performance.now() + WEAPON_SPAWN_INTERVAL_MS;
        this.generateWindowLights();
        this.loop();

        this.ns.send("sync_request", {});
    }

    // ── DOM setup ────────────────────────────────────────────────────────────

    private buildDom(): void {
        this.container.innerHTML = `
            <div class="stickman-layout">
                <canvas class="stickman-canvas"></canvas>
                <div class="stickman-hud"></div>
                <div class="stickman-mode">
                    <span class="stickman-mode-label stickman-mode-left">Co-op</span>
                    <div class="stickman-toggle"><div class="stickman-toggle-knob"></div></div>
                    <span class="stickman-mode-label stickman-mode-right">FFA</span>
                </div>
                <div class="stickman-game-over hidden"></div>
            </div>
        `;
        this.canvas = this.container.querySelector<HTMLCanvasElement>(".stickman-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.hudEl = this.container.querySelector<HTMLDivElement>(".stickman-hud")!;
        this.gameOverEl = this.container.querySelector<HTMLDivElement>(".stickman-game-over")!;
        this.modeToggleEl = this.container.querySelector<HTMLDivElement>(".stickman-mode")!;
        this.modeToggleEl.querySelector(".stickman-toggle")!.addEventListener("click", () => {
            this.friendlyFire = !this.friendlyFire;
            this.ns.send<ModeMsg>("mode", { friendlyFire: this.friendlyFire });
        });
    }

    private startResizeWatcher(): void {
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

    // ── Host election ────────────────────────────────────────────────────────

    private hostId(): string {
        const all = [this.net.me.id, ...this.net.peers.keys()];
        all.sort();
        return all[0];
    }

    private isHost(): boolean {
        return this.hostId() === this.net.me.id;
    }

    // ── Player init ──────────────────────────────────────────────────────────

    private initLocalPlayer(): void {
        const p: PlayerState = {
            id: this.net.me.id,
            x: 100 + Math.random() * (FIELD_W - 200),
            y: GROUND_Y,
            vx: 0, vy: 0, knockbackVx: 0,
            facingRight: true,
            ducking: false,
            hp: PLAYER_HP,
            dead: false,
            respawnAt: null,
            invincibleUntil: 0,
            color: this.net.me.color,
            name: this.net.me.name,
            activeAttack: null,
            cooldowns: {},
            weapon: null,
        };
        this.players.set(this.net.me.id, p);
        this.loadAvatarImg(this.net.me.id, this.net.me.avatar);
    }

    // ── Window lights (pre-generated) ──────────────────────────────────────────

    private generateWindowLights(): void {
        const buildings = [
            { x: 30, w: 80, top: GROUND_Y - 180 },
            { x: 130, w: 60, top: GROUND_Y - 130 },
            { x: 220, w: 90, top: GROUND_Y - 200 },
            { x: 450, w: 70, top: GROUND_Y - 160 },
            { x: 550, w: 100, top: GROUND_Y - 220 },
            { x: 900, w: 75, top: GROUND_Y - 150 },
            { x: 1020, w: 85, top: GROUND_Y - 190 },
            { x: 1120, w: 65, top: GROUND_Y - 140 },
        ];
        this.windowLights = [];
        for (const b of buildings) {
            for (let wx = b.x + 8; wx < b.x + b.w - 12; wx += 18) {
                for (let wy = b.top + 10; wy < GROUND_Y - 15; wy += 25) {
                    if (Math.random() > 0.45) {
                        this.windowLights.push({ x: wx, y: wy });
                    }
                }
            }
        }
    }

    // ── Avatar loading ───────────────────────────────────────────────────────

    private loadAvatarImg(peerId: string, avatar: Avatar | undefined): void {
        const old = this.avatarImgs.get(peerId);
        if (old) URL.revokeObjectURL(old.url);
        const svgStr = renderAvatarSvg(avatar, 48);
        const blob = new Blob([svgStr], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        this.avatarImgs.set(peerId, { img, url });
    }

    // ── Peers changed ────────────────────────────────────────────────────────

    private onPeersChanged(): void {
        // Add new peers
        for (const [peerId, info] of this.net.peers) {
            if (peerId === this.net.me.id) continue;
            if (!this.players.has(peerId)) {
                this.players.set(peerId, {
                    id: peerId,
                    x: FIELD_W / 2, y: GROUND_Y,
                    vx: 0, vy: 0, knockbackVx: 0,
                    facingRight: true, ducking: false,
                    hp: PLAYER_HP, dead: false,
                    respawnAt: null, invincibleUntil: 0,
                    color: info.color, name: info.name,
                    activeAttack: null, cooldowns: {},
                    weapon: null,
                });
            }
            this.loadAvatarImg(peerId, info.avatar);
        }
        // Remove departed peers
        for (const id of this.players.keys()) {
            if (id === this.net.me.id) continue;
            if (!this.net.peers.has(id)) {
                this.players.delete(id);
                const av = this.avatarImgs.get(id);
                if (av) { URL.revokeObjectURL(av.url); this.avatarImgs.delete(id); }
                this.damageMap.delete(id);
            }
        }
    }

    // ── Input ─────────────────────────────────────────────────────────────────

    private onKeyDown = (e: KeyboardEvent): void => {
        if (this.gameOver) return;
        const key = e.key;
        this.keysDown.add(key);
        if (key === "ArrowLeft") e.preventDefault();
        if (key === "ArrowRight") e.preventDefault();
        if (key === "ArrowUp") e.preventDefault();
        if (key === "ArrowDown") e.preventDefault();
        if (key === " ") e.preventDefault();
        if (key.toLowerCase() === "t") { this.secretSpawnWand(); return; }
        const attackKey = KEY_TO_ATTACK[key.toLowerCase()];
        if (attackKey) this.fireAttack(attackKey, performance.now());
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        this.keysDown.delete(e.key);
    };

    private onBlur = (): void => {
        this.keysDown.clear();
    };

    // ── Game loop ────────────────────────────────────────────────────────────

    private loop = (): void => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
        this.lastFrameTime = now;
        if (!this.gameOver) {
            this.step(dt, now);
        }
        this.draw(now);
        this.renderHud(now);
        this.rafId = requestAnimationFrame(this.loop);
    };

    private step(dt: number, now: number): void {
        const me = this.players.get(this.net.me.id)!;

        // Local player movement
        if (!me.dead) {
            this.processLocalInput(me, dt, now);
            this.stepPlayer(me, dt);
            // End attack when duration expires
            if (me.activeAttack) {
                const def = this.getAttackDef(me.activeAttack.key);
                if (!def || now - me.activeAttack.startedAt > def.duration) {
                    me.activeAttack = null;
                }
            }
            this.checkHits(me, now);
        } else if (me.respawnAt && now >= me.respawnAt) {
            this.respawnLocalPlayer(now);
        }

        // Clear expired attack animations for remote players
        for (const [id, p] of this.players) {
            if (id === this.net.me.id) continue;
            if (p.activeAttack) {
                const def = this.getAttackDef(p.activeAttack.key);
                if (!def || now - p.activeAttack.startedAt > def.duration) {
                    p.activeAttack = null;
                }
            }
        }

        // Broadcast local state
        if (now - this.lastInputBroadcast >= BROADCAST_INTERVAL_MS) {
            this.lastInputBroadcast = now;
            this.broadcastInput();
        }

        // Platform crumbling
        this.updateCrumblePlatforms(now);

        // L-platform trap logic
        this.stepLPlatform(dt, now);

        // Health pack pickup (any player)
        if (!me.dead) this.checkHealthPickup(me);
        // Weapon pickup
        if (!me.dead) this.checkWeaponPickup(me);
        // Decay screen shake
        if (this.screenShake > 0) this.screenShake *= 0.9;
        if (this.screenShake < 0.5) this.screenShake = 0;

        // Host duties
        if (this.isHost()) {
            this.stepMobs(dt, now);
            if (now - this.lastMobBroadcast >= BROADCAST_INTERVAL_MS) {
                this.lastMobBroadcast = now;
                this.broadcastMobState();
                this.pruneDeadMobs();
            }
            this.checkSpawnAccel(now);
            if (now >= this.nextSpawnAt) {
                this.spawnMob(now);
                this.nextSpawnAt = now + this.spawnIntervalMs;
            }
            if (now >= this.nextHealthPackAt) {
                this.spawnHealthPack();
                this.nextHealthPackAt = now + HEALTH_PACK_INTERVAL_MS;
            }
            this.expireHealthPacks(now);
            this.expireWeapons(now);
            if (now >= this.nextWeaponSpawnAt) {
                this.spawnWeapon();
                this.nextWeaponSpawnAt = now + WEAPON_SPAWN_INTERVAL_MS;
            }
            this.checkGameOver();
        }
    }

    private processLocalInput(me: PlayerState, _dt: number, _now: number): void {
        me.vx = 0;
        if (this.keysDown.has("ArrowLeft")) { me.vx = -PLAYER_SPEED; me.facingRight = false; }
        if (this.keysDown.has("ArrowRight")) { me.vx = PLAYER_SPEED; me.facingRight = true; }
        me.ducking = this.keysDown.has("ArrowDown");
        if (this.keysDown.has("ArrowUp") && me.vy === 0) {
            me.vy = JUMP_VY;
        }
    }

    private stepPlayer(p: PlayerState, dt: number): void {
        const now = performance.now();
        p.vy += GRAVITY * dt;
        p.x += (p.vx + p.knockbackVx) * dt;
        p.y += p.vy * dt;
        // Decay knockback
        if (p.knockbackVx !== 0) {
            p.knockbackVx *= Math.pow(0.02, dt);
            if (Math.abs(p.knockbackVx) < 5) p.knockbackVx = 0;
        }
        // Ground collision
        if (p.y >= GROUND_Y) { p.y = GROUND_Y; p.vy = 0; }
        // Platform collision (only when falling)
        if (p.vy >= 0) {
            for (let i = 0; i < this.platforms.length; i++) {
                if (this.platformGone.has(i)) continue;
                const plat = this.platforms[i];
                if (p.x >= plat.x && p.x <= plat.x + plat.w && p.y >= plat.y && p.y <= plat.y + 16) {
                    p.y = plat.y; p.vy = 0;
                    if (this.isHost() && plat.crumbles && !this.platformCrumbleStart.has(i)) {
                        this.platformCrumbleStart.set(i, now);
                        this.ns.send<PlatCrumbleMsg>("plat_crumble", { idx: i });
                    }
                    break;
                }
            }
            // L-platform collision (horizontal ledge) — only if trapdoor is closed
            if (!this.lPlatTrapdoorOpen && p.vy >= 0) {
                const lx = L_PLAT_X + L_VERT_W;
                const ly = L_LEDGE_Y;
                if (p.x >= lx && p.x <= lx + L_HORIZ_W && p.y >= ly && p.y <= ly + 16) {
                    p.y = ly; p.vy = 0;
                }
            }
        }
        // L-platform vertical wall push — fling player hard to the right
        if (this.lPlatPushOffset > 0) {
            const wallRight = L_PLAT_X + L_VERT_W + this.lPlatPushOffset;
            const wallTop = L_LEDGE_Y - L_VERT_H;
            const wallBot = L_LEDGE_Y + L_HORIZ_H;
            if (p.x >= wallRight - 25 && p.x <= wallRight + 5 && p.y >= wallTop && p.y <= wallBot) {
                p.knockbackVx = 1200;
                p.vy = -400;
                p.x = wallRight + 10;
            }
        }
        if (p.x < 20) p.x = 20;
        if (p.x > FIELD_W - 20) p.x = FIELD_W - 20;
    }

    private updateCrumblePlatforms(now: number): void {
        for (const [idx, startTime] of this.platformCrumbleStart) {
            if (now - startTime >= CRUMBLE_TIME_MS) {
                this.platformGone.add(idx);
                this.platformCrumbleStart.delete(idx);
                if (this.isHost()) {
                    this.ns.send<PlatGoneMsg>("plat_gone", { idx });
                    this.platformRespawnAt.set(idx, now + PLAT_RESPAWN_DELAY_MS);
                }
            }
        }
        // Host handles respawning platforms at new locations
        if (this.isHost()) {
            for (const [idx, respawnTime] of this.platformRespawnAt) {
                if (now >= respawnTime) {
                    this.platformRespawnAt.delete(idx);
                    const newX = 80 + Math.floor(Math.random() * (FIELD_W - 200));
                    const newY = GROUND_Y - 80 - Math.floor(Math.random() * 80);
                    const newW = 70 + Math.floor(Math.random() * 50);
                    this.platforms[idx] = { ...this.platforms[idx], x: newX, y: newY, w: newW };
                    this.platformGone.delete(idx);
                    this.ns.send<PlatRespawnMsg>("plat_respawn", { idx, x: newX, y: newY, w: newW });
                }
            }
        }
    }

    private respawnPlatforms(): void {
        this.platformGone.clear();
        this.platformCrumbleStart.clear();
        this.platformRespawnAt.clear();
        this.platforms = PLATFORMS.map(p => ({ ...p }));
    }

    // ── L-platform trap logic ────────────────────────────────────────────────

    private stepLPlatform(dt: number, now: number): void {
        // Check if any player is on the L-platform ledge
        const lx = L_PLAT_X + L_VERT_W;
        const ly = L_LEDGE_Y;
        let anyOnLedge = false;
        for (const p of this.players.values()) {
            if (p.dead) continue;
            if (Math.abs(p.y - ly) < 2 && p.x >= lx && p.x <= lx + L_HORIZ_W) {
                anyOnLedge = true; break;
            }
        }

        // Track occupation start
        if (anyOnLedge && this.lPlatOccupiedSince === 0) {
            this.lPlatOccupiedSince = now;
            this.lPlatNextTrapAt = now + L_TRAP_MIN_MS + Math.random() * (L_TRAP_MAX_MS - L_TRAP_MIN_MS);
        } else if (!anyOnLedge && this.lPlatPushOffset === 0 && !this.lPlatTrapdoorOpen) {
            this.lPlatOccupiedSince = 0;
            this.lPlatNextTrapAt = 0;
        }

        // Host triggers traps
        if (this.isHost() && this.lPlatNextTrapAt > 0 && now >= this.lPlatNextTrapAt && this.lPlatPushOffset === 0 && !this.lPlatTrapdoorOpen && this.lPlatResettingAt === 0) {
            const trap = Math.random() < 0.5 ? "push" : "trapdoor";
            this.activateLTrap(trap);
            this.ns.send<LPlatTrapMsg>("l_trap", { trap });
            this.lPlatNextTrapAt = 0;
            this.lPlatOccupiedSince = 0;
        }

        // Animate push (slide the vertical wall right)
        if (this.lPlatPushOffset > 0 && this.lPlatPushOffset < L_PUSH_DISTANCE) {
            this.lPlatPushOffset += L_PUSH_SPEED * dt;
            if (this.lPlatPushOffset >= L_PUSH_DISTANCE) {
                this.lPlatPushOffset = L_PUSH_DISTANCE;
                if (this.lPlatResettingAt === 0) this.lPlatResettingAt = now + L_RESET_DELAY_MS;
            }
        }

        // Reset after delay
        if (this.lPlatResettingAt > 0 && now >= this.lPlatResettingAt) {
            const wasPush = this.lPlatPushOffset > 0;
            if (this.lPlatPushOffset > 0) {
                this.lPlatPushOffset = 0;
            }
            if (this.lPlatTrapdoorOpen) {
                this.lPlatTrapdoorOpen = false;
            }
            this.lPlatResettingAt = 0;
            if (this.isHost()) {
                this.ns.send<LPlatResetMsg>("l_reset", { trap: wasPush ? "push" : "trapdoor" });
            }
        }

        // Trapdoor: after activation, schedule reset
        if (this.lPlatTrapdoorOpen && this.lPlatResettingAt === 0) {
            this.lPlatResettingAt = now + L_RESET_DELAY_MS;
        }
    }

    private activateLTrap(trap: "push" | "trapdoor"): void {
        if (trap === "push") {
            this.lPlatPushOffset = 0.01;
        } else {
            this.lPlatTrapdoorOpen = true;
        }
    }

    private resetLPlatform(): void {
        this.lPlatPushOffset = 0;
        this.lPlatTrapdoorOpen = false;
        this.lPlatResettingAt = 0;
        this.lPlatOccupiedSince = 0;
        this.lPlatNextTrapAt = 0;
    }

    // ── Attacks ──────────────────────────────────────────────────────────────

    private fireAttack(attackKey: string, now: number): void {
        const me = this.players.get(this.net.me.id)!;
        if (me.dead) return;
        if (me.activeAttack) return;

        // If player has a weapon and presses Z, use weapon attack
        let actualKey = attackKey;
        if (me.weapon && attackKey === "punch") {
            actualKey = "weapon_" + me.weapon.kind;
        }

        const def = this.getAttackDef(actualKey);
        if (!def) return;
        if (me.cooldowns[actualKey] && now < me.cooldowns[actualKey]) return;

        me.activeAttack = { key: actualKey, startedAt: now, hitTargets: new Set() };
        me.cooldowns[actualKey] = now + def.duration + def.cooldown;

        // Screen shake + kapow for power attacks and wand
        if (attackKey === "power" || attackKey === "roundhouse") {
            this.screenShake = attackKey === "power" ? 12 : 6;
            this.kapowEffects.push({ x: me.x, y: me.y - 40, startedAt: now, text: attackKey === "power" ? "KAPOW!" : "WHAM!" });
        } else if (actualKey === "weapon_wand") {
            this.screenShake = 15;
            this.kapowEffects.push({ x: me.x, y: me.y - 40, startedAt: now, text: "INFERNO!" });
        }

        // Weapon durability
        if (me.weapon && actualKey.startsWith("weapon_")) {
            me.weapon.durability--;
            if (me.weapon.durability <= 0) me.weapon = null;
        }

        this.ns.send<AttackMsg>("attack", {
            attackKey: actualKey,
            originX: me.x,
            originY: me.y,
            facingRight: me.facingRight,
        });
    }

    private getAttackDef(key: string): AttackDef | null {
        if (key.startsWith("weapon_")) {
            const wk = key.replace("weapon_", "");
            const w = WEAPONS[wk];
            if (!w) return null;
            return { damage: w.damage, range: w.range, height: w.height, duration: w.duration, cooldown: w.cooldown, isAoe: w.isAoe };
        }
        return ATTACKS[key] || null;
    }

    private checkHits(me: PlayerState, now: number): void {
        if (!me.activeAttack) return;
        const def = this.getAttackDef(me.activeAttack.key);
        if (!def) return;
        const hitbox = this.getAttackHitbox(me, def);

        // Bow is a single-target projectile — stop after first hit
        const isSingleTarget = me.activeAttack.key === "weapon_bow";
        const alreadyHitOne = isSingleTarget && me.activeAttack.hitTargets.size > 0;
        if (alreadyHitOne) return;

        // Check against other players (only if friendly fire is on)
        if (this.friendlyFire) {
            for (const [id, p] of this.players) {
                if (id === me.id || p.dead) continue;
                if (now < p.invincibleUntil) continue;
                if (me.activeAttack.hitTargets.has(id)) continue;
                const targetBox = this.getEntityBox(p);
                if (rectsOverlap(hitbox, targetBox)) {
                    me.activeAttack.hitTargets.add(id);
                    this.sendHit(me.id, id, "player", me.activeAttack.key, def.damage);
                    this.applyHit(me.id, id, "player", def.damage);
                    if (isSingleTarget) return;
                }
            }
        }

        // Check against mobs
        for (const [id, mob] of this.mobs) {
            if (mob.dead) continue;
            if (me.activeAttack.hitTargets.has(id)) continue;
            const mobBox: Rect = { x: mob.x - 15, y: mob.y - 60, w: 30, h: 60 };
            if (rectsOverlap(hitbox, mobBox)) {
                me.activeAttack.hitTargets.add(id);
                this.sendHit(me.id, id, "mob", me.activeAttack.key, def.damage);
                this.applyHit(me.id, id, "mob", def.damage);
                if (isSingleTarget) return;
            }
        }
    }

    private getAttackHitbox(p: PlayerState, def: AttackDef): Rect {
        const key = p.activeAttack?.key ?? "";
        if (key.startsWith("weapon_")) {
            const wk = key.replace("weapon_", "");
            const w = WEAPONS[wk];
            if (w && w.style === "ranged") {
                // Wand: wall of fire in facing direction, limited to flame height at player's level
                if (wk === "wand") {
                    const progress = p.activeAttack ? Math.min(1, (performance.now() - p.activeAttack.startedAt) / def.duration) : 1;
                    const maxFlight = p.facingRight ? FIELD_W - p.x : p.x;
                    const currentRange = maxFlight * progress;
                    const hx = p.facingRight ? p.x : p.x - currentRange;
                    const flameH = 150;
                    return { x: hx, y: p.y - flameH, w: currentRange, h: flameH };
                }
                // Bow/other ranged: projectile grows across field
                const progress = p.activeAttack ? Math.min(1, (performance.now() - p.activeAttack.startedAt) / def.duration) : 1;
                const maxFlight = p.facingRight ? FIELD_W - p.x : p.x;
                const currentRange = maxFlight * progress;
                const hx = p.facingRight ? p.x : p.x - currentRange;
                return { x: hx, y: 0, w: currentRange, h: FIELD_H };
            }
            // Thrown weapons (spear): limited range but full height (can hit flying mobs)
            if (w && w.style === "thrown") {
                const hx = p.facingRight ? p.x : p.x - def.range;
                return { x: hx, y: 0, w: def.range, h: FIELD_H };
            }
        }
        const hx = p.facingRight ? p.x : p.x - def.range;
        return { x: hx, y: p.y - def.height, w: def.range, h: def.height };
    }

    private getEntityBox(p: PlayerState): Rect {
        const h = p.ducking ? 40 : 80;
        return { x: p.x - 15, y: p.y - h, w: 30, h };
    }

    private sendHit(attackerId: string, targetId: string, targetKind: "player" | "mob", attackKey: string, damage: number): void {
        this.ns.send<HitMsg>("hit", { attackerId, targetId, targetKind, attackKey, damage });
    }

    // ── Damage & kills ───────────────────────────────────────────────────────

    private applyHit(attackerId: string, targetId: string, targetKind: "player" | "mob", damage: number): void {
        this.trackDamage(targetId, attackerId, damage);

        if (targetKind === "player") {
            const target = this.players.get(targetId);
            if (!target || target.dead) return;
            target.hp = Math.max(0, target.hp - damage);
            if (target.hp <= 0) {
                target.dead = true;
                if (targetId === this.net.me.id) {
                    target.respawnAt = performance.now() + RESPAWN_DELAY_MS;
                }
                this.onKill(targetId, "player");
            }
        } else {
            const mob = this.mobs.get(targetId);
            if (!mob || mob.dead) return;
            mob.hp = Math.max(0, mob.hp - damage);
            if (mob.hp <= 0) {
                mob.dead = true;
                this.onKill(targetId, "mob");
            }
        }
    }

    private trackDamage(targetId: string, attackerId: string, damage: number): void {
        let perTarget = this.damageMap.get(targetId);
        if (!perTarget) { perTarget = new Map(); this.damageMap.set(targetId, perTarget); }
        perTarget.set(attackerId, (perTarget.get(attackerId) ?? 0) + damage);
    }

    private onKill(targetId: string, targetKind: "player" | "mob"): void {
        const points = targetKind === "mob" ? MOB_KILL_POINTS : PLAYER_KILL_POINTS;
        const perTarget = this.damageMap.get(targetId);
        if (!perTarget || perTarget.size === 0) return;

        const dmgArray: Array<[string, number]> = [...perTarget.entries()];
        this.ns.send<KillMsg>("kill", { targetId, targetKind, damageMap: dmgArray });
        this.splitKillReward(targetId, points);
    }

    private splitKillReward(targetId: string, totalPoints: number): void {
        const perTarget = this.damageMap.get(targetId);
        if (!perTarget || perTarget.size === 0) return;
        const totalDmg = [...perTarget.values()].reduce((a, b) => a + b, 0);
        for (const [attackerId, dmg] of perTarget) {
            const share = Math.round((dmg / totalDmg) * totalPoints);
            if (share > 0 && this.net.peers.has(attackerId)) {
                this.net.awardScore(attackerId, share);
            }
        }
        this.damageMap.delete(targetId);
    }

    // ── Respawn ──────────────────────────────────────────────────────────────

    private respawnLocalPlayer(now: number): void {
        const me = this.players.get(this.net.me.id)!;
        me.dead = false;
        me.hp = PLAYER_HP;
        me.respawnAt = null;
        me.invincibleUntil = now + INVINCIBILITY_MS;
        me.x = 50 + Math.random() * (FIELD_W - 100);
        me.y = GROUND_Y;
        me.vx = 0; me.vy = 0; me.knockbackVx = 0;
        this.ns.send<RespawnMsg>("respawn", { x: me.x, y: me.y });
    }

    // ── Mob simulation (host) ────────────────────────────────────────────────

    private stepMobs(dt: number, now: number): void {
        for (const mob of this.mobs.values()) {
            if (mob.dead) continue;

            if (mob.kind === "flying") {
                // Flying mob: hovers and swoops toward players
                const target = this.nearestLivingPlayer(mob.x);
                if (target) {
                    const dx = target.x - mob.x;
                    const dy = (target.y - 40) - mob.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    mob.vx = (dx / (dist || 1)) * FLYING_MOB_SPEED;
                    mob.vy = (dy / (dist || 1)) * FLYING_MOB_SPEED * 0.5;
                    mob.x += mob.vx * dt;
                    mob.y += mob.vy * dt;
                    // Keep in air
                    if (mob.y > GROUND_Y - 30) mob.y = GROUND_Y - 30;
                    if (mob.y < 50) mob.y = 50;
                    // Attack when close
                    if (dist < 50 && now >= mob.attackCooldownUntil) {
                        mob.attackCooldownUntil = now + MOB_ATTACK_COOLDOWN_MS;
                        mob.lastAttackAt = now;
                        this.sendHit(mob.id, target.id, "player", "mob_melee", MOB_ATTACK_DAMAGE);
                        this.applyHit(mob.id, target.id, "player", MOB_ATTACK_DAMAGE);
                    }
                }
            } else {
                // Ground mob: gravity + walk toward player
                mob.vy += GRAVITY * dt;
                mob.y += mob.vy * dt;
                if (mob.y >= GROUND_Y) { mob.y = GROUND_Y; mob.vy = 0; }
                if (mob.y >= GROUND_Y) {
                    const target = this.nearestLivingPlayer(mob.x);
                    if (target) {
                        mob.vx = Math.sign(target.x - mob.x) * MOB_SPEED;
                        mob.x += mob.vx * dt;
                        const distX = Math.abs(target.x - mob.x);
                        const distY = Math.abs(target.y - mob.y);
                        if (distX < MOB_ATTACK_RANGE && distY < 30 && now >= mob.attackCooldownUntil) {
                            mob.attackCooldownUntil = now + MOB_ATTACK_COOLDOWN_MS;
                            mob.lastAttackAt = now;
                            this.sendHit(mob.id, target.id, "player", "mob_melee", MOB_ATTACK_DAMAGE);
                            this.applyHit(mob.id, target.id, "player", MOB_ATTACK_DAMAGE);
                        }
                    }
                }
            }
        }
    }

    private pruneDeadMobs(): void {
        for (const [id, mob] of this.mobs) {
            if (mob.dead) this.mobs.delete(id);
        }
    }

    private nearestLivingPlayer(fromX: number): PlayerState | null {
        let best: PlayerState | null = null;
        let bestDist = Infinity;
        for (const p of this.players.values()) {
            if (p.dead) continue;
            // Use actual distance (X+Y) so elevated players are less prioritized
            const dx = Math.abs(p.x - fromX);
            const dy = Math.abs(p.y - GROUND_Y);
            const d = dx + dy * 0.5;
            if (d < bestDist) { bestDist = d; best = p; }
        }
        return best;
    }

    private spawnMob(now: number): void {
        const id = `mob-${now}-${Math.random().toString(36).slice(2, 6)}`;
        const x = 50 + Math.random() * (FIELD_W - 100);
        const kind: "ground" | "flying" = Math.random() < 0.3 ? "flying" : "ground";
        const y = kind === "flying" ? FLYING_MOB_Y + Math.random() * 80 : 0;
        const hp = kind === "flying" ? FLYING_MOB_HP : MOB_HP;
        const mob: MobState = { id, kind, x, y, vx: 0, vy: 0, hp, dead: false, attackCooldownUntil: 0, lastAttackAt: 0 };
        this.mobs.set(id, mob);
        this.ns.send<MobSpawnMsg>("mob_spawn", { id, x, y, kind });
    }

    private checkSpawnAccel(now: number): void {
        if (now - this.lastAccelAt >= SPAWN_ACCEL_EVERY_MS) {
            this.lastAccelAt = now;
            this.spawnIntervalMs = Math.max(SPAWN_INTERVAL_FLOOR_MS, this.spawnIntervalMs - SPAWN_INTERVAL_ACCEL_MS);
        }
    }

    // ── Health packs ──────────────────────────────────────────────────────────

    private spawnHealthPack(): void {
        const id = `hp-${performance.now()}-${Math.random().toString(36).slice(2, 5)}`;
        const x = 80 + Math.random() * (FIELD_W - 160);
        const y = GROUND_Y - HEALTH_PACK_RADIUS;
        this.healthPacks.set(id, { x, y, spawnedAt: performance.now() });
        this.ns.send<HealthPackMsg>("health_spawn", { id, x, y });
    }

    private expireHealthPacks(now: number): void {
        for (const [id, pack] of this.healthPacks) {
            if (now - pack.spawnedAt >= HEALTH_PACK_EXPIRE_MS) {
                this.healthPacks.delete(id);
                this.ns.send<HealthPickupMsg>("health_pickup", { packId: id });
            }
        }
    }

    private expireWeapons(now: number): void {
        for (const [id, wp] of this.weaponPickups) {
            if (now - wp.spawnedAt >= WEAPON_EXPIRE_MS) {
                this.weaponPickups.delete(id);
                this.ns.send<WeaponPickedMsg>("weapon_picked", { pickupId: id, playerId: "" });
            }
        }
    }

    private checkHealthPickup(me: PlayerState): void {
        for (const [id, pack] of this.healthPacks) {
            const dx = me.x - pack.x;
            const dy = (me.y - 30) - pack.y;
            if (dx * dx + dy * dy < (HEALTH_PACK_RADIUS + 15) ** 2) {
                me.hp = Math.min(PLAYER_HP, me.hp + HEALTH_PACK_HEAL);
                this.healthPacks.delete(id);
                this.ns.send<HealthPickupMsg>("health_pickup", { packId: id });
                break;
            }
        }
    }

    // ── Weapons ──────────────────────────────────────────────────────────────

    private spawnWeapon(): void {
        const id = `wp-${performance.now()}-${Math.random().toString(36).slice(2, 5)}`;
        const x = 80 + Math.random() * (FIELD_W - 160);
        const y = GROUND_Y - 20;
        const elapsed = performance.now() - this.gameStartedAt;
        let kind: string;
        if (elapsed >= WAND_MIN_TIME_MS && Math.random() < WAND_SPAWN_CHANCE) {
            kind = "wand";
        } else {
            const regularKinds = ["bow", "club", "spear"];
            kind = regularKinds[Math.floor(Math.random() * regularKinds.length)];
        }
        this.weaponPickups.set(id, { id, x, y, kind, spawnedAt: performance.now() });
        this.ns.send<WeaponSpawnMsg>("weapon_spawn", { id, x, y, kind });
    }

    private checkWeaponPickup(me: PlayerState): void {
        for (const [id, wp] of this.weaponPickups) {
            const dx = me.x - wp.x;
            const dy = (me.y - 20) - wp.y;
            if (dx * dx + dy * dy < 30 ** 2) {
                const dur = wp.kind === "wand" ? WAND_DURABILITY : WEAPON_DURABILITY;
                me.weapon = { kind: wp.kind, durability: dur };
                this.weaponPickups.delete(id);
                this.ns.send<WeaponPickedMsg>("weapon_picked", { pickupId: id, playerId: me.id });
                break;
            }
        }
    }

    private secretSpawnWand(): void {
        const me = this.players.get(this.net.me.id)!;
        me.weapon = { kind: "wand", durability: WAND_DURABILITY };
    }

    // ── Game over ────────────────────────────────────────────────────────────

    private checkGameOver(): void {
        if (this.gameOver) return;
        const livingPlayers = [...this.players.values()].filter(p => !p.dead);
        if (livingPlayers.length === 0 && this.players.size > 0) {
            this.gameOver = true;
            const scores: Array<[string, number]> = [];
            for (const [id, info] of this.net.peers) {
                scores.push([id, info.score]);
            }
            this.ns.send<GameOverMsg>("game_over", { scores });
            this.renderGameOver();
        }
    }

    // ── Network broadcasting ─────────────────────────────────────────────────

    private broadcastInput(): void {
        const me = this.players.get(this.net.me.id)!;
        this.ns.send<InputMsg>("input", {
            x: me.x, y: me.y, vx: me.vx, vy: me.vy,
            facingRight: me.facingRight, ducking: me.ducking,
            hp: me.hp, dead: me.dead,
        });
    }

    private broadcastMobState(): void {
        const mobs: MobStateMsg["mobs"] = [];
        for (const mob of this.mobs.values()) {
            mobs.push({ id: mob.id, x: mob.x, y: mob.y, hp: mob.hp, dead: mob.dead, kind: mob.kind });
        }
        this.ns.send<MobStateMsg>("mob_state", { mobs });
    }

    // ── Network handlers ─────────────────────────────────────────────────────

    private registerNetwork(): void {
        this.ns.on<InputMsg>("input", (msg, peerId) => {
            const p = this.players.get(peerId);
            if (!p) return;
            p.x = msg.x; p.y = msg.y; p.vx = msg.vx; p.vy = msg.vy;
            p.facingRight = msg.facingRight; p.ducking = msg.ducking;
            p.hp = msg.hp; p.dead = msg.dead;
        });

        this.ns.on<AttackMsg>("attack", (msg, peerId) => {
            const p = this.players.get(peerId);
            if (!p) return;
            if (!this.getAttackDef(msg.attackKey)) return;
            p.activeAttack = { key: msg.attackKey, startedAt: performance.now(), hitTargets: new Set() };
            p.x = msg.originX; p.y = msg.originY; p.facingRight = msg.facingRight;
            if (msg.attackKey === "power" || msg.attackKey === "roundhouse") {
                this.screenShake = msg.attackKey === "power" ? 12 : 6;
                this.kapowEffects.push({ x: msg.originX, y: msg.originY - 40, startedAt: performance.now(), text: msg.attackKey === "power" ? "KAPOW!" : "WHAM!" });
            }
        });

        this.ns.on<HitMsg>("hit", (msg) => {
            this.applyHit(msg.attackerId, msg.targetId, msg.targetKind, msg.damage);
            // Trigger mob attack animation on non-host peers
            const mob = this.mobs.get(msg.attackerId);
            if (mob) mob.lastAttackAt = performance.now();
        });

        this.ns.on<MobSpawnMsg>("mob_spawn", (msg) => {
            if (!this.mobs.has(msg.id)) {
                const hp = msg.kind === "flying" ? FLYING_MOB_HP : MOB_HP;
                this.mobs.set(msg.id, { id: msg.id, kind: msg.kind || "ground", x: msg.x, y: msg.y, vx: 0, vy: 0, hp, dead: false, attackCooldownUntil: 0, lastAttackAt: 0 });
            }
        });

        this.ns.on<MobStateMsg>("mob_state", (msg) => {
            if (this.isHost()) return;
            const hostIds = new Set<string>();
            for (const m of msg.mobs) {
                hostIds.add(m.id);
                const mob = this.mobs.get(m.id);
                if (mob) { mob.x = m.x; mob.y = m.y; mob.hp = m.hp; mob.dead = m.dead; }
                else { this.mobs.set(m.id, { id: m.id, kind: (m.kind as "ground" | "flying") || "ground", x: m.x, y: m.y, vx: 0, vy: 0, hp: m.hp, dead: m.dead, attackCooldownUntil: 0, lastAttackAt: 0 }); }
            }
            for (const id of this.mobs.keys()) { if (!hostIds.has(id)) this.mobs.delete(id); }
        });

        this.ns.on<KillMsg>("kill", (msg) => {
            this.damageMap.delete(msg.targetId);
            if (msg.targetKind === "mob") { const mob = this.mobs.get(msg.targetId); if (mob) mob.dead = true; }
        });

        this.ns.on<RespawnMsg>("respawn", (msg, peerId) => {
            const p = this.players.get(peerId);
            if (!p) return;
            p.dead = false; p.hp = PLAYER_HP; p.x = msg.x; p.y = msg.y;
            p.invincibleUntil = performance.now() + INVINCIBILITY_MS; p.respawnAt = null;
        });

        this.ns.on<object>("sync_request", (_msg, peerId) => {
            if (!this.isHost()) return;
            const players: SyncMsg["players"] = [];
            for (const p of this.players.values()) {
                players.push({ id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, facingRight: p.facingRight, ducking: p.ducking, hp: p.hp, dead: p.dead, color: p.color, name: p.name });
            }
            const mobs: SyncMsg["mobs"] = [];
            for (const m of this.mobs.values()) { mobs.push({ id: m.id, x: m.x, y: m.y, hp: m.hp, dead: m.dead, kind: m.kind }); }
            const scores: Array<[string, number]> = [...this.net.peers.entries()].map(([id, info]) => [id, info.score]);
            const platformState = this.platforms.map((plat, i) => ({ x: plat.x, y: plat.y, w: plat.w, gone: this.platformGone.has(i) }));
            const elapsed = performance.now() - this.gameStartedAt;
            this.ns.send<SyncMsg>("sync", { players, mobs, spawnIntervalMs: this.spawnIntervalMs, gameOver: this.gameOver, scores, platformState, gameStartedAt: elapsed }, peerId);
        });

        this.ns.on<SyncMsg>("sync", (msg) => {
            this.spawnIntervalMs = msg.spawnIntervalMs;
            this.gameOver = msg.gameOver;
            if (msg.gameStartedAt) {
                this.gameStartedAt = performance.now() - msg.gameStartedAt;
            }
            if (msg.platformState) {
                for (let i = 0; i < msg.platformState.length && i < this.platforms.length; i++) {
                    this.platforms[i] = { ...this.platforms[i], x: msg.platformState[i].x, y: msg.platformState[i].y, w: msg.platformState[i].w };
                    if (msg.platformState[i].gone) this.platformGone.add(i);
                    else this.platformGone.delete(i);
                }
            }
            for (const mp of msg.players) {
                if (mp.id === this.net.me.id) continue;
                const existing = this.players.get(mp.id);
                if (existing) { existing.x = mp.x; existing.y = mp.y; existing.vx = mp.vx; existing.vy = mp.vy; existing.facingRight = mp.facingRight; existing.ducking = mp.ducking; existing.hp = mp.hp; existing.dead = mp.dead; }
                else { this.players.set(mp.id, { id: mp.id, x: mp.x, y: mp.y, vx: mp.vx, vy: mp.vy, knockbackVx: 0, facingRight: mp.facingRight, ducking: mp.ducking, hp: mp.hp, dead: mp.dead, respawnAt: null, invincibleUntil: 0, color: mp.color, name: mp.name, activeAttack: null, cooldowns: {}, weapon: null }); }
                const peerInfo = this.net.peers.get(mp.id);
                if (peerInfo && !this.avatarImgs.has(mp.id)) {
                    this.loadAvatarImg(mp.id, peerInfo.avatar);
                }
            }
            for (const mm of msg.mobs) {
                this.mobs.set(mm.id, { id: mm.id, kind: (mm.kind as "ground" | "flying") || "ground", x: mm.x, y: mm.y, vx: 0, vy: 0, hp: mm.hp, dead: mm.dead, attackCooldownUntil: 0, lastAttackAt: 0 });
            }
            if (this.gameOver) this.renderGameOver();
        });

        this.ns.on<GameOverMsg>("game_over", () => { this.gameOver = true; this.renderGameOver(); });
        this.ns.on<object>("restart", () => { this.restartGame(); });
        this.ns.on<HealthPackMsg>("health_spawn", (msg) => { this.healthPacks.set(msg.id, { x: msg.x, y: msg.y, spawnedAt: performance.now() }); });
        this.ns.on<HealthPickupMsg>("health_pickup", (msg) => { this.healthPacks.delete(msg.packId); });
        this.ns.on<PlatCrumbleMsg>("plat_crumble", (msg) => {
            if (!this.platformCrumbleStart.has(msg.idx)) {
                this.platformCrumbleStart.set(msg.idx, performance.now());
            }
        });
        this.ns.on<PlatGoneMsg>("plat_gone", (msg) => {
            this.platformGone.add(msg.idx);
            this.platformCrumbleStart.delete(msg.idx);
        });
        this.ns.on<PlatRespawnMsg>("plat_respawn", (msg) => {
            this.platforms[msg.idx] = { ...this.platforms[msg.idx], x: msg.x, y: msg.y, w: msg.w };
            this.platformGone.delete(msg.idx);
        });
        this.ns.on<ModeMsg>("mode", (msg) => { this.friendlyFire = msg.friendlyFire; });
        this.ns.on<LPlatTrapMsg>("l_trap", (msg) => { this.activateLTrap(msg.trap); });
        this.ns.on<LPlatResetMsg>("l_reset", () => { this.resetLPlatform(); });
        this.ns.on<WeaponSpawnMsg>("weapon_spawn", (msg) => { this.weaponPickups.set(msg.id, { id: msg.id, x: msg.x, y: msg.y, kind: msg.kind, spawnedAt: performance.now() }); });
        this.ns.on<WeaponPickedMsg>("weapon_picked", (msg) => { this.weaponPickups.delete(msg.pickupId); });
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private draw(now: number): void {
        const c = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        c.clearRect(0, 0, w, h);
        c.save();
        // Screen shake
        if (this.screenShake > 0) {
            const sx = (Math.random() - 0.5) * this.screenShake * 2;
            const sy = (Math.random() - 0.5) * this.screenShake * 2;
            c.translate(sx * (w / FIELD_W), sy * (h / FIELD_H));
        }
        c.scale(w / FIELD_W, h / FIELD_H);

        this.drawBackground(c);

        // Draw weapon pickups (blink when about to expire)
        for (const wp of this.weaponPickups.values()) {
            const timeLeft = WEAPON_EXPIRE_MS - (now - wp.spawnedAt);
            if (timeLeft < ITEM_BLINK_MS && Math.floor(now / 150) % 2 === 0) continue;
            this.drawWeaponPickup(c, wp, now);
        }

        // Draw health packs (blink when about to expire)
        for (const pack of this.healthPacks.values()) {
            const timeLeft = HEALTH_PACK_EXPIRE_MS - (now - pack.spawnedAt);
            if (timeLeft < ITEM_BLINK_MS && Math.floor(now / 150) % 2 === 0) continue;
            this.drawHealthPack(c, pack, now);
        }

        // Draw mobs
        for (const mob of this.mobs.values()) {
            if (!mob.dead) this.drawMob(c, mob, now);
        }

        // Draw players
        for (const p of this.players.values()) {
            if (!p.dead) this.drawStickman(c, p, now);
            else if (p.id !== this.net.me.id) continue;
        }

        // Draw kapow effects
        for (let i = this.kapowEffects.length - 1; i >= 0; i--) {
            const fx = this.kapowEffects[i];
            const age = now - fx.startedAt;
            if (age > 600) { this.kapowEffects.splice(i, 1); continue; }
            const alpha = 1 - age / 600;
            const scale = 1 + age / 300;
            c.save();
            c.globalAlpha = alpha;
            c.font = `bold ${Math.round(18 * scale)}px sans-serif`;
            c.textAlign = "center";
            c.fillStyle = "#ff4444";
            c.strokeStyle = "#fff";
            c.lineWidth = 2;
            c.strokeText(fx.text, fx.x, fx.y - age * 0.05);
            c.fillText(fx.text, fx.x, fx.y - age * 0.05);
            c.restore();
        }

        c.restore();
    }

    private drawBackground(c: CanvasRenderingContext2D): void {
        // Sunny sky gradient
        const grad = c.createLinearGradient(0, 0, 0, FIELD_H);
        grad.addColorStop(0, "#87ceeb");
        grad.addColorStop(0.7, "#b8e4f0");
        grad.addColorStop(1, "#e0f4ff");
        c.fillStyle = grad;
        c.fillRect(0, 0, FIELD_W, FIELD_H);

        // Smiling sun (top-right)
        const sunX = FIELD_W - 90;
        const sunY = 70;
        const sunR = 40;
        // Sun rays
        c.save();
        c.strokeStyle = "#ffd633";
        c.lineWidth = 3;
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
            c.beginPath();
            c.moveTo(sunX + Math.cos(a) * (sunR + 6), sunY + Math.sin(a) * (sunR + 6));
            c.lineTo(sunX + Math.cos(a) * (sunR + 18), sunY + Math.sin(a) * (sunR + 18));
            c.stroke();
        }
        c.restore();
        // Sun body
        c.fillStyle = "#ffdd00";
        c.beginPath(); c.arc(sunX, sunY, sunR, 0, Math.PI * 2); c.fill();
        // Sun face - eyes
        c.fillStyle = "#333";
        c.beginPath(); c.arc(sunX - 12, sunY - 8, 4, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(sunX + 12, sunY - 8, 4, 0, Math.PI * 2); c.fill();
        // Sun face - smile
        c.strokeStyle = "#333";
        c.lineWidth = 3;
        c.lineCap = "round";
        c.beginPath(); c.arc(sunX, sunY + 2, 16, 0.2, Math.PI - 0.2); c.stroke();

        // Clouds
        c.fillStyle = "#ffffff";
        c.globalAlpha = 0.8;
        this.drawCloud(c, 120, 80, 1);
        this.drawCloud(c, 450, 50, 1.3);
        this.drawCloud(c, 800, 100, 0.9);
        c.globalAlpha = 1;

        // Background buildings
        c.fillStyle = "#c8b99a";
        c.fillRect(30, GROUND_Y - 180, 80, 180);
        c.fillStyle = "#a8c4d4";
        c.fillRect(130, GROUND_Y - 130, 60, 130);
        c.fillStyle = "#d4b8a0";
        c.fillRect(220, GROUND_Y - 200, 90, 200);
        c.fillStyle = "#b8c8a8";
        c.fillRect(450, GROUND_Y - 160, 70, 160);
        c.fillStyle = "#a0b8d4";
        c.fillRect(550, GROUND_Y - 220, 100, 220);
        c.fillStyle = "#c8a8b8";
        c.fillRect(900, GROUND_Y - 150, 75, 150);
        c.fillStyle = "#b4c4b4";
        c.fillRect(1020, GROUND_Y - 190, 85, 190);
        c.fillStyle = "#d4c8a8";
        c.fillRect(1120, GROUND_Y - 140, 65, 140);

        // Building windows (pre-generated, stable)
        c.fillStyle = "#6cb4d4";
        c.globalAlpha = 0.7;
        for (const w of this.windowLights) {
            c.fillRect(w.x, w.y, 8, 12);
        }
        c.globalAlpha = 1;

        // Ground (sidewalk + road)
        c.fillStyle = "#888888";
        c.fillRect(0, GROUND_Y, FIELD_W, FIELD_H - GROUND_Y);
        // Road line markings
        c.strokeStyle = "#cccccc";
        c.lineWidth = 2;
        c.setLineDash([20, 15]);
        c.beginPath(); c.moveTo(0, GROUND_Y + 20); c.lineTo(FIELD_W, GROUND_Y + 20); c.stroke();
        c.setLineDash([]);
        // Curb
        c.fillStyle = "#aaa";
        c.fillRect(0, GROUND_Y - 3, FIELD_W, 3);

        // Draw platforms (cars / crates / dumpsters)
        const now = performance.now();
        for (let i = 0; i < this.platforms.length; i++) {
            if (this.platformGone.has(i)) continue;
            const plat = this.platforms[i];
            const crumbleStart = this.platformCrumbleStart.get(i);
            if (crumbleStart) {
                const elapsed = now - crumbleStart;
                const progress = Math.min(1, elapsed / CRUMBLE_TIME_MS);
                c.save();
                c.globalAlpha = 1 - progress * 0.6;
                const shake = progress * 3 * (Math.random() > 0.5 ? 1 : -1);
                c.translate(shake, 0);
                this.drawPlatform(c, plat);
                c.restore();
            } else {
                this.drawPlatform(c, plat);
            }
        }

        // Draw L-platform
        this.drawLPlatform(c);
    }

    private drawPlatform(c: CanvasRenderingContext2D, plat: Platform): void {
        c.save();
        if (plat.kind === "car") {
            // Car body
            c.fillStyle = plat.color;
            c.beginPath();
            c.roundRect(plat.x, plat.y + 10, plat.w, plat.h - 10, 4);
            c.fill();
            // Car roof
            c.fillStyle = plat.color;
            c.beginPath();
            c.roundRect(plat.x + plat.w * 0.2, plat.y, plat.w * 0.6, 14, [4, 4, 0, 0]);
            c.fill();
            // Windshield
            c.fillStyle = "#1a1a2e";
            c.fillRect(plat.x + plat.w * 0.25, plat.y + 2, plat.w * 0.2, 10);
            c.fillRect(plat.x + plat.w * 0.55, plat.y + 2, plat.w * 0.2, 10);
            // Wheels
            c.fillStyle = "#111";
            c.beginPath(); c.arc(plat.x + 20, plat.y + plat.h, 8, 0, Math.PI * 2); c.fill();
            c.beginPath(); c.arc(plat.x + plat.w - 20, plat.y + plat.h, 8, 0, Math.PI * 2); c.fill();
            // Headlights
            c.fillStyle = "#ffee88";
            c.fillRect(plat.x + plat.w - 4, plat.y + 18, 4, 6);
            c.fillRect(plat.x, plat.y + 18, 4, 6);
        } else if (plat.kind === "crate") {
            c.fillStyle = plat.color;
            c.fillRect(plat.x, plat.y, plat.w, plat.h);
            // Cross lines on crate
            c.strokeStyle = "#6b4e0a";
            c.lineWidth = 2;
            c.beginPath(); c.moveTo(plat.x, plat.y); c.lineTo(plat.x + plat.w, plat.y + plat.h); c.stroke();
            c.beginPath(); c.moveTo(plat.x + plat.w, plat.y); c.lineTo(plat.x, plat.y + plat.h); c.stroke();
            c.strokeStyle = "#a07b1a";
            c.strokeRect(plat.x, plat.y, plat.w, plat.h);
        } else {
            // Dumpster
            c.fillStyle = plat.color;
            c.fillRect(plat.x, plat.y, plat.w, plat.h);
            c.fillStyle = "#2a4a28";
            c.fillRect(plat.x + 4, plat.y + 4, plat.w - 8, 8);
            c.strokeStyle = "#1a3a18";
            c.lineWidth = 2;
            c.strokeRect(plat.x, plat.y, plat.w, plat.h);
        }
        c.restore();
    }

    private drawLPlatform(c: CanvasRenderingContext2D): void {
        c.save();

        // L shape: vertical wall rises ABOVE the ledge on the left,
        //          horizontal ledge extends RIGHT from the base of the vertical.
        //
        //   |
        //   |
        //   |
        //   |______________
        //
        const vertX = L_PLAT_X + this.lPlatPushOffset;
        const vertTop = L_LEDGE_Y - L_VERT_H;
        const ledgeX = L_PLAT_X + L_VERT_W;
        const ledgeY = L_LEDGE_Y;

        // Vertical part (the wall that can push right)
        c.fillStyle = "#555";
        c.fillRect(vertX, vertTop, L_VERT_W, L_VERT_H + L_HORIZ_H);
        // Metal edge highlight
        c.fillStyle = "#6a6a6a";
        c.fillRect(vertX, vertTop, L_VERT_W, 3);
        c.fillStyle = "#444";
        c.fillRect(vertX + L_VERT_W - 3, vertTop, 3, L_VERT_H + L_HORIZ_H);
        // Rivets on vertical
        c.fillStyle = "#888";
        for (let ry = vertTop + 20; ry < ledgeY + L_HORIZ_H; ry += 22) {
            c.beginPath(); c.arc(vertX + L_VERT_W / 2, ry, 2.5, 0, Math.PI * 2); c.fill();
        }

        // Horizontal part (the ledge / trapdoor) — at the bottom, extending right
        if (!this.lPlatTrapdoorOpen) {
            c.fillStyle = "#666";
            c.fillRect(ledgeX, ledgeY, L_HORIZ_W, L_HORIZ_H);
            // Surface highlight
            c.fillStyle = "#777";
            c.fillRect(ledgeX, ledgeY, L_HORIZ_W, 3);
            // Warning stripes on underside
            c.fillStyle = "#cc8800";
            const stripeW = 12;
            for (let sx = ledgeX; sx < ledgeX + L_HORIZ_W; sx += stripeW * 2) {
                c.fillRect(sx, ledgeY + L_HORIZ_H - 4, stripeW, 4);
            }
        } else {
            // Trapdoor open — two halves hinge downward
            c.globalAlpha = 0.5;
            c.fillStyle = "#666";
            c.save();
            c.translate(ledgeX, ledgeY + L_HORIZ_H);
            c.rotate(0.7);
            c.fillRect(0, 0, L_HORIZ_W / 2, L_HORIZ_H);
            c.restore();
            c.save();
            c.translate(ledgeX + L_HORIZ_W, ledgeY + L_HORIZ_H);
            c.rotate(-0.7);
            c.fillRect(-L_HORIZ_W / 2, 0, L_HORIZ_W / 2, L_HORIZ_H);
            c.restore();
            c.globalAlpha = 1;
        }

        // Warning "!" blinks 3s before trap fires
        if (this.lPlatOccupiedSince > 0 && this.lPlatNextTrapAt > 0 && !this.lPlatTrapdoorOpen && this.lPlatPushOffset === 0) {
            const timeLeft = this.lPlatNextTrapAt - performance.now();
            if (timeLeft < 3000) {
                c.fillStyle = "#ff0000";
                c.globalAlpha = 0.5 + Math.sin(performance.now() / 100) * 0.3;
                c.font = "bold 14px sans-serif";
                c.textAlign = "center";
                c.fillText("!", ledgeX + L_HORIZ_W / 2, ledgeY - 10);
                c.globalAlpha = 1;
            }
        }

        c.restore();
    }

    private drawCloud(c: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
        c.save();
        c.translate(x, y);
        c.scale(scale, scale);
        c.beginPath();
        c.arc(0, 0, 20, 0, Math.PI * 2);
        c.arc(25, -5, 16, 0, Math.PI * 2);
        c.arc(-25, -3, 18, 0, Math.PI * 2);
        c.arc(15, 8, 14, 0, Math.PI * 2);
        c.arc(-15, 6, 15, 0, Math.PI * 2);
        c.fill();
        c.restore();
    }

    private drawStickman(c: CanvasRenderingContext2D, p: PlayerState, now: number): void {
        const invincible = now < p.invincibleUntil;
        if (invincible && Math.floor(now / 100) % 2 === 0) return; // flash

        c.save();
        c.strokeStyle = p.color;
        c.lineWidth = 3;
        c.lineCap = "round";

        const cx = p.x;
        const legLen = p.ducking ? 10 : 20;
        const bodyH = p.ducking ? 30 : 50;
        const headR = 14;
        const feetY = p.y;
        const bodyBot = feetY - legLen;
        const bodyTop = bodyBot - bodyH;
        const headY = bodyTop - headR;

        // HP bar above head
        const barW = 36;
        const barH = 5;
        const barX = cx - barW / 2;
        const barY = headY - headR - 10;
        const hpFrac = Math.max(0, p.hp / PLAYER_HP);
        c.fillStyle = "#222";
        c.globalAlpha = 0.7;
        c.fillRect(barX, barY, barW, barH);
        c.globalAlpha = 1;
        c.fillStyle = hpFrac > 0.5 ? "#4caf50" : hpFrac > 0.25 ? "#ff9800" : "#f44336";
        c.fillRect(barX, barY, barW * hpFrac, barH);

        // Avatar head
        const avatarEntry = this.avatarImgs.get(p.id);
        if (avatarEntry && avatarEntry.img.complete && avatarEntry.img.naturalWidth > 0) {
            c.drawImage(avatarEntry.img, cx - headR, headY - headR, headR * 2, headR * 2);
        } else {
            c.beginPath(); c.arc(cx, headY, headR, 0, Math.PI * 2); c.stroke();
        }

        // Body
        c.beginPath(); c.moveTo(cx, bodyTop); c.lineTo(cx, bodyBot); c.stroke();

        // Legs (animated when walking)
        if (p.ducking) {
            c.beginPath(); c.moveTo(cx, bodyBot); c.lineTo(cx - 14, feetY); c.stroke();
            c.beginPath(); c.moveTo(cx, bodyBot); c.lineTo(cx + 14, feetY); c.stroke();
        } else if (Math.abs(p.vx) > 10) {
            const cycle = Math.sin(now / 100);
            const kneeOffset1 = cycle * 12;
            const kneeOffset2 = -cycle * 12;
            c.beginPath(); c.moveTo(cx, bodyBot); c.lineTo(cx + kneeOffset1, feetY); c.stroke();
            c.beginPath(); c.moveTo(cx, bodyBot); c.lineTo(cx + kneeOffset2, feetY); c.stroke();
        } else {
            c.beginPath(); c.moveTo(cx, bodyBot); c.lineTo(cx - 8, feetY); c.stroke();
            c.beginPath(); c.moveTo(cx, bodyBot); c.lineTo(cx + 8, feetY); c.stroke();
        }

        // Arms
        const armY = bodyTop + 10;
        if (p.activeAttack) {
            this.drawAttackArms(c, p, armY, now);
        } else if (p.weapon) {
            const dir = p.facingRight ? 1 : -1;
            this.drawHeldWeapon(c, p, cx, armY, dir, now);
            // Back arm relaxed
            c.strokeStyle = p.color;
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(cx, armY); c.lineTo(cx - dir * 10, armY + 18); c.stroke();
        } else {
            const dir = p.facingRight ? 1 : -1;
            c.beginPath(); c.moveTo(cx, armY); c.lineTo(cx + dir * 20, armY + 15); c.stroke();
            c.beginPath(); c.moveTo(cx, armY); c.lineTo(cx - dir * 10, armY + 18); c.stroke();
        }

        c.restore();
    }

    private drawHeldWeapon(c: CanvasRenderingContext2D, p: PlayerState, cx: number, armY: number, dir: number, now: number): void {
        if (!p.weapon) return;
        const wk = p.weapon.kind;
        // Arm holding the weapon (angled up slightly)
        c.strokeStyle = p.color;
        c.lineWidth = 3;
        const handX = cx + dir * 18;
        const handY = armY + 8;
        c.beginPath(); c.moveTo(cx, armY); c.lineTo(handX, handY); c.stroke();

        if (wk === "bow") {
            // Bow held at side — curved arc + string
            c.strokeStyle = "#8B6914";
            c.lineWidth = 2.5;
            c.beginPath();
            c.arc(handX + dir * 3, handY, 12, dir > 0 ? -1 : Math.PI - 1, dir > 0 ? 1 : Math.PI + 1);
            c.stroke();
            // Bowstring
            c.strokeStyle = "#777";
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(handX + dir * 3 + 12 * Math.cos(dir > 0 ? -1 : Math.PI - 1), handY + 12 * Math.sin(-1));
            c.lineTo(handX + dir * 3 + 12 * Math.cos(dir > 0 ? 1 : Math.PI + 1), handY + 12 * Math.sin(1));
            c.stroke();
        } else if (wk === "club") {
            // Club resting on shoulder
            c.strokeStyle = "#8B4513";
            c.lineWidth = 5;
            c.beginPath(); c.moveTo(handX, handY); c.lineTo(handX + dir * 5, handY - 25); c.stroke();
            // Club head
            c.fillStyle = "#5C3317";
            c.beginPath(); c.arc(handX + dir * 5, handY - 27, 7, 0, Math.PI * 2); c.fill();
        } else if (wk === "spear") {
            // Spear held diagonally pointing forward
            c.strokeStyle = "#8B6914";
            c.lineWidth = 2.5;
            c.beginPath(); c.moveTo(handX - dir * 8, handY + 10); c.lineTo(handX + dir * 28, handY - 12); c.stroke();
            // Spear tip
            c.fillStyle = "#888";
            c.beginPath();
            c.moveTo(handX + dir * 28, handY - 12);
            c.lineTo(handX + dir * 35, handY - 15);
            c.lineTo(handX + dir * 28, handY - 17);
            c.closePath(); c.fill();
        } else if (wk === "wand") {
            // Magic wand held upright with glowing tip
            c.strokeStyle = "#7B2D8B";
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(handX, handY); c.lineTo(handX + dir * 4, handY - 22); c.stroke();
            // Glowing orb at tip
            const glow = 3 + Math.sin(now * 0.008) * 1.5;
            c.fillStyle = "rgba(255,68,255,0.3)";
            c.beginPath(); c.arc(handX + dir * 4, handY - 24, glow + 3, 0, Math.PI * 2); c.fill();
            c.fillStyle = "#ff44ff";
            c.beginPath(); c.arc(handX + dir * 4, handY - 24, glow, 0, Math.PI * 2); c.fill();
            // Tiny sparkles
            c.fillStyle = "#ffaaff";
            const t = now * 0.003;
            for (let i = 0; i < 3; i++) {
                const angle = t + i * (Math.PI * 2 / 3);
                const sx = handX + dir * 4 + Math.cos(angle) * (glow + 4);
                const sy = handY - 24 + Math.sin(angle) * (glow + 4);
                c.beginPath(); c.arc(sx, sy, 1.2, 0, Math.PI * 2); c.fill();
            }
        }
    }

    private drawAttackArms(c: CanvasRenderingContext2D, p: PlayerState, armY: number, now: number): void {
        if (!p.activeAttack) return;
        const def = this.getAttackDef(p.activeAttack.key);
        if (!def) return;
        const progress = Math.min(1, (now - p.activeAttack.startedAt) / def.duration);
        const dir = p.facingRight ? 1 : -1;
        const reach = def.range * 0.6 * progress;
        const legL = p.ducking ? 10 : 20;
        const bodyBot = p.y - legL;

        c.save();
        c.lineWidth = 4;

        if (p.activeAttack.key.startsWith("weapon_")) {
            // Weapon attack animations — checked first to avoid isAoe catching wand
            this.drawWeaponAttack(c, p, armY, dir, progress, reach, now);
        } else if (def.isAoe) {
            // Power attack — both arms extended + shockwave ring
            c.strokeStyle = "#ff4444";
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x + reach, armY - 10); c.stroke();
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x - reach, armY - 10); c.stroke();
            c.globalAlpha = 1 - progress;
            c.beginPath(); c.arc(p.x, bodyBot - 10, def.range * progress, 0, Math.PI * 2); c.stroke();
        } else if (p.activeAttack.key === "roundhouse") {
            // Roundhouse — sweeping leg in a wide arc
            c.strokeStyle = "#ffaa00";
            const angle = dir * progress * Math.PI;
            const legReach = reach * 1.2;
            c.beginPath(); c.moveTo(p.x, bodyBot); c.lineTo(p.x + Math.cos(angle) * legReach, bodyBot - 10 + Math.sin(angle) * legReach * 0.5); c.stroke();
            // Trail arc
            c.globalAlpha = 0.4;
            c.beginPath(); c.arc(p.x, bodyBot - 5, legReach * 0.8, dir > 0 ? -0.3 : Math.PI - 0.5, dir > 0 ? progress * Math.PI : Math.PI + progress * Math.PI); c.stroke();
            // Normal arms stay relaxed
            c.globalAlpha = 1;
            c.strokeStyle = p.color;
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x + dir * 15, armY + 12); c.stroke();
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x - dir * 10, armY + 14); c.stroke();
        } else if (p.activeAttack.key === "kick") {
            // Kick — leg bends at knee then extends forward from lower body
            c.strokeStyle = "#ffcc00";
            const feetY = p.y;
            const kneeY = bodyBot + (feetY - bodyBot) * 0.5;
            const legReach = reach * 1.1;
            // Standing leg (back)
            c.strokeStyle = p.color;
            c.beginPath(); c.moveTo(p.x, bodyBot); c.lineTo(p.x - dir * 6, feetY); c.stroke();
            // Kicking leg: hip → knee → foot extending forward
            c.strokeStyle = "#ffcc00";
            c.lineWidth = 4;
            const kneeX = p.x + dir * 8;
            c.beginPath(); c.moveTo(p.x, bodyBot); c.lineTo(kneeX, kneeY); c.stroke();
            c.beginPath(); c.moveTo(kneeX, kneeY); c.lineTo(p.x + dir * legReach, kneeY - 8); c.stroke();
            // Foot
            c.fillStyle = "#ffcc00";
            c.beginPath(); c.arc(p.x + dir * legReach, kneeY - 8, 4, 0, Math.PI * 2); c.fill();
            // Resting arms
            c.strokeStyle = p.color;
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x + dir * 12, armY + 15); c.stroke();
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x - dir * 10, armY + 14); c.stroke();
        } else {
            // Punch — fist extends forward
            c.strokeStyle = p.color;
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x + dir * reach, armY - 5); c.stroke();
            // Trailing arm relaxed
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x - dir * 12, armY + 12); c.stroke();
            // Fist dot
            c.fillStyle = p.color;
            c.beginPath(); c.arc(p.x + dir * reach, armY - 5, 4, 0, Math.PI * 2); c.fill();
        }
        c.restore();
    }

    private drawWeaponAttack(c: CanvasRenderingContext2D, p: PlayerState, armY: number, dir: number, progress: number, reach: number, now: number): void {
        const wk = p.activeAttack!.key.replace("weapon_", "");
        if (wk === "club") {
            c.strokeStyle = "#8B4513";
            c.lineWidth = 5;
            const swingAngle = -Math.PI / 2 + progress * Math.PI * 0.8;
            const clubLen = 35;
            c.beginPath(); c.moveTo(p.x, armY);
            c.lineTo(p.x + Math.cos(swingAngle * dir) * clubLen, armY + Math.sin(swingAngle) * clubLen);
            c.stroke();
            c.fillStyle = "#5C3317";
            c.beginPath(); c.arc(p.x + Math.cos(swingAngle * dir) * clubLen, armY + Math.sin(swingAngle) * clubLen, 6, 0, Math.PI * 2); c.fill();
        } else if (wk === "bow") {
            c.strokeStyle = "#8B6914";
            c.lineWidth = 2;
            c.beginPath(); c.arc(p.x + dir * 10, armY + 5, 18, dir > 0 ? -0.8 : Math.PI - 0.8, dir > 0 ? 0.8 : Math.PI + 0.8); c.stroke();
            const maxFlight = dir > 0 ? FIELD_W - p.x : p.x;
            const arrowDist = maxFlight * progress;
            c.strokeStyle = "#333";
            c.lineWidth = 2;
            const arrowLen = 30;
            const arrowTip = p.x + dir * (15 + arrowDist);
            const arrowTail = arrowTip - dir * arrowLen;
            c.beginPath(); c.moveTo(arrowTail, armY + 5); c.lineTo(arrowTip, armY + 5); c.stroke();
            c.fillStyle = "#666";
            c.beginPath(); c.moveTo(arrowTip, armY + 5);
            c.lineTo(arrowTip - dir * 8, armY + 2); c.lineTo(arrowTip - dir * 8, armY + 8); c.closePath(); c.fill();
        } else if (wk === "spear") {
            c.strokeStyle = "#8B6914";
            c.lineWidth = 3;
            const spearLen = reach * 1.2;
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x + dir * spearLen, armY - 3); c.stroke();
            c.fillStyle = "#888";
            c.beginPath(); c.moveTo(p.x + dir * spearLen, armY - 3);
            c.lineTo(p.x + dir * (spearLen + 10), armY - 3);
            c.lineTo(p.x + dir * spearLen, armY - 8); c.closePath(); c.fill();
        } else if (wk === "wand") {
            // Wand in hand
            c.strokeStyle = "#7B2D8B";
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x + dir * 25, armY - 10); c.stroke();
            c.fillStyle = "#ff44ff";
            c.beginPath(); c.arc(p.x + dir * 25, armY - 10, 5 + Math.sin(now * 0.02) * 2, 0, Math.PI * 2); c.fill();
            // Wall of fire — sweeps from player to field edge
            const maxFireDist = dir > 0 ? FIELD_W - p.x : p.x;
            const fireFront = maxFireDist * progress;
            const fireLeft = dir > 0 ? p.x + 20 : p.x - fireFront;
            const fireRight = dir > 0 ? p.x + fireFront : p.x - 20;
            const fireW = fireRight - fireLeft;
            if (fireW > 5) {
                const numFlames = Math.max(3, Math.floor(fireW / 20));
                const t = now * 0.006;
                const baseY = p.y;
                // Draw flames from player's feet upward
                for (let i = 0; i < numFlames; i++) {
                    const fx = fireLeft + (i + 0.5) * (fireW / numFlames);
                    const phase = fx * 0.04 + t + i * 1.3;
                    const flameH = 100 + Math.sin(phase * 2.1) * 40 + Math.sin(phase * 4.7) * 20;
                    const flameW = 14 + Math.sin(phase * 3.2) * 5;
                    // Outer flame (red/orange)
                    c.globalAlpha = 0.8 * (1 - progress * 0.3);
                    const outerGrad = c.createLinearGradient(fx, baseY, fx, baseY - flameH);
                    outerGrad.addColorStop(0, "#ff6600");
                    outerGrad.addColorStop(0.4, "#ff3300");
                    outerGrad.addColorStop(0.8, "#aa0000");
                    outerGrad.addColorStop(1, "rgba(60,0,0,0)");
                    c.fillStyle = outerGrad;
                    c.beginPath();
                    c.moveTo(fx - flameW, baseY);
                    c.quadraticCurveTo(fx - flameW * 1.2, baseY - flameH * 0.5, fx, baseY - flameH);
                    c.quadraticCurveTo(fx + flameW * 1.2, baseY - flameH * 0.5, fx + flameW, baseY);
                    c.closePath();
                    c.fill();
                    // Inner flame (yellow/white core)
                    const innerH = flameH * 0.5;
                    const innerW = flameW * 0.5;
                    c.globalAlpha = 0.9 * (1 - progress * 0.3);
                    const innerGrad = c.createLinearGradient(fx, baseY, fx, baseY - innerH);
                    innerGrad.addColorStop(0, "#fffbe0");
                    innerGrad.addColorStop(0.5, "#ffcc00");
                    innerGrad.addColorStop(1, "rgba(255,100,0,0)");
                    c.fillStyle = innerGrad;
                    c.beginPath();
                    c.moveTo(fx - innerW, baseY);
                    c.quadraticCurveTo(fx - innerW * 0.8, baseY - innerH * 0.6, fx, baseY - innerH);
                    c.quadraticCurveTo(fx + innerW * 0.8, baseY - innerH * 0.6, fx + innerW, baseY);
                    c.closePath();
                    c.fill();
                }
                // Embers rising
                c.globalAlpha = 0.9;
                for (let i = 0; i < numFlames; i++) {
                    const ex = fireLeft + Math.random() * fireW;
                    const ey = p.y - 50 - ((now * 0.15 + i * 37) % 180);
                    const eSize = 2 + Math.sin(now * 0.01 + i) * 1;
                    c.fillStyle = (i % 2 === 0) ? "#ffdd00" : "#ff8800";
                    c.beginPath(); c.arc(ex, ey, eSize, 0, Math.PI * 2); c.fill();
                }
                c.globalAlpha = 1;
            }
        }
        // Trailing arm
        c.strokeStyle = p.color;
        c.lineWidth = 3;
        c.beginPath(); c.moveTo(p.x, armY); c.lineTo(p.x - dir * 12, armY + 12); c.stroke();
    }

    private drawMob(c: CanvasRenderingContext2D, mob: MobState, now: number): void {
        c.save();
        c.lineCap = "round";

        if (mob.kind === "flying") {
            this.drawFlyingMob(c, mob, now);
        } else {
            this.drawGroundMob(c, mob, now);
        }

        c.restore();
    }

    private drawGroundMob(c: CanvasRenderingContext2D, mob: MobState, now: number): void {
        c.strokeStyle = "#cc3333";
        c.lineWidth = 3;

        const cx = mob.x;
        const headR = 10;
        const headY = mob.y - 50;
        const attacking = now - mob.lastAttackAt < 300;
        const dir = mob.vx >= 0 ? 1 : -1;

        // Head
        c.beginPath(); c.arc(cx, headY, headR, 0, Math.PI * 2); c.stroke();
        // Angry eyes
        c.fillStyle = "#cc3333";
        c.fillRect(cx - 5, headY - 3, 3, 3);
        c.fillRect(cx + 2, headY - 3, 3, 3);
        // Body
        c.beginPath(); c.moveTo(cx, headY + headR); c.lineTo(cx, mob.y); c.stroke();

        // Arms — swing forward when attacking
        const armY = headY + 18;
        if (attacking) {
            const progress = (now - mob.lastAttackAt) / 300;
            const swing = Math.sin(progress * Math.PI) * 30;
            c.lineWidth = 4;
            c.strokeStyle = "#ff4444";
            c.beginPath(); c.moveTo(cx, armY); c.lineTo(cx + dir * (20 + swing), armY - 5); c.stroke();
            c.beginPath(); c.moveTo(cx, armY); c.lineTo(cx + dir * (15 + swing * 0.7), armY + 8); c.stroke();
            c.strokeStyle = "#cc3333";
            c.lineWidth = 3;
        } else {
            // Walking arm swing
            const armSwing = Math.sin(now / 200) * 8;
            c.beginPath(); c.moveTo(cx, armY); c.lineTo(cx - 15 + armSwing, armY + 17); c.stroke();
            c.beginPath(); c.moveTo(cx, armY); c.lineTo(cx + 15 - armSwing, armY + 17); c.stroke();
        }

        // Legs — walking animation
        const legSwing = Math.sin(now / 150) * 10;
        c.beginPath(); c.moveTo(cx, mob.y); c.lineTo(cx + legSwing, mob.y + 12); c.stroke();
        c.beginPath(); c.moveTo(cx, mob.y); c.lineTo(cx - legSwing, mob.y + 12); c.stroke();

        // HP bar
        const maxHp = MOB_HP;
        const barW = 30; const barH = 4;
        const barX = cx - barW / 2; const barY = headY - headR - 8;
        c.fillStyle = "#333"; c.fillRect(barX, barY, barW, barH);
        c.fillStyle = "#cc3333"; c.fillRect(barX, barY, barW * (mob.hp / maxHp), barH);
    }

    private drawFlyingMob(c: CanvasRenderingContext2D, mob: MobState, now: number): void {
        c.strokeStyle = "#8844aa";
        c.lineWidth = 3;

        const cx = mob.x;
        const cy = mob.y;
        const attacking = now - mob.lastAttackAt < 300;

        // Fat round body
        c.fillStyle = "#9955cc";
        c.beginPath(); c.ellipse(cx, cy, 18, 14, 0, 0, Math.PI * 2); c.fill();
        c.stroke();

        // Wings flapping
        const wingAngle = Math.sin(now / 80) * 0.5;
        c.strokeStyle = "#7733aa";
        c.lineWidth = 2;
        // Left wing
        c.beginPath();
        c.moveTo(cx - 16, cy - 4);
        c.quadraticCurveTo(cx - 30, cy - 20 + wingAngle * 15, cx - 22, cy - 14 + wingAngle * 10);
        c.stroke();
        // Right wing
        c.beginPath();
        c.moveTo(cx + 16, cy - 4);
        c.quadraticCurveTo(cx + 30, cy - 20 + wingAngle * 15, cx + 22, cy - 14 + wingAngle * 10);
        c.stroke();

        // Beak
        const dir = mob.vx >= 0 ? 1 : -1;
        c.fillStyle = "#ffaa00";
        c.beginPath();
        c.moveTo(cx + dir * 18, cy);
        c.lineTo(cx + dir * 26, cy + 2);
        c.lineTo(cx + dir * 18, cy + 5);
        c.closePath(); c.fill();

        // Angry eyes
        c.fillStyle = "#fff";
        c.beginPath(); c.arc(cx - 5 * dir, cy - 4, 4, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(cx + 3 * dir, cy - 4, 4, 0, Math.PI * 2); c.fill();
        c.fillStyle = "#000";
        c.beginPath(); c.arc(cx - 5 * dir, cy - 4, 2, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(cx + 3 * dir, cy - 4, 2, 0, Math.PI * 2); c.fill();

        // Stick legs dangling
        c.strokeStyle = "#8844aa";
        c.lineWidth = 2;
        const dangle = Math.sin(now / 120) * 3;
        c.beginPath(); c.moveTo(cx - 6, cy + 12); c.lineTo(cx - 6, cy + 22 + dangle); c.stroke();
        c.beginPath(); c.moveTo(cx + 6, cy + 12); c.lineTo(cx + 6, cy + 22 - dangle); c.stroke();

        // Attack flash
        if (attacking) {
            c.strokeStyle = "#ff4444";
            c.lineWidth = 3;
            const r = 20 + (now - mob.lastAttackAt) / 300 * 15;
            c.globalAlpha = 1 - (now - mob.lastAttackAt) / 300;
            c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
            c.globalAlpha = 1;
        }

        // HP bar
        const barW = 30; const barH = 4;
        const barX = cx - barW / 2; const barY = cy - 22;
        c.fillStyle = "#333"; c.fillRect(barX, barY, barW, barH);
        c.fillStyle = "#9955cc"; c.fillRect(barX, barY, barW * (mob.hp / FLYING_MOB_HP), barH);
    }

    private drawHealthPack(c: CanvasRenderingContext2D, pack: { x: number; y: number }, now: number): void {
        c.save();
        const bob = Math.sin(now / 400) * 3;
        const px = pack.x;
        const py = pack.y + bob;

        // Glow
        c.globalAlpha = 0.3;
        c.fillStyle = "#4cff4c";
        c.beginPath(); c.arc(px, py, HEALTH_PACK_RADIUS + 4, 0, Math.PI * 2); c.fill();

        // Box
        c.globalAlpha = 1;
        c.fillStyle = "#ffffff";
        c.fillRect(px - 9, py - 9, 18, 18);

        // Cross
        c.fillStyle = "#22aa22";
        c.fillRect(px - 2, py - 7, 4, 14);
        c.fillRect(px - 7, py - 2, 14, 4);

        c.restore();
    }

    private drawWeaponPickup(c: CanvasRenderingContext2D, wp: WeaponPickup, now: number): void {
        c.save();
        const bob = Math.sin(now / 350) * 3;
        const px = wp.x;
        const py = wp.y + bob;

        // Glow
        c.globalAlpha = 0.3;
        c.fillStyle = "#ffcc00";
        c.beginPath(); c.arc(px, py, 16, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;

        if (wp.kind === "bow") {
            // Bow shape
            c.strokeStyle = "#8B6914";
            c.lineWidth = 3;
            c.beginPath(); c.arc(px, py, 10, -0.8, 0.8); c.stroke();
            c.strokeStyle = "#555";
            c.lineWidth = 1;
            c.beginPath(); c.moveTo(px + 10 * Math.cos(-0.8), py + 10 * Math.sin(-0.8));
            c.lineTo(px + 10 * Math.cos(0.8), py + 10 * Math.sin(0.8)); c.stroke();
        } else if (wp.kind === "club") {
            // Club shape
            c.fillStyle = "#5C3317";
            c.beginPath(); c.roundRect(px - 4, py - 12, 8, 20, 3); c.fill();
            c.fillStyle = "#8B4513";
            c.beginPath(); c.arc(px, py - 12, 6, 0, Math.PI * 2); c.fill();
        } else if (wp.kind === "spear") {
            // Spear shape
            c.strokeStyle = "#8B6914";
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(px, py + 12); c.lineTo(px, py - 10); c.stroke();
            c.fillStyle = "#888";
            c.beginPath(); c.moveTo(px, py - 14); c.lineTo(px - 4, py - 8); c.lineTo(px + 4, py - 8); c.closePath(); c.fill();
        } else if (wp.kind === "wand") {
            // Magic wand shape
            c.strokeStyle = "#7B2D8B";
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(px, py + 10); c.lineTo(px, py - 8); c.stroke();
            // Wand tip star
            c.fillStyle = "#ff44ff";
            c.beginPath(); c.arc(px, py - 10, 4, 0, Math.PI * 2); c.fill();
            // Sparkles
            c.fillStyle = "#ffaaff";
            const t = now / 200;
            for (let i = 0; i < 3; i++) {
                const angle = t + i * (Math.PI * 2 / 3);
                const sx = px + Math.cos(angle) * 8;
                const sy = py - 10 + Math.sin(angle) * 8;
                c.beginPath(); c.arc(sx, sy, 1.5, 0, Math.PI * 2); c.fill();
            }
        }

        // Label
        c.font = "bold 8px sans-serif";
        c.textAlign = "center";
        c.fillStyle = "#333";
        c.fillText(WEAPONS[wp.kind]?.name || wp.kind, px, py + 20);

        c.restore();
    }

    // ── HUD ──────────────────────────────────────────────────────────────────

    private renderHud(now: number): void {
        const me = this.players.get(this.net.me.id)!;
        let html = "";

        // Survival timer (top-center)
        const elapsed = Math.floor((now - this.gameStartedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        html += `<div class="stickman-timer">${mins}:${secs < 10 ? "0" : ""}${secs}</div>`;

        // HP bar (top-center)
        const hpPct = Math.max(0, me.hp / PLAYER_HP * 100);
        const hpColor = hpPct > 50 ? "#4caf50" : hpPct > 25 ? "#ff9800" : "#f44336";
        html += `<div class="stickman-hp-bar"><div class="stickman-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div><span>${me.hp} HP</span></div>`;

        // Cooldowns
        const pwExp = me.cooldowns["power"] || 0;
        const rhExp = me.cooldowns["roundhouse"] || 0;
        const pwDef = ATTACKS.power;
        const rhDef = ATTACKS.roundhouse;
        const pwTotal = pwDef.duration + pwDef.cooldown;
        const rhTotal = rhDef.duration + rhDef.cooldown;
        const pwPct = now >= pwExp ? 100 : Math.max(0, (1 - (pwExp - now) / pwTotal) * 100);
        const rhPct = now >= rhExp ? 100 : Math.max(0, (1 - (rhExp - now) / rhTotal) * 100);
        html += `<div class="stickman-cooldowns">`;
        html += `<div class="stickman-cd"><span>Power [Space]</span><div class="stickman-cd-bar"><div class="stickman-cd-fill" style="width:${pwPct}%;background:${pwPct >= 100 ? '#4caf50' : '#ff9800'}"></div></div></div>`;
        html += `<div class="stickman-cd"><span>Roundhouse [C]</span><div class="stickman-cd-bar"><div class="stickman-cd-fill" style="width:${rhPct}%;background:${rhPct >= 100 ? '#4caf50' : '#ff9800'}"></div></div></div>`;
        html += `</div>`;

        // Respawn countdown
        if (me.dead && me.respawnAt) {
            const secs = Math.ceil((me.respawnAt - now) / 1000);
            html += `<div class="stickman-respawn">Respawning in ${secs}s...</div>`;
        }

        // Weapon indicator
        if (me.weapon) {
            const wDef = WEAPONS[me.weapon.kind];
            const maxDur = me.weapon.kind === "wand" ? WAND_DURABILITY : WEAPON_DURABILITY;
            html += `<div class="stickman-weapon"><span style="color:#ffcc00">${wDef?.name || me.weapon.kind}</span> [Z to use] &mdash; ${me.weapon.durability}/${maxDur}</div>`;
        }

        // Controls hint
        html += `<div class="stickman-controls">Arrows: move/jump/duck &nbsp; Z: ${me.weapon ? me.weapon.kind : 'punch'} &nbsp; X: kick &nbsp; C: roundhouse &nbsp; Space: power</div>`;

        // Update toggle position
        this.modeToggleEl.classList.toggle("active", this.friendlyFire);

        // Score list
        html += `<div class="stickman-scores">`;
        const sorted = [...this.net.peers.entries()].sort((a, b) => b[1].score - a[1].score);
        for (const [, info] of sorted) {
            html += `<div class="stickman-score-row"><span style="color:${info.color}">${info.name}</span><span>${info.score}</span></div>`;
        }
        html += `</div>`;

        this.hudEl.innerHTML = html;
    }

    private renderGameOver(): void {
        this.gameOverEl.classList.remove("hidden");
        const sorted = [...this.net.peers.entries()].sort((a, b) => b[1].score - a[1].score);
        let html = `<div class="stickman-go-inner"><h2>Game Over</h2><div class="stickman-go-scores">`;
        for (const [, info] of sorted) {
            html += `<div class="stickman-go-row"><span style="color:${info.color}">${info.name}</span><span>${info.score} pts</span></div>`;
        }
        html += `</div><button class="stickman-restart-btn">Restart</button></div>`;
        this.gameOverEl.innerHTML = html;
        this.gameOverEl.querySelector<HTMLButtonElement>(".stickman-restart-btn")!.onclick = () => {
            this.restartGame();
            this.ns.send("restart", {});
        };
    }

    private restartGame(): void {
        this.gameOver = false;
        this.gameOverEl.classList.add("hidden");
        this.mobs.clear();
        this.damageMap.clear();
        this.healthPacks.clear();
        this.respawnPlatforms();
        this.resetLPlatform();
        this.gameStartedAt = performance.now();
        this.spawnIntervalMs = SPAWN_INTERVAL_START_MS;
        this.nextSpawnAt = performance.now() + this.spawnIntervalMs;
        this.lastAccelAt = performance.now();
        this.weaponPickups.clear();
        this.nextWeaponSpawnAt = performance.now() + WEAPON_SPAWN_INTERVAL_MS;
        for (const p of this.players.values()) {
            p.hp = PLAYER_HP;
            p.dead = false;
            p.respawnAt = null;
            p.invincibleUntil = performance.now() + INVINCIBILITY_MS;
            p.x = 50 + Math.random() * (FIELD_W - 100);
            p.y = GROUND_Y;
            p.vx = 0; p.vy = 0; p.knockbackVx = 0;
            p.activeAttack = null;
            p.cooldowns = {};
            p.weapon = null;
        }
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    destroy(): void {
        cancelAnimationFrame(this.rafId);
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.onBlur);
        this.resizeObs?.disconnect();
        this.unsubPeers?.();
        for (const av of this.avatarImgs.values()) URL.revokeObjectURL(av.url);
        this.ns.close();
        this.container.innerHTML = "";
    }
}
