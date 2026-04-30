import type { Net } from "../net";

export interface GameInstance {
  unmount(): void;
}

export interface Game {
  /** Stable id used in the URL hash and broadcast to peers. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Mount the game UI into `container`, using `net` for P2P. */
  create(container: HTMLElement, net: Net): GameInstance;
}
