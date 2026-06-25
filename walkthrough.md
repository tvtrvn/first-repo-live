# Top 50 Vietnamese Pop Music Videos — Complete Codebase Walkthrough

A comprehensive guide for engineers and curious users who want to understand every part of this Next.js application: what it does, how it works, where each piece lives, and what every term means.

---

## 1. Introduction

This is a single-page web app that surfaces the **top ~100 most-viewed long-form Vietnamese pop ("vpop") music videos** on YouTube, sorted descending by view count and paginated 25 per page. Hovering any thumbnail starts a muted in-place YouTube preview; clicking opens the actual YouTube watch page in a new tab.

What makes the project more than a toy:

- It is built on the **YouTube Data API v3**, which has a hard daily quota of 10,000 units. A single naive request from this app spends ~1,010 units. Without caching, ~10 page loads per day would burn the quota.
- The app therefore stores **one daily snapshot per UTC date** in **MongoDB**. After the first load of the day, every subsequent visitor reads from MongoDB and YouTube is not called at all.
- A **TTL index** on the snapshot's `createdAt` automatically prunes snapshots older than 30 days, so the collection never grows unboundedly.
- If MongoDB is unreachable in production, the route silently falls back to a live YouTube fetch — Mongo is best-effort cache, not a dependency.

The app is built with the **Next.js 16 App Router** and uses **Server Components by default**. The page (`app/page.tsx`) is a server-rendered React component that fetches `/api/youtube/test` on the server before sending HTML to the browser. The only **client** component is `VideoCard`, which needs `useState`/`useRef` for the hover-preview timing.

---

## 2. High-Level Architecture

```
                      Browser
                         |
                         | initial HTML request
                         v
              +------------------------+
              |  Next.js Server        |
              |                        |
              |  app/page.tsx          |  ← Server Component, runs per request
              |   (force-dynamic)      |
              |   reads ?page=N        |
              |   issues internal fetch|
              +-----------+------------+
                          |
                          | fetch(/api/youtube/test?page=N, cache:"no-store")
                          v
              +-----------+------------+
              |  app/api/youtube/test  |
              |     route.ts (Node)    |
              |                        |
              |  1. find today's       |
              |     snapshot in Mongo  |
              |  2. cache hit → return |
              |  3. cache miss →       |
              |     call YouTube API   |
              |     write snapshot     |
              |  4. paginate slice     |
              +---+----------------+---+
                  |                |
   getDb()        |                | https://www.googleapis.com/youtube/v3/...
                  v                v
        +-----------------+   +---------------------+
        |  MongoDB Atlas  |   |  YouTube Data API   |
        |  youtubeDaily   |   |  search.list +      |
        |  Snapshots      |   |  videos.list        |
        +-----------------+   +---------------------+
```

**Request lifecycle in plain English:**

1. User opens `https://<your-site>/` (or with `?page=2`, etc.).
2. Next.js executes `app/page.tsx` on the server. Because the route exports `dynamic = "force-dynamic"`, no static caching is attempted — the page is rendered fresh on every request.
3. `page.tsx` reconstructs its own absolute base URL from the request's `Host` header and calls `fetch(<base>/api/youtube/test?page=N)` with `cache: "no-store"`.
4. The API route (`route.ts`) runs on Node (not Edge — MongoDB driver requires Node). It:
   - Looks up `youtubeDailySnapshots` by today's `YYYY-MM-DD` UTC key.
   - On hit, returns the cached video list (no YouTube call).
   - On miss, runs two YouTube `search.list` queries × 5 paginated pages each → batches the resulting IDs through `videos.list` (50 per batch) for full metadata → filters Shorts (≤60s) → sorts by view count → caps at `MAX_VIDEOS` → upserts into Mongo.
5. Either way, the route paginates the array (25 per page) and returns JSON.
6. `page.tsx` receives the JSON, redirects if the requested page is out of range, and renders the `<VideoCard>` grid + pagination links as HTML.
7. The HTML reaches the browser fully rendered. Only `<VideoCard>` hydrates on the client (for the hover preview).

---

## 3. Tech Stack at a Glance

| Layer | Technology | Purpose |
|---|---|---|
| Framework | **Next.js 16** (App Router) | Server Components, file-system routing, API routes |
| Language | **TypeScript 5** | Type safety across the page, API route, and helpers |
| UI library | **React 19** | Component model |
| Styling | **Tailwind CSS 4** (PostCSS plugin) | Utility classes + CSS custom properties for theme |
| Fonts | **Geist Sans / Geist Mono** (via `next/font/google`) | Self-hosted Google fonts |
| Database | **MongoDB 7.1** (`mongodb` driver, no ORM) | Daily snapshot cache with a TTL index |
| External API | **YouTube Data API v3** | `search.list` + `videos.list` |
| Runtime | **Node.js** (`export const runtime = "nodejs"`) | API route — MongoDB driver isn't supported on Edge |
| Lint | ESLint 9 + `eslint-config-next` | Code style |
| Hosting | Vercel (designed for) | Both server-component pages and `nodejs` API routes |

There is no global state library, no form library, no separate auth — the app is publicly readable.

---

## 4. Project Layout

```
my-youtube-app/
├── app/
│   ├── layout.tsx              # Root layout: Geist fonts, <html>/<body>, metadata
│   ├── page.tsx                # Server Component: fetches API, renders grid + pagination
│   ├── globals.css             # Tailwind import + CSS custom properties (light/dark theme)
│   ├── components/
│   │   └── VideoCard.tsx       # Client Component: thumbnail, rank badge, hover preview
│   └── api/
│       └── youtube/
│           └── test/
│               └── route.ts    # Node API route: Mongo cache → YouTube → cache write → paginate
├── lib/
│   └── mongodb.ts              # Singleton MongoClient promise (HMR-safe)
├── docs/
│   └── YOUTUBE_API_SETUP.md    # Click-by-click Google Cloud setup
├── public/                     # Static assets (Next/Vercel SVGs — unused by the app)
├── next.config.ts              # (empty config)
├── tsconfig.json
├── postcss.config.mjs
├── eslint.config.mjs
├── .env.local                  # YOUTUBE_API_KEY + MONGODB_URI (gitignored)
├── package.json
└── README.md
```

There's one API route, one page, one shared client component, one Mongo helper. That's the entire surface area.

---

## 5. How to Run Locally

### Prerequisites

- **Node.js 18 or later** (Next 16 requires modern Node).
- A **YouTube Data API v3** key. Full step-by-step in `docs/YOUTUBE_API_SETUP.md`. Quick path: enable the API in Google Cloud → Credentials → Create API Key → restrict to YouTube Data API v3.
- A **MongoDB connection string**. The free tier of **MongoDB Atlas** works; you just need a `mongodb+srv://...` URI. The app calls `client.db()` with no name, so MongoDB will use whatever database is in the path of your URI (defaulting to `"test"` if you don't specify one).

### Setup

```bash
cd my-youtube-app
npm install
```

Create `.env.local` at the project root:

```bash
YOUTUBE_API_KEY=AIzaSy...your-key-here
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/yourdb?retryWrites=true&w=majority
```

> Important: `lib/mongodb.ts` **throws at module load time** if `MONGODB_URI` is missing or empty. If you want to develop without Mongo, you need to comment out that throw and accept that every page load will hit YouTube.

### Run

```bash
npm run dev
```

The dev server runs at `http://localhost:3000`. The first request of the day will:

1. Connect to MongoDB.
2. Issue ~10 YouTube API calls (`search.list` × 2 queries × 5 pages = 10, plus 1–2 `videos.list` batches).
3. Write today's snapshot to Mongo.
4. Render the page.

Subsequent loads on the same UTC day will hit only MongoDB.

### Production build

```bash
npm run build
npm start
```

`next start` runs the compiled output. Make sure the env vars are set in your shell or process manager.

---

## 6. How to Deploy

The repo is built for **Vercel** — Next.js's first-party host. Other hosts that support Node.js Next.js builds (Netlify, Railway, Fly, your own server) work too.

### Vercel

1. Push the repo to GitHub.
2. Go to <https://vercel.com> → **Add New Project** → import the repo.
3. Vercel auto-detects Next.js. No build settings to tweak.
4. In **Environment Variables**, add both `YOUTUBE_API_KEY` and `MONGODB_URI`. Set them on **Production**, **Preview**, and **Development** environments.
5. Deploy. Vercel runs the API route on its Node runtime (required because the MongoDB driver isn't Edge-compatible).

### MongoDB Atlas IP allowlist

Atlas requires you to allow the database server to be reached from the host. For Vercel, the simplest approach is to allow `0.0.0.0/0` (any IP) in the Atlas **Network Access** panel and rely on the username/password in the URI for security. For a stricter setup, use Vercel's static-IP feature on a paid plan.

### Google Cloud key restrictions

Once deployed, you can tighten the YouTube API key:

- **Application restrictions** → "HTTP referrers" with `*.your-domain.com/*` works for client-side usage, but this app calls the API from the server, so **leave as None** unless you also restrict by API.
- **API restrictions** → restrict to **YouTube Data API v3** only (recommended; prevents the key from working for unrelated Google APIs if leaked).

---

## 7. Code Deep-Dive

### 7.1 `app/layout.tsx` — root layout

```tsx
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = { title: "Top 50 Most Viewed Vietnamese Music Videos", ... };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
```

Two things to note:

- **`next/font/google`** downloads the Geist fonts at build time and self-hosts them. No external font request happens at runtime. The fonts are exposed via CSS variables (`--font-geist-sans`, `--font-geist-mono`) that `globals.css` references through `@theme inline`.
- **`metadata`** drives `<title>` and `<meta name="description">` automatically; no need for `<Head>`.

### 7.2 `app/page.tsx` — the home page (Server Component)

```ts
export const dynamic = "force-dynamic";
```

This route directive turns off Next.js's default static optimization. Every request runs the function fresh. Why: the data changes day-over-day (when a new snapshot is written), and we want the result to reflect the latest state in MongoDB, not a stale build-time HTML.

The function signature uses Next.js 15+'s "async searchParams":

```ts
export default async function Home({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const params = await searchParams;
  const requestedPage = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  ...
}
```

`searchParams` is a Promise in Next 15+ to support async-by-default semantics for dynamic params.

`getVideos(page)` reconstructs the API's absolute URL using the request's `Host` header:

```ts
const host = headersList.get("host") ?? "localhost:3000";
const protocol = process.env.NODE_ENV === "development" ? "http" : "https";
const base = `${protocol}://${host}`;
const res = await fetch(`${base}/api/youtube/test?page=${page}`, { cache: "no-store" });
```

This pattern means the server makes an HTTP call to its own API route. On Vercel that internal hop is fast (intra-region), and it keeps the page/route boundary clean: if you replaced the API route with a separate service, no code in `page.tsx` would change.

`cache: "no-store"` is critical: without it, Next 16 would aggressively cache the internal fetch and you'd serve stale pagination data.

The redirect-on-out-of-range logic:

```ts
if (!error && requestedPage > 1 && requestedPage > totalPages) {
  redirect(requestedPage === 2 ? "/" : `/?page=1`);
}
```

If the user bookmarks `/?page=5` but tomorrow's snapshot only has 3 pages, we send a 307 to `/?page=1` so the URL and content stay consistent. The `requestedPage === 2` branch sends them to `/` instead of `/?page=1` for a clean URL.

`rankOffset` computes the absolute video rank across pages so card #1 on page 2 shows "#26":

```ts
const rankOffset = pageNum * 25 - 25;
```

The render branches into three states: error, empty, and grid+pagination. The error path includes a friendly explanation about `YOUTUBE_API_KEY` because it's the most common misconfiguration.

The pagination nav is just `<Link>`s — Next.js handles client-side navigation; the server re-renders with the new page.

### 7.3 `app/components/VideoCard.tsx` — the only client component

```tsx
"use client";
```

This directive marks the file as a Client Component. Everything that uses `useState`, `useRef`, `useEffect`, or browser-only APIs has to be inside a `"use client"` boundary.

The card's behaviour:

- **Hover with delay.** `handleMouseEnter` starts a `setTimeout(..., 400ms)`. If the cursor leaves before the timeout fires, the timer is cleared and no preview opens. This prevents the preview from flashing every time the cursor swipes across the grid.
- **Preview iframe.** When the timer completes, `setShowPreview(true)` swaps in a YouTube embed with `autoplay=1&mute=1&controls=1&rel=0&modestbranding=1`. The `mute=1` is required for autoplay to work in Chrome and most browsers (autoplay-with-sound is blocked by default).
- **Click navigation.** The whole card is wrapped in `<Link>` to `https://www.youtube.com/watch?v={id}` with `target="_blank" rel="noopener noreferrer"`. `rel="noopener"` prevents the opened tab from accessing `window.opener` in the parent.
- **Rank badge.** When `rank` is provided, a small `#N` chip sits in the top-left of the thumbnail.
- **View/like formatting.** `formatViewCount` converts raw numbers to "1.2B" / "150.0M" / "3.4K".
- **Date formatting.** `formatDate` uses `Intl.DateTimeFormat` with `en-VN` locale.

A subtle bug-resistance choice: the timer ref is cleared inside `handleMouseLeave` so a fast in-and-out doesn't leave a pending timer that fires after the cursor is gone.

### 7.4 `app/api/youtube/test/route.ts` — the heart of the system

About 275 lines. Read this section if you want to understand how the quota math works out.

#### Setup

```ts
const API_KEY = process.env.YOUTUBE_API_KEY;
export const runtime = "nodejs";
```

`runtime = "nodejs"` is non-negotiable: the `mongodb` driver uses Node-only APIs (`net`, `tls`, `dns`) that don't exist in the Edge runtime.

Constants worth knowing:

| Constant | Value | Why |
|---|---|---|
| `PER_PAGE` | 25 | Page size returned to the frontend |
| `MAX_VIDEOS` | 100 | Cap on cached + paginated videos |
| `SEARCH_PAGES` | 5 | Pages of 50 IDs to pull from each search query |
| `SEARCH_QUERIES` | `["vpop music videos", "nhạc pop việt nam mv"]` | One English, one Vietnamese — both with `regionCode=VN` |
| `SHORTS_MAX_SECONDS` | 60 | Filter cutoff — Shorts are excluded |

#### `durationToSeconds(iso)`

YouTube returns durations as ISO 8601 (e.g., `PT1M30S`). This helper parses the `H`, `M`, `S` groups and converts to seconds so the route can drop anything ≤60s.

#### Step 1 — read today's UTC date key

```ts
const todayKey = new Date().toISOString().slice(0, 10); // "2026-05-18"
```

This is the deduplication key for snapshots. **Always UTC**, so two visitors in different timezones see the same snapshot on the same calendar day.

#### Step 2 — try Mongo cache

```ts
const db = await getDb();
snapshots = db.collection<SnapshotDoc>("youtubeDailySnapshots");
await snapshots.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
const existing = await snapshots.findOne({ date: todayKey });
if (existing && Array.isArray(existing.videos)) {
  videos = existing.videos;
}
```

Three things happening here:

- `createIndex({ createdAt: 1 }, { expireAfterSeconds: ... })` is the **TTL index**. MongoDB checks it every ~60s and deletes documents whose `createdAt` is older than 30 days. `createIndex` is idempotent — calling it on every request is cheap because the index already exists after the first call.
- The lookup is a single-key query on `date`. With many days of snapshots, you might add a `{ date: 1 }` index manually; for ~30 documents (one per day, 30-day TTL), the default scan is fine.
- The whole block is wrapped in `try/catch`. If Mongo is down in production, we log a warning and continue — `snapshots` stays `null`, the cache miss path runs as if no cache existed, and we just don't write afterwards.

#### Step 3 — cache miss path: hit YouTube

```ts
for (const query of SEARCH_QUERIES) {
  let pageToken: string | undefined;
  for (let p = 0; p < SEARCH_PAGES; p++) {
    const searchParams = new URLSearchParams({
      part: "snippet",
      type: "video",
      order: "viewCount",
      regionCode: "VN",
      q: query,
      maxResults: "50",
      key: API_KEY,
    });
    if (pageToken) searchParams.set("pageToken", pageToken);
    const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`, ...);
    ...
    pageToken = searchData.nextPageToken;
    if (!pageToken || pageIds.length === 0) break;
  }
}
```

A few design choices:

- **Two queries, deduplicated.** A single search will sometimes miss obvious hits because YouTube's index is fuzzy on language. Running both English and Vietnamese queries with `regionCode=VN` and merging is a cheap way to expand coverage. IDs are tracked in `seenIds` to skip duplicates.
- **`order: "viewCount"`** is the YouTube parameter that asks the API to return results sorted by views. We sort again client-side later because merged results from two queries aren't globally sorted.
- **`order: "viewCount"` + `regionCode: "VN"`** is what makes this Vietnam-specific. Without `regionCode`, the same query returns very different results in different countries.
- **`maxResults: "50"`** is the API's maximum per page.
- **`SEARCH_PAGES = 5`** caps at 250 IDs per query. With dedup, two queries typically give ~300–400 unique IDs.

If YouTube returns a non-OK response, the route checks `error.errors[0].reason`:

```ts
const message =
  reason === "quotaExceeded" ? "YouTube API quota exceeded. ..." :
  reason === "rateLimitExceeded" ? "YouTube API rate limit exceeded. ..." :
  "YouTube API error";
```

These messages flow back to the user as the error banner on the home page — far more useful than a generic 500.

#### Step 4 — `videos.list` in batches

`search.list` returns IDs + snippets only; it does **not** include `statistics` (view count, like count) or `contentDetails` (duration). You need `videos.list` for those, and `videos.list` accepts up to 50 IDs at a time:

```ts
for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
  const batchIds = videoIds.slice(i, i + BATCH_SIZE);
  const videosParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: batchIds.join(","),
    key: API_KEY,
  });
  const videosRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?${videosParams}`, ...);
  ...
}
```

Asking for three `part`s in one call is far cheaper than calling three separate endpoints — see the quota math below.

#### Step 5 — filter, sort, cap

```ts
internalVideos = internalVideos
  .filter(v => (v.durationSeconds ?? 0) > SHORTS_MAX_SECONDS)
  .sort((a, b) => Number(b.viewCount ?? 0) - Number(a.viewCount ?? 0))
  .slice(0, MAX_VIDEOS);
```

- **Filter Shorts.** Anything ≤60s is dropped. This is what makes the list "music videos" rather than "music videos + Shorts."
- **Sort by view count.** Numeric comparison after `Number(...)` coercion. Missing view counts (defaulting to 0) sink to the bottom.
- **Slice to MAX_VIDEOS.** Hard cap at 100. The displayed UI promises "Top 50" but the cache stores up to 100 so any future UI change can use the larger pool without re-querying YouTube.

Then `durationSeconds` is stripped before storage — it was only needed for the filter:

```ts
videos = internalVideos.map(({ durationSeconds: _d, ...rest }) => rest);
```

#### Step 6 — write back to Mongo

```ts
if (snapshots) {
  await snapshots.updateOne(
    { date: todayKey },
    { $set: { date: todayKey, videos, createdAt: new Date() } },
    { upsert: true }
  );
}
```

`upsert: true` makes this an idempotent write — if today's snapshot already exists (race condition with another concurrent request), the existing one is overwritten with the new computed result. The TTL clock resets via the fresh `createdAt`.

Any Mongo write failure is caught and logged; the response is still returned. Cache is best-effort.

#### Step 7 — paginate and respond

```ts
const totalCount = videos.length;
const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));
const page = Math.min(currentPage, totalPages);
const start = (page - 1) * PER_PAGE;
const paginatedVideos = videos.slice(start, start + PER_PAGE);

return NextResponse.json({
  success: true,
  count: paginatedVideos.length,
  videos: paginatedVideos,
  pagination: { page, totalPages, totalCount, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
});
```

The API does the slicing rather than dumping all 100 to the client. Saves a tiny bit of bandwidth, and `page.tsx`'s redirect logic upstream relies on `pagination.totalPages` to know when to bounce out-of-range URLs.

### 7.5 `lib/mongodb.ts` — singleton MongoClient

```ts
declare global {
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

let clientPromise: Promise<MongoClient>;

if (global._mongoClientPromise) {
  clientPromise = global._mongoClientPromise;
} else {
  const client = new MongoClient(uri);
  clientPromise = client.connect();
  global._mongoClientPromise = clientPromise;
}
```

This is the **Vercel-recommended pattern** for the MongoDB driver in Next.js. The reasoning:

- In **development**, Next's HMR (Hot Module Replacement) re-executes modules on every save. Without the global cache, each save would create a new `MongoClient`, leaking sockets until the process died.
- In **production** (one process per Lambda warm container on Vercel), the global also avoids opening a fresh client per request.

`global._mongoClientPromise` is the conventional name; the `declare global` block teaches TypeScript that the property exists.

### 7.6 `app/globals.css` — Tailwind + CSS variables

```css
@import "tailwindcss";

:root { /* light theme tokens */
  --background: #f8f9fb;
  --foreground: #1a1d24;
  --accent: #c2410c;
  --card-bg: #ffffff;
  ...
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

@media (prefers-color-scheme: dark) {
  :root { /* dark theme tokens */
    --background: #0f1115;
    ...
  }
}
```

Three patterns at play:

- **Tailwind 4 single-import.** No separate `@tailwind base/components/utilities` directives; just `@import "tailwindcss"`.
- **CSS custom properties (variables).** All semantic colors live as `--*` tokens. Components like `<VideoCard>` use them via `var(--card-bg)` either in `style={{}}` or as Tailwind arbitrary values like `bg-[var(--card-bg)]`.
- **`@theme inline`** is Tailwind 4's way of teaching Tailwind about your CSS variables so `bg-background` / `text-foreground` work as utilities.
- **`prefers-color-scheme: dark`** overrides every `--*` token for users whose OS prefers dark mode. No JS toggle needed.

`.line-clamp-2` is a small fallback in case the Tailwind plugin's `line-clamp-2` isn't enabled in your Tailwind version — it uses the (still widely supported) `-webkit-line-clamp` recipe.

---

## 8. YouTube API Quota Math

The free tier of YouTube Data API v3 includes **10,000 quota units per day**. Each endpoint costs different amounts:

| Endpoint | Cost | What we call it for |
|---|---|---|
| `search.list` | **100 units** | Find candidate video IDs |
| `videos.list` | **1 unit** | Fetch full metadata for known IDs |

**Cost per cold load:**

```
search.list: 2 queries × 5 pages × 100 = 1000 units
videos.list: ~300 IDs / 50 per batch = ~6 batches × 1 = ~6 units
Total: ~1006-1010 units
```

**Daily capacity:**

```
10,000 / 1010 = ~9.9 cold loads/day
```

That's why the MongoDB cache is essential: the *first* visitor of the day pays the ~1010-unit cost; every subsequent visitor that day pays **0 units** (Mongo hit). With the cache, the app can serve unlimited daily visitors while staying within free-tier quota.

If you need more, the Google Cloud Console has a "Quota Increase Request" form. For an internal portfolio project, 10k is plenty.

---

## 9. Data Flow End-to-End

Two scenarios.

### Scenario A — Cache hit (2nd+ visitor of the day)

```
Browser      page.tsx         route.ts         MongoDB         YouTube
   |            |                  |              |                 |
   |-- GET / -->|                  |              |                 |
   |            |-- fetch          |              |                 |
   |            |   /api/youtube/test?page=1 ---->|                 |
   |            |                  |-- findOne    |                 |
   |            |                  |   date=today |                 |
   |            |                  |------------->|                 |
   |            |                  |<-- doc ------|                 |
   |            |                  |   videos[]   |                 |
   |            |                  |-- paginate   |                 |
   |            |<-- JSON ---------|              |                 |
   |            |   videos[0..24]                 |                 |
   |            |   pagination                    |                 |
   |            |-- render HTML                   |                 |
   |<-- HTML ---|                                 |                 |
   |   25 cards |                                 |                 |
   |   hydrate VideoCard                          |                 |
```

Total external I/O: 1 round-trip to MongoDB. Latency under 200ms on Atlas free tier.

### Scenario B — Cache miss (first visitor of the day)

```
Browser      page.tsx         route.ts         MongoDB         YouTube
   |            |                  |              |                 |
   |-- GET / -->|                  |              |                 |
   |            |-- fetch /api/--->|              |                 |
   |            |                  |-- findOne -->|                 |
   |            |                  |<-- null -----|                 |
   |            |                  |              |                 |
   |            |                  |-- search.list q="vpop..." ---->|
   |            |                  |<-- 50 IDs ---|----------------|
   |            |                  |-- search.list pageToken ----->|
   |            |                  |    (×4 more pages)             |
   |            |                  |-- search.list q="nhạc..." ---->|
   |            |                  |    (×5 pages)                  |
   |            |                  |                                |
   |            |                  |-- videos.list ids batch 1 ---->|
   |            |                  |    (~6 batches of 50)          |
   |            |                  |                                |
   |            |                  |-- filter Shorts                |
   |            |                  |-- sort by views                |
   |            |                  |-- slice 100                    |
   |            |                  |                                |
   |            |                  |-- upsert ---->|                |
   |            |                  |    snapshot   |                |
   |            |                  |-- paginate    |                |
   |            |<-- JSON ---------|               |                |
   |            |-- render HTML    |               |                |
   |<-- HTML ---|                  |               |                |
```

Latency on cold load: 3–6 seconds, depending on YouTube response times. After this, today's cache is warm.

---

## 10. Plain-English Glossary

**App Router (Next.js):** The Next.js routing system that uses the `app/` directory; each folder is a route segment, `page.tsx` is the page component, `route.ts` is an API handler. Distinct from the older `pages/` router.

**API quota (YouTube):** A per-day budget of "units" allocated by Google. Each YouTube endpoint costs different units (search.list = 100, videos.list = 1). Free tier = 10,000 units/day.

**Cache hit / miss:** Hit = the data was already in MongoDB for today's date and was returned without calling YouTube. Miss = no snapshot existed and we had to call YouTube.

**Client Component:** A React component marked with `"use client"` at the top of the file. Runs in the browser, can use hooks, can attach event listeners.

**Cold load:** The first request after a cache eviction or after midnight UTC — pays the full ~1010-unit cost of calling YouTube end-to-end.

**`dynamic = "force-dynamic"`:** A Next.js route export that disables every form of caching and static optimization for the route. Forces fresh server execution on every request.

**Edge runtime vs Node runtime:** Next.js can run code in two environments. Edge is a lightweight, V8-isolate-based runtime that runs everywhere on Vercel's edge network. Node is the standard Node.js runtime; required for modules with native deps like `mongodb`. This app's API route uses Node.

**ISO 8601 duration:** A string format YouTube uses for video durations. `PT1M30S` = 1 minute 30 seconds. `PT45S` = 45 seconds. `PT1H10M5S` = 1 hour 10 minutes 5 seconds.

**Long-form vs Shorts:** YouTube classifies videos with duration ≤60s as Shorts. This app filters them out via the `durationToSeconds` helper.

**Page (in pagination):** A subset of the result list. 25 videos per page; up to 4 pages (100 videos cap). The URL `?page=2` requests page 2.

**`pageToken`:** YouTube's pagination cursor. Each `search.list` response includes a `nextPageToken` you pass to the next request to get the next 50 results.

**Rank offset:** `(page - 1) × 25`. Used to display absolute video ranks across pagination (#26 on page 2's first card, etc.).

**`regionCode=VN`:** YouTube parameter that asks the API to score results for Vietnam, surfacing the videos that Vietnam-based viewers most watch.

**Server Component:** A React component that renders on the server only. No client JS for that component is shipped to the browser. The default for files inside `app/` unless you opt in with `"use client"`.

**`searchParams` Promise:** In Next 15+, query-string params (`?page=2`) are passed to page components as a `Promise<>` so you can opt into async semantics. You `await` it before reading fields.

**Snapshot (Mongo doc):** A row in `youtubeDailySnapshots` with shape `{ date: "YYYY-MM-DD", videos: [...], createdAt: Date }`. One per UTC date.

**TTL index:** An index on a date field that tells MongoDB to delete documents whose value is older than `expireAfterSeconds`. Runs in the background every ~60s.

**`upsert: true`:** A MongoDB write flag — if the matching document exists, update it; otherwise insert a new one. Makes the write idempotent under race conditions.

**UTC date key:** A string like `"2026-05-18"` derived from `new Date().toISOString().slice(0, 10)`. Always UTC so timezone doesn't affect which snapshot is fresh.

**`videos.list` part:** A comma-separated list of metadata sections to fetch (`snippet`, `statistics`, `contentDetails`). Asking for more parts in one call is cheaper than calling once per part.

---

## 11. Common Tasks

### Change the search queries

Edit `SEARCH_QUERIES` at the top of `app/api/youtube/test/route.ts`:

```ts
const SEARCH_QUERIES = ["k-pop music videos", "K-Pop MV"]; // for K-pop instead
```

You probably also want to change `regionCode` (`"KR"` for Korea, etc.). Restart the dev server after editing.

### Change the page size

Two places have to agree:

```ts
const PER_PAGE = 25;  // in route.ts
```

And in `page.tsx`:

```ts
const rankOffset = pageNum * 25 - 25;  // change the 25
```

(Or compute it from the pagination response: `rankOffset = (pageNum - 1) * PER_PAGE` if you also send `PER_PAGE` back in the response.)

### Show Shorts too

Comment out the filter in `route.ts`:

```ts
// internalVideos = internalVideos.filter(v => (v.durationSeconds ?? 0) > SHORTS_MAX_SECONDS);
```

Then either bump `MAX_VIDEOS` so Shorts don't crowd out the long-form list, or accept that the top 100 might now be Shorts-heavy.

### Cache for longer than 1 day

The snapshot key is `todayKey` (UTC date). To cache for, say, a full week, you'd change `todayKey` to bucket by ISO week. The TTL index (`expireAfterSeconds: 30 days`) is the deletion clock; it's independent of the lookup key.

### Add view-count history charts

You'd want a *different* collection — `youtubeVideoHistory` — that records `{ videoId, date, viewCount, likeCount }` rows per day. Write to it from the cache-miss branch (when fresh stats arrive from YouTube). Then add a route like `GET /api/videos/:id/history` and a Recharts component on a dedicated video page.

### Replace MongoDB with another store

The cache contract is small: `findOne({ date: todayKey })` and `updateOne({ date: todayKey }, ..., { upsert: true })`. A KV store like Vercel KV, Upstash Redis, or even SQLite with a single `snapshots(date PRIMARY KEY, json TEXT, created_at INTEGER)` table can substitute. Replace the contents of `lib/mongodb.ts` and the cache calls in `route.ts`.

### Switch to dark mode by default

Either flip the OS preference (system-level), or change `globals.css` to make dark the default and put light inside a media query:

```css
:root { /* dark tokens directly */ }
@media (prefers-color-scheme: light) { :root { /* light tokens */ } }
```

### Add a "refresh now" button (admin)

Cheap version: an authenticated `POST /api/youtube/test/refresh` that deletes `snapshots.findOne({ date: todayKey })` and lets the next GET rebuild. Real version: add a header check (e.g., `X-Admin-Token`) so randoms can't trigger the YouTube spend.

---

## 12. Troubleshooting

**"YOUTUBE_API_KEY is not configured" banner on the home page.**

The route checks for `process.env.YOUTUBE_API_KEY` and also rejects the literal placeholder `paste_your_api_key_here`. Make sure `.env.local` contains a real key, and **restart the dev server** — Next picks up env changes only on (re)start.

**"YouTube API quota exceeded."**

You hit the 10,000-unit daily limit. Options:

- Wait until 00:00 Pacific Time (the YouTube quota reset).
- Request a quota increase in Google Cloud Console.
- Verify the cache is actually working — open the API route in DevTools and check whether subsequent requests still call YouTube. They shouldn't.

**"YouTube API rate limit exceeded."**

You're hammering the API too fast. The cache normally prevents this; if you see it during development, you probably have HMR re-running the route on every save. The `next: { revalidate: 3600 }` hint Next sees on each `fetch` call helps, but the canonical fix is to be cache-hitting.

**`MONGODB_URI is not configured` thrown at startup.**

`lib/mongodb.ts` throws if the env var is missing. Even if you don't want Mongo, the import chain pulls it in. Either set `MONGODB_URI` or temporarily comment out the throw.

**Mongo connection times out on Vercel.**

Your Atlas Network Access policy is blocking Vercel's IP. Open Atlas → Network Access → add `0.0.0.0/0` (allow from anywhere) and rely on the URI's username/password for auth.

**Hover preview never starts / is stuck on the thumbnail.**

The iframe needs `autoplay=1&mute=1` to start playing without a click. Some browsers (notably iOS Safari) ignore even that if the user hasn't interacted with the page. Tap the card once; subsequent hovers should preview.

**Hover preview plays audio.**

It shouldn't — the embed URL has `mute=1`. If audio is playing, you might have edited `embedUrl` to remove that param or your browser is overriding it. Reload with DevTools open and verify the iframe src.

**Pagination link goes to `/?page=5` but lands on `/?page=1`.**

That's the intentional `redirect()` in `page.tsx` for out-of-range pages. If the snapshot only has 100 videos = 4 pages, page 5 doesn't exist and we bounce you to page 1. Bookmarking deep links works fine while they're in range.

**Card titles are mis-cropped or overflow.**

`.line-clamp-2` truncates to two lines via the `-webkit-line-clamp` trick. If the trick isn't applied (some older browsers, some test environments), the title flows naturally. The fallback CSS class is defined in `globals.css` if Tailwind's `line-clamp` plugin isn't active.

**`Module not found: Can't resolve 'mongodb'`** in production.**

The API route uses Node-only modules. If you accidentally set `runtime = "edge"`, that breaks. Confirm `export const runtime = "nodejs";` is present.

**Build fails on Vercel: `MONGODB_URI is not configured`.**

The throw runs during `next build` (because the module is imported during route compilation). Add the env vars to **Production** *and* the **Preview** environment in Vercel — both are needed for the build to succeed for PR deploys.

**`Hydration failed because the initial UI does not match what was rendered on the server`.**

Almost always caused by `new Date().toLocaleDateString(...)` in a Server Component when the server and client are in different timezones, or by a `Math.random()`-based render. `VideoCard` calls `toLocaleDateString` only on the client (the file is `"use client"`), so it should be safe. If you see this, look for date-formatting calls in `page.tsx` and move them into a client component.
