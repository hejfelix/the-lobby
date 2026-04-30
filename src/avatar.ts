// Avatar rendering + character creator UI.
// Powered by DiceBear (MIT licensed) — https://www.dicebear.com

import { createAvatar, type Style } from "@dicebear/core";
import {
  adventurer,
  avataaars,
  bottts,
  funEmoji,
  lorelei,
  micah,
  miniavs,
  notionists,
  openPeeps,
  personas,
  pixelArt,
  thumbs,
} from "@dicebear/collection";
import { AVATAR_BG_OPTIONS, AVATAR_STYLES, type Avatar, type AvatarStyle, type Net } from "./net";

const STORAGE_KEY = "pfg-avatar";

// Map our string ids to the corresponding DiceBear style modules.
const STYLE_MAP: Record<AvatarStyle, Style<object>> = {
  adventurer: adventurer as Style<object>,
  avataaars: avataaars as Style<object>,
  bottts: bottts as Style<object>,
  funEmoji: funEmoji as Style<object>,
  lorelei: lorelei as Style<object>,
  micah: micah as Style<object>,
  miniavs: miniavs as Style<object>,
  notionists: notionists as Style<object>,
  openPeeps: openPeeps as Style<object>,
  personas: personas as Style<object>,
  pixelArt: pixelArt as Style<object>,
  thumbs: thumbs as Style<object>,
};

const STYLE_LABELS: Record<AvatarStyle, string> = {
  adventurer: "Adventurer",
  avataaars: "Avataaars",
  bottts: "Bots",
  funEmoji: "Fun Emoji",
  lorelei: "Lorelei",
  micah: "Micah",
  miniavs: "Mini",
  notionists: "Notionists",
  openPeeps: "Open Peeps",
  personas: "Personas",
  pixelArt: "Pixel Art",
  thumbs: "Thumbs",
};

export function loadAvatarFromStorage(): Avatar | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Avatar>;
    if (typeof parsed.style === "string" && typeof parsed.seed === "string") {
      return {
        style: parsed.style,
        seed: parsed.seed,
        flip: typeof parsed.flip === "string" ? parsed.flip : "false",
        bg: typeof parsed.bg === "string" ? parsed.bg : "transparent",
      };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return undefined;
}

function saveAvatarToStorage(avatar: Avatar): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(avatar));
  } catch {
    /* ignore quota errors */
  }
}

function styleOf(name: string): Style<object> {
  if ((AVATAR_STYLES as readonly string[]).includes(name)) {
    return STYLE_MAP[name as AvatarStyle];
  }
  return STYLE_MAP.adventurer;
}

/**
 * Returns an SVG markup string for the given avatar at `size` pixels.
 * Renders deterministically from `avatar.seed` so everyone in the room
 * sees the same character.
 */
export function renderAvatarSvg(avatar: Avatar | undefined, size: number, _accent?: string): string {
  const a: Avatar = avatar ?? {
    style: "adventurer",
    seed: "anon",
    flip: "false",
    bg: "transparent",
  };
  const style = styleOf(a.style);
  const opts: Record<string, unknown> = {
    seed: a.seed || "anon",
    size,
    flip: a.flip === "true",
  };
  if (a.bg && a.bg !== "transparent") {
    opts.backgroundColor = [a.bg];
    opts.backgroundType = ["solid"];
  }
  return createAvatar(style, opts).toString();
}

interface CreatorOptions {
  net: Net;
  /** Called whenever the avatar changes. */
  onChange?: (avatar: Avatar) => void;
}

const SAMPLE_SEEDS = [
  "felix", "maya", "kai", "nora", "leo", "ivy", "milo", "zara",
  "otis", "luna", "remy", "iris", "theo", "juno", "axel", "wren",
];

function randomSeed(): string {
  return SAMPLE_SEEDS[Math.floor(Math.random() * SAMPLE_SEEDS.length)] +
    "-" + Math.random().toString(36).slice(2, 6);
}

/**
 * Mounts the character creator inside `container`. Returns an unmount fn.
 */
export function renderCharacterCreator(container: HTMLElement, opts: CreatorOptions): () => void {
  const net = opts.net;
  let current: Avatar = { ...net.me.avatar };

  container.innerHTML = `
    <div class="creator">
      <div class="creator-header">
        <h2>Make your character</h2>
        <p class="creator-sub">Pick a style. Type any seed to generate a one-of-a-kind avatar. Visible to everyone in the room.</p>
      </div>
      <div class="creator-body">
        <div class="creator-preview">
          <div class="creator-preview-frame">
            <div class="creator-avatar"></div>
          </div>
          <div class="creator-name">${escapeHtml(net.me.name)}</div>
          <div class="creator-actions">
            <button class="creator-randomise" type="button">Randomise</button>
            <button class="creator-flip" type="button">Flip</button>
          </div>
        </div>
        <div class="creator-controls">
          <div class="creator-group">
            <div class="creator-group-label">Seed</div>
            <div class="creator-seed-row">
              <input class="creator-seed-input" type="text" maxlength="64" placeholder="Type anything…" />
              <button class="creator-seed-shuffle" type="button" title="New random seed">Shuffle</button>
            </div>
            <p class="hint">The seed deterministically picks features. Same seed = same character.</p>
          </div>
          <div class="creator-group">
            <div class="creator-group-label">Background</div>
            <div class="creator-bg-row"></div>
          </div>
          <div class="creator-group">
            <div class="creator-group-label">Style</div>
            <div class="creator-style-grid"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const previewEl = container.querySelector<HTMLDivElement>(".creator-avatar")!;
  const styleGridEl = container.querySelector<HTMLDivElement>(".creator-style-grid")!;
  const bgRowEl = container.querySelector<HTMLDivElement>(".creator-bg-row")!;
  const seedInput = container.querySelector<HTMLInputElement>(".creator-seed-input")!;

  const renderPreview = () => {
    previewEl.innerHTML = renderAvatarSvg(current, 160);
  };

  const renderStyles = () => {
    styleGridEl.innerHTML = "";
    for (const styleId of AVATAR_STYLES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "creator-style";
      if (current.style === styleId) btn.classList.add("active");
      const sampleAvatar: Avatar = { ...current, style: styleId };
      btn.innerHTML = `
        <div class="creator-style-thumb">${renderAvatarSvg(sampleAvatar, 56)}</div>
        <div class="creator-style-name">${escapeHtml(STYLE_LABELS[styleId])}</div>
      `;
      btn.onclick = () => {
        current = { ...current, style: styleId };
        commit();
      };
      styleGridEl.appendChild(btn);
    }
  };

  const renderBgs = () => {
    bgRowEl.innerHTML = "";
    for (const bg of AVATAR_BG_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "creator-bg-swatch";
      if (current.bg === bg) btn.classList.add("active");
      if (bg === "transparent") {
        btn.classList.add("transparent");
        btn.title = "No background";
      } else {
        btn.style.background = `#${bg}`;
        btn.title = `#${bg}`;
      }
      btn.onclick = () => {
        current = { ...current, bg };
        commit();
      };
      bgRowEl.appendChild(btn);
    }
  };

  const commit = () => {
    saveAvatarToStorage(current);
    net.updateAvatar(current);
    opts.onChange?.(current);
    renderPreview();
    renderStyles();
    renderBgs();
    if (seedInput.value !== current.seed) seedInput.value = current.seed;
  };

  // Seed input — debounce keystrokes so we don't spam the network.
  let seedTimer: ReturnType<typeof setTimeout> | null = null;
  seedInput.value = current.seed;
  seedInput.oninput = () => {
    const v = seedInput.value.slice(0, 64);
    if (seedTimer) clearTimeout(seedTimer);
    seedTimer = setTimeout(() => {
      current = { ...current, seed: v || "anon" };
      commit();
    }, 200);
  };

  container.querySelector<HTMLButtonElement>(".creator-seed-shuffle")!.onclick = () => {
    current = { ...current, seed: randomSeed() };
    commit();
  };

  container.querySelector<HTMLButtonElement>(".creator-randomise")!.onclick = () => {
    const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
    current = {
      style: pick(AVATAR_STYLES),
      seed: randomSeed(),
      flip: Math.random() < 0.5 ? "true" : "false",
      bg: pick(AVATAR_BG_OPTIONS),
    };
    commit();
  };

  container.querySelector<HTMLButtonElement>(".creator-flip")!.onclick = () => {
    current = { ...current, flip: current.flip === "true" ? "false" : "true" };
    commit();
  };

  renderPreview();
  renderStyles();
  renderBgs();

  return () => {
    if (seedTimer) clearTimeout(seedTimer);
    container.innerHTML = "";
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
