/**
 * The board's sounds, synthesised rather than sampled: nothing to ship, nothing
 * to license. Errors are swallowed, so no audio costs only the sound.
 */

export type SoundName = "move" | "burn" | "check" | "mate";

/** The burn animation's length (App.css). */
const BURN_MS = 1000;

let enabled = true;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<SoundName, AudioBuffer>();

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

/** mulberry32: seeded, so the noise never varies. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole coefficient for a cutoff in Hz. */
function pole(hz: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * hz) / sr);
}

/** A piece landing: noise transient, then the body ringing. */
function click(sr: number): Float32Array {
  const out = new Float32Array(Math.round(sr * 0.09));
  const rand = rng(0x9e3779b9);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    lp += pole(4200, sr) * ((rand() * 2 - 1) * Math.exp(-t / 0.0016) - lp);
    const body =
      0.5 * Math.sin(2 * Math.PI * 470 * t) * Math.exp(-t / 0.019) +
      0.3 * Math.sin(2 * Math.PI * 1240 * t) * Math.exp(-t / 0.011) +
      0.22 * Math.sin(2 * Math.PI * 3150 * t) * Math.exp(-t / 0.004);
    out[i] = Math.tanh((lp * 2.6 + body) * 1.25) * 0.62;
  }
  return out;
}

/** Fire: noise, cutoff falling, crackle over it. */
function burn(sr: number): Float32Array {
  const n = Math.round((sr * BURN_MS) / 1000);
  const out = new Float32Array(n);
  const rand = rng(0x85ebca6b);
  let lp = 0;
  let dc = 0;
  let pop = 0;
  let popDecay = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    lp += pole(5600 - 4400 * u, sr) * (rand() * 2 - 1 - lp);
    // Highpass, or it rumbles.
    dc += pole(240, sr) * (lp - dc);
    if (rand() < 0.0022 * (1 - u) + 0.0004) {
      pop = (rand() * 2 - 1) * (0.5 + 0.5 * (1 - u));
      popDecay = Math.exp(-1 / (sr * (0.0009 + rand() * 0.004)));
    }
    pop *= popDecay;
    const env = Math.min(1, i / (sr * 0.045)) * Math.pow(1 - u, 1.6);
    out[i] = Math.tanh(((lp - dc) * 2.9 + pop * 1.4) * env) * 0.42;
  }
  return out;
}

/** Inharmonic partials, each decaying at its own rate. Mate low, check high. */
function bell(sr: number, hz: number, seconds: number, partials: number[][], gain: number) {
  const out = new Float32Array(Math.round(sr * seconds));
  const rand = rng(0xc2b2ae35);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let v = 0;
    for (const [ratio, level, decay] of partials) {
      v += level * Math.sin(2 * Math.PI * hz * ratio * t) * Math.exp(-t / decay);
    }
    lp += pole(3400, sr) * ((rand() * 2 - 1) * Math.exp(-t / 0.004) - lp);
    // Eased in, or the strike clicks.
    out[i] = Math.tanh((v + lp * 1.6) * 1.15) * gain * Math.min(1, t / 0.002);
  }
  return out;
}

function samples(name: SoundName, sr: number): Float32Array {
  if (name === "move") return click(sr);
  if (name === "burn") return burn(sr);
  if (name === "check") {
    return bell(sr, 742, 0.55, [[1, 0.42, 0.3], [2.04, 0.26, 0.17], [3.11, 0.15, 0.09], [4.6, 0.08, 0.05]], 0.4);
  }
  return bell(
    sr,
    116,
    1.9,
    [[1, 0.5, 1.35], [2.01, 0.34, 0.85], [2.98, 0.2, 0.5], [4.22, 0.13, 0.3], [5.43, 0.08, 0.18]],
    0.58,
  );
}

/** Opened on the first sound, which follows a gesture. */
function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

/** `delay` in seconds, for a sound answering the move. */
export function playSound(name: SoundName, delay = 0) {
  if (!enabled) return;
  try {
    const c = audio();
    if (!c || !master) return;
    // Suspended until the page has had a gesture, so the AI's opening move
    // goes unheard.
    if (c.state === "suspended") void c.resume().catch(() => {});
    let buf = buffers.get(name);
    if (!buf) {
      const data = samples(name, c.sampleRate);
      buf = c.createBuffer(1, data.length, c.sampleRate);
      buf.getChannelData(0).set(data);
      buffers.set(name, buf);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.start(c.currentTime + delay);
  } catch {
    /* a sound must never break a move */
  }
}
