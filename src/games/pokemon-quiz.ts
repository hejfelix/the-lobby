import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Pokémon Quiz — host-driven trivia rounds with several question types.
 *
 * The peer with the lowest peer ID acts as the host: it picks a round type,
 * fetches data from PokéAPI, and broadcasts a `question` payload. Every peer
 * (including the host) votes; after the deadline (or once everyone has voted)
 * the host broadcasts a `reveal` with the correct answer + updated scoreboard.
 *
 * Round types:
 *   1. whos-that     — silhouetted sprite, choose the name (4 options)
 *   2. pokedex       — flavor text (name redacted), choose primary type (4 options)
 *   3. dual-type     — sprite, choose the full Type/Type combo (4 options)
 *   4. stat-showdown — two sprites, pick the one with higher base stat total
 *   5. move-master   — list of 4 moves, guess the Pokémon (4 options)
 *   6. evolution     — sprite, pick what it evolves to/from (4 options)
 *   7. order-size    — drag four Pokémon into ascending height order
 *   8. order-weight  — drag four Pokémon into ascending weight order
 *
 * Late join: newcomer asks `sync-request`; host responds with the current
 * question + scoreboard so the newcomer drops straight into the active round.
 */

// Pokémon pool sizes per difficulty (national-dex IDs from 1 to N).
//   Easy   = Gen 1            (1–151)
//   Medium = Gens 1–3          (1–386)
//   Hard   = Gens 1–9 (all)    (1–1025)
const POOL_SIZES = { easy: 151, medium: 386, hard: 1025 } as const;
const ROUND_DURATION_MS = 20_000;
const REVEAL_DURATION_MS = 4_000;
const PICK_DELAY_MS = 1_000; // tiny pause before the next round begins.
const API = "https://pokeapi.co/api/v2";

type RoundType =
    | "whos-that"
    | "pokedex"
    | "dual-type"
    | "stat-showdown"
    | "move-master"
    | "evolution"
    | "order-size"
    | "order-weight";

const ROUND_LABELS: Record<RoundType, string> = {
    "whos-that": "Who's that Pokémon?",
    "pokedex": "Read the Pokédex — guess the type",
    "dual-type": "Name the dual type",
    "stat-showdown": "Stat showdown — who's stronger?",
    "move-master": "Move Master — name the Pokémon",
    "evolution": "Evolution chain",
    "order-size": "Order by size (smallest → largest)",
    "order-weight": "Order by weight (lightest → heaviest)",
};

const TYPE_COLORS: Record<string, string> = {
    normal: "#A8A77A", fire: "#EE8130", water: "#6390F0", electric: "#F7D02C",
    grass: "#7AC74C", ice: "#96D9D6", fighting: "#C22E28", poison: "#A33EA1",
    ground: "#E2BF65", flying: "#A98FF3", psychic: "#F95587", bug: "#A6B91A",
    rock: "#B6A136", ghost: "#735797", dragon: "#6F35FC", dark: "#705746",
    steel: "#B7B7CE", fairy: "#D685AD",
};

const ALL_TYPES = Object.keys(TYPE_COLORS);

interface Question {
    id: string;
    round: number;
    type: RoundType;
    promptText: string;
    flavorText?: string;
    images: string[]; // 1 image for most rounds, 2 for stat-showdown
    silhouette: boolean;
    /** If true, images are only shown after the answer is revealed. */
    hideUntilReveal?: boolean;
    options: string[]; // displayed labels
    /** Optional sprite URL per option (parallel to `options`). */
    optionImages?: string[];
    /** Optional metadata per option, shown after the reveal (e.g. "1.0 m"). */
    optionMeta?: string[];
    /** Multiple-choice answer (single index). Undefined for ordering rounds. */
    correctIdx?: number;
    /** Ordering rounds: canonical option order from smallest → largest. */
    correctOrder?: number[];
    revealName: string; // canonical name to show on reveal
    deadline: number; // Date.now() ms
    hostId: string;
}

interface Reveal {
    id: string;
    correctIdx?: number;
    correctOrder?: number[];
    revealName: string;
    revealImages: string[]; // un-silhouetted versions
    scores: Record<string, number>;
    votes: Record<string, number>;
}

// ---------- Pokémon API types (loose, defensive parsing) ----------

interface ApiPokemon {
    id: number;
    name: string;
    /** PokeAPI returns height in decimetres. */
    height: number;
    /** PokeAPI returns weight in hectograms. */
    weight: number;
    sprites: {
        other?: {
            "official-artwork"?: { front_default?: string | null };
        };
        front_default?: string | null;
    };
    types: Array<{ slot: number; type: { name: string } }>;
    stats: Array<{ base_stat: number; stat: { name: string } }>;
    moves: Array<{ move: { name: string } }>;
}

interface ApiSpecies {
    evolution_chain?: { url: string };
    flavor_text_entries: Array<{
        flavor_text: string;
        language: { name: string };
    }>;
}

interface ApiEvoNode {
    species: { name: string; url: string };
    evolves_to: ApiEvoNode[];
}

interface ApiEvoChain {
    chain: ApiEvoNode;
}

// ---------- helpers ----------

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]!));
}

function titleCase(s: string): string {
    return s.split(/[-_\s]+/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

function shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number, exclude: T[] = []): T[] {
    const pool = arr.filter((x) => !exclude.includes(x));
    return shuffle(pool).slice(0, n);
}

function spriteUrl(p: ApiPokemon): string {
    return (
        p.sprites.other?.["official-artwork"]?.front_default ||
        p.sprites.front_default ||
        ""
    );
}

function bst(p: ApiPokemon): number {
    return p.stats.reduce((s, x) => s + x.base_stat, 0);
}

function isOrderingRound(t: RoundType): boolean {
    return t === "order-size" || t === "order-weight";
}

function formatHeight(decimetres: number): string {
    return `${(decimetres / 10).toFixed(1)} m`;
}

function formatWeight(hectograms: number): string {
    return `${(hectograms / 10).toFixed(1)} kg`;
}

function cleanFlavor(text: string, name: string): string {
    const cleaned = text
        .replace(/[\f\n\r]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    // Hide the Pokémon's name (and POKéMON references) so it isn't a giveaway.
    const nameRe = new RegExp(name, "gi");
    return cleaned.replace(nameRe, "?????");
}

function pickEnglishFlavor(species: ApiSpecies, name: string): string | null {
    const en = species.flavor_text_entries.filter((e) => e.language.name === "en");
    if (!en.length) return null;
    return cleanFlavor(pickRandom(en).flavor_text, name);
}

// ---------- API cache ----------

const pokemonCache = new Map<number, Promise<ApiPokemon>>();
const speciesCache = new Map<number, Promise<ApiSpecies>>();

function fetchPokemon(id: number): Promise<ApiPokemon> {
    let p = pokemonCache.get(id);
    if (!p) {
        p = fetch(`${API}/pokemon/${id}`).then((r) => {
            if (!r.ok) throw new Error(`pokemon ${id}: ${r.status}`);
            return r.json() as Promise<ApiPokemon>;
        });
        pokemonCache.set(id, p);
    }
    return p;
}

function fetchSpecies(id: number): Promise<ApiSpecies> {
    let p = speciesCache.get(id);
    if (!p) {
        p = fetch(`${API}/pokemon-species/${id}`).then((r) => {
            if (!r.ok) throw new Error(`species ${id}: ${r.status}`);
            return r.json() as Promise<ApiSpecies>;
        });
        speciesCache.set(id, p);
    }
    return p;
}

const evoChainCache = new Map<string, Promise<ApiEvoChain>>();

function fetchEvoChain(url: string): Promise<ApiEvoChain> {
    let p = evoChainCache.get(url);
    if (!p) {
        p = fetch(url).then((r) => {
            if (!r.ok) throw new Error(`evo-chain ${url}: ${r.status}`);
            return r.json() as Promise<ApiEvoChain>;
        });
        evoChainCache.set(url, p);
    }
    return p;
}

function idFromUrl(url: string): number | null {
    const m = url.match(/\/(\d+)\/?$/);
    return m ? Number(m[1]) : null;
}

/** Find a node by species name; return that node + its parent (or null). */
function findEvoNode(
    chain: ApiEvoNode,
    name: string,
    parent: ApiEvoNode | null = null,
): { node: ApiEvoNode; parent: ApiEvoNode | null } | null {
    if (chain.species.name === name) return { node: chain, parent };
    for (const child of chain.evolves_to) {
        const found = findEvoNode(child, name, chain);
        if (found) return found;
    }
    return null;
}

// ---------- game ----------

interface QuizConfig {
    id: string;
    name: string;
    description: string;
    badge: string;
    poolSize: number;
    /** Trystero namespace — distinct per difficulty so messages don't cross. */
    ns: string;
}

function makeQuizGame(cfg: QuizConfig): Game {
    return {
        id: cfg.id,
        name: cfg.name,
        description: cfg.description,
        badge: cfg.badge,
        create(container, net): GameInstance {
            const inst = new PokemonQuizInstance(container, net, cfg);
            return { unmount: () => inst.destroy() };
        },
    };
}

export const PokemonQuizEasyGame: Game = makeQuizGame({
    id: "pokemon-quiz",
    name: "Pokémon Quiz — Easy",
    description:
        "Eight-round trivia powered by PokéAPI. Easy mode — Gen 1 only (the original 151).",
    badge: "Gen 1 · everyone votes",
    poolSize: POOL_SIZES.easy,
    ns: "pokemon-quiz-easy",
});

export const PokemonQuizMediumGame: Game = makeQuizGame({
    id: "pokemon-quiz-medium",
    name: "Pokémon Quiz — Medium",
    description:
        "Eight-round trivia. Medium mode — Gens 1–3 (Kanto, Johto and Hoenn).",
    badge: "Gens 1–3 · everyone votes",
    poolSize: POOL_SIZES.medium,
    ns: "pokemon-quiz-medium",
});

export const PokemonQuizHardGame: Game = makeQuizGame({
    id: "pokemon-quiz-hard",
    name: "Pokémon Quiz — Hard",
    description:
        "Eight-round trivia. Hard mode — every Pokémon from Gens 1–9.",
    badge: "All gens · everyone votes",
    poolSize: POOL_SIZES.hard,
    ns: "pokemon-quiz-hard",
});

class PokemonQuizInstance {
    private container: HTMLElement;
    private net: Net;
    private ns: GameNamespace;
    private cfg: QuizConfig;

    private isHost = false;
    private currentQuestion: Question | null = null;
    private currentReveal: Reveal | null = null;
    private revealStartT = 0; // local clock; used to animate the next-round countdown
    private myVote: number | null = null;
    private myOrder: number[] | null = null; // current local order for ordering rounds
    private orderSubmitted = false;
    private votes = new Map<string, number>(); // peerId → option idx (this round) — also used as a "submitted" set for ordering rounds
    private orderVotes = new Map<string, number[]>(); // peerId → submitted ordering
    private scores = new Map<string, number>(); // peerId → match score

    private roundNum = 0;
    private hostBusy = false; // host is fetching / scheduling
    private hostNextTimer: number | null = null;
    private hostRevealTimer: number | null = null;
    private rafId: number | null = null;
    private unsubPeers: (() => void) | null = null;

    // --- audio ---
    private audio: AudioContext | null = null;
    /** Last whole-second value we played a tick for, so we don't repeat. */
    private lastTickSec = -1;

    private stageEl!: HTMLDivElement;
    private sidebarEl!: HTMLDivElement;

    constructor(container: HTMLElement, net: Net, cfg: QuizConfig) {
        this.container = container;
        this.net = net;
        this.cfg = cfg;
        this.ns = net.namespace(cfg.ns);

        container.innerHTML = `
      <div class="game-layout pq-layout">
        <aside class="toolbar pq-sidebar">
          <div class="tool-group">
            <label>How to play</label>
            <p class="hint">
              Five rotating round types. Everyone votes each round; correct
              answers earn a point. The host (lowest peer ID) drives the timer
              and fetches questions from <a href="https://pokeapi.co" target="_blank" rel="noopener">PokéAPI</a>.
            </p>
          </div>
          <div class="tool-group">
            <label>Scoreboard</label>
            <div class="pq-scoreboard"></div>
          </div>
          <div class="tool-group">
            <label>Round types</label>
            <ul class="pq-types">
              <li>Who's that Pokémon?</li>
              <li>Read the dex, guess the type</li>
              <li>Name the dual type</li>
              <li>Stat showdown</li>
              <li>Move Master</li>
              <li>Evolution chain</li>
              <li>Order by size</li>
              <li>Order by weight</li>
            </ul>
          </div>
        </aside>
        <section class="pq-stage"></section>
      </div>
    `;

        this.stageEl = container.querySelector<HTMLDivElement>(".pq-stage")!;
        this.sidebarEl = container.querySelector<HTMLDivElement>(".pq-scoreboard")!;

        this.registerNetwork();
        this.unsubPeers = this.net.on("peers", () => {
            this.maybeBecomeHost();
            this.renderSidebar();
        });

        this.maybeBecomeHost();
        this.ns.send("sync-request", {});
        this.renderStage();
        this.renderSidebar();

        const tick = () => {
            this.refreshTimer();
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    destroy(): void {
        if (this.rafId != null) cancelAnimationFrame(this.rafId);
        if (this.hostNextTimer != null) clearTimeout(this.hostNextTimer);
        if (this.hostRevealTimer != null) clearTimeout(this.hostRevealTimer);
        this.unsubPeers?.();
        this.audio?.close().catch(() => { /* ignore */ });
        this.ns.close();
        this.container.innerHTML = "";
    }

    // ---------- audio ----------

    /** Lazy-init audio context (browsers require a user gesture). */
    private ensureAudio(): AudioContext | null {
        if (this.audio) return this.audio;
        try {
            const Ctor =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return null;
            this.audio = new Ctor();
            return this.audio;
        } catch {
            return null;
        }
    }

    private playTone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; sweepTo?: number; delay?: number } = {}): void {
        const ctx = this.audio;
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
        const t0 = ctx.currentTime + (opts.delay ?? 0);
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = opts.type ?? "sine";
        osc.frequency.setValueAtTime(freq, t0);
        if (opts.sweepTo !== undefined) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(40, opts.sweepTo), t0 + dur);
        }
        const peak = opts.gain ?? 0.18;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
    }

    /** Two-note descending blip when a new question lands. */
    private playNewQuestion(): void {
        if (!this.ensureAudio()) return;
        this.playTone(660, 0.12, { type: "triangle", gain: 0.14 });
        this.playTone(880, 0.18, { type: "triangle", gain: 0.14, delay: 0.1 });
    }

    /** Short tick for the final 5 seconds of voting. */
    private playTick(): void {
        if (!this.ensureAudio()) return;
        this.playTone(1200, 0.05, { type: "square", gain: 0.08 });
    }

    /** Rising arpeggio for the local player getting it right. */
    private playCorrect(): void {
        if (!this.ensureAudio()) return;
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.playTone(f, 0.18, { type: "triangle", gain: 0.16, delay: i * 0.07 }));
    }

    /** Low buzz for a wrong answer. */
    private playWrong(): void {
        if (!this.ensureAudio()) return;
        this.playTone(220, 0.35, { type: "sawtooth", gain: 0.14, sweepTo: 110 });
    }

    // ---------- networking ----------

    private registerNetwork(): void {
        this.ns.on<Question>("question", (q, peerId) => {
            if (!q || typeof q.id !== "string") return;
            // Only accept from the current host.
            if (peerId !== this.computeHostId()) return;
            this.currentQuestion = q;
            this.currentReveal = null;
            this.myVote = null;
            this.orderSubmitted = false;
            this.myOrder = isOrderingRound(q.type) && q.optionImages
                ? shuffle(q.options.map((_, i) => i))
                : null;
            this.votes.clear();
            this.orderVotes.clear();
            this.roundNum = q.round;
            this.lastTickSec = -1;
            this.playNewQuestion();
            this.renderStage();
        });

        this.ns.on<{ id: string; idx: number }>("vote", (data, peerId) => {
            if (!this.currentQuestion || data?.id !== this.currentQuestion.id) return;
            if (isOrderingRound(this.currentQuestion.type)) return; // wrong action for this round
            const idx = Number(data.idx);
            if (!Number.isInteger(idx) || idx < 0 || idx >= this.currentQuestion.options.length) return;
            this.votes.set(peerId, idx);
            this.renderStage();
            // Host: if everyone voted early, end the round.
            if (this.isHost && this.votes.size >= this.net.peers.size) {
                this.endRoundEarly();
            }
        });

        this.ns.on<{ id: string; order: number[] }>("order-vote", (data, peerId) => {
            const q = this.currentQuestion;
            if (!q || data?.id !== q.id) return;
            if (!isOrderingRound(q.type)) return;
            if (!Array.isArray(data.order) || data.order.length !== q.options.length) return;
            const seen = new Set<number>();
            for (const v of data.order) {
                const n = Number(v);
                if (!Number.isInteger(n) || n < 0 || n >= q.options.length) return;
                if (seen.has(n)) return;
                seen.add(n);
            }
            this.orderVotes.set(peerId, data.order.map(Number));
            this.votes.set(peerId, 0); // mark as "submitted" for early-end + voter count
            this.renderStage();
            if (this.isHost && this.votes.size >= this.net.peers.size) {
                this.endRoundEarly();
            }
        });

        this.ns.on<Reveal>("reveal", (r, peerId) => {
            if (!r || typeof r.id !== "string") return;
            if (peerId !== this.computeHostId()) return;
            if (!this.currentQuestion || r.id !== this.currentQuestion.id) return;
            this.currentReveal = r;
            this.revealStartT = Date.now();
            this.scores = new Map(Object.entries(r.scores));
            this.playRevealOutcome();
            this.renderStage();
            this.renderSidebar();
        });

        this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
            if (!this.isHost) return;
            // Send current question (if any) + scores so the newcomer is in sync.
            if (this.currentQuestion) {
                this.ns.send("question", this.currentQuestion, peerId);
                if (this.currentReveal) this.ns.send("reveal", this.currentReveal, peerId);
            }
            this.ns.send("scores", { scores: Object.fromEntries(this.scores) }, peerId);
        });

        this.ns.on<{ scores: Record<string, number> }>("scores", (data, peerId) => {
            if (peerId !== this.computeHostId()) return;
            if (!data?.scores || typeof data.scores !== "object") return;
            this.scores = new Map(Object.entries(data.scores));
            this.renderSidebar();
        });
    }

    // ---------- host logic ----------

    private computeHostId(): string {
        const ids = [...this.net.peers.keys()].sort();
        return ids[0] ?? this.net.me.id;
    }

    private maybeBecomeHost(): void {
        const shouldHost = this.computeHostId() === this.net.me.id;
        if (shouldHost && !this.isHost) {
            this.isHost = true;
            // Kick off the first round shortly.
            this.scheduleNextRound(800);
        } else if (!shouldHost && this.isHost) {
            this.isHost = false;
            if (this.hostNextTimer != null) clearTimeout(this.hostNextTimer);
            if (this.hostRevealTimer != null) clearTimeout(this.hostRevealTimer);
            this.hostNextTimer = null;
            this.hostRevealTimer = null;
        }
    }

    private scheduleNextRound(delayMs: number): void {
        if (this.hostNextTimer != null) clearTimeout(this.hostNextTimer);
        this.hostNextTimer = window.setTimeout(() => this.startRound(), delayMs);
    }

    private async startRound(): Promise<void> {
        if (!this.isHost || this.hostBusy) return;
        this.hostBusy = true;
        try {
            const types: RoundType[] = [
                "whos-that",
                "pokedex",
                "dual-type",
                "stat-showdown",
                "move-master",
                "evolution",
                "order-size",
                "order-weight",
            ];
            const type = types[this.roundNum % types.length];
            const question = await this.buildQuestion(type, this.roundNum + 1);
            if (!question) {
                // Something failed — try again shortly.
                this.scheduleNextRound(2000);
                return;
            }
            this.currentQuestion = question;
            this.currentReveal = null;
            this.votes.clear();
            this.orderVotes.clear();
            this.myVote = null;
            this.orderSubmitted = false;
            this.myOrder = isOrderingRound(question.type) && question.optionImages
                ? shuffle(question.options.map((_, i) => i))
                : null;
            this.roundNum = question.round;
            this.ns.send("question", question);
            this.renderStage();

            // Schedule reveal at the deadline.
            if (this.hostRevealTimer != null) clearTimeout(this.hostRevealTimer);
            const wait = Math.max(0, question.deadline - Date.now());
            this.hostRevealTimer = window.setTimeout(() => this.revealAndAdvance(), wait);
        } catch (err) {
            console.warn("[pokemon-quiz] startRound failed", err);
            this.scheduleNextRound(2000);
        } finally {
            this.hostBusy = false;
        }
    }

    private endRoundEarly(): void {
        if (!this.isHost) return;
        if (this.hostRevealTimer != null) clearTimeout(this.hostRevealTimer);
        this.hostRevealTimer = window.setTimeout(() => this.revealAndAdvance(), 250);
    }

    private revealAndAdvance(): void {
        if (!this.isHost || !this.currentQuestion) return;
        const q = this.currentQuestion;
        // Award scores.
        if (isOrderingRound(q.type) && q.correctOrder) {
            // +1 per correctly placed item (out of 4).
            for (const [peerId, order] of this.orderVotes) {
                let correctCount = 0;
                for (let i = 0; i < q.correctOrder.length; i++) {
                    if (order[i] === q.correctOrder[i]) correctCount++;
                }
                if (correctCount > 0) {
                    this.scores.set(peerId, (this.scores.get(peerId) ?? 0) + correctCount);
                    this.net.awardScore(peerId, correctCount);
                }
            }
        } else {
            for (const [peerId, idx] of this.votes) {
                if (idx === q.correctIdx) {
                    this.scores.set(peerId, (this.scores.get(peerId) ?? 0) + 1);
                    this.net.awardScore(peerId, 1);
                }
            }
        }
        const reveal: Reveal = {
            id: q.id,
            correctIdx: q.correctIdx,
            correctOrder: q.correctOrder,
            revealName: q.revealName,
            revealImages: q.images,
            scores: Object.fromEntries(this.scores),
            votes: Object.fromEntries(this.votes),
        };
        this.currentReveal = reveal;
        this.revealStartT = Date.now();
        this.ns.send("reveal", reveal);
        this.playRevealOutcome();
        this.renderStage();
        this.renderSidebar();
        this.scheduleNextRound(REVEAL_DURATION_MS + PICK_DELAY_MS);
    }

    /** Play correct/wrong sound based on the local player's answer this round. */
    private playRevealOutcome(): void {
        const q = this.currentQuestion;
        const r = this.currentReveal;
        if (!q || !r) return;
        if (isOrderingRound(q.type) && r.correctOrder && this.myOrder && this.orderSubmitted) {
            let correctCount = 0;
            for (let i = 0; i < r.correctOrder.length; i++) {
                if (this.myOrder[i] === r.correctOrder[i]) correctCount++;
            }
            // Half or more in the right slot counts as a "correct" vibe.
            if (correctCount >= Math.ceil(r.correctOrder.length / 2)) this.playCorrect();
            else this.playWrong();
        } else if (this.myVote !== null && r.correctIdx !== undefined) {
            if (this.myVote === r.correctIdx) this.playCorrect();
            else this.playWrong();
        }
    }

    // ---------- question builders ----------

    private async buildQuestion(type: RoundType, round: number): Promise<Question | null> {
        switch (type) {
            case "whos-that": return this.buildWhosThat(round);
            case "pokedex": return this.buildPokedex(round);
            case "dual-type": return this.buildDualType(round);
            case "stat-showdown": return this.buildStatShowdown(round);
            case "move-master": return this.buildMoveMaster(round);
            case "evolution": return this.buildEvolution(round);
            case "order-size": return this.buildOrder(round, "size");
            case "order-weight": return this.buildOrder(round, "weight");
        }
    }

    private async buildWhosThat(round: number): Promise<Question | null> {
        const ids = pickN([...Array(this.cfg.poolSize)].map((_, i) => i + 1), 4);
        const mons = await Promise.all(ids.map(fetchPokemon));
        const correct = mons[0];
        const opts = shuffle(mons.map((m) => titleCase(m.name)));
        const correctIdx = opts.indexOf(titleCase(correct.name));
        return this.makeQuestion({
            round,
            type: "whos-that",
            promptText: "Who's that Pokémon?",
            images: [spriteUrl(correct)],
            silhouette: true,
            options: opts,
            correctIdx,
            revealName: titleCase(correct.name),
        });
    }

    private async buildPokedex(round: number): Promise<Question | null> {
        // Try a handful of candidates until we find one with English flavor text.
        for (let attempt = 0; attempt < 5; attempt++) {
            const id = 1 + Math.floor(Math.random() * this.cfg.poolSize);
            const [mon, species] = await Promise.all([fetchPokemon(id), fetchSpecies(id)]);
            const flavor = pickEnglishFlavor(species, mon.name);
            if (!flavor) continue;
            const primary = mon.types.find((t) => t.slot === 1)?.type.name ?? "normal";
            const wrongs = pickN(ALL_TYPES, 3, [primary]);
            const opts = shuffle([primary, ...wrongs]).map(titleCase);
            const correctIdx = opts.indexOf(titleCase(primary));
            return this.makeQuestion({
                round,
                type: "pokedex",
                promptText: "Read this Pokédex entry — what's its primary type?",
                flavorText: flavor,
                images: [spriteUrl(mon)],
                silhouette: false,
                hideUntilReveal: true,
                options: opts,
                correctIdx,
                revealName: titleCase(mon.name),
            });
        }
        return null;
    }

    private async buildDualType(round: number): Promise<Question | null> {
        // Find a dual-type Pokémon among a few random picks.
        for (let attempt = 0; attempt < 8; attempt++) {
            const id = 1 + Math.floor(Math.random() * this.cfg.poolSize);
            const mon = await fetchPokemon(id);
            if (mon.types.length < 2) continue;
            const t1 = mon.types.find((t) => t.slot === 1)!.type.name;
            const t2 = mon.types.find((t) => t.slot === 2)!.type.name;
            const correctLabel = `${titleCase(t1)} / ${titleCase(t2)}`;
            // Build distractors: swap one or both types.
            const distractors = new Set<string>();
            while (distractors.size < 3) {
                const a = pickRandom(ALL_TYPES);
                const b = pickRandom(ALL_TYPES.filter((x) => x !== a));
                const label = `${titleCase(a)} / ${titleCase(b)}`;
                if (label !== correctLabel) distractors.add(label);
            }
            const opts = shuffle([correctLabel, ...distractors]);
            return this.makeQuestion({
                round,
                type: "dual-type",
                promptText: `What's ${titleCase(mon.name)}'s dual type?`,
                images: [spriteUrl(mon)],
                silhouette: false,
                options: opts,
                correctIdx: opts.indexOf(correctLabel),
                revealName: titleCase(mon.name),
            });
        }
        return null;
    }

    private async buildStatShowdown(round: number): Promise<Question | null> {
        for (let attempt = 0; attempt < 6; attempt++) {
            const [idA, idB] = pickN([...Array(this.cfg.poolSize)].map((_, i) => i + 1), 2);
            const [a, b] = await Promise.all([fetchPokemon(idA), fetchPokemon(idB)]);
            const bstA = bst(a);
            const bstB = bst(b);
            if (bstA === bstB) continue; // skip ties.
            const opts = [titleCase(a.name), titleCase(b.name)];
            const correctIdx = bstA > bstB ? 0 : 1;
            return this.makeQuestion({
                round,
                type: "stat-showdown",
                promptText: "Who has the higher base stat total?",
                images: [spriteUrl(a), spriteUrl(b)],
                silhouette: false,
                options: opts,
                correctIdx,
                revealName: `${titleCase(a.name)} (${bstA}) vs ${titleCase(b.name)} (${bstB})`,
            });
        }
        return null;
    }

    private async buildMoveMaster(round: number): Promise<Question | null> {
        for (let attempt = 0; attempt < 5; attempt++) {
            const ids = pickN([...Array(this.cfg.poolSize)].map((_, i) => i + 1), 4);
            const mons = await Promise.all(ids.map(fetchPokemon));
            const correct = mons[0];
            if (correct.moves.length < 4) continue;
            const moves = pickN(correct.moves.map((m) => m.move.name), 4)
                .map(titleCase);
            const shuffled = shuffle(mons);
            const opts = shuffled.map((m) => titleCase(m.name));
            const optionImages = shuffled.map((m) => spriteUrl(m));
            const correctIdx = opts.indexOf(titleCase(correct.name));
            return this.makeQuestion({
                round,
                type: "move-master",
                promptText: "These are four of its moves. Who learns them?",
                flavorText: moves.join(" · "),
                images: [],
                silhouette: false,
                options: opts,
                optionImages,
                correctIdx,
                revealName: titleCase(correct.name),
            });
        }
        return null;
    }

    private async buildEvolution(round: number): Promise<Question | null> {
        // Pick a Gen 1 species, find a neighbor (prev or next) in its chain,
        // and ask which Pokémon it evolves to/from. Distractors are random
        // Gen 1 Pokémon (excluding the source and the answer).
        for (let attempt = 0; attempt < 8; attempt++) {
            const id = 1 + Math.floor(Math.random() * this.cfg.poolSize);
            try {
                const species = await fetchSpecies(id);
                if (!species.evolution_chain?.url) continue;
                const chain = await fetchEvoChain(species.evolution_chain.url);
                const source = await fetchPokemon(id);
                const found = findEvoNode(chain.chain, source.name);
                if (!found) continue;

                // Possible neighbors: parent (evolves from) or first child (evolves to).
                type Neighbor = { name: string; direction: "to" | "from" };
                const neighbors: Neighbor[] = [];
                if (found.parent) {
                    neighbors.push({ name: found.parent.species.name, direction: "from" });
                }
                if (found.node.evolves_to.length > 0) {
                    neighbors.push({
                        name: pickRandom(found.node.evolves_to).species.name,
                        direction: "to",
                    });
                }
                if (!neighbors.length) continue;
                const pick = pickRandom(neighbors);
                const correctId = idFromUrl(
                    pick.direction === "from"
                        ? found.parent!.species.url
                        : found.node.evolves_to.find((c) => c.species.name === pick.name)!.species.url,
                );
                if (!correctId) continue;

                const correctMon = await fetchPokemon(correctId);

                // Distractor pool: Gen 1 ids minus the source and the answer.
                const exclude = new Set<number>([id, correctId]);
                const distractorIds: number[] = [];
                while (distractorIds.length < 3) {
                    const cand = 1 + Math.floor(Math.random() * this.cfg.poolSize);
                    if (exclude.has(cand)) continue;
                    exclude.add(cand);
                    distractorIds.push(cand);
                }
                const distractors = await Promise.all(distractorIds.map(fetchPokemon));
                const all = shuffle([correctMon, ...distractors]);
                const opts = all.map((m) => titleCase(m.name));
                const optionImages = all.map((m) => spriteUrl(m));
                const correctIdx = opts.indexOf(titleCase(correctMon.name));

                const verb = pick.direction === "to" ? "evolve into" : "evolve from";
                return this.makeQuestion({
                    round,
                    type: "evolution",
                    promptText: `What does ${titleCase(source.name)} ${verb}?`,
                    images: [spriteUrl(source)],
                    silhouette: false,
                    options: opts,
                    optionImages,
                    correctIdx,
                    revealName: titleCase(correctMon.name),
                });
            } catch (err) {
                console.warn("[pokemon-quiz] evolution attempt failed", err);
                continue;
            }
        }
        return null;
    }

    private async buildOrder(round: number, dim: "size" | "weight"): Promise<Question | null> {
        // Pick four distinct Gen 1 Pokémon, ensure they have distinct height/weight
        // values so there's a single canonical ordering.
        for (let attempt = 0; attempt < 6; attempt++) {
            const ids = pickN([...Array(this.cfg.poolSize)].map((_, i) => i + 1), 4);
            const mons = await Promise.all(ids.map(fetchPokemon));
            const valueOf = (m: ApiPokemon) => (dim === "size" ? m.height : m.weight);
            const values = mons.map(valueOf);
            // Reject if any duplicates — keeps the canonical order unambiguous.
            if (new Set(values).size !== values.length) continue;

            // Display the Pokémon in shuffled order; correctOrder is the ascending
            // permutation of these display indices.
            const display = shuffle(mons);
            const opts = display.map((m) => titleCase(m.name));
            const optionImages = display.map((m) => spriteUrl(m));
            const optionMeta = display.map((m) =>
                dim === "size" ? formatHeight(m.height) : formatWeight(m.weight),
            );
            const correctOrder = display
                .map((m, i) => ({ i, v: valueOf(m) }))
                .sort((a, b) => a.v - b.v)
                .map((x) => x.i);

            return this.makeQuestion({
                round,
                type: dim === "size" ? "order-size" : "order-weight",
                promptText: dim === "size"
                    ? "Drag the Pokémon into order, smallest → largest."
                    : "Drag the Pokémon into order, lightest → heaviest.",
                images: [],
                silhouette: false,
                options: opts,
                optionImages,
                optionMeta,
                correctOrder,
                revealName: display
                    .map((m, i) => `${titleCase(m.name)} (${optionMeta[i]})`)
                    .join(", "),
            });
        }
        return null;
    }

    private makeQuestion(partial: Omit<Question, "id" | "deadline" | "hostId">): Question {
        return {
            ...partial,
            id: crypto.randomUUID(),
            deadline: Date.now() + ROUND_DURATION_MS,
            hostId: this.net.me.id,
        };
    }

    // ---------- player vote ----------

    private vote(idx: number): void {
        if (!this.currentQuestion || this.currentReveal) return;
        if (isOrderingRound(this.currentQuestion.type)) return;
        if (Date.now() > this.currentQuestion.deadline) return;
        if (this.myVote !== null) return; // one vote per round
        this.myVote = idx;
        this.votes.set(this.net.me.id, idx);
        this.ns.send("vote", { id: this.currentQuestion.id, idx });
        this.renderStage();
        // If we're the host (e.g. solo, or last to vote), end the round now.
        if (this.isHost && this.votes.size >= this.net.peers.size) {
            this.endRoundEarly();
        }
    }

    private submitOrder(): void {
        const q = this.currentQuestion;
        if (!q || this.currentReveal) return;
        if (!isOrderingRound(q.type)) return;
        if (Date.now() > q.deadline) return;
        if (this.orderSubmitted || !this.myOrder) return;
        this.orderSubmitted = true;
        this.orderVotes.set(this.net.me.id, this.myOrder.slice());
        this.votes.set(this.net.me.id, 0);
        this.ns.send("order-vote", { id: q.id, order: this.myOrder.slice() });
        this.renderStage();
        if (this.isHost && this.votes.size >= this.net.peers.size) {
            this.endRoundEarly();
        }
    }

    private moveOrderItem(from: number, to: number): void {
        if (!this.myOrder || this.orderSubmitted || this.currentReveal) return;
        if (from === to || from < 0 || to < 0) return;
        if (from >= this.myOrder.length || to >= this.myOrder.length) return;
        const next = this.myOrder.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        this.myOrder = next;
        this.renderStage();
    }

    // ---------- rendering ----------

    private renderStage(): void {
        const q = this.currentQuestion;
        if (!q) {
            this.stageEl.innerHTML = `
        <div class="pq-empty">
          <h2>Pokémon Quiz</h2>
          <p>Loading first question…</p>
        </div>
      `;
            return;
        }
        const reveal = this.currentReveal;
        const totalVoters = this.net.peers.size;
        const voted = this.votes.size;

        const showImages = q.images.length && !(q.hideUntilReveal && !reveal);
        const imagesHtml = showImages
            ? `<div class="pq-images ${q.images.length > 1 ? "pq-images-pair" : ""}">
                  ${q.images.map((src, i) => `
                    <div class="pq-image-wrap">
                      <img class="pq-image ${q.silhouette && !reveal ? "pq-silhouette" : ""}"
                        src="${escapeHtml(src)}" alt="" draggable="false" />
                      ${reveal && q.type === "stat-showdown"
                    ? `<div class="pq-image-label">${escapeHtml(q.options[i])}</div>`
                    : ""}
                    </div>
                  `).join("")}
                </div>`
            : "";

        let flavorHtml = "";
        if (q.flavorText) {
            if (q.type === "move-master") {
                const moves = q.flavorText.split(" · ");
                flavorHtml = `<ul class="pq-moves">${moves
                    .map((m) => `<li>${escapeHtml(m)}</li>`)
                    .join("")}</ul>`;
            } else {
                flavorHtml = `<blockquote class="pq-flavor">${escapeHtml(q.flavorText)}</blockquote>`;
            }
        }

        const ordering = isOrderingRound(q.type);

        const optionsHtml = ordering
            ? this.renderOrderHtml(q, reveal !== null)
            : q.options.map((opt, i) => {
                const isCorrect = reveal && i === q.correctIdx;
                const isWrongMine = reveal && this.myVote === i && i !== q.correctIdx;
                const isMine = this.myVote === i;
                const voteCount = [...this.votes.values()].filter((v) => v === i).length;
                const optImg = q.optionImages?.[i];
                const cls = [
                    "pq-option",
                    optImg ? "pq-option-with-image" : "",
                    isMine ? "pq-mine" : "",
                    reveal && isCorrect ? "pq-correct" : "",
                    isWrongMine ? "pq-wrong" : "",
                ].filter(Boolean).join(" ");
                const typeColor = q.type === "pokedex" || q.type === "dual-type"
                    ? this.optionAccent(opt)
                    : "";
                const accent = typeColor ? `style="--pq-accent:${typeColor}"` : "";
                const imgHtml = optImg
                    ? `<img class="pq-option-image" src="${escapeHtml(optImg)}" alt="" draggable="false" />`
                    : "";
                return `
            <button type="button" class="${cls}" data-idx="${i}" ${accent}
              ${reveal || this.myVote !== null ? "disabled" : ""}>
              ${imgHtml}
              <span class="pq-option-label">${escapeHtml(opt)}</span>
              ${reveal ? `<span class="pq-option-count">${voteCount}</span>` : ""}
            </button>
          `;
            }).join("");

        const remaining = Math.max(0, q.deadline - Date.now());
        const remSec = Math.ceil(remaining / 1000);

        const REVEAL_TOTAL_MS = REVEAL_DURATION_MS + PICK_DELAY_MS;
        const revealRem = reveal
            ? Math.max(0, REVEAL_TOTAL_MS - (Date.now() - this.revealStartT))
            : 0;
        const revealSec = Math.ceil(revealRem / 1000);
        // Circumference of r=22 circle ≈ 138.23.
        const circ = 2 * Math.PI * 22;
        const dashOffset = reveal ? circ * (1 - revealRem / REVEAL_TOTAL_MS) : 0;

        let revealText = "";
        if (reveal) {
            if (ordering && q.correctOrder && this.myOrder) {
                let correct = 0;
                for (let i = 0; i < q.correctOrder.length; i++) {
                    if (this.myOrder[i] === q.correctOrder[i]) correct++;
                }
                revealText = this.orderSubmitted
                    ? `You placed <strong>${correct} / ${q.correctOrder.length}</strong> correctly.`
                    : `Correct order revealed below.`;
            } else if (q.correctIdx !== undefined) {
                revealText =
                    `Answer: <strong>${escapeHtml(q.options[q.correctIdx])}</strong>` +
                    ` · It was <strong>${escapeHtml(q.revealName)}</strong>`;
            }
        }

        const statusHtml = reveal
            ? `<div class="pq-reveal">
                  <div class="pq-reveal-text">${revealText}</div>
                  <div class="pq-next-timer" title="Next round">
                    <svg viewBox="0 0 56 56" width="56" height="56">
                      <circle cx="28" cy="28" r="22" fill="none"
                        stroke="rgba(0,0,0,0.08)" stroke-width="5" />
                      <circle class="pq-next-ring" cx="28" cy="28" r="22" fill="none"
                        stroke="var(--accent)" stroke-width="5" stroke-linecap="round"
                        stroke-dasharray="${circ.toFixed(2)}"
                        stroke-dashoffset="${dashOffset.toFixed(2)}"
                        transform="rotate(-90 28 28)" />
                      <text class="pq-next-label" x="28" y="33" text-anchor="middle"
                        font-family="ui-monospace, monospace" font-size="16"
                        font-weight="700" fill="var(--ink)">${revealSec}</text>
                    </svg>
                  </div>
               </div>`
            : `<div class="pq-status">
                  <span class="pq-timer ${remSec <= 5 ? "pq-timer-warn" : ""}">${remSec}s</span>
                  <span class="pq-voters">${voted} / ${totalVoters} voted</span>
               </div>`;

        this.stageEl.innerHTML = `
      <div class="pq-card">
        <div class="pq-round">Round ${q.round} · ${escapeHtml(ROUND_LABELS[q.type])}</div>
        <h2 class="pq-prompt">${escapeHtml(q.promptText)}</h2>
        ${imagesHtml}
        ${flavorHtml}
        <div class="pq-options">${optionsHtml}</div>
        ${statusHtml}
      </div>
    `;

        // Wire up option buttons.
        this.stageEl.querySelectorAll<HTMLButtonElement>(".pq-option").forEach((btn) => {
            const idx = Number(btn.dataset.idx);
            btn.addEventListener("click", () => { this.ensureAudio(); this.vote(idx); });
        });

        // Wire up the ordering UI.
        if (ordering) {
            this.wireOrderInteractions();
        }
    }

    private renderOrderHtml(q: Question, isReveal: boolean): string {
        const order = this.myOrder ?? q.options.map((_, i) => i);
        const correct = q.correctOrder;
        const submitted = this.orderSubmitted || isReveal;
        const items = order.map((optIdx, slot) => {
            const name = q.options[optIdx];
            const img = q.optionImages?.[optIdx];
            const meta = q.optionMeta?.[optIdx];
            const correctHere = isReveal && correct ? correct[slot] === optIdx : false;
            const wrongHere = isReveal && correct ? correct[slot] !== optIdx : false;
            const cls = [
                "pq-order-item",
                submitted ? "pq-order-locked" : "",
                correctHere ? "pq-order-correct" : "",
                wrongHere ? "pq-order-wrong" : "",
            ].filter(Boolean).join(" ");
            return `
        <li class="${cls}" draggable="${!submitted}" data-slot="${slot}">
          <span class="pq-order-rank">${slot + 1}</span>
          ${img ? `<img class="pq-order-img" src="${escapeHtml(img)}" alt="" draggable="false" />` : ""}
          <span class="pq-order-name">${escapeHtml(name)}</span>
          ${isReveal && meta ? `<span class="pq-order-meta">${escapeHtml(meta)}</span>` : ""}
          ${!submitted ? `<span class="pq-order-grip" aria-hidden="true">⋮⋮</span>` : ""}
        </li>`;
        }).join("");

        const buttonHtml = !isReveal
            ? `<div class="pq-order-actions">
                  <button type="button" class="pq-order-submit" ${submitted ? "disabled" : ""}>
                    ${submitted ? "Locked in" : "Lock in order"}
                  </button>
               </div>`
            : "";

        // On reveal, also render the canonical correct ordering so players can
        // see what the right answer was, regardless of how they ordered theirs.
        let correctHtml = "";
        if (isReveal && correct) {
            const correctItems = correct.map((optIdx, slot) => {
                const name = q.options[optIdx];
                const img = q.optionImages?.[optIdx];
                const meta = q.optionMeta?.[optIdx];
                return `
            <li class="pq-order-item pq-order-locked pq-order-answer" data-slot="${slot}">
              <span class="pq-order-rank">${slot + 1}</span>
              ${img ? `<img class="pq-order-img" src="${escapeHtml(img)}" alt="" draggable="false" />` : ""}
              <span class="pq-order-name">${escapeHtml(name)}</span>
              ${meta ? `<span class="pq-order-meta">${escapeHtml(meta)}</span>` : ""}
            </li>`;
            }).join("");
            correctHtml = `
        <div class="pq-order-correct-heading">Correct order</div>
        <ol class="pq-order-list pq-order-list-answer">${correctItems}</ol>`;
        }

        const yourHeading = isReveal
            ? `<div class="pq-order-correct-heading">Your order</div>`
            : "";

        return `${yourHeading}<ol class="pq-order-list">${items}</ol>${buttonHtml}${correctHtml}`;
    }

    private wireOrderInteractions(): void {
        const list = this.stageEl.querySelector<HTMLOListElement>(".pq-order-list");
        if (!list) return;
        const submit = this.stageEl.querySelector<HTMLButtonElement>(".pq-order-submit");
        submit?.addEventListener("click", () => { this.ensureAudio(); this.submitOrder(); });
        if (this.orderSubmitted || this.currentReveal) return;

        let dragFrom: number | null = null;
        list.querySelectorAll<HTMLLIElement>(".pq-order-item").forEach((li) => {
            li.addEventListener("dragstart", (e) => {
                this.ensureAudio();
                dragFrom = Number(li.dataset.slot);
                li.classList.add("pq-order-dragging");
                e.dataTransfer?.setData("text/plain", String(dragFrom));
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            });
            li.addEventListener("dragend", () => {
                li.classList.remove("pq-order-dragging");
                list.querySelectorAll(".pq-order-over").forEach((el) =>
                    el.classList.remove("pq-order-over"),
                );
                dragFrom = null;
            });
            li.addEventListener("dragover", (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                li.classList.add("pq-order-over");
            });
            li.addEventListener("dragleave", () => li.classList.remove("pq-order-over"));
            li.addEventListener("drop", (e) => {
                e.preventDefault();
                li.classList.remove("pq-order-over");
                const to = Number(li.dataset.slot);
                const from = dragFrom ?? Number(e.dataTransfer?.getData("text/plain"));
                if (Number.isFinite(from) && Number.isFinite(to)) {
                    this.moveOrderItem(from, to);
                }
            });
        });
    }

    private optionAccent(opt: string): string {
        // For type-style options, colour the button by the (first) type name.
        const first = opt.split(/[\s/]+/)[0]?.toLowerCase() ?? "";
        return TYPE_COLORS[first] ?? "";
    }

    private renderSidebar(): void {
        const rows = [...this.net.peers.entries()]
            .map(([id, info]) => ({ id, info, score: this.scores.get(id) ?? 0 }))
            .sort((a, b) => b.score - a.score);
        if (!rows.length) {
            this.sidebarEl.innerHTML = `<p class="hint">No players yet.</p>`;
            return;
        }
        this.sidebarEl.innerHTML = rows.map((r) => `
      <div class="pq-score-row ${r.id === this.net.me.id ? "pq-score-me" : ""}">
        <span class="pq-score-dot" style="background:${escapeHtml(r.info.color)}"></span>
        <span class="pq-score-name">${escapeHtml(r.info.name)}</span>
        <span class="pq-score-val">${r.score}</span>
      </div>
    `).join("");
    }

    private refreshTimer(): void {
        const q = this.currentQuestion;
        if (!q) return;
        if (this.currentReveal) {
            const ring = this.stageEl.querySelector<SVGCircleElement>(".pq-next-ring");
            const label = this.stageEl.querySelector<SVGTextElement>(".pq-next-label");
            if (!ring || !label) return;
            const total = REVEAL_DURATION_MS + PICK_DELAY_MS;
            const remaining = Math.max(0, total - (Date.now() - this.revealStartT));
            const circ = 2 * Math.PI * 22;
            const offset = circ * (1 - remaining / total);
            ring.setAttribute("stroke-dashoffset", offset.toFixed(2));
            const sec = Math.ceil(remaining / 1000).toString();
            if (label.textContent !== sec) label.textContent = sec;
            return;
        }
        const timerEl = this.stageEl.querySelector<HTMLSpanElement>(".pq-timer");
        if (!timerEl) return;
        const remaining = Math.max(0, q.deadline - Date.now());
        const remSec = Math.ceil(remaining / 1000);
        const text = `${remSec}s`;
        if (timerEl.textContent !== text) timerEl.textContent = text;
        timerEl.classList.toggle("pq-timer-warn", remSec <= 5);
        // Tick once per second during the final 5s.
        if (remSec > 0 && remSec <= 5 && remSec !== this.lastTickSec) {
            this.lastTickSec = remSec;
            this.playTick();
        }
    }
}
