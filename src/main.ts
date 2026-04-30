import { Net, randomColor } from "./net";
import { GAMES, findGame } from "./games";
import type { GameInstance } from "./games/game";
import { loadAvatarFromStorage, renderAvatarSvg, renderCharacterCreator } from "./avatar";

const APP_ID = "fun-games-v1";
const root = document.getElementById("root")!;

interface JoinForm {
    name: string;
    room: string;
}

renderJoin();

function renderJoin() {
    const stored = localStorage.getItem("pfg-name") ?? "";
    const params = new URLSearchParams(location.hash.slice(1));
    const room = params.get("room") ?? "team-room";

    root.innerHTML = `
    <div class="lobby">
      <div class="lobby-card">
        <h1>Fun Games</h1>
        <p class="tagline">
          A small set of peer-to-peer games for the team.
          No accounts, no servers — just share a room name.
        </p>
        <label for="name-input">Display name</label>
        <input id="name-input" maxlength="20" placeholder="Your name" />
        <label for="room-input">Room</label>
        <input id="room-input" maxlength="40" placeholder="team-name" />
        <button id="join-btn">Join</button>
        <p class="hint">
          Anyone with the same room name joins the same session.
          Switch games anytime — your peers, scores and chat stay connected.
        </p>
      </div>
    </div>
  `;
    const nameInput = root.querySelector<HTMLInputElement>("#name-input")!;
    const roomInput = root.querySelector<HTMLInputElement>("#room-input")!;
    nameInput.value = stored;
    roomInput.value = room;
    const submit = () => {
        const form: JoinForm = {
            name: nameInput.value.trim() || "anon",
            room: roomInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        };
        if (!form.room) return;
        localStorage.setItem("pfg-name", form.name);
        startApp(form);
    };
    root.querySelector<HTMLButtonElement>("#join-btn")!.onclick = submit;
    for (const el of [nameInput, roomInput]) {
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }
}

function startApp({ name, room }: JoinForm) {
    history.replaceState(null, "", `#room=${encodeURIComponent(room)}`);

    const savedAvatar = loadAvatarFromStorage();
    const net = new Net(APP_ID, room, name, randomColor(), savedAvatar);
    net.addLocalSelf();
    net.announce();

    root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <button class="brand-btn" title="Back to game lobby">
            <svg class="brand-btn-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Fun Games</span>
          </button>
          <span class="game-tag" id="game-tag"></span>
        </div>
        <div class="room-info">
          <span>Room</span>
          <strong id="room-label"></strong>
          <button id="copy-link" title="Copy invite link">Copy link</button>
          <span id="conn-status" class="conn-status" title="Searching for peers">
            <span class="conn-spinner" aria-hidden="true"></span>
            <span class="conn-text">Connecting…</span>
          </span>
        </div>
        <div class="peers" id="peers"></div>
      </header>
      <main class="stage">
        <section class="game-host" id="game-host"></section>
        <aside class="chat">
          <div class="chat-log" id="chat-log"></div>
          <form id="chat-form">
            <input
              id="chat-input"
              autocomplete="off"
              maxlength="200"
              placeholder="Type a message or guess..."
            />
          </form>
        </aside>
      </main>
      <div id="status" class="status"></div>
    </div>
  `;

    root.querySelector<HTMLElement>("#room-label")!.textContent = room;
    root.querySelector<HTMLButtonElement>("#copy-link")!.onclick = async () => {
        try { await navigator.clipboard.writeText(location.href); flash("Invite link copied"); }
        catch { window.prompt("Copy this link:", location.href); }
    };
    root.querySelector<HTMLButtonElement>(".brand-btn")!.onclick = () => {
        setGame(null);
    };

    const peersEl = root.querySelector<HTMLDivElement>("#peers")!;
    const chatLog = root.querySelector<HTMLDivElement>("#chat-log")!;
    const chatForm = root.querySelector<HTMLFormElement>("#chat-form")!;
    const chatInput = root.querySelector<HTMLInputElement>("#chat-input")!;
    const host = root.querySelector<HTMLDivElement>("#game-host")!;
    const gameTag = root.querySelector<HTMLSpanElement>("#game-tag")!;

    let activeInstance: GameInstance | null = null;

    const renderPeers = () => {
        peersEl.innerHTML = "";
        const me = net.me.id;
        const list = [...net.peers.entries()]
            .map(([id, p]) => ({ id, ...p, isMe: id === me }))
            .sort((a, b) => b.score - a.score);
        for (const p of list) {
            const chip = document.createElement("span");
            chip.className = "peer-chip";
            chip.innerHTML = `
        <span class="peer-chip-avatar" style="background:${p.color}22">${renderAvatarSvg(p.avatar, 44, p.color)}</span>
        <span>${escapeHtml(p.name)}${p.isMe ? " (you)" : ""}</span>
        <span class="score">${p.score}</span>
      `;
            peersEl.appendChild(chip);
        }
    };

    const renderChatEntry = (entry: import("./net").ChatEntry) => {
        const el = document.createElement("div");
        el.className = "msg";
        if (entry.kind === "system") el.classList.add("system");
        if (entry.kind === "good") el.classList.add("correct");
        if (entry.kind === "warn") el.classList.add("close");
        if (entry.kind === "user") {
            const w = document.createElement("span");
            w.className = "who";
            w.style.color = entry.color;
            w.textContent = `${entry.fromName}: `;
            el.appendChild(w);
        }
        el.appendChild(document.createTextNode(entry.text));
        chatLog.appendChild(el);
        chatLog.scrollTop = chatLog.scrollHeight;
    };

    const setGame = (gameId: string | null) => {
        if (activeInstance) {
            activeInstance.unmount();
            activeInstance = null;
        }
        host.innerHTML = "";
        if (!gameId) {
            gameTag.textContent = "";
            renderGameLobby(host, net, (g) => setGame(g.id));
            net.setGame(null);
            return;
        }
        const game = findGame(gameId);
        if (!game) { setGame(null); return; }
        gameTag.textContent = game.name;
        activeInstance = game.create(host, net);
        net.setGame(gameId);
    };

    net.on("peers", renderPeers);
    net.on("chat", renderChatEntry);
    net.on("game", (id) => {
        // Another peer changed the game — follow them.
        if (activeInstance && id === net.currentGameId && idMatchesActive(id)) return;
        if (id === currentActiveId()) return;
        if (activeInstance) { activeInstance.unmount(); activeInstance = null; }
        host.innerHTML = "";
        if (!id) { gameTag.textContent = ""; renderGameLobby(host, net, (g) => setGame(g.id)); return; }
        const game = findGame(id);
        if (!game) { renderGameLobby(host, net, (g) => setGame(g.id)); return; }
        gameTag.textContent = game.name;
        activeInstance = game.create(host, net);
    });

    // Track which game id the host is currently showing, to avoid re-mounting.
    const idMatchesActive = (id: string | null) => {
        return gameTag.textContent === (findGame(id)?.name ?? "");
    };
    const currentActiveId = (): string | null => {
        const name = gameTag.textContent;
        return GAMES.find((g) => g.name === name)?.id ?? null;
    };

    for (const entry of net.chatLog) renderChatEntry(entry);
    renderPeers();

    // Connection status indicator: shows a spinner while we have no peers yet.
    // Hides automatically once at least one other peer joins.
    const connStatus = root.querySelector<HTMLSpanElement>("#conn-status")!;
    const updateConnStatus = () => {
        // Subtract 1 for ourselves.
        const others = net.peers.size - 1;
        if (others > 0) {
            connStatus.classList.add("connected");
            connStatus.querySelector(".conn-text")!.textContent = "Connected";
            // Fade out the indicator after a moment.
            setTimeout(() => connStatus.classList.add("hidden"), 2000);
        } else {
            connStatus.classList.remove("connected", "hidden");
            connStatus.querySelector(".conn-text")!.textContent = "Searching for peers…";
        }
    };
    net.on("peers", updateConnStatus);
    updateConnStatus();

    chatForm.onsubmit = (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = "";
        net.sendChatMessage(text);
    };

    // Connectivity hint after 20s of solitude (in case discovery is slow).
    setTimeout(() => {
        if (net.peers.size <= 1) {
            net.pushSystem("Still searching for peers. If others are in the same room, a refresh sometimes helps.");
        }
    }, 20000);

    // Default view: the game lobby.
    setGame(null);
    flash(`Joined room "${room}"`);
}

function renderGameLobby(host: HTMLElement, net: Net, onPick: (g: typeof GAMES[number]) => void) {
    host.innerHTML = `
    <div class="game-lobby">
      <div class="game-lobby-section">
        <h2>Pick a game</h2>
        <p class="game-lobby-sub">Anyone in the room can switch games. Your peers and chat carry over.</p>
        <div class="game-grid"></div>
      </div>
      <div class="game-lobby-divider"></div>
      <div class="game-lobby-section creator-host"></div>
    </div>
  `;
    const grid = host.querySelector<HTMLDivElement>(".game-grid")!;
    for (const g of GAMES) {
        const card = document.createElement("button");
        card.className = "game-card";
        card.innerHTML = `
      <div class="game-card-name">${escapeHtml(g.name)}</div>
      <div class="game-card-desc">${escapeHtml(g.description)}</div>
    `;
        card.onclick = () => onPick(g);
        grid.appendChild(card);
    }
    const creatorHost = host.querySelector<HTMLDivElement>(".creator-host")!;
    renderCharacterCreator(creatorHost, { net });
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]!));
}

function flash(text: string) {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2000);
}
