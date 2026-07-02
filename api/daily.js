// Returns today's pre-generated seed from Upstash KV.
// Falls back to nothing (caller handles the 404 and uses local data.js seeds).
module.exports = async (req, res) => {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: "KV not configured" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const key   = `sixdegrees:${today}`;

  try {
    const r    = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const body = await r.json();
    if (!body.result) return res.status(404).json({ error: "No seed for today" });

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json(JSON.parse(body.result));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
