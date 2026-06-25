# Top 50 Vietnamese Pop Music Videos

A Next.js 16 web app that displays the **top 50–100 most-viewed long-form Vietnamese pop music videos** on YouTube. Updates once per day via the YouTube Data API v3; results are cached in MongoDB so the page is fast and the API quota lasts.

![Stack](https://img.shields.io/badge/Next.js-16-black) ![Stack](https://img.shields.io/badge/React-19-61dafb) ![Stack](https://img.shields.io/badge/TypeScript-5-3178c6) ![Stack](https://img.shields.io/badge/MongoDB-7.1-47A248)

---

## What it does

- Fetches the most-viewed Vietnamese pop ("vpop") music videos from YouTube using **two search queries** in `regionCode=VN`:
  - `"vpop music videos"`
  - `"nhạc pop việt nam mv"`
- **Filters out YouTube Shorts** (anything ≤60 seconds via `contentDetails.duration` ISO 8601 parsing)
- Sorts by view count and caps at **100 videos**
- Renders **25 videos per page** with prev/next pagination
- **Hover any thumbnail** to play a muted in-place preview (400 ms hover delay; iframe embed)
- Click a card → opens the video on YouTube in a new tab

## How it stays fast and stays under quota

1. On request, the server checks **MongoDB** (`youtubeDailySnapshots` collection) for today's snapshot by date key (`YYYY-MM-DD`).
2. If found → serve from cache. No YouTube API call.
3. If not found → call YouTube (`search.list` × 2 queries × 5 pages + `videos.list` in batches of 50), filter / sort / cap, write the result back to MongoDB with the date key, then serve.
4. MongoDB has a **TTL index** (`expireAfterSeconds: 30 days`) on `createdAt` so old snapshots are pruned automatically.
5. If MongoDB is unavailable, the route falls back to a live YouTube fetch and continues — Mongo is best-effort cache, not a dependency.

Quota math: ~1010 YouTube units per cold load, run at most once per day → ~28 loads/day fits inside the default 10,000-unit free quota.

## Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router, Server Components, `force-dynamic`) |
| Language | TypeScript 5 |
| UI | React 19, Tailwind CSS 4 |
| Database | MongoDB 7.1 (official driver, no ORM) |
| External API | YouTube Data API v3 (`search.list`, `videos.list`) |
| Runtime | Node.js (`export const runtime = "nodejs"` on the API route — MongoDB driver requires it) |
| Hosting | Designed for Vercel |

## Architecture

```
                    ┌──────────────────────┐
   GET /            │ app/page.tsx         │ ← async Server Component
   (Server Component│   fetches /api/...   │
   on request)      │   renders <VideoCard>│
                    └────────┬─────────────┘
                             │ (fetch with cache: "no-store")
                             ▼
                    ┌──────────────────────────────────┐
   GET /api/        │ app/api/youtube/test/route.ts    │
   youtube/test     │   runtime = "nodejs"             │
                    │   1. Check Mongo for today       │
                    │   2. If miss: search × 2 queries │
                    │      → videos.list batches       │
                    │      → filter Shorts             │
                    │      → sort by viewCount         │
                    │      → cap at MAX_VIDEOS         │
                    │      → write snapshot to Mongo   │
                    │   3. Paginate (25/page) + return │
                    └────────┬─────────────────────────┘
                             │
                             ▼
                    ┌──────────────────────┐
                    │ MongoDB              │
                    │ youtubeDailySnapshots│ ← TTL index 30d on createdAt
                    └──────────────────────┘
```

Key files:

| File | Role |
|---|---|
| `app/page.tsx` | Server Component. Resolves `?page=N`, fetches the API, redirects on out-of-range pages. |
| `app/components/VideoCard.tsx` | Client Component. Thumbnail, rank badge, hover-preview iframe, formatted view/like counts. |
| `app/api/youtube/test/route.ts` | The orchestrator. ~270 lines: snapshot check → YouTube fetch → filter/sort/cap → snapshot write → pagination. |
| `lib/mongodb.ts` | Singleton MongoClient promise stashed on `globalThis` to survive HMR in dev. |

## Run locally

Prerequisites: Node 18+, a MongoDB connection string (Atlas free tier works), a YouTube Data API v3 key.

```bash
npm install
cp .env.local.example .env.local   # if you have the example file; otherwise create .env.local
# Add these to .env.local:
#   YOUTUBE_API_KEY=...
#   MONGODB_URI=mongodb+srv://...
npm run dev
# open http://localhost:3000
```

Full key-setup walkthrough is in [`docs/YOUTUBE_API_SETUP.md`](docs/YOUTUBE_API_SETUP.md) — covers creating the Google Cloud project, enabling YouTube Data API v3, creating + restricting the key, and adding it to Vercel.

## Deploy

1. Push to GitHub.
2. Import into Vercel.
3. Add `YOUTUBE_API_KEY` and `MONGODB_URI` to the project's environment variables (Production + Preview).
4. Deploy. The route runs on the Node.js runtime so the MongoDB driver works.

## Notes / design decisions

- **Two search queries** (English + Vietnamese) deliberately overlap to find more candidates. Results are deduped before the `videos.list` calls.
- **Long-form only** — Shorts are excluded because the "Top 50 music videos" framing implies full music videos, not 60-second clips.
- **`cache: "no-store"`** on the internal fetch from `page.tsx` → the rendered page is always fresh per request (the API route's MongoDB layer is what does the actual day-level caching).
- **Hover preview** uses `HOVER_DELAY_MS = 400` to avoid firing on accidental cursor sweeps; embed uses `?autoplay=1&mute=1` so it's iOS-Safari friendly.
- **Pagination is URL-state** — `/?page=2` is bookmarkable and shareable; redirect handles out-of-range page numbers so URL + content stay consistent.
- **No client API key exposure** — the key is read from `process.env.YOUTUBE_API_KEY` only in the API route. It never reaches the browser bundle.

## License

MIT.
