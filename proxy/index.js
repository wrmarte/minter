// proxy/index.js
// ======================================================
// Lurker Proxy (Railway service)
// - Proxies Reservoir calls so main bot can access them even if blocked
// - Secured with x-lurker-proxy-key header
//
// Endpoint:
//   GET /health
//   GET /reservoir?chain=<base|eth>&p=<urlencoded path starting with />
//
// Example:
//   /reservoir?chain=base&p=%2Forders%2Fasks%2Fv5%3Fcontracts%3D0x...%26limit%3D20
// ======================================================

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = Number(process.env.PORT || 3000);

function s(v) { return String(v || "").trim(); }

const PROXY_KEY = s(process.env.PROXY_KEY);
const RESERVOIR_API_KEY = s(process.env.RESERVOIR_API_KEY);

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

    const upstream = "https://api.reservoir.tools" + p;

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

    const r = await fetch(upstream, { headers });
    const body = await r.text();

    res.status(r.status);
    res.set("content-type", r.headers.get("content-type") || "application/json");
    return res.send(body);
  } catch (e) {
    return res.status(500).send(`Proxy error: ${e?.message || e}`);
  }
});

app.listen(PORT, () => {
  console.log(`🧿 Lurker proxy listening on :${PORT}`);
});
