import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  maxLife: number;
  radius: number;
}

interface Rocket {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetY: number;
  color: string;
  radius: number;
}

const COLORS = ["#ff5252", "#ffab40", "#ffe14d", "#69f0ae", "#40c4ff", "#7c4dff", "#ff4dd8"];

const DURATION_MS = 4500;
const FADE_MS = 800;

export function Fireworks({
  onDone,
  launchX,
  launchY,
}: {
  onDone: () => void;
  launchX?: number;
  launchY?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    // Where rockets launch from — the bottom center of the board, not the page.
    const baseY = launchY ?? height;
    const baseX = launchX ?? width / 2;
    // Scale everything up on large/high-density screens so explosions read
    // clearly instead of shrinking to a speck in a big viewport.
    let scale = Math.max(1.4, Math.min(width, height) / 500);
    const dpr = window.devicePixelRatio || 1;

    function applySize() {
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    applySize();

    const handleResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      scale = Math.max(1, Math.min(width, height) / 700);
      applySize();
    };
    window.addEventListener("resize", handleResize);

    const rockets: Rocket[] = [];
    const particles: Particle[] = [];
    const startTime = performance.now();
    let lastLaunch = 0;
    let rocketsLaunched = 0;
    let rafId = 0;

    function launchRocket() {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      rockets.push({
        x: baseX + (Math.random() - 0.5) * width * 0.3,
        y: baseY,
        vx: (Math.random() - 0.5) * 1.5 * scale,
        vy: -(height * 0.008 + Math.random() * height * 0.0035),
        targetY: height * (0.1 + Math.random() * 0.3),
        color,
        radius: 4.5 * scale,
      });
    }

    function explode(x: number, y: number, color: string) {
      const count = 22 + Math.floor(Math.random() * 12);
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.2;
        const speed = (2.5 + Math.random() * 6.5) * scale;
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color,
          life: 0,
          maxLife: 60 + Math.random() * 40,
          radius: (3 + Math.random() * 2.2) * scale,
        });
      }
    }

    function frame(now: number) {
      const elapsed = now - startTime;
      ctx!.clearRect(0, 0, width, height);

      // First three rockets go up almost together (~60ms apart) for an
      // opening salvo, then the rest trickle out at the normal cadence.
      const launchGap = rocketsLaunched < 3 ? 60 : 400 + Math.random() * 300;
      if (elapsed < DURATION_MS - 800 && now - lastLaunch > launchGap) {
        launchRocket();
        lastLaunch = now;
        rocketsLaunched += 1;
      }

      ctx!.shadowBlur = 18 * scale;
      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.x += r.vx;
        r.y += r.vy;
        ctx!.shadowColor = r.color;
        ctx!.beginPath();
        ctx!.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
        ctx!.fillStyle = r.color;
        ctx!.fill();
        if (r.y <= r.targetY) {
          explode(r.x, r.y, r.color);
          rockets.splice(i, 1);
        }
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += 1;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.045 * scale;
        p.vx *= 0.99;
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }
        const alpha = 1 - p.life / p.maxLife;
        ctx!.shadowColor = p.color;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx!.fillStyle = p.color;
        ctx!.globalAlpha = alpha;
        ctx!.fill();
        ctx!.globalAlpha = 1;
      }
      ctx!.shadowBlur = 0;

      if (elapsed < DURATION_MS) {
        rafId = requestAnimationFrame(frame);
      }
    }

    rafId = requestAnimationFrame(frame);
    const doneTimer = setTimeout(onDone, DURATION_MS + FADE_MS);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(doneTimer);
      window.removeEventListener("resize", handleResize);
    };
  }, [onDone]);

  return (
    <canvas
      ref={canvasRef}
      className="fireworks-overlay"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9999,
        animation: `fireworks-fade-out ${FADE_MS}ms ease-out ${DURATION_MS}ms forwards`,
      }}
    />
  );
}
