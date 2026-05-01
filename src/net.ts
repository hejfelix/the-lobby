// Net — wraps Trystero so multiple games can share one P2P room.
// Owns the peer roster, scores, chat history, and current game id.

import { joinRoom, selfId, getRelaySockets, type Room } from "trystero/nostr";

export interface Avatar {
    /** DiceBear style id (see AVATAR_STYLES). */
    style: string;
    /** Free-form seed string — DiceBear deterministically generates from this. */
    seed: string;
    /** "true" or "false" — string so the type stays JsonValue-compatible. */
    flip: string;
    /** Background colour (hex without #) or "transparent". */
    bg: string;
    // Index signature so the type fits Trystero's JsonValue payload constraint.
    [key: string]: string;
}

export interface PeerInfo {
    name: string;
    color: string;
    score: number;
    avatar?: Avatar;
}

export interface ChatEntry {
    id: string;
    fromId: string;
    fromName: string;
    color: string;
    text: string;
    kind?: "user" | "system" | "good" | "warn";
    ts: number;
}

type SendFn<T> = (data: T, peerId?: string) => Promise<unknown[]> | void;
type RecvFn<T> = (data: T, peerId: string) => void;

export interface GameNamespace {
    /** Send `data` for action `name` to all peers (or one specific peer). */
    send<T>(name: string, data: T, peerId?: string): void;
    /** Subscribe to action `name`. */
    on<T>(name: string, handler: RecvFn<T>): void;
    /** Tear down all listeners for this namespace (called when game unmounts). */
    close(): void;
}

type Listener<T> = (payload: T) => void;

interface Events {
    peers: void;
    chat: ChatEntry;
    game: string | null;
    join: { id: string; name: string; color: string };
}

export class Net {
    readonly me: { id: string; name: string; color: string; avatar: Avatar };
    readonly room: Room;
    readonly roomName: string;
    readonly peers: Map<string, PeerInfo> = new Map();
    readonly chatLog: ChatEntry[] = [];
    currentGameId: string | null = null;

    private listeners: { [K in keyof Events]: Set<Listener<Events[K]>> } = {
        peers: new Set(),
        chat: new Set(),
        game: new Set(),
        join: new Set(),
    };

    // Actions on the shared "core" namespace.
    private sendHello: SendFn<{ name: string; color: string; score: number; gameId: string | null; avatar: Avatar }>;
    private sendChat: SendFn<{ text: string; kind?: ChatEntry["kind"] }>;
    private sendGame: SendFn<{ id: string | null }>;
    private sendScore: SendFn<{ id: string; delta: number }>;

    // Game-namespaced action senders, indexed by `${ns}:${name}`.
    private gameSenders: Map<string, SendFn<unknown>> = new Map();
    private gameHandlers: Map<string, Set<RecvFn<unknown>>> = new Map();
    private namespaceCleanups: Map<string, Array<() => void>> = new Map();

    constructor(appId: string, roomName: string, name: string, color: string, avatar?: Avatar) {
        this.me = { id: selfId, name, color, avatar: avatar ?? defaultAvatar(name || selfId) };
        this.roomName = roomName;
        console.info("[net] joining room", roomName, "as", selfId);
        this.room = joinRoom({ appId }, roomName);
        setTimeout(() => {
            try {
                const sockets = getRelaySockets() as Record<string, WebSocket>;
                const status = Object.entries(sockets).map(
                    ([url, ws]) => `${url}=${["CONNECTING", "OPEN", "CLOSING", "CLOSED"][ws.readyState]}`,
                );
                console.info("[net] relay socket status:", status);
            } catch (e) {
                console.warn("[net] could not read relay sockets", e);
            }
        }, 3000);

        const [sendHello, onHello] = this.room.makeAction<{
            name: string;
            color: string;
            score: number;
            gameId: string | null;
            avatar: Avatar;
        }>("hello");
        const [sendChat, onChat] = this.room.makeAction<{
            text: string;
            kind?: ChatEntry["kind"];
        }>("chat");
        const [sendGame, onGame] = this.room.makeAction<{ id: string | null }>("game");
        const [sendScore, onScore] = this.room.makeAction<{ id: string; delta: number }>("score");
        const [sendAction, onAction] = this.room.makeAction<{
            ns: string;
            name: string;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: any;
        }>("act");

        this.sendHello = sendHello;
        this.sendChat = sendChat;
        this.sendGame = sendGame;
        this.sendScore = sendScore;

        onHello((data, peerId) => {
            const isNew = !this.peers.has(peerId);
            this.peers.set(peerId, {
                name: String(data?.name ?? "anon").slice(0, 24),
                color: typeof data?.color === "string" ? data.color : randomColor(),
                score: Number(data?.score) || 0,
                avatar: sanitizeAvatar(data?.avatar),
            });
            this.emit("peers");
            if (isNew) {
                const peer = this.peers.get(peerId)!;
                this.pushSystem(`${peer.name} joined.`);
                this.emit("join", { id: peerId, name: peer.name, color: peer.color });
            }
        });

        onChat((data, peerId) => {
            const peer = this.peers.get(peerId);
            if (!peer) return;
            this.pushChat({
                fromId: peerId,
                fromName: peer.name,
                color: peer.color,
                text: String(data?.text ?? "").slice(0, 500),
                kind: data?.kind === "system" ? "system" : "user",
            });
        });

        onGame((data, peerId) => {
            // Only accept game switches from peers we know about.
            if (!this.peers.has(peerId)) return;
            const id = data?.id ?? null;
            if (id === this.currentGameId) return;
            this.currentGameId = id;
            this.emit("game", id);
            this.pushSystem(
                id
                    ? `${this.peers.get(peerId)!.name} switched to ${id}.`
                    : `${this.peers.get(peerId)!.name} returned to the lobby.`,
            );
        });

        onScore((data, peerId) => {
            const target = this.peers.get(data.id);
            if (!target) return;
            // Trust only the source-of-truth peer (the game's authority broadcasts deltas).
            target.score += Number(data.delta) || 0;
            this.emit("peers");
            void peerId;
        });

        onAction((env, peerId) => {
            const key = `${env.ns}:${env.name}`;
            const handlers = this.gameHandlers.get(key);
            if (!handlers) return;
            for (const h of handlers) h(env.data, peerId);
        });

        // Remember the action sender for namespaces.
        this.gameSenders.set("__envelope__", sendAction as SendFn<unknown>);

        this.room.onPeerJoin((peerId) => {
            console.info("[net] peer connected:", peerId);
            // Greet the new peer with our identity + current game.
            this.sendHello(
                {
                    name: this.me.name,
                    color: this.me.color,
                    score: this.myScore(),
                    gameId: this.currentGameId,
                    avatar: this.me.avatar,
                },
                peerId,
            );
        });
        this.room.onPeerLeave((peerId) => {
            console.info("[net] peer disconnected:", peerId);
            const p = this.peers.get(peerId);
            this.peers.delete(peerId);
            this.emit("peers");
            if (p) this.pushSystem(`${p.name} left.`);
        });
    }

    /** My score lives on the same Map as everyone else for simplicity. */
    myScore(): number {
        return this.peers.get(this.me.id)?.score ?? 0;
    }

    addLocalSelf(): void {
        // Called once after construction — register ourselves in the peer list.
        this.peers.set(this.me.id, {
            name: this.me.name,
            color: this.me.color,
            score: 0,
            avatar: this.me.avatar,
        });
        this.emit("peers");
    }

    /** Update our avatar locally and re-announce so peers redraw us. */
    updateAvatar(avatar: Avatar): void {
        this.me.avatar = sanitizeAvatar(avatar) ?? this.me.avatar;
        const me = this.peers.get(this.me.id);
        if (me) me.avatar = this.me.avatar;
        this.emit("peers");
        this.announce();
    }

    awardScore(targetId: string, delta: number): void {
        const target = this.peers.get(targetId);
        if (!target) return;
        target.score += delta;
        this.emit("peers");
        this.sendScore({ id: targetId, delta });
    }

    setGame(id: string | null): void {
        this.currentGameId = id;
        this.emit("game", id);
        this.sendGame({ id });
    }

    sendChatMessage(text: string): void {
        if (!text.trim()) return;
        this.pushChat({
            fromId: this.me.id,
            fromName: this.me.name,
            color: this.me.color,
            text,
            kind: "user",
        });
        this.sendChat({ text });
    }

    pushSystem(text: string): void {
        this.pushChat({
            fromId: "system",
            fromName: "system",
            color: "#6b6a63",
            text,
            kind: "system",
        });
    }

    pushChat(partial: Omit<ChatEntry, "id" | "ts">): void {
        const entry: ChatEntry = {
            ...partial,
            id: crypto.randomUUID(),
            ts: Date.now(),
        };
        this.chatLog.push(entry);
        if (this.chatLog.length > 200) this.chatLog.shift();
        this.emit("chat", entry);
    }

    /** Create a per-game namespace for sending typed actions. */
    namespace(ns: string): GameNamespace {
        const cleanups: Array<() => void> = [];
        this.namespaceCleanups.set(ns, cleanups);
        const envelope = this.gameSenders.get("__envelope__")!;

        return {
            send: <T>(name: string, data: T, peerId?: string) => {
                envelope({ ns, name, data }, peerId);
            },
            on: <T>(name: string, handler: RecvFn<T>) => {
                const key = `${ns}:${name}`;
                let set = this.gameHandlers.get(key);
                if (!set) {
                    set = new Set();
                    this.gameHandlers.set(key, set);
                }
                set.add(handler as RecvFn<unknown>);
                cleanups.push(() => set!.delete(handler as RecvFn<unknown>));
            },
            close: () => {
                for (const fn of cleanups) fn();
                this.namespaceCleanups.delete(ns);
            },
        };
    }

    on<K extends keyof Events>(event: K, handler: Listener<Events[K]>): () => void {
        this.listeners[event].add(handler as Listener<Events[K]>);
        return () => this.listeners[event].delete(handler as Listener<Events[K]>);
    }

    private emit<K extends keyof Events>(event: K, payload?: Events[K]): void {
        for (const fn of this.listeners[event]) (fn as Listener<unknown>)(payload);
    }

    /** Broadcast our hello on first join so existing peers learn about us. */
    announce(): void {
        this.sendHello({
            name: this.me.name,
            color: this.me.color,
            score: this.myScore(),
            gameId: this.currentGameId,
            avatar: this.me.avatar,
        });
    }

    destroy(): void {
        for (const cleanups of this.namespaceCleanups.values()) {
            for (const fn of cleanups) fn();
        }
        this.namespaceCleanups.clear();
        this.gameHandlers.clear();
        this.room.leave();
    }
}

export function randomColor(): string {
    const h = Math.floor(Math.random() * 360);
    return `hsl(${h} 45% 45%)`;
}

export const AVATAR_STYLES = [
    "adventurer",
    "avataaars",
    "bottts",
    "funEmoji",
    "lorelei",
    "micah",
    "miniavs",
    "notionists",
    "openPeeps",
    "personas",
    "pixelArt",
    "thumbs",
] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

export const AVATAR_BG_OPTIONS = [
    "transparent",
    "b6e3f4",
    "c0aede",
    "d1d4f9",
    "ffd5dc",
    "ffdfbf",
    "a3d9b1",
] as const;

// Kept so existing imports don't break. Faces/eyes/mouths/hats are now
// rendered by DiceBear; this only documents the legacy shape.
export const AVATAR_OPTIONS = {
    face: ["#f5d5a8"],
    eyes: ["normal"],
    mouth: ["smile"],
    hat: ["none"],
} as const;

export function defaultAvatar(seed: string): Avatar {
    return {
        style: "adventurer",
        seed: seed || "anon",
        flip: "false",
        bg: "transparent",
    };
}

function sanitizeAvatar(a: unknown): Avatar | undefined {
    if (!a || typeof a !== "object") return undefined;
    const obj = a as Record<string, unknown>;
    const style = typeof obj.style === "string" && (AVATAR_STYLES as readonly string[]).includes(obj.style)
        ? obj.style
        : "adventurer";
    const seed = typeof obj.seed === "string" ? obj.seed.slice(0, 64) : "anon";
    const flip = obj.flip === "true" || obj.flip === true ? "true" : "false";
    const bg = typeof obj.bg === "string" && (AVATAR_BG_OPTIONS as readonly string[]).includes(obj.bg)
        ? obj.bg
        : "transparent";
    return { style, seed: seed || "anon", flip, bg };
}
