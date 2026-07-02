// Vercel cron handler — picks a quality actor pair for today and stores it in Upstash KV.
// Protected by CRON_SECRET env var (Vercel passes this automatically for cron calls).
// Safe to call manually: POST /api/generate with Authorization: Bearer <secret>
module.exports = async (req, res) => {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const TMDB_KEY    = process.env.TMDB_API_KEY || "be1b9e9f3ef148e74a052a4805ac471f";
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: "KV not configured" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const key   = `sixdegrees:${today}`;

  // Idempotent — if today's seed already exists, return it
  const existing = await kvGet(REDIS_URL, REDIS_TOKEN, key);
  if (existing) return res.json({ ok: true, cached: true, seed: JSON.parse(existing) });

  // Curated pool of quality film actors (TMDB person IDs from hand-verified seeds)
  const ACTOR_POOL = [
    31, 112, 192, 287, 380, 500, 819, 1100, 1158, 1245,
    1327, 1333, 1813, 1892, 2037, 2231, 2524, 2632, 2888, 2975,
    3084, 3223, 3894, 4483, 4724, 5064, 6193, 6384, 6968, 7167,
    8167, 8784, 10182, 16828, 17419, 73457,
  ];

  let seed = null;

  for (let attempt = 0; attempt < 15 && !seed; attempt++) {
    // Pick a random anchor actor
    const actorAId = ACTOR_POOL[Math.floor(Math.random() * ACTOR_POOL.length)];

    let personA;
    try {
      personA = await tmdbFetch(`/person/${actorAId}?append_to_response=movie_credits`, TMDB_KEY);
    } catch (_) { continue; }
    if (personA.adult) continue;

    // Get their high-vote-count films (likely well-known theatrical releases)
    const films = (personA.movie_credits?.cast || [])
      .filter(m => !m.adult && !m.video && m.vote_count > 8000 && (m.order === undefined || m.order < 10))
      .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));

    if (films.length === 0) continue;

    // Pick randomly from the top 5 films (adds variety)
    const film = films[Math.floor(Math.random() * Math.min(5, films.length))];

    let castData;
    try {
      castData = await tmdbFetch(`/movie/${film.id}/credits`, TMDB_KEY);
    } catch (_) { continue; }

    const castCandidates = (castData.cast || [])
      .filter(p => !p.adult && p.id !== actorAId && (p.order === undefined || p.order < 10));

    for (const candidate of castCandidates) {
      let personB;
      try {
        personB = await tmdbFetch(`/person/${candidate.id}?append_to_response=movie_credits`, TMDB_KEY);
      } catch (_) { continue; }
      if (personB.adult) continue;

      // Film-career filter: must have ≥ 4 films with 5000+ votes (screens out TV actors)
      const filmCareer = (personB.movie_credits?.cast || []).filter(
        m => !m.adult && !m.video && m.vote_count > 5000 && (m.order === undefined || m.order < 10)
      );
      if (filmCareer.length < 4) continue;

      seed = {
        date: today,
        actorA: { id: actorAId,      name: personA.name },
        actorB: { id: candidate.id,  name: personB.name },
        sharedFilm: film.title,
      };
      break;
    }
  }

  if (!seed) return res.status(500).json({ error: "Could not generate a valid seed after 15 attempts" });

  // Store for 8 days so today's puzzle persists past midnight in all time zones
  await kvSet(REDIS_URL, REDIS_TOKEN, key, JSON.stringify(seed), 8 * 24 * 3600);
  res.json({ ok: true, seed });
};

// ── Upstash helpers ────────────────────────────────────────────────────────────

async function kvGet(url, token, key) {
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json();
  return body.result || null;
}

async function kvSet(url, token, key, value, ttlSeconds) {
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["SETEX", key, String(ttlSeconds), value]),
  });
}

// ── TMDB helper ────────────────────────────────────────────────────────────────

async function tmdbFetch(endpoint, apiKey) {
  const sep  = endpoint.includes("?") ? "&" : "?";
  const url  = `https://api.themoviedb.org/3${endpoint}${sep}api_key=${apiKey}`;
  const resp = await fetch(url);
  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 1500));
    const retry = await fetch(url);
    if (!retry.ok) throw new Error(`TMDB ${retry.status}: ${endpoint}`);
    return retry.json();
  }
  if (!resp.ok) throw new Error(`TMDB ${resp.status}: ${endpoint}`);
  return resp.json();
}
