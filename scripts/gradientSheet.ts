/**
 * Writes a sheet of card gradients, one swatch per seed, so a clip can pick a
 * `titleGradient` or `endGradient` seed by eye rather than by guessing.
 * See `docs/clip-tool-spec.md`.
 *
 *   npx esbuild scripts/gradientSheet.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=scripts/gradientSheet.bundle.mjs
 *   node scripts/gradientSheet.bundle.mjs [count] [--from N] [--out path]
 *
 * Swatches are shaped and typeset like the real title card, so what you judge
 * is what you get. Click one to copy its seed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cardGradient } from "./lib/clipManifest";

const DEFAULT_OUT = "clips/out/gradients.html";

function parseArgs(argv: string[]) {
  let count = 100;
  let from = 1;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") from = Number(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i];
    else count = Number(argv[i]);
  }
  if (!Number.isInteger(count) || count < 1) throw new Error(`bad count: ${count}`);
  if (!Number.isInteger(from)) throw new Error(`bad --from: ${from}`);
  return { count, from, out };
}

const STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 28px; background: #101114; color: #e8e8ea;
    font: 15px/1.5 system-ui, -apple-system, sans-serif;
  }
  h1 { font-size: 19px; margin: 0 0 4px; }
  p { margin: 0 0 24px; color: #9a9aa2; }
  code { background: #1d1f24; padding: 2px 6px; border-radius: 5px; }
  .grid {
    display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
  .swatch {
    aspect-ratio: 9 / 16; border-radius: 14px; position: relative; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; padding: 12px; box-sizing: border-box; text-align: center;
    border: none; font: inherit; color: #fff;
  }
  .swatch:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
  .title {
    font: 700 15px/1.2 system-ui, sans-serif; letter-spacing: -0.02em;
    text-shadow: 0 2px 18px rgba(0, 0, 0, 0.3);
  }
  .glyph { font-size: 46px; line-height: 1; text-shadow: 0 2px 18px rgba(0, 0, 0, 0.3); }
  .seed {
    position: absolute; top: 8px; left: 8px; padding: 2px 7px; border-radius: 7px;
    background: rgba(10, 10, 12, 0.62); font: 600 12px system-ui, sans-serif;
    letter-spacing: 0.02em;
  }
  #toast {
    position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
    background: #22aa77; color: #06130d; padding: 9px 16px; border-radius: 9px;
    font-weight: 600; opacity: 0; transition: opacity 140ms ease; pointer-events: none;
  }
  #toast.on { opacity: 1; }
`;

const SCRIPT = `
  const toast = document.getElementById("toast");
  let timer;
  document.querySelectorAll(".swatch").forEach((el) => {
    el.addEventListener("click", async () => {
      const seed = el.dataset.seed;
      const text = '"titleGradient": ' + seed;
      try { await navigator.clipboard.writeText(text); } catch { /* file:// may block it */ }
      toast.textContent = "copied  " + text;
      toast.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => toast.classList.remove("on"), 1300);
    });
  });
`;

function main(): void {
  const { count, from, out } = parseArgs(process.argv.slice(2));
  const swatches = Array.from({ length: count }, (_, i) => {
    const seed = from + i;
    return (
      `<button class="swatch" data-seed="${seed}" style="background:${cardGradient(seed)}">` +
      `<span class="seed">${seed}</span>` +
      `<span class="title">Situation critical…</span>` +
      `<span class="glyph">♟</span>` +
      `</button>`
    );
  }).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clip card gradients</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Clip card gradients</h1>
<p>Seeds ${from} to ${from + count - 1}. Click a swatch to copy its seed, then paste into a manifest as <code>"titleGradient": N</code> or <code>"endGradient": N</code>.</p>
<div class="grid">
${swatches}
</div>
<div id="toast"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;

  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  process.stderr.write(`${path}\n`);
}

try {
  main();
} catch (e) {
  console.error(`gradientSheet: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
