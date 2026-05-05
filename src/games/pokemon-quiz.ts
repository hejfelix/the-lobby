import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";

/**
 * Pokémon Quiz — host-driven trivia rounds with five question types.
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
 *
 * Late join: newcomer asks `sync-request`; host responds with the current
 * question + scoreboard so the newcomer drops straight into the active round.
 */

const POOL_SIZE = 151; // Gen 1 — recognisable enough for a casual quiz.
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
    | "evolution";

const ROUND_LABELS: Record<RoundType, string> = {
    "whos-that": "Who's that Pokémon?",
    "pokedex": "Read the Pokédex — guess the type",
    "dual-type": "Name the dual type",
    "stat-showdown": "Stat showdown — who's stronger?",
    "move-master": "Move Master — name the Pokémon",
    "evolution": "Evolution chain",
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
    correctIdx: number;
    revealName: string; // canonical name to show on reveal
    deadline: number; // Date.now() ms
    hostId: string;
}

interface Reveal {
    id: string;
    correctIdx: number;
    revealName: string;
    revealImages: string[]; // un-silhouetted versions
    scores: Record<string, number>;
    votes: Record<string, number>;
}

// ---------- Pokémon API types (loose, defensive parsing) ----------

interface ApiPokemon {
    id: number;
    name: string;
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

export const PokemonQuizGame: Game = {
    id: "pokemon-quiz",
    name: "Pokémon Quiz",
    description:
        "Six-round trivia powered by PokéAPI. Silhouettes, dex blurbs, dual types, stat showdowns, move sets and evolution chains.",
    badge: "Gen 1 · everyone votes",
    create(container, net): GameInstance {
        const inst = new PokemonQuizInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

class PokemonQuizInstance {
    private container: HTMLElement;
    private net: Net;
    private ns: GameNamespace;

    private isHost = false;
    private currentQuestion: Question | null = null;
    private currentReveal: Reveal | null = null;
    private revealStartT = 0; // local clock; used to animate the next-round countdown
    private myVote: number | null = null;
    private votes = new Map<string, number>(); // peerId → option idx (this round)
    private scores = new Map<string, number>(); // peerId → match score

    private roundNum = 0;
    private hostBusy = false; // host is fetching / scheduling
    private hostNextTimer: number | null = null;
    private hostRevealTimer: number | null = null;
    private rafId: number | null = null;
    private unsubPeers: (() => void) | null = null;

    private stageEl!: HTMLDivElement;
    private sidebarEl!: HTMLDivElement;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("pokemon-quiz");

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
        this.ns.close();
        this.container.innerHTML = "";
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
            this.votes.clear();
            this.roundNum = q.round;
            this.renderStage();
        });

        this.ns.on<{ id: string; idx: number }>("vote", (data, peerId) => {
            if (!this.currentQuestion || data?.id !== this.currentQuestion.id) return;
            const idx = Number(data.idx);
            if (!Number.isInteger(idx) || idx < 0 || idx >= this.currentQuestion.options.length) return;
            this.votes.set(peerId, idx);
            this.renderStage();
            // Host: if everyone voted early, end the round.
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
            this.myVote = null;
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
        // Award scores: +1 per correct voter (broadcast deltas via Net).
        for (const [peerId, idx] of this.votes) {
            if (idx === q.correctIdx) {
                this.scores.set(peerId, (this.scores.get(peerId) ?? 0) + 1);
                this.net.awardScore(peerId, 1);
            }
        }
        const reveal: Reveal = {
            id: q.id,
            correctIdx: q.correctIdx,
            revealName: q.revealName,
            revealImages: q.images,
            scores: Object.fromEntries(this.scores),
            votes: Object.fromEntries(this.votes),
        };
        this.currentReveal = reveal;
        this.revealStartT = Date.now();
        this.ns.send("reveal", reveal);
        this.renderStage();
        this.renderSidebar();
        this.scheduleNextRound(REVEAL_DURATION_MS + PICK_DELAY_MS);
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
        }
    }

    private async buildWhosThat(round: number): Promise<Question | null> {
        const ids = pickN([...Array(POOL_SIZE)].map((_, i) => i + 1), 4);
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
            const id = 1 + Math.floor(Math.random() * POOL_SIZE);
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
            const id = 1 + Math.floor(Math.random() * POOL_SIZE);
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
            const [idA, idB] = pickN([...Array(POOL_SIZE)].map((_, i) => i + 1), 2);
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
            const ids = pickN([...Array(POOL_SIZE)].map((_, i) => i + 1), 4);
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
            const id = 1 + Math.floor(Math.random() * POOL_SIZE);
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
                    const cand = 1 + Math.floor(Math.random() * POOL_SIZE);
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

        const optionsHtml = q.options.map((opt, i) => {
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

        const statusHtml = reveal
            ? `<div class="pq-reveal">
                  <div class="pq-reveal-text">
                    Answer: <strong>${escapeHtml(q.options[q.correctIdx])}</strong>
                    · It was <strong>${escapeHtml(q.revealName)}</strong>
                  </div>
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
            btn.addEventListener("click", () => this.vote(idx));
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
    }
}
