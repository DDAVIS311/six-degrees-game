# Six Degrees

A daily browser-based trivia game inspired by Six Degrees of Kevin Bacon. Each day you get a pair of actors — name a film they both appeared in to extend the ladder. The game ends when you miss a connection on both ends. Your score is the total number of successful connections.

## Setup

### 1. Get a TMDb API key

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/signup)
2. Go to **Settings → API** and request an API key (Developer / Personal use)
3. Copy the **API Key (v3 auth)** value

### 2. Add your key

Open `config.js` and replace the placeholder:

```js
API_KEY: "YOUR_TMDB_API_KEY_HERE",
```

### 3. Run locally

Just open `index.html` in any modern browser — no server, no build step needed.

```
open sixdegrees/index.html
```

---

## Known beta limitations

- Scores are not saved between sessions (refresh = new game)
- Daily puzzle resets at midnight local time
- Some actor pairs may have fewer than expected shared films due to TMDb data gaps
- Very obscure actors may return no valid co-stars (the ladder end is skipped gracefully)

## Planned features (v2+)

- localStorage score persistence and streak tracking
- Leaderboard / daily comparison
- Hints system (costs a connection)
- Mobile PWA wrapper
- Auto-generated daily pairs via TMDb discovery (replacing the hand-curated seed list)
