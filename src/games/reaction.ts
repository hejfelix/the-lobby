import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Reaction Race
 * ─────────────
 * Anyone presses "Start round" → the dot is red → after a random delay
 * (1.5–5s) the host broadcasts "GO" and the dot turns green. Each peer
 * measures the time between receiving the GO signal and clicking the dot.
 * False starts (clicking before GO) get marked DNF for that round.
 * Fastest peer to register a click wins +1 point.
 *
 * The "host" of a round is whoever pressed Start — they pick the delay
 * locally and send the GO signal. Network latency adds a small fairness
 * fudge but it's usually <50ms on the relays we use, well under human
 * reaction time noise (~250ms).
 */

const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 5000;
/** How long after GO to accept results before scoring + auto-advancing. */
const RESULT_WINDOW_MS = 3000;

type Phase = "idle" | "waiting" | "go" | "scored";

interface RoundResult {
    ms: number; // negative = false start
    name: string;
    color: string;
}

export const ReactionGame: Game = {
    id: "reaction",
    name: "Reaction Race",
    description: "Click when the dot turns green. Fastest finger wins +1.",
    create(container, net): GameInstance {
        const inst = new ReactionInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

class ReactionInstance {
    private container: HTMLElement;
    private net: Net;
    private ns: GameNamespace;

    private phase: Phase = "idle";
    private round = 0;
    private goAtLocalMs = 0;
    /** peerId → result for the current round. */
    private results: Map<string, RoundResult> = new Map();
    private clicked = false;

    private dotEl!: HTMLDivElement;
    private statusEl!: HTMLDivElement;
    private startBtn!: HTMLButtonElement;
    private resultsEl!: HTMLDivElement;
    private leaderEl!: HTMLDivElement;
    private bestEl!: HTMLDivElement;

    /** Personal stats this session. */
    private bestMs: number | null = null;
    private attempts = 0;
    private sumMs = 0;

    private timers: ReturnType<typeof setTimeout>[] = [];
    private unsubPeers: (() => void) | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("reaction");

        container.innerHTML = `
      <div class="game-layout reaction-layout">
        <aside class="toolbar reaction-toolbar">
          <div class="tool-group">
            <label>How it works</label>
            <p class="hint">
              Wait for the dot to turn green, then click as fast as you can.
              Click early and you're out for the round. Anyone can start a round.
            </p>
          </div>
          <div class="tool-group">
            <label>Your stats</label>
            <div class="reaction-best"></div>
          </div>
          <div class="tool-group">
            <label>Last round</label>
            <div class="reaction-results"></div>
          </div>
        </aside>
        <section class="reaction-stage">
          <div class="reaction-status"></div>
          <div class="reaction-dot reaction-idle" tabindex="0" role="button" aria-label="Reaction dot">
            <span class="reaction-dot-label">Press Start</span>
          </div>
          <button class="reaction-start" type="button">Start round</button>
          <div class="reaction-leader-wrap">
            <h3>Best times this session</h3>
            <div class="reaction-leader"></div>
          </div>
        </section>
      </div>
    `;

        const q = <T extends Element>(s: string) => container.querySelector(s) as T;
        this.dotEl = q<HTMLDivElement>(".reaction-dot");
        this.statusEl = q<HTMLDivElement>(".reaction-status");
        this.startBtn = q<HTMLButtonElement>(".reaction-start");
        this.resultsEl = q<HTMLDivElement>(".reaction-results");
        this.leaderEl = q<HTMLDivElement>(".reaction-leader");
        this.bestEl = q<HTMLDivElement>(".reaction-best");

        this.startBtn.onclick = () => this.startRound();
        this.dotEl.onclick = () => this.handleClick();
        this.dotEl.onkeydown = (e) => {
            if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                this.handleClick();
            }
        };

        this.registerNetwork();
        this.unsubPeers = this.net.on("peers", () => this.renderLeaderboard());
        this.renderStatus();
        this.renderLeaderboard();
        this.renderBest();
    }

    private startRound(): void {
        if (this.phase === "waiting" || this.phase === "go") return;
        const round = this.round + 1;
        const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
        // Tell peers we're starting; they'll show the red dot. The host waits the
        // delay locally, then broadcasts "go".
        this.ns.send("start", { round });
        this.beginWaiting(round);
        const goTimer = setTimeout(() => {
            this.ns.send("go", { round });
            this.fireGo(round);
        }, delay);
        this.timers.push(goTimer);
    }

    private beginWaiting(round: number): void {
        this.clearTimers();
        this.round = round;
        this.phase = "waiting";
        this.results.clear();
        this.clicked = false;
        this.dotEl.classList.remove("reaction-go", "reaction-scored", "reaction-idle");
        this.dotEl.classList.add("reaction-waiting");
        this.dotEl.querySelector(".reaction-dot-label")!.textContent = "Wait…";
        this.startBtn.disabled = true;
        this.renderStatus();
        this.renderResults();
    }

    private fireGo(round: number): void {
        if (round !== this.round) return;
        this.phase = "go";
        this.goAtLocalMs = performance.now();
        this.dotEl.classList.remove("reaction-waiting");
        this.dotEl.classList.add("reaction-go");
        this.dotEl.querySelector(".reaction-dot-label")!.textContent = "CLICK!";
        this.renderStatus();
        // After the result window, wrap up and re-enable start button.
        const endTimer = setTimeout(() => this.endRound(round), RESULT_WINDOW_MS);
        this.timers.push(endTimer);
    }

    private handleClick(): void {
        if (this.phase === "idle" || this.phase === "scored") return;
        if (this.clicked) return;
        this.clicked = true;
        if (this.phase === "waiting") {
            // False start.
            const result: RoundResult = { ms: -1, name: this.net.me.name, color: this.net.me.color };
            this.results.set(this.net.me.id, result);
            this.ns.send("result", { round: this.round, ms: -1 });
            this.renderResults();
            return;
        }
        // Phase = go.
        const ms = Math.max(1, Math.round(performance.now() - this.goAtLocalMs));
        const result: RoundResult = { ms, name: this.net.me.name, color: this.net.me.color };
        this.results.set(this.net.me.id, result);
        this.ns.send("result", { round: this.round, ms });
        // Update personal stats.
        this.attempts++;
        this.sumMs += ms;
        if (this.bestMs === null || ms < this.bestMs) this.bestMs = ms;
        this.renderResults();
        this.renderBest();
        this.renderLeaderboard();
    }

    private endRound(round: number): void {
        if (round !== this.round) return;
        if (this.phase === "scored") return;
        this.phase = "scored";
        this.dotEl.classList.remove("reaction-go", "reaction-waiting");
        this.dotEl.classList.add("reaction-scored");
        this.dotEl.querySelector(".reaction-dot-label")!.textContent = "Round over";
        this.startBtn.disabled = false;
        // Determine winner — fastest valid result wins +1.
        let winnerId: string | null = null;
        let winnerMs = Infinity;
        for (const [id, r] of this.results) {
            if (r.ms > 0 && r.ms < winnerMs) {
                winnerId = id;
                winnerMs = r.ms;
            }
        }
        if (winnerId === this.net.me.id) {
            this.net.awardScore(this.net.me.id, 1);
        }
        this.renderStatus();
        this.renderResults();
        // Auto-reset to idle after a moment so the dot is ready again.
        const idleTimer = setTimeout(() => {
            if (this.phase !== "scored") return;
            this.phase = "idle";
            this.dotEl.classList.remove("reaction-scored");
            this.dotEl.classList.add("reaction-idle");
            this.dotEl.querySelector(".reaction-dot-label")!.textContent = "Press Start";
            this.renderStatus();
        }, 2000);
        this.timers.push(idleTimer);
    }

    private registerNetwork(): void {
        this.ns.on<{ round: number }>("start", (data, peerId) => {
            if (!data || typeof data.round !== "number") return;
            // Only honour higher round numbers, to ignore stale messages.
            if (data.round <= this.round && this.phase !== "idle") return;
            const peer = this.net.peers.get(peerId);
            if (!peer) return;
            this.beginWaiting(data.round);
            this.statusEl.textContent = `${peer.name} started a round…`;
        });

        this.ns.on<{ round: number }>("go", (data, peerId) => {
            if (!data || data.round !== this.round) return;
            if (this.phase !== "waiting") return;
            void peerId;
            this.fireGo(data.round);
        });

        this.ns.on<{ round: number; ms: number }>("result", (data, peerId) => {
            if (!data || data.round !== this.round) return;
            const peer = this.net.peers.get(peerId);
            if (!peer) return;
            const ms = Number(data.ms);
            if (!Number.isFinite(ms)) return;
            this.results.set(peerId, { ms: Math.round(ms), name: peer.name, color: peer.color });
            this.renderResults();
        });
    }

    private renderStatus(): void {
        if (this.phase === "idle") {
            this.statusEl.textContent = "Ready when you are.";
        } else if (this.phase === "waiting") {
            this.statusEl.textContent = "Wait for green…";
        } else if (this.phase === "go") {
            this.statusEl.textContent = "GO!";
        } else if (this.phase === "scored") {
            const valid = [...this.results.entries()]
                .filter(([, r]) => r.ms > 0)
                .sort((a, b) => a[1].ms - b[1].ms);
            if (valid.length === 0) {
                this.statusEl.textContent = "Nobody clicked in time.";
            } else {
                const [, top] = valid[0];
                this.statusEl.textContent = `${top.name} won — ${top.ms}ms`;
            }
        }
    }

    private renderResults(): void {
        const rows = [...this.results.entries()].sort(([, a], [, b]) => {
            if (a.ms < 0 && b.ms < 0) return 0;
            if (a.ms < 0) return 1;
            if (b.ms < 0) return -1;
            return a.ms - b.ms;
        });
        if (rows.length === 0) {
            this.resultsEl.innerHTML = `<div class="reaction-empty">No results yet.</div>`;
            return;
        }
        this.resultsEl.innerHTML = "";
        for (const [id, r] of rows) {
            const row = document.createElement("div");
            row.className = "reaction-result-row";
            if (id === this.net.me.id) row.classList.add("mine");
            const dot = document.createElement("span");
            dot.className = "reaction-dot-mini";
            dot.style.background = r.color;
            const name = document.createElement("span");
            name.className = "reaction-result-name";
            name.textContent = r.name;
            const time = document.createElement("span");
            time.className = "reaction-result-time";
            time.textContent = r.ms < 0 ? "DNF" : `${r.ms}ms`;
            if (r.ms < 0) time.classList.add("dnf");
            row.append(dot, name, time);
            this.resultsEl.appendChild(row);
        }
    }

    private renderBest(): void {
        if (this.attempts === 0) {
            this.bestEl.innerHTML = `<div class="reaction-empty">No attempts yet.</div>`;
            return;
        }
        const avg = Math.round(this.sumMs / this.attempts);
        this.bestEl.innerHTML = `
      <div class="reaction-stat-row"><span>Best</span><span class="reaction-stat-val">${this.bestMs}ms</span></div>
      <div class="reaction-stat-row"><span>Avg</span><span class="reaction-stat-val">${avg}ms</span></div>
      <div class="reaction-stat-row"><span>Tries</span><span class="reaction-stat-val">${this.attempts}</span></div>
    `;
    }

    private renderLeaderboard(): void {
        // Use the room's persistent score for now (winner of round = +1).
        const peers = [...this.net.peers.entries()]
            .map(([id, p]) => ({ id, name: p.name, color: p.color, score: p.score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);
        this.leaderEl.innerHTML = "";
        for (let i = 0; i < peers.length; i++) {
            const p = peers[i];
            const row = document.createElement("div");
            row.className = "reaction-leader-row";
            if (p.id === this.net.me.id) row.classList.add("mine");
            row.innerHTML = `
        <span class="reaction-rank">${i + 1}</span>
        <span class="reaction-dot-mini" style="background:${p.color}"></span>
        <span class="reaction-leader-name">${escapeHtml(p.name)}</span>
        <span class="reaction-leader-score">${p.score}</span>
      `;
            this.leaderEl.appendChild(row);
        }
    }

    private clearTimers(): void {
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
    }

    destroy(): void {
        this.clearTimers();
        this.unsubPeers?.();
        this.ns.close();
        this.container.innerHTML = "";
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]!));
}
