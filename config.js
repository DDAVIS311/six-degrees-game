// TMDb API key and global constants
const CONFIG = {
  API_KEY: "be1b9e9f3ef148e74a052a4805ac471f",
  BASE_URL: "https://api.themoviedb.org/3",
  IMG_BASE: "https://image.tmdb.org/t/p/w185",
  CACHE_TTL: 600000,       // 10 minutes in ms
  MAX_CAST_ORDER: 10,      // top-billed only
  MIN_VOTE_COUNT: 100,
  ADULT_GENRE_IDS: [10749],
  DEBOUNCE_MS: 300,
  RETRY_DELAY_MS: 1000,
};
