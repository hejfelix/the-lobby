# The Lobby

A small collection of peer-to-peer browser games. Static TypeScript app, no
backend, no accounts, no sign-ups. Hosted on GitHub Pages.

Pick a room name, share the URL with friends, and you all land in the same
lobby. The same P2P session is shared across every game — peers, scores,
avatars and chat carry over when you switch games.

## Games

- **Sketchroom** — collaborative drawing canvas with optional
  guess-the-word rounds.
- **Quick Polls** — post a question with options, watch the room vote live.
- **Hoops** (Easy / Hard / Extreme) — slingshot a ball through the hoop;
  harder difficulties shrink the ball/rim and make the hoop drift.
- **Clicker** — race to rack up clicks before the timer runs out.
- **Wordle** — co-op daily Wordle with a 15k-word valid-guess list.
- **Reaction Race** — wait for green, click as fast as you can.
- **Group Construction** — incremental co-op resource builder.
- **Stock Market** — shared random-walk price chart. Press space (or the big
  button) to toggle buy/sell. PUMP and TANK to swing the market.

Each player gets a customisable [DiceBear](https://www.dicebear.com/) avatar.

## How it works

- Networking via [Trystero](https://github.com/dmotz/trystero) over WebRTC,
  using public Nostr relays (e.g. `wss://relay.damus.io`) for peer
  signaling. Once peers find each other in the same room, all data flows
  directly browser-to-browser — the relays only see the initial offer/answer.
- A single `Net` instance owns the WebRTC room, peer roster, scores, chat,
  and avatars. Each game gets its own typed message namespace
  (`net.namespace("sketch")`) multiplexed through one Trystero action, so
  games can be added without touching the network code.

## Develop

```bash
npm install
npm run dev
# open http://localhost:5173
```

Open in two browser windows (or one regular + one private) using the same
room name to test multiplayer locally.

## Build & deploy

```bash
npm run build   # type-check + Vite production bundle into dist/
npm run preview # smoke-test the built output
```

The included [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
builds the project on every push to `main` and deploys `dist/` to GitHub
Pages. In the repo settings under **Pages**, set the source to **GitHub
Actions**.

## Adding a new game

1. Create `src/games/yourgame.ts` exporting a `Game` (see `src/games/game.ts`).
2. Use the namespace API for messages:

   ```ts
   const ns = net.namespace("yourgame");
   ns.send("move", { x, y });
   ns.on<{ x: number; y: number }>("move", (data, peerId) => { ... });
   ```

3. Register it in `src/games/index.ts`. It will appear automatically in the
   game lobby for everyone in the room.

## Caveats

- WebRTC needs a NAT-traversable network. Strict corporate firewalls may
  block STUN or the signaling relays. If signaling is blocked, the app logs
  a hint after a few seconds.
- No persistence. When everyone leaves a room, its state is gone.
- Some games elect a "host" (lowest peer id) to run the simulation. If the
  host disconnects mid-game, another peer takes over but in-flight state
  may briefly hiccup.

## Develop

```bash
npm install
npm run dev
# open http://localhost:5173
```

Open in two browser windows (or one regular + one private) using the same
room name to test multiplayer locally.

## Build & deploy

```bash
npm run build   # type-check + Vite production bundle into dist/
npm run preview # smoke-test the built output
```

The included [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
builds the project on every push to `main` and deploys `dist/` to GitHub
Pages. In the repo settings under **Pages**, set the source to **GitHub
Actions**.

## Adding a new game

1. Create `src/games/yourgame.ts` exporting a `Game` (see `src/games/game.ts`).
2. Use the namespace API for messages:

   ```ts
   const ns = net.namespace("yourgame");
   ns.send("move", { x, y });
   ns.on<{ x: number; y: number }>("move", (data, peerId) => { ... });
   ```

3. Register it in `src/games/index.ts`. It will appear automatically in the
   game lobby for everyone in the room.

## Caveats

- WebRTC needs a NAT-traversable network. Strict corporate firewalls may
  block STUN or the signaling relays. If signaling is blocked, the app logs
  a hint after a few seconds.
- No persistence. When everyone leaves a room, its state is gone.
