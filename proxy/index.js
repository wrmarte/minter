// proxy/index.js
// ======================================================
// Lurker Proxy (Railway service) — multi-upstream DNS fallback
// - Proxies Reservoir calls so main bot can access them even if blocked
// - Secured with x-lurker-proxy-key header
//
// Endpoint:
//   GET /health
//   GET /reservoir?chain=<base|eth>&p=<urlencoded path starting with />
//
// Security:
//   Requires header: x-lurker-proxy-key === PROXY_KEY (env)
//
// Upstreams:
//   - Uses RESERVOIR_UPSTREAMS (comma-separated) if set
//   - Otherwise tries sensible defaults
// ======================================================

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = Number(process.env.PORT || 3000);

function s(v) { return String(v || "").trim(); }
function debugOn() { return String(process.env.LURKER_PROXY_DEBUG || "0").trim() === "1"; }

const PROXY_KEY = s(process.env.PROXY_KEY);
const RESERVOIR_API_KEY = s(process.env.RESERVOIR_API_KEY);

// Comma-separated list override
function getUpstreams(chain) {
  const env = s(process.env.RESERVOIR_UPSTREAMS);
  if (env) {
    return env
      .split(",")
      .map(x => s(x))
      .filter(Boolean)
      .map(x => x.replace(/\/+$/, ""));
  }

  // Defaults (ordered)
  // NOTE: api-base is sometimes available even when api.reservoir.tools DNS is flaky
  const list = [
    "https://api.reservoir.tools",
    "https://api-base.reservoir.tools",
    "https://api-ethereum.reservoir.tools",
  ];

  // Chain-specific prioritization
  const c = s(chain).toLowerCase();
  if (c === "base") {
    return ["https://api-base.reservoir.tools", ...list.filter(x => x !== "https://api-base.reservoir.tools")];
  }
  if (c === "eth" || c === "ethereum") {
    return ["https://api-ethereum.reservoir.tools", ...list.filter(x => x !== "https://api-ethereum.reservoir.tools")];
  }
  return list;
}

app.get("/health", (_req, res) => res.status(200).send("OK"));

app.get("/reservoir", async (req, res) => {
  try {
    const got = s(req.header("x-lurker-proxy-key"));
    if (!PROXY_KEY) return res.status(500).send("PROXY_KEY not set");
    if (!got || got !== PROXY_KEY) return res.status(401).send("Unauthorized");

    const chain = s(req.query.chain || "eth").toLowerCase();
    const p = String(req.query.p || "");

    if (!p.startsWith("/")) return res.status(400).send("Bad p (must start with /)");

    // Allowlist ONLY the endpoints your lurker uses
    const allowed =
      p.startsWith("/orders/asks/v5?") ||
      p.startsWith("/tokens/v6?");

    if (!allowed) return res.status(403).send("Blocked path");

    const headers = { accept: "application/json" };
    if (RESERVOIR_API_KEY) headers["x-api-key"] = RESERVOIR_API_KEY;

    // Reservoir chain headers
    if (chain === "base") {
      headers["x-chain-id"] = "8453";
      headers["x-chain"] = "base";
      headers["x-reservoir-chain"] = "base";
    } else if (chain === "eth" || chain === "ethereum") {
      headers["x-chain-id"] = "1";
      headers["x-chain"] = "ethereum";
      headers["x-reservoir-chain"] = "ethereum";
    }

    const upstreams = getUpstreams(chain);

    let lastErr = null;
    for (const base of upstreams) {
      const upstream = base + p;
      try {
        if (debugOn()) console.log(`[PROXY] try upstream=${base} path=${p.slice(0, 80)}`);

        const r = await fetch(upstream, { headers, timeout: 15000 });
        const body = await r.text();

        // If upstream responds, return it even if it’s a 4xx/5xx (so bot sees real error)
        if (debugOn()) console.log(`[PROXY] upstream=${base} status=${r.status}`);

        res.status(r.status);
        res.set("content-type", r.headers.get("content-type") || "application/json");
        return res.send(body);
      } catch (e) {
        lastErr = e;
        if (debugOn()) console.log(`[PROXY] upstream failed=${base} err=${e?.message || e}`);
        continue;
      }
    }

    return res.status(502).send(`All upstreams failed: ${lastErr?.message || lastErr || "unknown"}`);
  } catch (e) {
    return res.status(500).send(`Proxy error: ${e?.message || e}`);
  }
});

app.listen(PORT, () => {
  console.log(`🧿 Lurker proxy listening on :${PORT}`);
});
