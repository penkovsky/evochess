/**
 * Turns a clip manifest into a vertical video, ready for a light edit and an
 * upload. See `docs/clip-tool-spec.md`.
 *
 *   npx esbuild scripts/makeClip.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=scripts/makeClip.bundle.mjs
 *   node scripts/makeClip.bundle.mjs clips/tutorial-2.json
 *
 * Frames are screenshots of the real app at a `?p=` link.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "@playwright/test";
import { SHARE_PARAM } from "../src/evochess/shareLink";
import { buildClip, type Clip, type Frame } from "./lib/clipManifest";

/** CSS pixels. Doubled by the device scale factor into a 1080x1920 frame. */
const VIEWPORT = { width: 540, height: 960 };
const CAPTION_BAND = 200;
const FOOTER_BAND = 200;
const DEV_PORT = 5199;

const CLIP_CSS = `
  /* Pieces must not animate: a frame would catch one in flight. */
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
  }
  html, body { overflow: hidden !important; background: #121212 !important; }
  .layout {
    max-width: none !important;
    margin: 0 !important;
    gap: 0 !important;
    padding: ${CAPTION_BAND}px 20px ${FOOTER_BAND}px !important;
    min-height: 100vh;
    box-sizing: border-box;
    align-items: center;
    justify-content: center;
  }
  .board-wrap { width: 500px !important; align-self: center !important; }
  /* Interface, not position. */
  .panel, .mobile-bar, .action-picker, .board-status, .board-status-underline,
  .link-banner, .tutorial-invite, .modal-backdrop, .sheet, .sheet-backdrop,
  .fireworks-overlay, .score-overlay, .puzzle-overlay, .live-join-overlay {
    display: none !important;
  }
  /* Over the board, the band between the two margins, so the eval bar in the
     bottom margin stays lit. Above the z-index offsetPiece lifts a travelling
     square to, or the piece drags a bright trail across the scrim. */
  #clip-scrim {
    position: fixed; left: 0; right: 0; top: ${CAPTION_BAND}px; bottom: ${FOOTER_BAND}px;
    background: rgba(12, 12, 12, 0.74); z-index: 1500;
  }
  #clip-caption {
    position: fixed; left: 0; right: 0; top: ${CAPTION_BAND}px; bottom: ${FOOTER_BAND}px;
    display: flex; align-items: center; justify-content: center; text-align: center;
    padding: 24px 34px; box-sizing: border-box; z-index: 1600;
    font: 600 34px/1.3 system-ui, -apple-system, sans-serif;
    color: #f2f2f2; letter-spacing: -0.01em;
  }
  #clip-eval {
    position: fixed; left: 40px; right: 40px; bottom: 96px; height: 22px;
    border-radius: 11px; overflow: hidden; background: #2c2c2c;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
  }
  #clip-eval-fill { position: absolute; top: 0; bottom: 0; left: 0; background: #ededed; }
  #clip-eval-text {
    position: fixed; right: 42px; bottom: 128px;
    font: 600 19px system-ui, sans-serif; color: #9a9a9a; letter-spacing: 0.02em;
  }
  /* An app icon: dark rounded square, mark inset, lifted off the gradient. */
  #clip-hero {
    width: 232px; height: 232px; border-radius: 54px; background: #16181d;
    display: flex; align-items: center; justify-content: center; flex: none;
    box-shadow: 0 20px 52px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.09);
  }
  #clip-hero img { width: 62%; height: 62%; }
  /* Whatever the manifest puts under the title, at display size. */
  #clip-glyph { font-size: 170px; line-height: 1; flex: none; }
  /* The same tile, small, over whatever the card is showing. */
  #clip-mark {
    position: fixed; top: 30px; left: 30px; width: 54px; height: 54px;
    border-radius: 14px; background: rgba(18, 20, 24, 0.85); z-index: 2100;
    display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.11);
  }
  #clip-mark img { width: 64%; height: 64%; }
  #clip-image {
    position: fixed; inset: 0; z-index: 2000; background: #121212;
    display: flex; align-items: center; justify-content: center;
  }
  #clip-image img { max-width: 100%; max-height: 100%; object-fit: contain; }
  #clip-card {
    position: fixed; inset: 0; z-index: 2000; background: #121212;
    display: flex; flex-direction: column; gap: 96px;
    align-items: center; justify-content: center; text-align: center;
    padding: 0 56px; box-sizing: border-box;
    font: 700 42px/1.22 system-ui, -apple-system, sans-serif; color: #ffffff;
    letter-spacing: -0.02em;
    /* Invisible on the plain dark card; keeps the title readable where a
       generated gradient runs light. */
    text-shadow: 0 2px 18px rgba(0, 0, 0, 0.3);
  }
`;

/** White-relative pawns to a bar fill. Flat at the ends, steep near equal. */
function evalFill(score: number): number {
  if (score === Infinity) return 1;
  if (score === -Infinity) return 0;
  return 0.5 + 0.5 * Math.tanh(score / 4);
}

function evalLabel(score: number): string {
  if (score === Infinity) return "+M";
  if (score === -Infinity) return "-M";
  return `${score >= 0 ? "+" : ""}${score.toFixed(1)}`;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** Inlined rather than served: the page is on a dev server that knows nothing
 *  about the manifest's directory. Cached, since a clip may reuse a picture. */
const dataUris = new Map<string, string>();
function dataUri(path: string): string {
  let uri = dataUris.get(path);
  if (uri === undefined) {
    const mime = MIME[extname(path).toLowerCase()];
    if (!mime) throw new Error(`unsupported image type: ${path}`);
    uri = `data:${mime};base64,${readFileSync(path).toString("base64")}`;
    dataUris.set(path, uri);
  }
  return uri;
}

/** The site mark, inlined like any other image. Vector, so it scales clean. */
const LOGO_PATH = "public/favicon.svg";

/** What travels with the piece, not with the square. */
const TRAVELS = "[data-piece], .rook-charge-badge, .rook-locked-dot";

/**
 * Draws the piece on `from` `t` of the way to `to`. The square is lifted
 * because later squares paint over earlier ones.
 */
async function offsetPiece(page: Page, from: string, to: string, t: number) {
  await page.evaluate(
    ({ from, to, t, travels }) => {
      const store = window as unknown as { __clipUndo?: (() => void)[] };
      store.__clipUndo?.forEach((undo) => undo());
      const undo: (() => void)[] = [];
      store.__clipUndo = undo;

      const square = (name: string) => document.querySelector(`[data-square="${name}"]`);
      const a = square(from);
      const b = square(to);
      if (!a || !b) throw new Error(`no squares ${from}/${to}`);
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const dx = (rb.left - ra.left) * t;
      const dy = (rb.top - ra.top) * t;

      const lift = a as HTMLElement;
      const position = lift.style.position;
      const zIndex = lift.style.zIndex;
      lift.style.position = "relative";
      lift.style.zIndex = "1000";
      undo.push(() => {
        lift.style.position = position;
        lift.style.zIndex = zIndex;
      });

      a.querySelectorAll(travels).forEach((node) => {
        const el = node as HTMLElement;
        const before = el.style.transform;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        undo.push(() => {
          el.style.transform = before;
        });
      });
    },
    { from, to, t, travels: TRAVELS },
  );
}

/**
 * Restores exactly what `offsetPiece` set. Never clear inline styles wholesale:
 * the board sets its own, and the coordinate labels depend on them.
 */
async function clearOffsets(page: Page) {
  await page.evaluate(() => {
    const store = window as unknown as { __clipUndo?: (() => void)[] };
    store.__clipUndo?.forEach((undo) => undo());
    store.__clipUndo = [];
  });
}

async function paintFrame(page: Page, frame: Frame, hasEvalBar: boolean) {
  // Every frame paints its own overlay. A move frame that inherited the
  // previous one would slide the piece out from under a caption still on
  // screen, and the lifted square would drag a bright trail across the scrim.
  const board = frame.kind === "board";
  const overlay =
    frame.kind === "image"
      ? { card: null, background: null, image: dataUri(frame.src), logo: frame.logo, glyph: null, glyphColor: null, caption: null, fill: null, label: null }
      : frame.kind === "card"
      ? { card: frame.text, background: frame.background, image: null, logo: frame.logo, glyph: frame.glyph, glyphColor: frame.glyphColor, caption: null, fill: null, label: null }
      : {
          image: null,
          card: null,
          background: null,
          logo: null,
          glyph: null,
          glyphColor: null,
          caption: board ? frame.caption : null,
          fill: frame.score === null ? null : evalFill(frame.score),
          label: frame.score === null ? null : evalLabel(frame.score),
        };
  await page.evaluate(
    ({ card, background, image, logo, logoUri, glyph, glyphColor, caption, fill, label, hasEvalBar }) => {
      const put = (id: string, html: string) => {
        const el = document.createElement("div");
        el.id = id;
        el.textContent = html;
        document.body.appendChild(el);
        return el;
      };
      document
        .querySelectorAll("#clip-scrim, #clip-caption, #clip-eval, #clip-eval-text, #clip-card, #clip-image, #clip-mark")
        .forEach((n) => n.remove());
      const mark = () => {
        const img = document.createElement("img");
        img.src = logoUri;
        put("clip-mark", "").appendChild(img);
      };
      if (image !== null) {
        const img = document.createElement("img");
        img.src = image;
        put("clip-image", "").appendChild(img);
        if (logo === "mark") mark();
        return;
      }
      if (card !== null) {
        const el = put("clip-card", card);
        if (background !== null) el.style.background = background;
        // Text first, then whatever sits under it: the card reads top to bottom.
        if (glyph !== null) {
          const g = document.createElement("div");
          g.id = "clip-glyph";
          g.textContent = glyph;
          if (glyphColor !== null) g.style.color = glyphColor;
          el.appendChild(g);
        }
        if (logo === "hero") {
          const img = document.createElement("img");
          img.src = logoUri;
          const tile = document.createElement("div");
          tile.id = "clip-hero";
          tile.appendChild(img);
          // Above the text, not below it: the mark introduces the sign-off.
          el.insertBefore(tile, el.firstChild);
        } else if (logo === "mark") mark();
        return;
      }
      if (caption) {
        put("clip-scrim", "");
        put("clip-caption", caption);
      }
      // The bar holds its place on plies with no score.
      if (hasEvalBar) {
        const bar = put("clip-eval", "");
        const inner = document.createElement("div");
        inner.id = "clip-eval-fill";
        inner.style.width = `${(fill ?? 0.5) * 100}%`;
        bar.appendChild(inner);
        if (label !== null) put("clip-eval-text", label);
      }
    },
    { ...overlay, hasEvalBar, logoUri: overlay.logo ? dataUri(resolve(LOGO_PATH)) : "" },
  );
}

async function renderFrames(clip: Clip, baseUrl: string, dir: string): Promise<string[]> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  // No engine: a link with the AI to move gets a move played on it. An empty
  // worker constructs and never answers. Dotted and case-sensitive, or it also
  // swallows `useAiWorker.ts`.
  await context.route(/ai\.worker/, (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  const page = await context.newPage();
  // Otherwise a failed mount is only a selector timeout.
  const faults: string[] = [];
  page.on("pageerror", (e) => faults.push(e.message));
  page.on("console", (m) => m.type() === "error" && faults.push(m.text()));

  const url = new URL(baseUrl);
  url.searchParams.set(SHARE_PARAM, clip.link);
  // Not "networkidle": the dev client never lets it settle.
  await page.goto(url.toString(), { waitUntil: "load" });
  try {
    await page.waitForSelector(".board-container", { timeout: 15000 });
    await page.waitForFunction(
      () => (document.querySelector(".board-container")?.querySelectorAll("*").length ?? 0) >= 64,
      undefined,
      { timeout: 15000 },
    );
  } catch {
    await page.screenshot({ path: join(dir, "failed.png") });
    const why = faults.length ? `\npage errors:\n  ${faults.join("\n  ")}` : "";
    throw new Error(`board never rendered at ${url}\nsee ${join(dir, "failed.png")}${why}`);
  }
  // Before the first step: this is what stops pieces animating.
  await page.addStyleTag({ content: CLIP_CSS });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const paths: string[] = [];
  let atPly = 0;
  for (const [i, frame] of clip.frames.entries()) {
    if (frame.kind === "board") {
      if (atPly > frame.ply) throw new Error(`frames must be in ply order; ${frame.ply} follows ${atPly}`);
      if (atPly < frame.ply) await clearOffsets(page);
      for (; atPly < frame.ply; atPly++) await stepForward(page, atPly + 1, clip.totalPlies);
      await waitForPosition(page, frame.squares);
    } else if (frame.kind === "move") {
      await offsetPiece(page, frame.from, frame.to, frame.t);
    }
    await paintFrame(page, frame, clip.hasEvalBar);
    const path = join(dir, `f${String(i).padStart(4, "0")}.png`);
    await page.screenshot({ path });
    paths.push(path);
    if (frame.kind === "board") process.stderr.write(`  ${i + 1}/${clip.frames.length} ply ${frame.ply}\n`);
    else if (frame.kind !== "move") {
      process.stderr.write(`  ${i + 1}/${clip.frames.length} ${frame.kind}\n`);
    }
  }
  await browser.close();
  return paths;
}

/**
 * One ply forward through the app's history browsing. The status line confirms
 * the key press landed; the stylesheet hides it but leaves it in the DOM.
 */
async function stepForward(page: Page, toPly: number, totalPlies: number) {
  const want = toPly >= totalPlies ? null : toPly === 0 ? "Start position" : `Move ${toPly} of ${totalPlies}`;
  await page.keyboard.press("ArrowRight");
  if (want === null) {
    // Past the last ply the app leaves browsing and drops the label.
    await page.waitForTimeout(150);
    return;
  }
  await page.waitForFunction(
    (text) => document.querySelector(".board-status")?.textContent?.trim() === text,
    want,
    { timeout: 5000 },
  );
}

/**
 * Waits until the board holds this position. Pieces arrive after the status
 * line does, so the occupied squares are the signal that the update landed.
 */
async function waitForPosition(page: Page, squares: string[]) {
  await page.waitForFunction(
    (want) => {
      const on: string[] = [];
      document.querySelectorAll("[data-square]").forEach((sq) => {
        if (sq.querySelector("[data-piece]")) on.push(sq.getAttribute("data-square")!);
      });
      return on.sort().join(",") === want;
    },
    squares.join(","),
    { polling: 50, timeout: 10000 },
  );
}

/**
 * Each frame holds for its own dwell. The last entry is repeated because
 * ffmpeg ignores the final duration.
 */
function writeConcatList(dir: string, paths: string[], frames: Frame[]): string {
  const lines: string[] = [];
  paths.forEach((path, i) => {
    lines.push(`file '${path}'`, `duration ${(frames[i].durationMs / 1000).toFixed(3)}`);
  });
  lines.push(`file '${paths[paths.length - 1]}'`);
  const listPath = join(dir, "frames.txt");
  writeFileSync(listPath, lines.join("\n") + "\n");
  return listPath;
}

function encode(listPath: string, out: string, fps: number) {
  const args = [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `fps=${fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-movflags", "+faststart",
    out,
  ];
  const res = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  if (res.status !== 0) throw new Error(`ffmpeg exited ${res.status}`);
}

async function startDevServer(port: number): Promise<() => void> {
  const bin = resolve("node_modules/.bin/vite");
  const child = spawn(bin, ["--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return () => child.kill("SIGTERM");
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error(`dev server did not start on ${url}`);
}

function parseArgs(argv: string[]) {
  let manifest: string | undefined;
  let base: string | undefined;
  let keepFrames = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--keep-frames") keepFrames = true;
    else if (!manifest) manifest = argv[i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!manifest) throw new Error("usage: makeClip.ts <manifest.json> [--base <url>] [--keep-frames]");
  return { manifest, base, keepFrames };
}

async function main() {
  const { manifest, base, keepFrames } = parseArgs(process.argv.slice(2));
  const clip = buildClip(manifest);
  const total = clip.frames.reduce((n, f) => n + f.durationMs, 0);
  process.stderr.write(`${clip.frames.length} frames, ${(total / 1000).toFixed(1)}s\n`);

  const baseUrl = base ?? clip.baseUrl;
  const stopServer = baseUrl ? null : await startDevServer(DEV_PORT);
  const dir = mkdtempSync(join(tmpdir(), "evoclip-"));
  try {
    const paths = await renderFrames(clip, baseUrl ?? `http://127.0.0.1:${DEV_PORT}/`, dir);
    await mkdir(dirname(clip.out), { recursive: true });
    encode(writeConcatList(dir, paths, clip.frames), clip.out, clip.fps);
    process.stderr.write(`${clip.out}\n`);
  } finally {
    stopServer?.();
    if (keepFrames) process.stderr.write(`frames kept in ${dir}\n`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`makeClip: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
