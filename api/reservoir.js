// Vercel Serverless Function: /api/reservoir
// Usage:
//   /api/reservoir?chain=base&p=/orders/asks/v5?contracts=...&limit=...
//
// Security:
//   Requires header: x-lurker-proxy-key === PROXY_KEY (env)

export default async function handler(req, res) {
  try {
    const want = (process.env.PROXY_KEY || "").trim();
    const got = (req.headers["x-lurker-proxy-key"] || "").trim();

    if (!want) return res.status(500).send("PROXY_KEY not set");
    if (got !== want) return res.status(401).send("Unauthorized");

    const chain = String(req.query.chain || "eth").toLowerCase();
    const p = String(req.query.p || "");

    if (!p.startsWith("/")) return res.status(400).send("Bad p (must start with /)");
    const allowed = p.startsWith("/orders/asks/v5?") || p.startsWith("/tokens/v6?");
    if (!allowed) return res.status(403).send("Blocked path");

    const upstream = "https://api.reservoir.tools" + p;

    const headers = { accept: "application/json" };
    if (process.env.RESERVOIR_API_KEY) headers["x-api-key"] = process.env.RESERVOIR_API_KEY;

    if (chain === "base") {
      headers["x-chain-id"] = "8453";
      headers["x-chain"] = "base";
      headers["x-reservoir-chain"] = "base";
    } else if (chain === "eth" || chain === "ethereum") {
      headers["x-chain-id"] = "1";
      headers["x-chain"] = "ethereum";
      headers["x-reservoir-chain"] = "ethereum";
    } else if (chain === "ape") {
      // If Reservoir doesn’t support Ape, this won’t help for ape listings.
      // We keep it for future-proofing.
      headers["x-chain"] = "apechain";
    }

    const r = await fetch(upstream, { headers });
    const txt = await r.text();

    res.status(r.status);
    res.setHeader("content-type", r.headers.get("content-type") || "application/json");
    return res.send(txt);
  } catch (e) {
    return res.status(500).send(`Proxy error: ${e?.message || e}`);
  }
}
