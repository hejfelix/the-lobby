import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

// ---------- field constants ----------
const FIELD_W = 800;
const FIELD_H = 500;
const BALL_R = 8;
const HOLE_R = 14;
const MAX_POWER = 900; // px/s
const FRICTION_K = 1.6; // exponential decay rate (per second)
const SAND_K = 5.5;
const STOP_SPEED = 8; // below this we snap to rest
const HOLE_CAPTURE_SPEED = 380; // ball must be slower than this to be captured
const POS_BROADCAST_HZ = 18;
const VOTE_CANDIDATES = 3;

// ---------- course types ----------
type Rect = { x: number; y: number; w: number; h: number };
type Circle = { x: number; y: number; r: number };

interface Course {
    id: string;
    name: string;
    par: number;
    tee: { x: number; y: number };
    hole: { x: number; y: number };
    walls: Rect[];        // axis-aligned wall rectangles
    bumpers?: Circle[];   // bouncy circular obstacles
    sand?: Rect[];        // slow zones
    water?: Rect[];       // reset + 1 stroke penalty
}

const COURSES: Course[] = [
    {
        id: "fairway",
        name: "Fairway",
        par: 2,
        tee: { x: 90, y: 250 },
        hole: { x: 710, y: 250 },
        walls: [],
    },
    {
        id: "lbend",
        name: "L-Bend",
        par: 3,
        tee: { x: 90, y: 100 },
        hole: { x: 710, y: 410 },
        walls: [
            // a wall blocking the diagonal — forces L-shaped path
            { x: 200, y: 180, w: 420, h: 30 },
            { x: 200, y: 210, w: 30, h: 180 },
        ],
    },
    {
        id: "bumpers",
        name: "Bumper Field",
        par: 3,
        tee: { x: 90, y: 250 },
        hole: { x: 710, y: 250 },
        walls: [],
        bumpers: [
            { x: 320, y: 180, r: 22 },
            { x: 400, y: 290, r: 22 },
            { x: 480, y: 200, r: 22 },
            { x: 560, y: 320, r: 22 },
            { x: 280, y: 360, r: 22 },
        ],
    },
    {
        id: "funnel",
        name: "Funnel",
        par: 3,
        tee: { x: 90, y: 250 },
        hole: { x: 720, y: 250 },
        walls: [
            { x: 280, y: 0, w: 24, h: 200 },
            { x: 280, y: 300, w: 24, h: 200 },
            { x: 460, y: 0, w: 24, h: 160 },
            { x: 460, y: 340, w: 24, h: 160 },
            { x: 620, y: 0, w: 24, h: 220 },
            { x: 620, y: 280, w: 24, h: 220 },
        ],
        sand: [{ x: 360, y: 220, w: 80, h: 60 }],
    },
    {
        id: "island",
        name: "Island Green",
        par: 4,
        tee: { x: 80, y: 250 },
        hole: { x: 660, y: 250 },
        walls: [],
        water: [
            { x: 240, y: 0, w: 240, h: 130 },
            { x: 240, y: 370, w: 240, h: 130 },
            { x: 240, y: 130, w: 70, h: 240 },
            { x: 410, y: 130, w: 70, h: 240 },
        ],
    },
    {
        id: "zigzag",
        name: "Zig Zag",
        par: 4,
        tee: { x: 90, y: 80 },
        hole: { x: 710, y: 420 },
        walls: [
            { x: 180, y: 0, w: 24, h: 340 },
            { x: 360, y: 160, w: 24, h: 340 },
            { x: 540, y: 0, w: 24, h: 340 },
        ],
        sand: [
            { x: 240, y: 380, w: 90, h: 60 },
            { x: 600, y: 380, w: 90, h: 60 },
        ],
    },
];

const COURSE_IDS = COURSES.map((c) => c.id);
const COURSE_BY_ID = new Map(COURSES.map((c) => [c.id, c] as const));

export const MinigolfGame: Game = {
    id: "minigolf",
    name: "Mini Golf",
    description: "Same course, fewest strokes wins. Vote on the next hole between rounds.",
    create(container, net): GameInstance {
        const inst = new MinigolfInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

// ---------- per-peer state ----------
interface PeerState {
    x: number;
    y: number;
    vx: number;
    vy: number;
    strokes: number;
    holed: boolean;
    holedAt: number;   // timestamp for sort stability (lower = earlier)
    moving: boolean;
}

interface SyncPayload {
    phase: Phase;
    courseId: string;
    candidates: string[];
    states: Record<string, { strokes: number; holed: boolean; holedAt: number }>;
    votes: Record<string, string>;
    totals: Record<string, number>;
}

type Phase = "playing" | "voting";

class MinigolfInstance {
    private net: Net;
    private ns: GameNamespace;
    private container: HTMLElement;
    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private sidebar!: HTMLDivElement;

    private course: Course = COURSES[0];
    private phase: Phase = "playing";
    private candidates: string[] = [];
    private votes: Map<string, string> = new Map(); // peerId -> courseId
    /** Cumulative total strokes across rounds. */
    private totals: Map<string, number> = new Map();
    private states: Map<string, PeerState> = new Map();

    private dragging: { startX: number; startY: number; curX: number; curY: number } | null = null;
    private rafId = 0;
    private lastFrame = 0;
    private lastPosBroadcast = 0;
    private resizeObs: ResizeObserver | null = null;
    private unsubPeers: (() => void) | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("minigolf");

        container.innerHTML = `
      <div class="game-layout golf-layout">
        <aside class="toolbar golf-toolbar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint">
              Drag from your ball to aim, release to putt. Lowest stroke count wins.
              When everyone holes out, vote on the next course.
            </p>
          </div>
          <div class="tool-group">
            <label>Round</label>
            <div class="golf-course"></div>
          </div>
          <div class="tool-group">
            <label>Scoreboard</label>
            <div class="golf-scoreboard"></div>
          </div>
          <div class="tool-group golf-vote-group" style="display:none">
            <label>Vote next course</label>
            <div class="golf-vote"></div>
          </div>
        </aside>
        <section class="golf-stage">
          <canvas class="golf-canvas"></canvas>
        </section>
      </div>
    `;

        this.canvas = container.querySelector<HTMLCanvasElement>(".golf-canvas")!;
        this.ctx = this.canvas.getContext("2d")!;
        this.sidebar = container.querySelector<HTMLDivElement>(".golf-toolbar")!;

        // Pick a deterministic-ish starting course based on room name + timestamp
        // (host's choice will be authoritative once we sync).
        this.course = COURSES[Math.floor(Math.random() * COURSES.length)];

        this.ensureSelfState(true);
        this.registerNetwork();
        this.attachInput();
        this.startResizeWatcher();
        this.unsubPeers = this.net.on("peers", () => this.handlePeerChange());

        // Late-join: ask the host for canonical state.
        this.ns.send("sync-request", {});

        this.renderSidebar();
        this.lastFrame = performance.now();
        this.loop();
    }

    destroy(): void {
        cancelAnimationFrame(this.rafId);
        this.resizeObs?.disconnect();
        this.unsubPeers?.();
        this.ns.close();
        this.container.innerHTML = "";
    }

    // ---------- helpers ----------

    private isHost(): boolean {
        const ids = [this.net.me.id, ...this.net.peers.keys()];
        const unique = [...new Set(ids)].sort();
        return unique[0] === this.net.me.id;
    }

    private ensureSelfState(reset: boolean): PeerState {
        let s = this.states.get(this.net.me.id);
        if (!s || reset) {
            s = {
                x: this.course.tee.x,
                y: this.course.tee.y,
                vx: 0,
                vy: 0,
                strokes: 0,
                holed: false,
                holedAt: 0,
                moving: false,
            };
            this.states.set(this.net.me.id, s);
        }
        return s;
    }

    private getOrCreateState(peerId: string): PeerState {
        let s = this.states.get(peerId);
        if (!s) {
            s = {
                x: this.course.tee.x,
                y: this.course.tee.y,
                vx: 0,
                vy: 0,
                strokes: 0,
                holed: false,
                holedAt: 0,
                moving: false,
            };
            this.states.set(peerId, s);
        }
        return s;
    }

    private allPlayers(): string[] {
        const ids = new Set<string>([this.net.me.id, ...this.net.peers.keys()]);
        return [...ids];
    }

    private allHoled(): boolean {
        const players = this.allPlayers();
        if (players.length === 0) return false;
        return players.every((id) => this.states.get(id)?.holed === true);
    }

    private handlePeerChange(): void {
        // Drop states for peers that have left.
        const live = new Set(this.allPlayers());
        for (const id of [...this.states.keys()]) {
            if (!live.has(id)) this.states.delete(id);
        }
        // A leaving peer might have been the only one not yet holed — re-check.
        if (this.phase === "playing" && this.allHoled()) {
            this.maybeStartVote();
        }
        this.renderSidebar();
    }

    // ---------- networking ----------

    private registerNetwork() {
        this.ns.on<{ x: number; y: number; vx: number; vy: number; strokes: number; moving: boolean; courseId: string }>(
            "pos",
            (m, peerId) => {
                if (!m || m.courseId !== this.course.id) return;
                const s = this.getOrCreateState(peerId);
                if (s.holed) return;
                s.x = clamp(Number(m.x) || 0, 0, FIELD_W);
                s.y = clamp(Number(m.y) || 0, 0, FIELD_H);
                s.vx = Number(m.vx) || 0;
                s.vy = Number(m.vy) || 0;
                s.strokes = Math.max(0, Math.min(99, Math.floor(Number(m.strokes) || 0)));
                s.moving = !!m.moving;
            },
        );

        this.ns.on<{ strokes: number; courseId: string }>("holed", (m, peerId) => {
            if (!m || m.courseId !== this.course.id) return;
            const s = this.getOrCreateState(peerId);
            if (s.holed) return;
            s.strokes = Math.max(1, Math.min(99, Math.floor(Number(m.strokes) || 1)));
            s.holed = true;
            s.holedAt = Date.now();
            s.moving = false;
            this.totals.set(peerId, (this.totals.get(peerId) ?? 0) + s.strokes);
            const peer = this.net.peers.get(peerId);
            if (peer) {
                this.net.pushSystem(`${peer.name} holed out in ${s.strokes} on ${this.course.name}.`);
            }
            this.renderSidebar();
            this.maybeStartVote();
        });

        this.ns.on<{ courseId: string; candidates: string[] }>("start-vote", (m, peerId) => {
            // Trust only the host (lowest peer id at the time of broadcast).
            const sortedPeers = [...this.allPlayers()].sort();
            if (peerId !== sortedPeers[0]) return;
            if (m.courseId !== this.course.id) return;
            this.startVote(filterCandidates(m.candidates), false);
        });

        this.ns.on<{ courseId: string }>("vote", (m, peerId) => {
            if (this.phase !== "voting") return;
            if (!m || !COURSE_BY_ID.has(m.courseId)) return;
            if (!this.candidates.includes(m.courseId)) return;
            this.votes.set(peerId, m.courseId);
            this.renderSidebar();
            this.maybeFinalizeVote();
        });

        this.ns.on<{ courseId: string }>("start-course", (m, peerId) => {
            const sortedPeers = [...this.allPlayers()].sort();
            if (peerId !== sortedPeers[0]) return;
            if (!m || !COURSE_BY_ID.has(m.courseId)) return;
            this.startCourse(m.courseId);
        });

        this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
            // Only the host responds, to avoid clobbering newcomer state with conflicting views.
            if (!this.isHost()) return;
            const states: SyncPayload["states"] = {};
            for (const [id, s] of this.states) {
                states[id] = { strokes: s.strokes, holed: s.holed, holedAt: s.holedAt };
            }
            const totals: Record<string, number> = {};
            for (const [id, t] of this.totals) totals[id] = t;
            const votes: Record<string, string> = {};
            for (const [id, v] of this.votes) votes[id] = v;
            const payload: SyncPayload = {
                phase: this.phase,
                courseId: this.course.id,
                candidates: this.candidates,
                states,
                votes,
                totals,
            };
            this.ns.send("sync", payload, peerId);
        });

        this.ns.on<SyncPayload>("sync", (m, peerId) => {
            if (!m) return;
            // Only accept from current host.
            const sortedPeers = [...this.allPlayers()].sort();
            if (peerId !== sortedPeers[0]) return;
            // Switch course if needed.
            if (m.courseId !== this.course.id && COURSE_BY_ID.has(m.courseId)) {
                this.course = COURSE_BY_ID.get(m.courseId)!;
                // Mark self as already holed for this round so we wait it out
                // (joining mid-round shouldn't penalize us with mystery strokes).
                const self = this.ensureSelfState(true);
                self.holed = true;
                self.holedAt = Date.now();
                self.strokes = 0;
            }
            for (const [id, ps] of Object.entries(m.states ?? {})) {
                if (id === this.net.me.id) continue;
                const s = this.getOrCreateState(id);
                s.strokes = Math.max(0, Math.min(99, Math.floor(ps.strokes || 0)));
                s.holed = !!ps.holed;
                s.holedAt = Number(ps.holedAt) || 0;
            }
            for (const [id, t] of Object.entries(m.totals ?? {})) {
                this.totals.set(id, Math.max(0, Math.floor(Number(t) || 0)));
            }
            if (m.phase === "voting") {
                this.startVote(filterCandidates(m.candidates), false);
                for (const [id, v] of Object.entries(m.votes ?? {})) {
                    if (this.candidates.includes(v)) this.votes.set(id, v);
                }
            } else {
                this.phase = "playing";
                this.candidates = [];
                this.votes.clear();
            }
            this.renderSidebar();
        });
    }

    // ---------- input ----------

    private attachInput() {
        const onDown = (e: PointerEvent) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (this.phase !== "playing") return;
            const me = this.ensureSelfState(false);
            if (me.holed || me.moving) return;
            const { x, y } = this.toField(e);
            // Require press near own ball (within generous radius).
            if (Math.hypot(x - me.x, y - me.y) > BALL_R * 6) return;
            this.canvas.setPointerCapture(e.pointerId);
            this.dragging = { startX: me.x, startY: me.y, curX: x, curY: y };
        };
        const onMove = (e: PointerEvent) => {
            if (!this.dragging) return;
            const { x, y } = this.toField(e);
            this.dragging.curX = x;
            this.dragging.curY = y;
        };
        const onUp = (e: PointerEvent) => {
            if (!this.dragging) return;
            const d = this.dragging;
            this.dragging = null;
            try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            // Slingshot vector: launch opposite of drag direction.
            const dx = d.startX - d.curX;
            const dy = d.startY - d.curY;
            const dist = Math.hypot(dx, dy);
            if (dist < 6) return;
            const power = Math.min(MAX_POWER, dist * 4);
            const me = this.ensureSelfState(false);
            if (me.holed || me.moving) return;
            me.vx = (dx / dist) * power;
            me.vy = (dy / dist) * power;
            me.strokes++;
            me.moving = true;
            this.broadcastPos(true);
        };
        this.canvas.addEventListener("pointerdown", onDown);
        this.canvas.addEventListener("pointermove", onMove);
        this.canvas.addEventListener("pointerup", onUp);
        this.canvas.addEventListener("pointercancel", onUp);
    }

    private toField(e: PointerEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        return { x: px * FIELD_W, y: py * FIELD_H };
    }

    // ---------- main loop ----------

    private loop = () => {
        const now = performance.now();
        const dt = Math.min(1 / 30, (now - this.lastFrame) / 1000);
        this.lastFrame = now;
        this.step(dt);
        this.draw();
        // Throttled position broadcast while moving.
        const me = this.states.get(this.net.me.id);
        if (me && me.moving && now - this.lastPosBroadcast > 1000 / POS_BROADCAST_HZ) {
            this.broadcastPos(false);
            this.lastPosBroadcast = now;
        }
        this.rafId = requestAnimationFrame(this.loop);
    };

    private step(dt: number) {
        const me = this.states.get(this.net.me.id);
        if (!me || me.holed) return;
        if (!me.moving) return;

        // Sub-step for physics stability.
        const SUB = 4;
        const sdt = dt / SUB;
        for (let i = 0; i < SUB; i++) {
            // Friction (sand if inside any sand zone).
            const inSand = (this.course.sand ?? []).some((r) => pointInRect(me.x, me.y, r));
            const k = inSand ? SAND_K : FRICTION_K;
            const decay = Math.exp(-k * sdt);
            me.vx *= decay;
            me.vy *= decay;

            me.x += me.vx * sdt;
            me.y += me.vy * sdt;

            // Boundary walls.
            if (me.x < BALL_R) { me.x = BALL_R; me.vx = -me.vx * 0.6; }
            if (me.x > FIELD_W - BALL_R) { me.x = FIELD_W - BALL_R; me.vx = -me.vx * 0.6; }
            if (me.y < BALL_R) { me.y = BALL_R; me.vy = -me.vy * 0.6; }
            if (me.y > FIELD_H - BALL_R) { me.y = FIELD_H - BALL_R; me.vy = -me.vy * 0.6; }

            // Inner walls.
            for (const w of this.course.walls) collideRect(me, w);
            // Bumpers.
            for (const b of this.course.bumpers ?? []) collideBumper(me, b);

            // Water — reset to tee + 1 stroke.
            if ((this.course.water ?? []).some((r) => pointInRect(me.x, me.y, r))) {
                me.x = this.course.tee.x;
                me.y = this.course.tee.y;
                me.vx = 0;
                me.vy = 0;
                me.strokes++;
                me.moving = false;
                this.broadcastPos(true);
                return;
            }

            // Hole capture.
            const hd = Math.hypot(me.x - this.course.hole.x, me.y - this.course.hole.y);
            const speed = Math.hypot(me.vx, me.vy);
            if (hd < HOLE_R && speed < HOLE_CAPTURE_SPEED) {
                me.x = this.course.hole.x;
                me.y = this.course.hole.y;
                me.vx = 0;
                me.vy = 0;
                me.moving = false;
                me.holed = true;
                me.holedAt = Date.now();
                this.totals.set(this.net.me.id, (this.totals.get(this.net.me.id) ?? 0) + me.strokes);
                this.net.pushSystem(`You holed out in ${me.strokes} on ${this.course.name}.`);
                this.ns.send("holed", { strokes: me.strokes, courseId: this.course.id });
                this.renderSidebar();
                this.maybeStartVote();
                return;
            }
        }

        // Stop check.
        if (Math.hypot(me.vx, me.vy) < STOP_SPEED) {
            me.vx = 0;
            me.vy = 0;
            me.moving = false;
            this.broadcastPos(true);
        }
    }

    private broadcastPos(immediate: boolean) {
        const me = this.states.get(this.net.me.id);
        if (!me) return;
        this.ns.send("pos", {
            x: me.x,
            y: me.y,
            vx: me.vx,
            vy: me.vy,
            strokes: me.strokes,
            moving: me.moving,
            courseId: this.course.id,
        });
        if (immediate) this.lastPosBroadcast = performance.now();
    }

    // ---------- voting flow ----------

    private maybeStartVote() {
        if (this.phase !== "playing") return;
        if (!this.allHoled()) return;
        if (!this.isHost()) return;
        // Pick N random candidates excluding the current course.
        const pool = COURSE_IDS.filter((id) => id !== this.course.id);
        const candidates: string[] = [];
        const taken = new Set<string>();
        while (candidates.length < Math.min(VOTE_CANDIDATES, pool.length)) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (!taken.has(pick)) {
                taken.add(pick);
                candidates.push(pick);
            }
        }
        this.startVote(candidates, true);
    }

    private startVote(candidates: string[], announce: boolean) {
        if (candidates.length === 0) return;
        this.phase = "voting";
        this.candidates = candidates.slice(0, VOTE_CANDIDATES);
        this.votes.clear();
        if (announce) {
            this.ns.send("start-vote", { courseId: this.course.id, candidates: this.candidates });
            this.net.pushSystem("Round complete — vote on the next course.");
        }
        this.renderSidebar();
    }

    private castVote(courseId: string) {
        if (this.phase !== "voting") return;
        if (!this.candidates.includes(courseId)) return;
        this.votes.set(this.net.me.id, courseId);
        this.ns.send("vote", { courseId });
        this.renderSidebar();
        this.maybeFinalizeVote();
    }

    private maybeFinalizeVote() {
        if (this.phase !== "voting") return;
        if (!this.isHost()) return;
        const players = this.allPlayers();
        const voted = players.filter((id) => this.votes.has(id));
        if (voted.length < players.length) return;
        // Tally.
        const tally = new Map<string, number>();
        for (const id of this.candidates) tally.set(id, 0);
        for (const v of this.votes.values()) {
            if (tally.has(v)) tally.set(v, (tally.get(v) ?? 0) + 1);
        }
        let winner = this.candidates[0];
        let best = -1;
        for (const id of this.candidates) {
            const n = tally.get(id) ?? 0;
            if (n > best) { best = n; winner = id; }
        }
        this.ns.send("start-course", { courseId: winner });
        this.startCourse(winner);
    }

    private startCourse(courseId: string) {
        const course = COURSE_BY_ID.get(courseId);
        if (!course) return;
        this.course = course;
        this.phase = "playing";
        this.candidates = [];
        this.votes.clear();
        // Reset per-round state for everyone we know about.
        for (const id of this.allPlayers()) {
            this.states.set(id, {
                x: course.tee.x,
                y: course.tee.y,
                vx: 0,
                vy: 0,
                strokes: 0,
                holed: false,
                holedAt: 0,
                moving: false,
            });
        }
        this.net.pushSystem(`Now playing: ${course.name} (par ${course.par}).`);
        this.broadcastPos(true);
        this.renderSidebar();
    }

    // ---------- rendering ----------

    private renderSidebar() {
        const courseEl = this.sidebar.querySelector<HTMLDivElement>(".golf-course");
        if (courseEl) {
            courseEl.innerHTML = `
        <div class="golf-course-name">${escapeHtml(this.course.name)}</div>
        <div class="golf-course-par">Par ${this.course.par}</div>
      `;
        }

        const sb = this.sidebar.querySelector<HTMLDivElement>(".golf-scoreboard");
        if (sb) {
            const rows = this.allPlayers().map((id) => {
                const s = this.states.get(id);
                const peer = id === this.net.me.id
                    ? { name: this.net.me.name, color: this.net.me.color }
                    : this.net.peers.get(id);
                const name = peer?.name ?? "anon";
                const color = peer?.color ?? "#888";
                const strokes = s?.strokes ?? 0;
                const holed = s?.holed === true;
                const total = this.totals.get(id) ?? 0;
                return { id, name, color, strokes, holed, total };
            }).sort((a, b) => {
                // Sort by total then current strokes.
                if (a.total !== b.total) return a.total - b.total;
                return a.strokes - b.strokes;
            });
            sb.innerHTML = rows.map((r) => `
        <div class="golf-row">
          <span class="golf-dot" style="background:${escapeAttr(r.color)}"></span>
          <span class="golf-name">${escapeHtml(r.name)}${r.id === this.net.me.id ? " (you)" : ""}</span>
          <span class="golf-strokes">${r.holed ? "✓" : ""} ${r.strokes}</span>
          <span class="golf-total" title="Total strokes across all rounds">${r.total}</span>
        </div>
      `).join("");
        }

        const voteGroup = this.sidebar.querySelector<HTMLDivElement>(".golf-vote-group");
        const voteEl = this.sidebar.querySelector<HTMLDivElement>(".golf-vote");
        if (voteGroup && voteEl) {
            if (this.phase === "voting" && this.candidates.length > 0) {
                voteGroup.style.display = "";
                const myVote = this.votes.get(this.net.me.id) ?? null;
                voteEl.innerHTML = this.candidates.map((id) => {
                    const c = COURSE_BY_ID.get(id)!;
                    const count = [...this.votes.values()].filter((v) => v === id).length;
                    const mine = myVote === id ? " mine" : "";
                    return `
            <button class="golf-vote-option${mine}" data-id="${escapeAttr(id)}">
              <span class="golf-vote-name">${escapeHtml(c.name)}</span>
              <span class="golf-vote-meta">par ${c.par} · ${count} vote${count === 1 ? "" : "s"}</span>
            </button>
          `;
                }).join("");
                voteEl.querySelectorAll<HTMLButtonElement>(".golf-vote-option").forEach((btn) => {
                    btn.onclick = () => this.castVote(btn.dataset.id!);
                });
            } else {
                voteGroup.style.display = "none";
                voteEl.innerHTML = "";
            }
        }
    }

    private draw() {
        const c = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        c.save();
        c.scale(w / FIELD_W, h / FIELD_H);

        // Felt background.
        c.fillStyle = "#4a8f5e";
        c.fillRect(0, 0, FIELD_W, FIELD_H);

        // Subtle stripes for fairway texture.
        c.fillStyle = "rgba(255,255,255,0.04)";
        for (let x = 0; x < FIELD_W; x += 60) {
            c.fillRect(x, 0, 30, FIELD_H);
        }

        // Water.
        for (const r of this.course.water ?? []) {
            c.fillStyle = "#4f88c4";
            c.fillRect(r.x, r.y, r.w, r.h);
            c.strokeStyle = "rgba(255,255,255,0.25)";
            c.lineWidth = 1;
            c.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        }
        // Sand.
        for (const r of this.course.sand ?? []) {
            c.fillStyle = "#e6d18a";
            c.fillRect(r.x, r.y, r.w, r.h);
        }

        // Hole.
        c.fillStyle = "#1a1a1a";
        c.beginPath();
        c.arc(this.course.hole.x, this.course.hole.y, HOLE_R, 0, Math.PI * 2);
        c.fill();
        // Flag pole + flag.
        const fx = this.course.hole.x;
        const fy = this.course.hole.y;
        c.strokeStyle = "#fff";
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(fx, fy);
        c.lineTo(fx, fy - 40);
        c.stroke();
        c.fillStyle = "#d94a4a";
        c.beginPath();
        c.moveTo(fx, fy - 40);
        c.lineTo(fx + 18, fy - 34);
        c.lineTo(fx, fy - 28);
        c.closePath();
        c.fill();

        // Tee marker.
        c.fillStyle = "rgba(255,255,255,0.35)";
        c.beginPath();
        c.arc(this.course.tee.x, this.course.tee.y, BALL_R + 4, 0, Math.PI * 2);
        c.fill();

        // Walls.
        for (const wRect of this.course.walls) {
            c.fillStyle = "#3b2a1f";
            c.fillRect(wRect.x, wRect.y, wRect.w, wRect.h);
            c.strokeStyle = "rgba(0,0,0,0.4)";
            c.lineWidth = 1;
            c.strokeRect(wRect.x + 0.5, wRect.y + 0.5, wRect.w - 1, wRect.h - 1);
        }
        // Bumpers.
        for (const b of this.course.bumpers ?? []) {
            c.fillStyle = "#c97a3b";
            c.beginPath();
            c.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            c.fill();
            c.strokeStyle = "rgba(0,0,0,0.3)";
            c.lineWidth = 2;
            c.stroke();
        }

        // Boundary frame.
        c.strokeStyle = "#2c1d12";
        c.lineWidth = 6;
        c.strokeRect(3, 3, FIELD_W - 6, FIELD_H - 6);

        // Balls — others first (so own ball draws on top).
        for (const [id, s] of this.states) {
            if (id === this.net.me.id) continue;
            const peer = this.net.peers.get(id);
            if (!peer) continue;
            this.drawBall(s.x, s.y, peer.color, peer.name, s.holed, true);
        }
        const me = this.states.get(this.net.me.id);
        if (me) {
            this.drawBall(me.x, me.y, this.net.me.color, this.net.me.name, me.holed, false);
        }

        // Aim arrow.
        if (this.dragging && me && !me.holed && !me.moving) {
            const d = this.dragging;
            const dx = d.startX - d.curX;
            const dy = d.startY - d.curY;
            const dist = Math.hypot(dx, dy);
            if (dist > 4) {
                const power = Math.min(MAX_POWER, dist * 4) / MAX_POWER;
                c.strokeStyle = this.net.me.color;
                c.lineWidth = 3;
                c.beginPath();
                c.moveTo(me.x, me.y);
                c.lineTo(me.x + dx, me.y + dy);
                c.stroke();
                // Arrowhead.
                const ang = Math.atan2(dy, dx);
                const ax = me.x + dx;
                const ay = me.y + dy;
                c.beginPath();
                c.moveTo(ax, ay);
                c.lineTo(ax - Math.cos(ang - 0.4) * 12, ay - Math.sin(ang - 0.4) * 12);
                c.moveTo(ax, ay);
                c.lineTo(ax - Math.cos(ang + 0.4) * 12, ay - Math.sin(ang + 0.4) * 12);
                c.stroke();
                // Power bar near the tee.
                c.fillStyle = "rgba(0,0,0,0.4)";
                c.fillRect(me.x - 30, me.y + BALL_R + 8, 60, 6);
                c.fillStyle = "#fff";
                c.fillRect(me.x - 30, me.y + BALL_R + 8, 60 * power, 6);
            }
        }

        // Voting overlay.
        if (this.phase === "voting") {
            c.fillStyle = "rgba(0,0,0,0.45)";
            c.fillRect(0, 0, FIELD_W, FIELD_H);
            c.fillStyle = "#fff";
            c.font = "600 28px ui-sans-serif, system-ui, sans-serif";
            c.textAlign = "center";
            c.fillText("Round complete!", FIELD_W / 2, FIELD_H / 2 - 20);
            c.font = "16px ui-sans-serif, system-ui, sans-serif";
            c.fillText("Vote for the next course in the sidebar →", FIELD_W / 2, FIELD_H / 2 + 12);
        }

        c.restore();
    }

    private drawBall(x: number, y: number, color: string, name: string, holed: boolean, ghost: boolean) {
        const c = this.ctx;
        c.save();
        if (ghost) c.globalAlpha = 0.55;
        if (holed) c.globalAlpha *= 0.45;
        c.fillStyle = color;
        c.beginPath();
        c.arc(x, y, BALL_R, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = "rgba(0,0,0,0.5)";
        c.lineWidth = 1.5;
        c.stroke();
        // Name label for ghosts.
        if (ghost) {
            c.globalAlpha = 0.85;
            c.font = "600 11px ui-sans-serif, system-ui, sans-serif";
            c.textAlign = "center";
            const label = name + (holed ? " ✓" : "");
            const w = c.measureText(label).width + 8;
            const bx = x - w / 2;
            const by = y - BALL_R - 18;
            c.fillStyle = "rgba(255,255,255,0.85)";
            c.fillRect(bx, by, w, 14);
            c.fillStyle = "#222";
            c.fillText(label, x, by + 10);
        }
        c.restore();
    }

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

// ---------- physics helpers ----------

function pointInRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function collideRect(ball: PeerState, r: Rect) {
    // Closest point on rect to ball.
    const cx = clamp(ball.x, r.x, r.x + r.w);
    const cy = clamp(ball.y, r.y, r.y + r.h);
    const dx = ball.x - cx;
    const dy = ball.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= BALL_R * BALL_R) return;
    if (d2 < 0.0001) {
        // Ball center inside the rect — push out along nearest face.
        const left = ball.x - r.x;
        const right = (r.x + r.w) - ball.x;
        const top = ball.y - r.y;
        const bottom = (r.y + r.h) - ball.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) { ball.x = r.x - BALL_R; ball.vx = -Math.abs(ball.vx) * 0.7; }
        else if (m === right) { ball.x = r.x + r.w + BALL_R; ball.vx = Math.abs(ball.vx) * 0.7; }
        else if (m === top) { ball.y = r.y - BALL_R; ball.vy = -Math.abs(ball.vy) * 0.7; }
        else { ball.y = r.y + r.h + BALL_R; ball.vy = Math.abs(ball.vy) * 0.7; }
        return;
    }
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const ny = dy / d;
    const push = BALL_R - d;
    ball.x += nx * push;
    ball.y += ny * push;
    const dot = ball.vx * nx + ball.vy * ny;
    if (dot < 0) {
        ball.vx -= 2 * dot * nx * 0.85;
        ball.vy -= 2 * dot * ny * 0.85;
    }
}

function collideBumper(ball: PeerState, b: Circle) {
    const dx = ball.x - b.x;
    const dy = ball.y - b.y;
    const d = Math.hypot(dx, dy);
    const minD = b.r + BALL_R;
    if (d >= minD || d < 0.0001) return;
    const nx = dx / d;
    const ny = dy / d;
    ball.x = b.x + nx * minD;
    ball.y = b.y + ny * minD;
    const dot = ball.vx * nx + ball.vy * ny;
    if (dot < 0) {
        // Bouncier than walls.
        ball.vx -= 2 * dot * nx * 1.05;
        ball.vy -= 2 * dot * ny * 1.05;
    }
}

function filterCandidates(arr: unknown): string[] {
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const v of arr) {
        if (typeof v === "string" && COURSE_BY_ID.has(v) && !out.includes(v)) out.push(v);
        if (out.length >= VOTE_CANDIDATES) break;
    }
    return out;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function escapeAttr(s: string): string {
    return escapeHtml(s);
}
