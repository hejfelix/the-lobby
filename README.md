# Fun Games

A small collection of peer-to-peer team games. Static TypeScript app, no
backend, no accounts. Hosted on GitHub Pages.

Currently included:

- **Sketchroom** — collaborative drawing canvas with optional guess-the-word
  rounds.
- **Quick Polls** — post a question with options, watch the room vote live.

The same room shares one P2P session across all games — peers, scores and
chat carry over when you switch games.

## How it works

- Networking via [Trystero](https://github.com/dmotz/trystero) over WebRTC,
  using public Nostr relays (e.g. `wss://relay.damus.io`) for peer signaling.
  Once peers find each other in the same room, all data flows directly
  browser-to-browser.
- A single `Net` instance owns the WebRTC room, peer roster, scores and chat.
  Each game gets its own typed message namespace (`net.namespace("sketch")`)
  multiplexed through one Trystero action, so games can be added without
  touching the network code.

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
