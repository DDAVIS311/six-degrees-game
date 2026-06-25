// Core game logic for Six Degrees — horizontal linear chain

const apiCache = {};

// TMDB profile photos consistently place the face in the upper ~40% of the image.
// object-fit:cover on a landscape cell already provides a tight crop by scaling to fill
// the width; anchoring at 20% from top reliably shows eyes+nose across all actors.
// No per-actor transform — dynamic actors would have no data and transforms make
// unknown photos catastrophically off-frame.
const FACE_ANCHOR = "50% 20%";

const GRAIN_BG = "url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%22100%22%20height=%22100%22%3E%3Cfilter%20id=%22n%22%3E%3CfeTurbulence%20type=%22fractalNoise%22%20baseFrequency=%220.85%22%20numOctaves=%222%22%20stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect%20width=%22100%22%20height=%22100%22%20filter=%22url(%23n)%22/%3E%3C/svg%3E')";

// Live split-flap counter handles — reset each time a new active frame is built
let sfTiles = [];
let sfValue = 0;

const gameState = {
  date: "",
  ladder: [],       // linear array of actors: [A, B, C, D ...]
  activePairs: [],  // [{actorA, actorB, status, id, film?, year?, options?}]
  score: 0,
  gameOver: false,
  usedFilmIds: new Set(), // films already used as correct answers this session
};

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(endpoint) {
  const url = `${CONFIG.BASE_URL}${endpoint}${endpoint.includes("?") ? "&" : "?"}api_key=${CONFIG.API_KEY}`;
  const cached = apiCache[url];
  if (cached && Date.now() - cached.fetchedAt < CONFIG.CACHE_TTL) return cached.data;
  let resp = await fetch(url);
  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
    resp = await fetch(url);
  }
  if (!resp.ok) throw new Error(`TMDb ${resp.status}: ${endpoint}`);
  const data = await resp.json();
  apiCache[url] = { data, fetchedAt: Date.now() };
  return data;
}

async function fetchActorData(id) {
  return apiFetch(`/person/${id}?append_to_response=movie_credits`);
}

function filterCredits(credits, minVotes = CONFIG.MIN_VOTE_COUNT) {
  if (!credits?.cast) return [];
  return credits.cast.filter(m =>
    !m.adult && !m.video &&
    m.vote_count > minVotes &&
    (m.order === undefined || m.order < CONFIG.MAX_CAST_ORDER) &&
    !m.genre_ids?.some(g => CONFIG.ADULT_GENRE_IDS.includes(g))
  );
}

function buildActorObj(person, credits) {
  const topFilm = credits.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  return {
    id: person.id,
    name: person.name,
    photo: person.profile_path ? `${CONFIG.IMG_BASE}${person.profile_path}` : null,
    knownFor: topFilm?.title || "",
  };
}

// ── Co-star discovery ─────────────────────────────────────────────────────────

async function fetchFilmCast(movieId) {
  const data = await apiFetch(`/movie/${movieId}/credits`);
  return (data.cast || []).filter(p => !p.adult && p.order < CONFIG.MAX_CAST_ORDER);
}

async function fetchCoStars(actorId, excludeIds = [], minVotes = CONFIG.MIN_VOTE_COUNT) {
  const person = await fetchActorData(actorId);
  if (person.adult) return [];
  // Sort by vote_count desc before slicing so we always look at the actor's
  // most widely-seen films first, not TMDB's arbitrary ordering.
  const credits = filterCredits(person.movie_credits, minVotes)
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
  const coStarMap = {};
  await Promise.all(credits.slice(0, 15).map(async film => {
    try {
      const cast = await fetchFilmCast(film.id);
      cast.forEach(p => {
        if (!excludeIds.includes(p.id) && p.id !== actorId && !coStarMap[p.id])
          coStarMap[p.id] = { ...p, popularity: p.popularity || 0 };
      });
    } catch (_) {}
  }));
  return Object.values(coStarMap).sort((a, b) => b.popularity - a.popularity);
}

async function pickNextCoStar(actorId, excludeIds, step = 0) {
  // Scale both actor pool width and film vote threshold by chain depth.
  // topN: narrow early so only popular co-stars get picked.
  // minVotes: high early so chains only go through well-known films.
  const topN     = step < 3 ? 5   : step < 6 ? 10 : 20;
  const minVotes = step < 3 ? 10000 : step < 6 ? 3000 : CONFIG.MIN_VOTE_COUNT;

  let pool = await fetchCoStars(actorId, excludeIds, minVotes);
  // Fall back to looser thresholds if the tighter filter yields nothing
  if (pool.length === 0) pool = await fetchCoStars(actorId, excludeIds, CONFIG.MIN_VOTE_COUNT);
  if (pool.length === 0) pool = await fetchCoStarsExpanded(actorId, excludeIds, 15);
  if (pool.length === 0) return null;
  // Pool is sorted by TMDB popularity desc; slice to the difficulty window.
  const top = pool.slice(0, Math.min(topN, pool.length));
  const pick = top[Math.floor(Math.random() * top.length)];
  const full = await fetchActorData(pick.id);
  if (full.adult) return null;
  return buildActorObj(full, filterCredits(full.movie_credits));
}

async function fetchCoStarsExpanded(actorId, excludeIds, orderLimit) {
  const person = await fetchActorData(actorId);
  const credits = (person.movie_credits?.cast || []).filter(m =>
    !m.adult && !m.video && m.vote_count > CONFIG.MIN_VOTE_COUNT &&
    (m.order === undefined || m.order < orderLimit)
  );
  const coStarMap = {};
  await Promise.all(credits.slice(0, 10).map(async film => {
    try {
      const data = await apiFetch(`/movie/${film.id}/credits`);
      (data.cast || []).filter(p => !p.adult && p.order < orderLimit).forEach(p => {
        if (!excludeIds.includes(p.id) && p.id !== actorId) coStarMap[p.id] = p;
      });
    } catch (_) {}
  }));
  return Object.values(coStarMap).sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

// ── Guess validation ──────────────────────────────────────────────────────────

function normalizeTitle(t) {
  return t.toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fuzzyMatch(guess, target) {
  const g = normalizeTitle(guess);
  const t = normalizeTitle(target);
  if (g === t) return true;
  if (t.includes(g) && g.length / t.length >= 0.8) return true;
  if (g.includes(t) && t.length / g.length >= 0.8) return true;
  return false;
}

async function validateGuess(actorAId, actorBId, guess) {
  const [dataA, dataB] = await Promise.all([fetchActorData(actorAId), fetchActorData(actorBId)]);
  const creditsA = filterCredits(dataA.movie_credits);
  const creditsB = filterCredits(dataB.movie_credits);
  const idsB = new Set(creditsB.map(m => m.id));
  const shared = creditsA.filter(m => idsB.has(m.id) && !gameState.usedFilmIds.has(m.id));
  const match = shared.find(m => fuzzyMatch(guess, m.title));
  if (match) return { correct: true, title: match.title, year: (match.release_date || "").slice(0, 4), filmId: match.id };
  return { correct: false, options: shared.slice(0, 3).map(m => m.title) };
}

// ── Game initialization ───────────────────────────────────────────────────────

function getTodaysSeed() {
  const today = new Date().toISOString().slice(0, 10);
  return DAILY_SEEDS.find(s => s.date === today) || DAILY_SEEDS[0];
}

async function initGame() {
  showLoading(true);
  try {
    const seed = getTodaysSeed();
    gameState.date = seed.date;

    const [dataA, dataB] = await Promise.all([
      fetchActorData(seed.actorA.id),
      fetchActorData(seed.actorB.id),
    ]);
    const actorA = buildActorObj(dataA, filterCredits(dataA.movie_credits));
    const actorB = buildActorObj(dataB, filterCredits(dataB.movie_credits));

    gameState.ladder = [actorA, actorB];
    gameState.activePairs = [{ actorA, actorB, status: "active", id: "pair-0" }];

    renderLadder();
    showFilmStrip(true);
    wireUniversalInput();
    pinGuessBarToKeyboard();

    // Pre-fetch next co-star for actorB (right end of the chain)
    fetchCoStars(actorB.id, gameState.ladder.map(a => a.id)).catch(() => {});
  } catch (err) {
    showError("Failed to load today's puzzle. Check your API key and try again.");
    console.error(err);
  } finally {
    showLoading(false);
  }
}

// ── Universal input ───────────────────────────────────────────────────────────

let submitDebounceTimer = null;

function wireUniversalInput() {
  const input = document.getElementById("universal-input");
  const btn   = document.getElementById("universal-submit");
  if (!input || !btn) return;

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") doUniversalSubmit();
  });
  btn.addEventListener("click", doUniversalSubmit);

}

// Resize body to the visual viewport height so the flex layout (header +
// film strip + guess bar) all shrink to fit the space above the keyboard.
// CSS viewport units (svh/dvh) do not respond to the software keyboard on
// iOS Safari — only the visualViewport API does.
function pinGuessBarToKeyboard() {
  if (!window.visualViewport) return;

  function update() {
    const vvp = window.visualViewport;
    // Move the body's top to match wherever iOS has panned the visual viewport,
    // and shrink height to the visible space above the keyboard.
    // Both must move together — height alone leaves the body behind the pan offset.
    document.body.style.top    = vvp.offsetTop  + "px";
    document.body.style.height = vvp.height     + "px";
  }

  window.visualViewport.addEventListener("resize", update);
  window.visualViewport.addEventListener("scroll", update);
  update();
}

function doUniversalSubmit() {
  if (submitDebounceTimer) return;
  if (gameState.gameOver) return;

  const input = document.getElementById("universal-input");
  const guess = input.value.trim();
  if (!guess) { shakeUniversalInput(); return; }

  // In the linear chain there is always exactly one active pair
  const pair = gameState.activePairs.find(p => p.status === "active");
  if (!pair) return;

  input.value = "";
  handleGuess(pair.id, guess);

  submitDebounceTimer = setTimeout(() => { submitDebounceTimer = null; }, CONFIG.DEBOUNCE_MS);
}

function shakeUniversalInput() {
  const input = document.getElementById("universal-input");
  if (!input) return;
  input.classList.add("shake");
  input.addEventListener("animationend", () => input.classList.remove("shake"), { once: true });
}

function setInputLoading(loading) {
  const input = document.getElementById("universal-input");
  const btn   = document.getElementById("universal-submit");
  if (input) input.disabled = loading;
  if (btn)   btn.disabled   = loading;
}

// ── Guess handling ────────────────────────────────────────────────────────────

async function handleGuess(pairId, guess) {
  if (gameState.gameOver) return;
  const pair = gameState.activePairs.find(p => p.id === pairId);
  if (!pair || pair.status !== "active") return;

  setInputLoading(true);
  try {
    const result = await validateGuess(pair.actorA.id, pair.actorB.id, guess);
    if (result.correct) await onCorrectGuess(pair, result);
    else onIncorrectGuess(pair, result);
  } catch (err) {
    console.error(err);
    showError("Connection error. Please try again.");
  } finally {
    setInputLoading(false);
  }
}

async function onCorrectGuess(pair, result) {
  pair.status = "solved";
  pair.film = result.title;
  pair.year = result.year;
  gameState.usedFilmIds.add(result.filmId);
  gameState.score += 1;
  updateScoreDisplay();
  renderPairSolved(pair);

  const excludeIds = gameState.ladder.map(a => a.id);
  const newActor = await pickNextCoStar(pair.actorB.id, excludeIds, gameState.score);

  if (!newActor) {
    checkGameOver();
    return;
  }

  gameState.ladder.push(newActor);
  const newPair = {
    actorA: pair.actorB,
    actorB: newActor,
    status: "active",
    id: `pair-${Date.now()}`,
  };
  gameState.activePairs.push(newPair);

  document.getElementById("ladder").appendChild(buildFilmFrame(newPair));
  scrollToActiveFrame();

  // Pre-fetch next co-star (non-blocking)
  fetchCoStars(newActor.id, [...excludeIds, newActor.id]).catch(() => {});
}

function onIncorrectGuess(pair, result) {
  pair.status = "failed";
  pair.options = result.options;
  renderPairFailed(pair);
  shakeUniversalInput();
  checkGameOver();
}

function checkGameOver() {
  const stillActive = gameState.activePairs.some(p => p.status === "active");
  if (!stillActive) {
    gameState.gameOver = true;
    setTimeout(() => renderGameOver(), 600);
  }
}

// ── Share text ────────────────────────────────────────────────────────────────

function buildShareText() {
  const names = gameState.ladder.map(a => a.name).join(" → ");
  return `Six Degrees — ${gameState.date}\nScore: ${gameState.score} 🎬\n${names}`;
}

async function copyShareText() {
  const text = buildShareText();
  try {
    await navigator.clipboard.writeText(text);
    showCopyConfirm();
  } catch (_) {
    prompt("Copy this:", text);
  }
}

// ── Grade helper ──────────────────────────────────────────────────────────────

function getGrade(score) {
  if (score <= 2)  return "Film student";
  if (score <= 5)  return "Cinephile";
  if (score <= 9)  return "Film critic";
  if (score <= 14) return "Arthouse regular";
  return "Kevin Bacon himself";
}

// ── UI rendering ──────────────────────────────────────────────────────────────

function renderLadder() {
  const container = document.getElementById("ladder");
  container.innerHTML = "";
  gameState.activePairs.forEach(pair => container.appendChild(buildFilmFrame(pair)));
  scrollToActiveFrame();
}

function buildFilmFrame(pair) {
  const frame = document.createElement("div");
  frame.className = `film-frame film-frame-${pair.status}`;
  frame.dataset.pairId = pair.id;

  if (pair.status === "solved")      buildSolvedContent(frame, pair);
  else if (pair.status === "failed") buildFailedContent(frame, pair);
  else                               buildActiveContent(frame, pair);

  return frame;
}

// ── Film frame structure helpers ──────────────────────────────────────────────

function buildPerfRow() {
  const row = document.createElement("div");
  row.className = "perf-row";
  for (let i = 0; i < 16; i++) row.appendChild(document.createElement("i"));
  return row;
}

function buildActorCell(actor, side) {
  const cell = document.createElement("div");
  cell.className = "actor-cell";

  if (actor.photo) {
    const img = document.createElement("img");
    img.alt = "";
    img.style.objectPosition = FACE_ANCHOR;
    img.src = actor.photo;
    img.onerror = () => { img.remove(); cell.appendChild(buildPhotoSVG()); };
    cell.appendChild(img);
  } else {
    cell.appendChild(buildPhotoSVG());
  }

  // Vignette — outer edge anchored per side
  const vig = document.createElement("div");
  vig.className = "cell-vig";
  const cx = side === "left" ? "42% 42%" : "58% 42%";
  vig.style.background = `radial-gradient(125% 78% at ${cx}, transparent 48%, rgba(8,6,4,0.6) 80%, #080604 100%)`;
  cell.appendChild(vig);

  const grain = document.createElement("div");
  grain.className = "cell-grain";
  grain.style.backgroundImage = GRAIN_BG;
  cell.appendChild(grain);

  const nameEl = document.createElement("div");
  nameEl.className = "actor-name";
  nameEl.textContent = actor.name;
  cell.appendChild(nameEl);

  return cell;
}

// ── Split-flap counter ────────────────────────────────────────────────────────

function makeSFHalf(part, isFlap) {
  const win = document.createElement("div");
  win.className = `sf-half ${part} ${isFlap ? "sf-flap" : "sf-static"}`;
  const g = document.createElement("div");
  g.className = "g";
  win.appendChild(g);
  win._g = g;
  return win;
}

function makeSFTile() {
  const tile = document.createElement("div");
  tile.className = "sf-tile";
  const staticTop    = makeSFHalf("top", false);
  const staticBottom = makeSFHalf("bottom", false);
  const flapFront    = makeSFHalf("top", true);
  const flapBack     = makeSFHalf("bottom", true);
  const hinge = document.createElement("div");
  hinge.className = "sf-hinge";
  tile.append(staticTop, staticBottom, flapFront, flapBack, hinge);
  tile._p = { staticTop, staticBottom, flapFront, flapBack };
  return tile;
}

function setSFDigit(tile, d) {
  const p = tile._p;
  p.staticTop._g.textContent = p.staticBottom._g.textContent = d;
  p.flapFront._g.textContent = p.flapBack._g.textContent = d;
  p.flapFront.style.transform = "rotateX(0deg)";
  p.flapBack.style.transform  = "rotateX(90deg)";
}

function flipSFTile(tile, oldD, newD) {
  const p = tile._p;
  p.staticTop._g.textContent    = newD;
  p.staticBottom._g.textContent = oldD;
  p.flapFront._g.textContent    = oldD;
  p.flapBack._g.textContent     = newD;
  p.flapFront.style.transform   = "rotateX(0deg)";
  p.flapBack.style.transform    = "rotateX(90deg)";

  const a1 = p.flapFront.animate(
    [{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }],
    { duration: 150, easing: "cubic-bezier(.36,0,.66,.2)", fill: "forwards" }
  );
  a1.onfinish = () => {
    p.flapFront.style.transform = "rotateX(-90deg)";
    const a2 = p.flapBack.animate(
      [{ transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }],
      { duration: 160, easing: "cubic-bezier(.34,.8,.5,1)", fill: "forwards" }
    );
    a2.onfinish = () => {
      p.staticBottom._g.textContent = newD;
      p.flapBack.style.transform  = "rotateX(90deg)";
      p.flapFront._g.textContent  = newD;
      p.flapFront.style.transform = "rotateX(0deg)";
    };
  };
}

function buildSFCounter(initialScore) {
  const counter = document.createElement("div");
  counter.className = "sf-counter";
  sfTiles = [makeSFTile(), makeSFTile()];
  const s = String(Math.max(0, Math.min(99, initialScore))).padStart(2, "0");
  sfTiles.forEach((t, i) => { setSFDigit(t, s[i]); counter.appendChild(t); });
  sfValue = initialScore;
  return counter;
}

// ── Frame content builders ────────────────────────────────────────────────────

// Active: Kodak perf rows + two actor cells + floating logo/counter plate
function buildActiveContent(frame, pair) {
  frame.appendChild(buildPerfRow());

  const win = document.createElement("div");
  win.className = "film-window";
  win.appendChild(buildActorCell(pair.actorA, "left"));
  win.appendChild(Object.assign(document.createElement("div"), { className: "cell-divider" }));
  win.appendChild(buildActorCell(pair.actorB, "right"));

  const plate = document.createElement("div");
  plate.className = "logo-plate";
  const logo = document.createElement("div");
  logo.className = "logo-6deg";
  logo.innerHTML = '6<span class="deg">°</span>';
  plate.appendChild(logo);
  plate.appendChild(buildSFCounter(gameState.score));
  win.appendChild(plate);

  frame.appendChild(win);
  frame.appendChild(buildPerfRow());
}

// Solved: actor cells + plate showing the connecting film title
function buildSolvedContent(frame, pair) {
  frame.appendChild(buildPerfRow());

  const win = document.createElement("div");
  win.className = "film-window";
  win.appendChild(buildActorCell(pair.actorA, "left"));
  win.appendChild(Object.assign(document.createElement("div"), { className: "cell-divider" }));
  win.appendChild(buildActorCell(pair.actorB, "right"));

  const plate = document.createElement("div");
  plate.className = "plate-info";
  const titleEl = document.createElement("div");
  titleEl.className = "plate-film-title";
  titleEl.textContent = `${pair.film}${pair.year ? `\n(${pair.year})` : ""}`;
  plate.appendChild(titleEl);
  win.appendChild(plate);

  frame.appendChild(win);
  frame.appendChild(buildPerfRow());
}

// Failed: actor cells + plate showing the answer hint
function buildFailedContent(frame, pair) {
  frame.appendChild(buildPerfRow());

  const win = document.createElement("div");
  win.className = "film-window";
  win.appendChild(buildActorCell(pair.actorA, "left"));
  win.appendChild(Object.assign(document.createElement("div"), { className: "cell-divider" }));
  win.appendChild(buildActorCell(pair.actorB, "right"));

  const plate = document.createElement("div");
  plate.className = "plate-info";
  const hint = pair.options?.length ? pair.options[0] : "No shared films";
  const msg = document.createElement("div");
  msg.className = "plate-failed-hint";
  msg.textContent = `✗  ${hint}`;
  plate.appendChild(msg);
  win.appendChild(plate);

  frame.appendChild(win);
  frame.appendChild(buildPerfRow());
}

function buildPhotoSVG() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 60 80");
  svg.setAttribute("fill", "none");
  const head = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  head.setAttribute("cx", "30"); head.setAttribute("cy", "24"); head.setAttribute("r", "14");
  head.setAttribute("fill", "#3A3A3A");
  const body = document.createElementNS("http://www.w3.org/2000/svg", "path");
  body.setAttribute("d", "M4 78c0-14.36 11.64-26 26-26s26 11.64 26 26");
  body.setAttribute("fill", "#3A3A3A");
  svg.appendChild(head);
  svg.appendChild(body);
  return svg;
}

// ── Incremental DOM updates ───────────────────────────────────────────────────

function renderPairSolved(pair) {
  const frame = document.querySelector(`[data-pair-id="${pair.id}"]`);
  if (!frame) { renderLadder(); return; }
  frame.className = "film-frame film-frame-solved";
  frame.innerHTML = "";
  buildSolvedContent(frame, pair);
}

function renderPairFailed(pair) {
  const frame = document.querySelector(`[data-pair-id="${pair.id}"]`);
  if (!frame) { renderLadder(); return; }
  frame.className = "film-frame film-frame-failed";
  frame.innerHTML = "";
  buildFailedContent(frame, pair);
}

function scrollToActiveFrame() {
  const container = document.getElementById("ladder");
  const active = container.querySelector(".film-frame-active");
  if (active) {
    container.scrollTo({ left: active.offsetLeft, behavior: "smooth" });
  }
}

// ── Keyboard navigation (arrow keys on desktop) ───────────────────────────────

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  const container = document.getElementById("ladder");
  if (!container) return;
  if (e.key === "ArrowRight") container.scrollBy({ left: container.offsetWidth, behavior: "smooth" });
  if (e.key === "ArrowLeft")  container.scrollBy({ left: -container.offsetWidth, behavior: "smooth" });
});

// ── Game over UI ──────────────────────────────────────────────────────────────

function renderGameOver() {
  // Hide the universal input bar
  const guessBar = document.getElementById("guess-bar");
  if (guessBar) guessBar.hidden = true;

  const overlay = document.getElementById("game-over");
  overlay.hidden = false;
  document.getElementById("final-score").textContent = gameState.score;
  document.getElementById("final-grade").textContent = getGrade(gameState.score);
  startMidnightCountdown();
  requestAnimationFrame(() => overlay.classList.add("visible"));
}

function startMidnightCountdown() {
  const el = document.getElementById("countdown");
  const tick = () => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const diff = midnight - now;
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    el.textContent = `${h}:${m}:${s}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ── Utility UI ────────────────────────────────────────────────────────────────

function showLoading(on) {
  document.getElementById("loading").hidden = !on;
}

function showFilmStrip(on) {
  document.getElementById("film-strip").hidden = !on;
  document.getElementById("guess-bar").hidden = !on;
}

function showError(msg) {
  const el = document.getElementById("error-msg");
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 5000);
}

function updateScoreDisplay() {
  if (!sfTiles.length) return;
  const next = Math.max(0, Math.min(99, gameState.score));
  const o = String(sfValue).padStart(2, "0");
  const n = String(next).padStart(2, "0");
  for (let i = 0; i < 2; i++) {
    if (o[i] !== n[i]) flipSFTile(sfTiles[i], o[i], n[i]);
  }
  sfValue = next;
}

function showCopyConfirm() {
  const btn = document.getElementById("share-btn");
  const orig = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = orig; }, 2000);
}

// Boot
document.addEventListener("DOMContentLoaded", initGame);
