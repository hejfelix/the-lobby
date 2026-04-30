// Collaborative lobby music.
// ──────────────────────────
// Loads CC-BY / CC0 audio files from public/music/manifest.json (populated by
// `npm run fetch-music`). Sync model: lowest peer id is the "DJ"; broadcasts
// `{trackIndex, startedAt}`. Each peer fetches the same audio file and seeks
// to `(now - startedAt) % duration` so playback stays roughly aligned across
// the room.

import type { Net, GameNamespace } from "./net";

interface ManifestTrack {
    title: string;
    artist: string;
    license: string;
    licenseUrl: string;
    sourceUrl: string;
    file: string;
    mood: string;
}

interface NowPlayingMsg {
    trackIndex: number;
    /** Wall-clock ms when this track started. */
    startedAt: number;
}

const MANIFEST_URL = "music/manifest.json";

export class LobbyMusic {
    private net: Net;
    private ns: GameNamespace;
    private container: HTMLElement;

    private tracks: ManifestTrack[] = [];
    private currentIndex = -1;
    private startedAt = 0;

    private muted = true;
    private localVolume = 0.3;

    private audioEl: HTMLAudioElement | null = null;

    private titleEl!: HTMLSpanElement;
    private moodEl!: HTMLSpanElement;
    private playBtn!: HTMLButtonElement;
    private prevBtn!: HTMLButtonElement;
    private nextBtn!: HTMLButtonElement;
    private volSlider!: HTMLInputElement;
    private creditEl!: HTMLAnchorElement;

    private unsubPeers: (() => void) | null = null;

    constructor(container: HTMLElement, net: Net) {
        this.container = container;
        this.net = net;
        this.ns = net.namespace("lobby-music");
        // Default: play (only stay muted if the user explicitly muted last time).
        this.muted = localStorage.getItem("lobby-music-muted") === "true";
        const vol = Number(localStorage.getItem("lobby-music-vol"));
        if (Number.isFinite(vol) && vol >= 0 && vol <= 1) this.localVolume = vol;

        this.audioEl = new Audio();
        this.audioEl.loop = false;
        this.audioEl.preload = "auto";
        this.audioEl.volume = this.muted ? 0 : this.localVolume;
        this.audioEl.addEventListener("ended", () => this.advanceIfDj());

        this.render();
        this.registerNetwork();
        this.unsubPeers = this.net.on("peers", () => this.maybeBecomeDj());

        // Browsers block autoplay until a user gesture. Resume playback on the
        // first interaction with the page so the lobby music kicks in naturally.
        // We keep listening until playback actually starts (e.g. the manifest may
        // still be loading when the first gesture happens).
        const onGesture = () => {
            if (this.muted || !this.audioEl || this.currentIndex < 0) return;
            this.audioEl
                .play()
                .then(() => {
                    window.removeEventListener("pointerdown", onGesture);
                    window.removeEventListener("keydown", onGesture);
                })
                .catch(() => { /* still blocked, will retry on next gesture */ });
        };
        window.addEventListener("pointerdown", onGesture);
        window.addEventListener("keydown", onGesture);

        this.loadManifest()
            .catch((e) => {
                console.warn("[music] manifest load failed", e);
            })
            .finally(() => {
                this.refreshUi();
                // Once we know what's available, kick off DJ election.
                setTimeout(() => this.maybeBecomeDj(true), 800);
            });
    }

    destroy(): void {
        this.unsubPeers?.();
        if (this.audioEl) {
            this.audioEl.pause();
            this.audioEl.src = "";
            this.audioEl = null;
        }
        this.ns.close();
    }

    // ---------- DOM ----------

    private render() {
        this.container.innerHTML = `
      <div class="music-player">
        <button type="button" class="music-btn music-prev" title="Previous track">‹</button>
        <button type="button" class="music-btn music-play" title="Play / mute">▶</button>
        <button type="button" class="music-btn music-next" title="Next track">›</button>
        <div class="music-info">
          <span class="music-title">—</span>
          <span class="music-mood"></span>
        </div>
        <a class="music-credit" target="_blank" rel="noopener" title=""></a>
        <input type="range" class="music-vol" min="0" max="100" step="1" title="Volume" />
      </div>
    `;
        this.titleEl = this.container.querySelector<HTMLSpanElement>(".music-title")!;
        this.moodEl = this.container.querySelector<HTMLSpanElement>(".music-mood")!;
        this.playBtn = this.container.querySelector<HTMLButtonElement>(".music-play")!;
        this.prevBtn = this.container.querySelector<HTMLButtonElement>(".music-prev")!;
        this.nextBtn = this.container.querySelector<HTMLButtonElement>(".music-next")!;
        this.volSlider = this.container.querySelector<HTMLInputElement>(".music-vol")!;
        this.creditEl = this.container.querySelector<HTMLAnchorElement>(".music-credit")!;
        this.volSlider.value = String(Math.round(this.localVolume * 100));

        this.playBtn.addEventListener("click", () => this.toggleMute());
        this.prevBtn.addEventListener("click", () => this.changeTrack(-1));
        this.nextBtn.addEventListener("click", () => this.changeTrack(+1));
        this.volSlider.addEventListener("input", () => {
            this.localVolume = Math.max(0, Math.min(1, Number(this.volSlider.value) / 100));
            localStorage.setItem("lobby-music-vol", String(this.localVolume));
            this.applyVolume();
        });
    }

    private refreshUi() {
        const t = this.currentIndex >= 0 ? this.tracks[this.currentIndex] : null;
        if (this.tracks.length === 0) {
            this.titleEl.textContent = "no music loaded";
            this.moodEl.textContent = "run npm run fetch-music";
        } else {
            this.titleEl.textContent = t ? t.title : "—";
            this.moodEl.textContent = t ? `${t.mood} · ${t.artist}` : "";
        }
        this.playBtn.textContent = this.muted ? "▶" : "■";
        this.playBtn.title = this.muted ? "Click to enable music" : "Mute music";
        this.playBtn.classList.toggle("music-muted", this.muted);

        if (t) {
            this.creditEl.textContent = t.license;
            this.creditEl.title = `${t.title} by ${t.artist} (${t.license}) — click for source`;
            this.creditEl.href = t.sourceUrl;
            this.creditEl.style.display = "";
        } else {
            this.creditEl.style.display = "none";
        }

        const canControl = this.tracks.length > 0;
        this.prevBtn.disabled = !canControl;
        this.nextBtn.disabled = !canControl;
        this.playBtn.disabled = !canControl;
    }

    // ---------- manifest ----------

    private async loadManifest() {
        const url = new URL(MANIFEST_URL, document.baseURI).toString();
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        const body = (await res.json()) as { tracks?: ManifestTrack[] };
        if (!body || !Array.isArray(body.tracks)) return;
        this.tracks = body.tracks.filter((t) => t && t.file && t.title);
    }

    private trackUrl(t: ManifestTrack): string {
        return new URL(`music/${t.file}`, document.baseURI).toString();
    }

    // ---------- network / DJ election ----------

    private registerNetwork() {
        this.ns.on<NowPlayingMsg>("now-playing", (msg, peerId) => {
            if (!msg) return;
            if (peerId !== this.djId()) return;
            this.applyTrack(msg.trackIndex, msg.startedAt);
        });
        this.ns.on<Record<string, never>>("sync-req", (_d, peerId) => {
            if (this.currentIndex < 0) return;
            if (this.djId() !== this.net.me.id) return;
            this.ns.send("now-playing", { trackIndex: this.currentIndex, startedAt: this.startedAt }, peerId);
        });
        this.ns.send("sync-req", {});
    }

    private djId(): string {
        const all = [this.net.me.id, ...this.net.peers.keys()];
        all.sort();
        return all[0];
    }

    private isDj(): boolean {
        return this.djId() === this.net.me.id;
    }

    private maybeBecomeDj(initial = false) {
        if (!this.isDj()) return;
        if (this.tracks.length === 0) return;
        if (this.currentIndex < 0 || initial) {
            // Default starting track: prefer "local-forecast.mp3" if present,
            // otherwise fall back to the first track.
            const preferred = this.tracks.findIndex((t) => t.file === "local-forecast.mp3");
            const idx = preferred >= 0 ? preferred : 0;
            this.applyTrack(idx, Date.now());
            this.broadcastNowPlaying();
        }
    }

    private broadcastNowPlaying() {
        this.ns.send("now-playing", { trackIndex: this.currentIndex, startedAt: this.startedAt });
    }

    private advanceIfDj() {
        if (!this.isDj() || this.tracks.length === 0) return;
        const next = (this.currentIndex + 1) % this.tracks.length;
        this.applyTrack(next, Date.now());
        this.broadcastNowPlaying();
    }

    // ---------- track control ----------

    private changeTrack(delta: number) {
        if (this.tracks.length === 0) return;
        if (!this.isDj()) {
            this.net.pushSystem("Only the lobby DJ can change tracks (lowest peer id).");
            return;
        }
        const next = this.currentIndex < 0
            ? 0
            : (this.currentIndex + delta + this.tracks.length) % this.tracks.length;
        this.applyTrack(next, Date.now());
        this.broadcastNowPlaying();
    }

    private applyTrack(index: number, startedAt: number) {
        if (index < 0 || index >= this.tracks.length || !this.audioEl) {
            this.currentIndex = -1;
            this.refreshUi();
            return;
        }
        this.currentIndex = index;
        this.startedAt = startedAt;
        const t = this.tracks[index];
        const url = this.trackUrl(t);
        if (this.audioEl.src !== url) {
            this.audioEl.src = url;
        }

        const seek = () => {
            if (!this.audioEl) return;
            const dur = this.audioEl.duration;
            const elapsed = Math.max(0, (Date.now() - this.startedAt) / 1000);
            if (Number.isFinite(dur) && dur > 0 && elapsed < dur) {
                try { this.audioEl.currentTime = elapsed; } catch { /* ignore */ }
            } else {
                try { this.audioEl.currentTime = 0; } catch { /* ignore */ }
            }
            if (!this.muted) {
                this.audioEl.play().catch(() => { /* user hasn't gestured yet */ });
            }
        };
        if (this.audioEl.readyState >= 1) {
            seek();
        } else {
            this.audioEl.addEventListener("loadedmetadata", seek, { once: true });
        }
        this.refreshUi();
    }

    // ---------- audio ----------

    private toggleMute() {
        this.muted = !this.muted;
        localStorage.setItem("lobby-music-muted", this.muted ? "true" : "false");
        this.applyVolume();
        if (this.audioEl) {
            if (this.muted) {
                this.audioEl.pause();
            } else if (this.currentIndex >= 0) {
                this.audioEl.play().catch(() => { /* ignore */ });
            }
        }
        this.refreshUi();
    }

    private applyVolume() {
        if (!this.audioEl) return;
        this.audioEl.volume = this.muted ? 0 : this.localVolume;
    }
}
