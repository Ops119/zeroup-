/**
 * Public website + live demo (what Railway runs).
 *
 *   /            landing page
 *   /demo        live demo page
 *   /api/demo/status   demo readiness
 *   /api/demo/run      Server-Sent Events stream of one full demo run
 *   /healthz
 *
 * The demo stack (local chain, contracts, sponsor, facilitator, paid API)
 * runs inside this process on loopback-only ports; only this server is public.
 */
import path from "path";
import express, { type Request, type Response } from "express";
import { loadConfig } from "../config";
import { LiveDemo, type DemoEvent } from "../demo/live";
import { RateLimiter } from "../services/http";

const SITE = path.join(__dirname, "..", "..", "site");
const port = Number(process.env.PORT ?? 8080);
const runsPerHour = Number(process.env.DEMO_RUNS_PER_HOUR ?? 10);

const demo = new LiveDemo(loadConfig());
const limiter = new RateLimiter(runsPerHour, 3_600_000);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway terminates TLS in front of us

app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, demo: demo.status() });
});

app.get("/api/demo/status", (_req, res) => {
  res.json(demo.status());
});

app.get("/api/demo/run", async (req: Request, res: Response) => {
  if (!limiter.take(req.ip ?? "unknown")) {
    res.status(429).json({ error: `limit of ${runsPerHour} demo runs per hour reached, try again later` });
    return;
  }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let open = true;
  req.on("close", () => (open = false));
  const send = (e: DemoEvent) => {
    if (open) res.write(`data: ${JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
  };
  const keepAlive = setInterval(() => open && res.write(": ping\n\n"), 15_000);
  try {
    await demo.run(send);
  } catch (err) {
    send({ t: "error", msg: (err as Error).message });
  } finally {
    clearInterval(keepAlive);
    if (open) res.end();
  }
});

app.use(express.static(SITE, { extensions: ["html"], index: "index.html", maxAge: "1h" }));
app.use((_req, res) => res.redirect("/"));

app.listen(port, "0.0.0.0", () => {
  console.log(`Zeroup site on http://0.0.0.0:${port}`);
  void demo.boot((m) => console.log(m));
});
