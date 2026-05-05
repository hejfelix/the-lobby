import type { Game } from "./game";
import { SketchGame } from "./sketch";
import { PollsGame } from "./polls";
import { HoopsEasyGame, HoopsHardGame, HoopsExtremeGame } from "./hoops";
import { ClickerGame } from "./clicker";
import { WordleGame } from "./wordle";
import { ReactionGame } from "./reaction";
import { ConstructionGame } from "./construction";
import { MarketGame } from "./market";
import { StickmanGame } from "./stickman";
import { FlappyGame } from "./flappy";
import { MinigolfGame } from "./minigolf";
import { PokemonQuizEasyGame, PokemonQuizMediumGame, PokemonQuizHardGame } from "./pokemon-quiz";

export const GAMES: Game[] = [
    SketchGame,
    PollsGame,
    HoopsEasyGame,
    HoopsHardGame,
    HoopsExtremeGame,
    ClickerGame,
    WordleGame,
    ReactionGame,
    ConstructionGame,
    MarketGame,
    StickmanGame,
    FlappyGame,
    MinigolfGame,
    PokemonQuizEasyGame,
    PokemonQuizMediumGame,
    PokemonQuizHardGame,
];

export function findGame(id: string | null): Game | undefined {
    if (!id) return undefined;
    return GAMES.find((g) => g.id === id);
}
