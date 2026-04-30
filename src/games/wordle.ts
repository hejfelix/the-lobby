import type { Game, GameInstance } from "./game";
import type { Net, GameNamespace } from "../net";
import { ALLOWED_GUESSES } from "./wordle-words";

/** Curated common 5-letter words used as round answers (so targets aren't obscure). */
const ANSWERS: string[] = [
    "about", "above", "abuse", "actor", "acute", "admit", "adopt", "adult", "after", "again",
    "agent", "agree", "ahead", "alarm", "album", "alert", "alike", "alive", "allow", "alone",
    "along", "alter", "among", "anger", "angle", "angry", "apart", "apple", "apply", "arena",
    "argue", "arise", "array", "aside", "asset", "audio", "audit", "avoid", "award", "aware",
    "badly", "baker", "bases", "basic", "beach", "began", "begin", "begun", "being", "below",
    "bench", "billy", "birth", "black", "blame", "blind", "block", "blood", "board", "boost",
    "booth", "bound", "brain", "brand", "bread", "break", "breed", "brief", "bring", "broad",
    "broke", "brown", "build", "built", "buyer", "cable", "calif", "carry", "catch", "cause",
    "chain", "chair", "chart", "chase", "cheap", "check", "chest", "chief", "child", "china",
    "chose", "civil", "claim", "class", "clean", "clear", "click", "clock", "close", "coach",
    "coast", "could", "count", "court", "cover", "craft", "crash", "cream", "crime", "cross",
    "crowd", "crown", "curve", "cycle", "daily", "dance", "dated", "dealt", "death", "debut",
    "delay", "depth", "doing", "doubt", "dozen", "draft", "drama", "drawn", "dream", "dress",
    "drill", "drink", "drive", "drove", "dying", "eager", "early", "earth", "eight", "elite",
    "empty", "enemy", "enjoy", "enter", "entry", "equal", "error", "event", "every", "exact",
    "exist", "extra", "faith", "false", "fault", "fiber", "field", "fifth", "fifty", "fight",
    "final", "first", "fixed", "flash", "fleet", "floor", "fluid", "focus", "force", "forth",
    "forty", "forum", "found", "frame", "frank", "fraud", "fresh", "front", "fruit", "fully",
    "funny", "giant", "given", "glass", "globe", "going", "grace", "grade", "grand", "grant",
    "grass", "great", "green", "gross", "group", "grown", "guard", "guess", "guest", "guide",
    "happy", "harry", "heart", "heavy", "hence", "henry", "horse", "hotel", "house", "human",
    "ideal", "image", "index", "inner", "input", "issue", "japan", "jimmy", "joint", "jones",
    "judge", "known", "label", "large", "laser", "later", "laugh", "layer", "learn", "lease",
    "least", "leave", "legal", "level", "lewis", "light", "limit", "links", "lives", "local",
    "logic", "loose", "lower", "lucky", "lunch", "lying", "magic", "major", "maker", "march",
    "maria", "match", "maybe", "mayor", "meant", "media", "metal", "might", "minor", "minus",
    "mixed", "model", "money", "month", "moral", "motor", "mount", "mouse", "mouth", "movie",
    "music", "needs", "never", "newly", "night", "noise", "north", "noted", "novel", "nurse",
    "occur", "ocean", "offer", "often", "order", "other", "ought", "paint", "panel", "paper",
    "party", "peace", "peter", "phase", "phone", "photo", "piece", "pilot", "pitch", "place",
    "plain", "plane", "plant", "plate", "point", "pound", "power", "press", "price", "pride",
    "prime", "print", "prior", "prize", "proof", "proud", "prove", "queen", "quick", "quiet",
    "quite", "radio", "raise", "range", "rapid", "ratio", "reach", "ready", "refer", "right",
    "rival", "river", "robin", "roger", "roman", "rough", "round", "route", "royal", "rural",
    "scale", "scene", "scope", "score", "sense", "serve", "seven", "shall", "shape", "share",
    "sharp", "sheet", "shelf", "shell", "shift", "shirt", "shock", "shoot", "short", "shown",
    "sight", "since", "sixth", "sixty", "sized", "skill", "sleep", "slide", "small", "smart",
    "smile", "smith", "smoke", "solid", "solve", "sorry", "sound", "south", "space", "spare",
    "speak", "speed", "spend", "spent", "split", "spoke", "sport", "staff", "stage", "stake",
    "stand", "start", "state", "steam", "steel", "stick", "still", "stock", "stone", "stood",
    "store", "storm", "story", "strip", "stuck", "study", "stuff", "style", "sugar", "suite",
    "super", "sweet", "table", "taken", "taste", "taxes", "teach", "teeth", "terry", "texas",
    "thank", "theft", "their", "theme", "there", "these", "thick", "thing", "think", "third",
    "those", "three", "threw", "throw", "tight", "times", "tired", "title", "today", "topic",
    "total", "touch", "tough", "tower", "track", "trade", "train", "treat", "trend", "trial",
    "tried", "tries", "truck", "truly", "trust", "truth", "twice", "under", "undue", "union",
    "unity", "until", "upper", "upset", "urban", "usage", "usual", "valid", "value", "video",
    "virus", "visit", "vital", "voice", "waste", "watch", "water", "wheel", "where", "which",
    "while", "white", "whole", "whose", "woman", "women", "world", "worry", "worse", "worst",
    "worth", "would", "wound", "write", "wrong", "wrote", "yield", "young", "youth",
];

const ALLOWED_SET = new Set<string>([...ALLOWED_GUESSES, ...ANSWERS]);
const MAX_GUESSES = 6;
const WORD_LEN = 5;

interface Guess {
    word: string;
    byId: string;
    byName: string;
    byColor: string;
}

interface RoundState {
    round: number;
    target: string;
    guesses: Guess[];
    finished: boolean;
    won: boolean;
}

export const WordleGame: Game = {
    id: "wordle",
    name: "Co-op Wordle",
    description: "Crack one word together. Six guesses, the whole room takes turns.",
    create(container, net): GameInstance {
        const inst = new WordleInstance(container, net);
        return { unmount: () => inst.destroy() };
    },
};

class WordleInstance {
    private container: HTMLElement;
    private net: Net;
    private ns: GameNamespace;
    private state: RoundState;
    private boardEl!: HTMLDivElement;
    private inputEl!: HTMLInputElement;
    private submitEl!: HTMLButtonElement;
    private statusEl!: HTMLDivElement;
    private nextEl!: HTMLButtonElement;
    private keyboardEl!: HTMLDivElement;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("wordle");

        const startRound = loadRound(net.roomName);
        this.state = freshRound(net.roomName, startRound);

        container.innerHTML = `
      <div class="game-layout wordle-layout">
        <aside class="toolbar wordle-toolbar">
          <div class="tool-group">
            <label>How it works</label>
            <p class="hint">
              The room shares one Wordle. Anyone can submit a guess.
              Six tries to crack it together. Solve it for +5 points each.
            </p>
          </div>
          <div class="tool-group">
            <label>Round</label>
            <div class="wordle-round-info">
              <span class="wordle-round-num">#${this.state.round + 1}</span>
              <button class="wordle-next" type="button" hidden>Next round</button>
            </div>
          </div>
          <div class="tool-group">
            <label>Status</label>
            <div class="wordle-status"></div>
          </div>
        </aside>
        <section class="wordle-stage">
          <div class="wordle-board"></div>
          <div class="wordle-keyboard"></div>
          <form class="wordle-input-row">
            <input class="wordle-input" maxlength="5" autocomplete="off" spellcheck="false"
                   placeholder="type a 5-letter word" />
            <button class="wordle-submit" type="submit">Guess</button>
          </form>
        </section>
      </div>
    `;

        const q = <T extends Element>(s: string) => container.querySelector(s) as T;
        this.boardEl = q<HTMLDivElement>(".wordle-board");
        this.keyboardEl = q<HTMLDivElement>(".wordle-keyboard");
        this.inputEl = q<HTMLInputElement>(".wordle-input");
        this.submitEl = q<HTMLButtonElement>(".wordle-submit");
        this.statusEl = q<HTMLDivElement>(".wordle-status");
        this.nextEl = q<HTMLButtonElement>(".wordle-next");

        const form = q<HTMLFormElement>(".wordle-input-row");
        form.onsubmit = (e) => {
            e.preventDefault();
            this.attemptGuess(this.inputEl.value);
        };
        this.inputEl.addEventListener("input", () => {
            this.inputEl.value = this.inputEl.value.toLowerCase().replace(/[^a-z]/g, "").slice(0, WORD_LEN);
        });
        this.nextEl.onclick = () => this.advanceRound();

        this.registerNetwork();
        this.ns.send("sync-request", {});
        this.render();
        setTimeout(() => this.inputEl.focus(), 50);
    }

    private attemptGuess(raw: string) {
        if (this.state.finished) return;
        const word = raw.toLowerCase().trim();
        if (word.length !== WORD_LEN) {
            this.flashStatus("Need a 5-letter word.", "warn");
            return;
        }
        if (!ALLOWED_SET.has(word)) {
            this.flashStatus(`"${word}" isn't in the word list.`, "warn");
            return;
        }
        if (this.state.guesses.some((g) => g.word === word)) {
            this.flashStatus("Already tried that one.", "warn");
            return;
        }
        const guess: Guess = {
            word,
            byId: this.net.me.id,
            byName: this.net.me.name,
            byColor: this.net.me.color,
        };
        this.applyGuess(guess);
        this.ns.send("guess", { round: this.state.round, ...guess });
        this.inputEl.value = "";
    }

    private applyGuess(guess: Guess) {
        if (this.state.finished) return;
        if (this.state.guesses.length >= MAX_GUESSES) return;
        if (this.state.guesses.some((g) => g.word === guess.word)) return;
        this.state.guesses.push(guess);
        if (guess.word === this.state.target) {
            this.state.finished = true;
            this.state.won = true;
            // Award everyone who contributed a guess this round.
            if (guess.byId === this.net.me.id) {
                const contributed = new Set(this.state.guesses.map((g) => g.byId));
                if (contributed.has(this.net.me.id)) {
                    this.net.awardScore(this.net.me.id, 5);
                }
            } else if (this.state.guesses.some((g) => g.byId === this.net.me.id)) {
                this.net.awardScore(this.net.me.id, 5);
            }
            saveRound(this.net.roomName, this.state.round + 1);
        } else if (this.state.guesses.length >= MAX_GUESSES) {
            this.state.finished = true;
            this.state.won = false;
            saveRound(this.net.roomName, this.state.round + 1);
        }
        this.render();
    }

    private advanceRound() {
        if (!this.state.finished) return;
        const nextIdx = this.state.round + 1;
        this.state = freshRound(this.net.roomName, nextIdx);
        saveRound(this.net.roomName, nextIdx);
        this.ns.send("next", { round: nextIdx });
        this.render();
        this.inputEl.focus();
    }

    private registerNetwork() {
        this.ns.on<{ round: number; word: string; byId: string; byName: string; byColor: string }>(
            "guess",
            (data, peerId) => {
                if (!data || typeof data.word !== "string") return;
                if (data.round !== this.state.round) return;
                const word = data.word.toLowerCase();
                if (word.length !== WORD_LEN) return;
                if (!ALLOWED_SET.has(word)) return;
                this.applyGuess({
                    word,
                    byId: peerId,
                    byName: String(data.byName ?? "anon").slice(0, 24),
                    byColor: String(data.byColor ?? "#888").slice(0, 12),
                });
            },
        );

        this.ns.on<{ round: number }>("next", (data) => {
            if (!data || typeof data.round !== "number") return;
            if (data.round <= this.state.round) return;
            this.state = freshRound(this.net.roomName, data.round);
            saveRound(this.net.roomName, data.round);
            this.render();
        });

        this.ns.on<Record<string, never>>("sync-request", (_d, peerId) => {
            this.ns.send(
                "sync",
                {
                    round: this.state.round,
                    guesses: this.state.guesses,
                    finished: this.state.finished,
                    won: this.state.won,
                },
                peerId,
            );
        });

        this.ns.on<{ round: number; guesses: Guess[]; finished: boolean; won: boolean }>(
            "sync",
            (data) => {
                if (!data || typeof data.round !== "number") return;
                // Adopt remote state if it's further along.
                if (data.round > this.state.round) {
                    this.state = freshRound(this.net.roomName, data.round);
                }
                if (data.round !== this.state.round) return;
                if (Array.isArray(data.guesses) && data.guesses.length > this.state.guesses.length) {
                    // Replay any missing guesses.
                    for (const g of data.guesses) {
                        if (!g || typeof g.word !== "string") continue;
                        if (this.state.guesses.some((x) => x.word === g.word)) continue;
                        this.applyGuess({
                            word: g.word.toLowerCase(),
                            byId: String(g.byId ?? ""),
                            byName: String(g.byName ?? "anon").slice(0, 24),
                            byColor: String(g.byColor ?? "#888").slice(0, 12),
                        });
                    }
                }
                this.render();
            },
        );
    }

    private render() {
        this.renderBoard();
        this.renderKeyboard();
        this.renderStatus();
        const roundLabel = this.container.querySelector<HTMLSpanElement>(".wordle-round-num");
        if (roundLabel) roundLabel.textContent = `#${this.state.round + 1}`;
        this.nextEl.hidden = !this.state.finished;
        const inputDisabled = this.state.finished;
        this.inputEl.disabled = inputDisabled;
        this.submitEl.disabled = inputDisabled;
    }

    private renderBoard() {
        this.boardEl.innerHTML = "";
        for (let r = 0; r < MAX_GUESSES; r++) {
            const row = document.createElement("div");
            row.className = "wordle-row";
            const guess = this.state.guesses[r];
            const colors = guess ? scoreGuess(guess.word, this.state.target) : null;
            for (let c = 0; c < WORD_LEN; c++) {
                const cell = document.createElement("div");
                cell.className = "wordle-cell";
                if (guess && colors) {
                    cell.textContent = guess.word[c].toUpperCase();
                    cell.classList.add(`wordle-${colors[c]}`);
                }
                row.appendChild(cell);
            }
            if (guess) {
                const tag = document.createElement("span");
                tag.className = "wordle-row-author";
                tag.style.color = guess.byColor;
                tag.textContent = guess.byName;
                row.appendChild(tag);
            }
            this.boardEl.appendChild(row);
        }
    }

    private renderKeyboard() {
        const status: Record<string, "green" | "yellow" | "gray"> = {};
        for (const g of this.state.guesses) {
            const colors = scoreGuess(g.word, this.state.target);
            for (let i = 0; i < WORD_LEN; i++) {
                const ch = g.word[i];
                const cur = status[ch];
                const next = colors[i];
                // green > yellow > gray
                if (cur === "green") continue;
                if (cur === "yellow" && next === "gray") continue;
                status[ch] = next;
            }
        }
        const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
        this.keyboardEl.innerHTML = "";
        for (const row of rows) {
            const rowEl = document.createElement("div");
            rowEl.className = "wordle-kb-row";
            for (const ch of row) {
                const key = document.createElement("button");
                key.type = "button";
                key.className = "wordle-key";
                if (status[ch]) key.classList.add(`wordle-${status[ch]}`);
                key.textContent = ch.toUpperCase();
                key.onclick = () => {
                    if (this.state.finished) return;
                    if (this.inputEl.value.length < WORD_LEN) {
                        this.inputEl.value += ch;
                        this.inputEl.focus();
                    }
                };
                rowEl.appendChild(key);
            }
            this.keyboardEl.appendChild(rowEl);
        }
    }

    private renderStatus() {
        if (this.state.finished) {
            if (this.state.won) {
                const last = this.state.guesses[this.state.guesses.length - 1];
                this.statusEl.className = "wordle-status good";
                this.statusEl.textContent = `Solved by ${last.byName} in ${this.state.guesses.length}!`;
            } else {
                this.statusEl.className = "wordle-status warn";
                this.statusEl.textContent = `Out of guesses. Word was ${this.state.target.toUpperCase()}.`;
            }
        } else {
            const left = MAX_GUESSES - this.state.guesses.length;
            this.statusEl.className = "wordle-status";
            this.statusEl.textContent = `${left} guess${left === 1 ? "" : "es"} left.`;
        }
    }

    private flashStatus(msg: string, kind: "warn" | "good") {
        const prevClass = this.statusEl.className;
        const prevText = this.statusEl.textContent;
        this.statusEl.className = `wordle-status ${kind}`;
        this.statusEl.textContent = msg;
        setTimeout(() => {
            // Only revert if nothing else has overwritten our flash.
            if (this.statusEl.textContent === msg) {
                this.statusEl.className = prevClass;
                this.statusEl.textContent = prevText;
            }
        }, 1800);
    }

    destroy() {
        this.ns.close();
        this.container.innerHTML = "";
    }
}

/** Score a guess against the target using standard Wordle rules (handles dupes). */
function scoreGuess(guess: string, target: string): Array<"green" | "yellow" | "gray"> {
    const result: Array<"green" | "yellow" | "gray"> = Array(WORD_LEN).fill("gray");
    const counts: Record<string, number> = {};
    for (const ch of target) counts[ch] = (counts[ch] ?? 0) + 1;
    // First pass: greens
    for (let i = 0; i < WORD_LEN; i++) {
        if (guess[i] === target[i]) {
            result[i] = "green";
            counts[guess[i]]--;
        }
    }
    // Second pass: yellows
    for (let i = 0; i < WORD_LEN; i++) {
        if (result[i] === "green") continue;
        const ch = guess[i];
        if ((counts[ch] ?? 0) > 0) {
            result[i] = "yellow";
            counts[ch]--;
        }
    }
    return result;
}

/** Deterministic word for a (room, round) so all peers agree without a host. */
function freshRound(roomName: string, round: number): RoundState {
    const seed = hashStr(`${roomName}::${round}`);
    const target = ANSWERS[seed % ANSWERS.length];
    return { round, target, guesses: [], finished: false, won: false };
}

function hashStr(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const STORAGE_KEY = "pfg-wordle-round";
function loadRound(roomName: string): number {
    try {
        const raw = localStorage.getItem(`${STORAGE_KEY}:${roomName}`);
        if (!raw) return 0;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
        return 0;
    }
}
function saveRound(roomName: string, round: number) {
    try {
        localStorage.setItem(`${STORAGE_KEY}:${roomName}`, String(round));
    } catch {
        /* ignore */
    }
}
