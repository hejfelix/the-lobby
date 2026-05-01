// Plays a triumphant brass-style fanfare via WebAudio + announces the
// new arrival's name with the browser's SpeechSynthesis (when available).
//
// Both APIs require a prior user gesture in most browsers — the join
// screen click satisfies that, so by the time peers can join we're
// already unlocked.

let ctx: AudioContext | null = null;
let muted = false;

const STORAGE_KEY = "pfg-fanfare-muted";

try {
    muted = localStorage.getItem(STORAGE_KEY) === "1";
} catch {
    /* ignore */
}

export function isFanfareMuted(): boolean {
    return muted;
}

export function setFanfareMuted(v: boolean): void {
    muted = v;
    try {
        localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
        /* ignore */
    }
}

function getCtx(): AudioContext | null {
    if (muted) return null;
    if (!ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
    }
    if (ctx.state === "suspended") {
        void ctx.resume().catch(() => { });
    }
    return ctx;
}

/** Play a single brass-ish note. */
function playNote(ac: AudioContext, freq: number, start: number, duration: number, gain = 0.18) {
    const t0 = ac.currentTime + start;
    const t1 = t0 + duration;

    // Two slightly detuned sawtooth oscillators for a richer brass tone.
    const osc1 = ac.createOscillator();
    const osc2 = ac.createOscillator();
    osc1.type = "sawtooth";
    osc2.type = "sawtooth";
    osc1.frequency.value = freq;
    osc2.frequency.value = freq * 1.005;

    // A simple low-pass to soften the edge.
    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    filter.Q.value = 0.7;

    const env = ac.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.025);
    env.gain.linearRampToValueAtTime(gain * 0.85, t0 + duration * 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, t1);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(ac.destination);

    osc1.start(t0);
    osc2.start(t0);
    osc1.stop(t1 + 0.05);
    osc2.stop(t1 + 0.05);
}

/** Play the loud, proud fanfare. */
export function playFanfare(): void {
    const ac = getCtx();
    if (!ac) return;

    // Bb major triumphant fanfare riff (Bb, F, Bb up, then a held D-F-Bb chord).
    const Bb3 = 233.08;
    const F4 = 349.23;
    const Bb4 = 466.16;
    const D5 = 587.33;
    const F5 = 698.46;

    const notes: Array<[number, number, number, number?]> = [
        // [freq, startSec, durationSec, gain?]
        [Bb3, 0.0, 0.18],
        [F4, 0.18, 0.18],
        [Bb4, 0.36, 0.18],
        [D5, 0.54, 0.12],
        [F5, 0.66, 0.12],
        // Held final chord
        [Bb4, 0.82, 0.7, 0.16],
        [D5, 0.82, 0.7, 0.14],
        [F5, 0.82, 0.7, 0.13],
        [Bb3, 0.82, 0.7, 0.18],
    ];

    for (const [f, s, d, g] of notes) {
        playNote(ac, f, s, d, g ?? 0.2);
    }
}

/** Speak `text` via SpeechSynthesis if available. */
export function speak(text: string): void {
    if (muted) return;
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
    try {
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 0.95;
        utter.pitch = 1.05;
        utter.volume = 1;
        // Prefer an English voice if available (call once voices are loaded).
        const pick = () => {
            const voices = synth.getVoices();
            if (voices.length) {
                const en = voices.find((v) => /en[-_]/i.test(v.lang)) || voices[0];
                if (en) utter.voice = en;
            }
            synth.speak(utter);
        };
        if (synth.getVoices().length) {
            pick();
        } else {
            // Some browsers populate voices async — wait once.
            const handler = () => {
                synth.removeEventListener("voiceschanged", handler);
                pick();
            };
            synth.addEventListener("voiceschanged", handler);
            // Fallback in case the event never fires.
            setTimeout(pick, 250);
        }
    } catch {
        /* ignore */
    }
}

/** Play fanfare and announce the new arrival. */
export function announceArrival(name: string): void {
    if (muted) return;
    playFanfare();
    // Stagger the speech slightly so it lands over the held chord.
    setTimeout(() => speak(`${name} has entered the lobby!`), 700);
}
