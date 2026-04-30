import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

const LOGICAL_W = 1920;
const LOGICAL_H = 1200;
const PALETTE = [
    "#1c1c1a", "#6b6a63", "#ffffff", "#a23b3b", "#b8741a", "#c2a83e",
    "#3d7a4e", "#2d5a4f", "#3a6a8a", "#4a4078", "#7a3a5e", "#8d6e63",
];
const PROMPTS = [
    "rubber duck", "pirate ship", "haunted castle", "spaceship", "burrito",
    "dragon", "octopus", "robot chef", "skateboarding cat", "volcano",
    "treasure map", "ice cream sundae", "sleeping dog", "rocket launch",
    "mountain hike", "coffee mug", "broken laptop", "yoga pose",
    "birthday cake", "sushi roll", "lighthouse", "ferris wheel",
    "bumblebee", "knight in armor", "wizard hat", "tropical island",
    "submarine", "pizza slice", "cactus", "snowman", "disco ball",
    "hot air balloon", "sleeping unicorn", "angry teapot", "soccer goalie",
    "flying saucer", "grumpy cloud", "jellyfish", "sandcastle",
    "chess piece", "vinyl record", "campfire", "old typewriter",
    "paper airplane", "saxophone", "telescope", "watering can",
    "library shelf",
];

interface Stroke {
    id: string;
    ownerId: string;
    color: string;
    size: number;
    erase: boolean;
    points: Array<[number, number]>;
}

interface PromptState {
    word: string | null;
    hash: string;
    length: number;
    mask: string;
    drawerId: string;
    drawerName: string;
    active: boolean;
}

export const SketchGame: Game = {
    id: "sketch",
    name: "Sketchroom",
    description: "Draw together on a shared canvas. Optional guess-the-word rounds.",
    create(container, net): GameInstance {
        const game = new SketchInstance(container, net);
        return { unmount: () => game.destroy() };
    },
};

class SketchInstance {
    private container: HTMLElement;
    private net: Net;
    private ns: GameNamespace;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private cursorsEl: HTMLDivElement;
    private promptDisplay: HTMLDivElement;
    private revealBtn: HTMLButtonElement;

    private strokes: Stroke[] = [];
    private pendingStroke: Stroke | null = null;
    private brush = { color: PALETTE[0], size: 4 };
    private tool: "pen" | "eraser" = "pen";
    private prompt: PromptState | null = null;

    private lastCursorSent = 0;
    private resizeObserver: ResizeObserver;
    private cleanupFns: Array<() => void> = [];

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("sketch");

        container.innerHTML = `
      <div class="game-layout sketch-layout">
        <aside class="toolbar">
          <div class="tool-group">
            <label>Color</label>
            <div class="palette"></div>
            <input type="color" class="color-picker" value="${PALETTE[0]}" />
          </div>
          <div class="tool-group">
            <label>Brush size</label>
            <input type="range" class="size" min="1" max="40" value="4" />
            <div class="size-preview"></div>
          </div>
          <div class="tool-group">
            <label>Tool</label>
            <button class="tool-pen active">Pen</button>
            <button class="tool-eraser">Eraser</button>
          </div>
          <div class="tool-group">
            <label>Canvas</label>
            <button class="undo-btn">Undo my last stroke</button>
            <button class="clear-btn">Clear all</button>
          </div>
          <div class="tool-group">
            <label>Round</label>
            <button class="new-prompt-btn">Start a round</button>
            <div class="prompt-display">No round in progress</div>
            <button class="reveal-btn hidden">Reveal answer</button>
          </div>
        </aside>
        <section class="canvas-wrap">
          <canvas></canvas>
          <div class="cursors"></div>
        </section>
      </div>
    `;

        const q = <T extends Element>(s: string) => container.querySelector(s) as T;
        this.canvas = q<HTMLCanvasElement>("canvas");
        const ctx = this.canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("no 2d ctx");
        this.ctx = ctx;
        this.cursorsEl = q<HTMLDivElement>(".cursors");
        this.promptDisplay = q<HTMLDivElement>(".prompt-display");
        this.revealBtn = q<HTMLButtonElement>(".reveal-btn");

        this.buildPalette(q<HTMLDivElement>(".palette"));
        const colorPicker = q<HTMLInputElement>(".color-picker");
        colorPicker.oninput = () => this.setColor(colorPicker.value);
        const sizeInput = q<HTMLInputElement>(".size");
        const sizePreview = q<HTMLDivElement>(".size-preview");
        sizeInput.oninput = () => {
            this.brush.size = +sizeInput.value;
            sizePreview.style.setProperty("--s", `${Math.max(2, this.brush.size)}px`);
        };
        sizePreview.style.setProperty("--s", `${this.brush.size}px`);

        const penBtn = q<HTMLButtonElement>(".tool-pen");
        const eraserBtn = q<HTMLButtonElement>(".tool-eraser");
        penBtn.onclick = () => { this.tool = "pen"; penBtn.classList.add("active"); eraserBtn.classList.remove("active"); this.canvas.style.cursor = "crosshair"; };
        eraserBtn.onclick = () => { this.tool = "eraser"; eraserBtn.classList.add("active"); penBtn.classList.remove("active"); this.canvas.style.cursor = "cell"; };
        q<HTMLButtonElement>(".undo-btn").onclick = () => this.undoMine();
        q<HTMLButtonElement>(".clear-btn").onclick = () => this.clearAll();
        q<HTMLButtonElement>(".new-prompt-btn").onclick = () => void this.startRound();
        this.revealBtn.onclick = () => this.reveal();

        this.canvas.addEventListener("pointerdown", this.onPointerDown);
        this.canvas.addEventListener("pointermove", this.onPointerMove);
        this.canvas.addEventListener("pointerup", this.onPointerUp);
        this.canvas.addEventListener("pointercancel", this.onPointerUp);
        this.canvas.addEventListener("pointerleave", this.onPointerUp);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas);
        this.resize();

        this.registerNetwork();

        // Ask peers for the current strokes (each peer that has any will send).
        this.ns.send("history-request", {});
    }

    private buildPalette(el: HTMLDivElement) {
        for (const c of PALETTE) {
            const sw = document.createElement("div");
            sw.className = "swatch";
            sw.style.background = c;
            sw.dataset.color = c;
            if (c === this.brush.color) sw.classList.add("active");
            sw.onclick = () => this.setColor(c);
            el.appendChild(sw);
        }
    }

    private setColor(c: string) {
        this.brush.color = c;
        this.container.querySelectorAll<HTMLDivElement>(".swatch").forEach((s) => {
            s.classList.toggle("active", s.dataset.color === c);
        });
        if (/^#[0-9a-f]{6}$/i.test(c)) {
            this.container.querySelector<HTMLInputElement>(".color-picker")!.value = c;
        }
    }

    private resize = () => {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.max(1, rect.width * dpr);
        this.canvas.height = Math.max(1, rect.height * dpr);
        this.redrawAll();
    };

    private clientToLogical(e: PointerEvent): [number, number] {
        const rect = this.canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * LOGICAL_W;
        const y = ((e.clientY - rect.top) / rect.height) * LOGICAL_H;
        return [Math.round(x), Math.round(y)];
    }

    private onPointerDown = (e: PointerEvent) => {
        this.canvas.setPointerCapture(e.pointerId);
        const [x, y] = this.clientToLogical(e);
        const stroke: Stroke = {
            id: `${this.net.me.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            ownerId: this.net.me.id,
            color: this.brush.color,
            size: this.brush.size,
            erase: this.tool === "eraser",
            points: [[x, y]],
        };
        this.pendingStroke = stroke;
        this.strokes.push(stroke);
        this.drawStroke(stroke);
        this.ns.send("ss", {
            id: stroke.id, color: stroke.color, size: stroke.size, erase: stroke.erase, point: [x, y],
        });
    };

    private onPointerMove = (e: PointerEvent) => {
        const [x, y] = this.clientToLogical(e);
        const now = performance.now();
        if (now - this.lastCursorSent > 50) {
            this.lastCursorSent = now;
            this.ns.send("cursor", { x, y });
        }
        if (!this.pendingStroke) return;
        const pts = this.pendingStroke.points;
        const last = pts[pts.length - 1];
        if (last[0] === x && last[1] === y) return;
        pts.push([x, y]);
        this.drawSegment(this.pendingStroke, last, [x, y]);
        this.ns.send("sp", { id: this.pendingStroke.id, point: [x, y] });
    };

    private onPointerUp = (e: PointerEvent) => {
        if (!this.pendingStroke) return;
        this.ns.send("se", { id: this.pendingStroke.id });
        this.pendingStroke = null;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    private styleFor(s: Stroke) { return s.erase ? "#ffffff" : s.color; }

    private drawSegment(s: Stroke, from: [number, number], to: [number, number]) {
        const sx = this.canvas.width / LOGICAL_W;
        const sy = this.canvas.height / LOGICAL_H;
        this.ctx.lineCap = "round";
        this.ctx.lineJoin = "round";
        this.ctx.strokeStyle = this.styleFor(s);
        this.ctx.lineWidth = s.size * Math.min(sx, sy);
        this.ctx.beginPath();
        this.ctx.moveTo(from[0] * sx, from[1] * sy);
        this.ctx.lineTo(to[0] * sx, to[1] * sy);
        this.ctx.stroke();
    }

    private drawStroke(s: Stroke) {
        if (s.points.length === 1) {
            const sx = this.canvas.width / LOGICAL_W;
            const sy = this.canvas.height / LOGICAL_H;
            this.ctx.fillStyle = this.styleFor(s);
            this.ctx.beginPath();
            this.ctx.arc(s.points[0][0] * sx, s.points[0][1] * sy, (s.size * Math.min(sx, sy)) / 2, 0, Math.PI * 2);
            this.ctx.fill();
            return;
        }
        for (let i = 1; i < s.points.length; i++) this.drawSegment(s, s.points[i - 1], s.points[i]);
    }

    private redrawAll() {
        this.ctx.fillStyle = "#ffffff";
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        for (const s of this.strokes) this.drawStroke(s);
    }

    private undoMine() {
        for (let i = this.strokes.length - 1; i >= 0; i--) {
            if (this.strokes[i].ownerId === this.net.me.id) {
                const removed = this.strokes.splice(i, 1)[0];
                this.ns.send("undo", { id: removed.id });
                this.redrawAll();
                return;
            }
        }
    }

    private clearAll() {
        if (!confirm("Clear the canvas for everyone?")) return;
        this.strokes = [];
        this.redrawAll();
        this.ns.send("clear", {});
    }

    private updateRemoteCursor(peerId: string, data: { x: number; y: number }) {
        const peer = this.net.peers.get(peerId);
        if (!peer) return;
        let el = this.cursorsEl.querySelector<HTMLDivElement>(`[data-peer="${peerId}"]`);
        if (!el) {
            el = document.createElement("div");
            el.className = "remote-cursor";
            el.dataset.peer = peerId;
            el.innerHTML = `<div class="dot"></div><div class="label"></div>`;
            const dot = el.querySelector<HTMLDivElement>(".dot")!;
            const lab = el.querySelector<HTMLDivElement>(".label")!;
            dot.style.background = peer.color;
            lab.textContent = peer.name;
            lab.style.background = peer.color;
            this.cursorsEl.appendChild(el);
        }
        const rect = this.canvas.getBoundingClientRect();
        el.style.left = `${(data.x / LOGICAL_W) * rect.width}px`;
        el.style.top = `${(data.y / LOGICAL_H) * rect.height}px`;
    }

    private async startRound() {
        const word = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
        const hash = await sha1(normalize(word));
        this.prompt = {
            word,
            hash,
            length: word.length,
            mask: maskWord(word),
            drawerId: this.net.me.id,
            drawerName: this.net.me.name,
            active: true,
        };
        this.ns.send("prompt", { hash, length: word.length, mask: this.prompt.mask });
        this.showPrompt(true);
        this.net.pushSystem(`You are drawing "${word}". Don't type it in chat.`);
    }

    private showPrompt(amDrawer: boolean) {
        if (!this.prompt) return;
        this.promptDisplay.classList.add("active");
        if (amDrawer) {
            this.promptDisplay.textContent = `Draw: ${this.prompt.word}`;
            this.revealBtn.classList.remove("hidden");
        } else {
            this.promptDisplay.textContent = `${this.prompt.drawerName}: ${this.prompt.mask} (${this.prompt.length})`;
            this.revealBtn.classList.add("hidden");
        }
    }

    private endRound() {
        if (this.prompt) this.prompt.active = false;
        this.promptDisplay.classList.remove("active");
        this.promptDisplay.textContent = "Round ended. Start another anytime.";
        this.revealBtn.classList.add("hidden");
    }

    private reveal() {
        if (!this.prompt?.active || this.prompt.drawerId !== this.net.me.id) return;
        this.net.pushSystem(`Drawer revealed: "${this.prompt.word}".`);
        this.ns.send("ended", { word: this.prompt.word, guesserId: null, guesserName: null, award: 0 });
        this.endRound();
    }

    private registerNetwork() {
        this.ns.on<{ id: string; color: string; size: number; erase: boolean; point: [number, number] }>(
            "ss",
            (data, peerId) => {
                if (!data?.id) return;
                const stroke: Stroke = {
                    id: String(data.id).slice(0, 64),
                    ownerId: peerId,
                    color: sanitizeColor(data.color),
                    size: clamp(+data.size || 4, 1, 80),
                    erase: !!data.erase,
                    points: [sanitizePoint(data.point)],
                };
                this.strokes.push(stroke);
                this.drawStroke(stroke);
            },
        );

        this.ns.on<{ id: string; point: [number, number] }>("sp", (data, peerId) => {
            const s = this.strokes.find((x) => x.id === data?.id && x.ownerId === peerId);
            if (!s) return;
            const p = sanitizePoint(data.point);
            const last = s.points[s.points.length - 1];
            s.points.push(p);
            this.drawSegment(s, last, p);
        });

        this.ns.on<{ id: string }>("se", () => { /* no-op */ });

        this.ns.on<{ id: string }>("undo", (data, peerId) => {
            const idx = this.strokes.findIndex((s) => s.id === data?.id && s.ownerId === peerId);
            if (idx >= 0) { this.strokes.splice(idx, 1); this.redrawAll(); }
        });

        this.ns.on<Record<string, never>>("clear", () => {
            this.strokes = [];
            this.redrawAll();
        });

        this.ns.on<{ x: number; y: number }>("cursor", (data, peerId) => this.updateRemoteCursor(peerId, data));

        this.ns.on<Record<string, never>>("history-request", (_d, peerId) => {
            if (this.strokes.length === 0) return;
            this.ns.send("history", { strokes: this.strokes.slice(-500) }, peerId);
        });

        this.ns.on<{ strokes: Stroke[] }>("history", (data) => {
            if (this.strokes.length > 0) return;
            if (!Array.isArray(data?.strokes)) return;
            this.strokes = data.strokes.filter(isValidStroke);
            this.redrawAll();
        });

        this.ns.on<{ hash: string; length: number; mask: string }>("prompt", (data, peerId) => {
            const peer = this.net.peers.get(peerId);
            this.prompt = {
                word: null,
                hash: data.hash,
                length: data.length,
                mask: data.mask,
                drawerId: peerId,
                drawerName: peer?.name ?? "someone",
                active: true,
            };
            this.showPrompt(false);
            this.net.pushSystem(`${this.prompt.drawerName} is drawing — guess in chat (${data.length} letters).`);
        });

        this.ns.on<{ word: string; guesserId: string | null; guesserName: string | null; award: number }>(
            "ended",
            (data, peerId) => {
                if (!this.prompt || peerId !== this.prompt.drawerId) return;
                const text = data.guesserId
                    ? `${data.guesserName} guessed "${data.word}" (+${data.award}).`
                    : `Round ended. The answer was "${data.word}".`;
                this.net.pushChat({
                    fromId: "system", fromName: "system", color: "#3d7a4e", text, kind: "good",
                });
                this.endRound();
            },
        );

        // Drawer-side guess validation: hook into chat by polling the chat log.
        const off = this.net.on("chat", (entry) => {
            if (!this.prompt?.active) return;
            if (this.prompt.drawerId !== this.net.me.id) return;
            if (entry.kind !== "user") return;
            if (entry.fromId === this.net.me.id) return;
            const guess = normalize(entry.text);
            const answer = normalize(this.prompt.word ?? "");
            if (!answer) return;
            if (guess === answer) {
                const award = 100;
                this.net.awardScore(entry.fromId, award);
                this.net.awardScore(this.net.me.id, 50);
                this.ns.send("ended", {
                    word: this.prompt.word,
                    guesserId: entry.fromId,
                    guesserName: entry.fromName,
                    award,
                });
                this.net.pushChat({
                    fromId: "system", fromName: "system", color: "#3d7a4e",
                    text: `${entry.fromName} guessed it (+${award}, drawer +50).`,
                    kind: "good",
                });
                this.endRound();
            } else if (isClose(guess, answer)) {
                // Only the drawer sees this nudge.
                this.net.pushChat({
                    fromId: "system", fromName: "system", color: "#b8741a",
                    text: `${entry.fromName} is close.`, kind: "warn",
                });
            }
        });
        this.cleanupFns.push(off);
    }

    destroy() {
        this.resizeObserver.disconnect();
        for (const fn of this.cleanupFns) fn();
        this.ns.close();
        this.container.innerHTML = "";
    }
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function sanitizeColor(c: unknown): string {
    return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#1c1c1a";
}
function sanitizePoint(p: unknown): [number, number] {
    if (!Array.isArray(p) || p.length !== 2) return [0, 0];
    return [clamp(+p[0] || 0, 0, LOGICAL_W), clamp(+p[1] || 0, 0, LOGICAL_H)];
}
function isValidStroke(s: unknown): s is Stroke {
    return !!s && typeof (s as Stroke).id === "string" && Array.isArray((s as Stroke).points);
}
function normalize(s: string) { return s.toLowerCase().trim().replace(/\s+/g, " "); }
function maskWord(w: string) { return w.replace(/[a-z]/gi, "_").replace(/_/g, "_ ").trim(); }
function isClose(a: string, b: string) {
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    if (Math.abs(a.length - b.length) > 2) return false;
    return levenshtein(a, b) <= 2;
}
function levenshtein(a: string, b: string) {
    const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[a.length][b.length];
}
async function sha1(s: string) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
