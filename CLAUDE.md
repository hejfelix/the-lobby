# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server at http://localhost:5173
npm run build     # Type-check (tsc --noEmit) + Vite production bundle → dist/
npm run preview   # Smoke-test the built output locally
```

No test runner or linter is configured — TypeScript strict mode (with `noUnusedLocals`, `noUnusedParameters`) is the primary static correctness check. `npm run build` will catch type errors before deploy.

## Architecture

**The Lobby** is a serverless, peer-to-peer browser game platform. It is a static TypeScript app — no backend, no accounts. Multiplayer connectivity is provided by [Trystero](https://github.com/dmotz/trystero) over WebRTC with Nostr relay signaling.

### Core modules (`src/`)

| File | Responsibility |
|---|---|
| `main.ts` | App entry: join screen → `Net` init → header/stage/chat UI wiring, game switching |
| `net.ts` | `Net` class — owns the Trystero room, peer roster, scores, chat, game-switch state |
| `avatar.ts` | DiceBear avatar generation, character creator UI, localStorage persistence |
| `lobby-music.ts` | Collaborative music player (DJ = lowest peer ID broadcasts track + timestamp) |
| `style.css` | All styling; no CSS framework, uses CSS variables |

### Games (`src/games/`)

Games implement a minimal plugin interface:

```typescript
interface Game {
  id: string; name: string; description: string;
  create(container: HTMLElement, net: Net): GameInstance;
}
interface GameInstance { unmount(): void; }
```

**To add a game:** create `src/games/yourgame.ts`, export a `Game` object, and register it in `src/games/index.ts`.

Inside `create()`, every game:
1. Renders its HTML into `container`
2. Calls `net.namespace(gameId)` to get an isolated message channel
3. Registers `ns.on(action, handler)` listeners for peer messages
4. Returns `{ unmount() }` that cleans up listeners and DOM

### Networking model

`Net` (in `net.ts`) is the single source of truth for lobby state. It wraps Trystero with a small set of core actions: `hello` (peer announce), `chat`, `game` (game switch), `score`, and `act` (game envelope).

Per-game messages are **multiplexed** through the single `act` action using `net.namespace(ns)`, which prepends the namespace to action names and returns a cleanup-aware sub-channel. This keeps Trystero action count low regardless of how many games are registered.

**Host election:** the peer with the lowest peer ID acts as simulation authority in games that need it (e.g. `hoops`, `construction`, `stickman`). If the host disconnects, the next-lowest peer takes over — brief state hiccups are expected.

**Late-join pattern:** games that have ongoing state implement a `sync-request` / response round so joining peers can catch up. See `polls.ts` for the canonical example.

### State & persistence

- All multiplayer state is ephemeral — it dies when the room empties.
- User preferences (name, avatar, music volume/mute) are stored in `localStorage` under `pfg-name`, `pfg-avatar`, `pfg-music-*` keys.
- No state management library; state lives in plain TypeScript class fields and `Map`s.

### UI rendering

No framework — all DOM is imperative `innerHTML` + `addEventListener`. The join → lobby → game flow is orchestrated in `main.ts`. Components return cleanup functions rather than lifecycle hooks.

### Deployment

GitHub Actions (`.github/workflows/deploy.yml`) builds and deploys to GitHub Pages on every push to `main`. The Vite config uses a relative base (`./`) for Pages compatibility.
