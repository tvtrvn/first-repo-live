import type { Collection } from "mongodb";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/mongodb";

const API_KEY = process.env.YOUTUBE_API_KEY;

// Ensure this route runs on the Node.js runtime (required for MongoDB driver)
export const runtime = "nodejs";

/** Parse ISO 8601 duration (e.g. PT1M30S, PT45S) to seconds. Shorts are ≤60s. */
function durationToSeconds(iso?: string): number {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

const SHORTS_MAX_SECONDS = 60; // Shorts are ≤60s
const PER_PAGE = 25;
// const MAX_VIDEOS = 100; // 50 videos = 2 pages; long-form only
const MAX_VIDEOS = 100;
// 2 queries × 5 pages ≈ 1010 units/load → ~28 loads/day on 10k quota; long-form only
const SEARCH_PAGES = 5;
const SEARCH_QUERIES = ["vpop music videos", "nhạc pop việt nam mv"];

export async function GET(request: Request) {
  if (!API_KEY || API_KEY === 'paste_your_api_key_here') {
    return NextResponse.json(
      { error: 'YOUTUBE_API_KEY is not configured. Add your key to .env.local' },
      { status: 500 }
    );
  }

  try {
    const url = new URL(request.url);
    const pageParam = url.searchParams.get('page');
    const currentPage = Math.max(1, parseInt(pageParam ?? '1', 10) || 1);

    // Determine today's key (UTC date, e.g. "2026-02-03")
    const todayKey = new Date().toISOString().slice(0, 10);

    type SnapshotVideo = {
      id: string;
      title?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnailUrl?: string;
      viewCount?: string;
      likeCount?: string;
    };
    type SnapshotDoc = { date: string; videos: SnapshotVideo[]; createdAt: Date };
    let videos: SnapshotVideo[] | null = null;
    let snapshots: Collection<SnapshotDoc> | null = null;

    // Try MongoDB snapshot cache first. If Mongo is down in production, continue without cache.
    try {
      const db = await getDb();
      snapshots = db.collection<SnapshotDoc>("youtubeDailySnapshots");
      // TTL index so old snapshots are pruned automatically (e.g. keep ~30 days)
      await snapshots.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
      const existing = await snapshots.findOne({ date: todayKey });
      if (existing && Array.isArray(existing.videos)) {
        videos = existing.videos;
      }
    } catch (mongoErr) {
      console.warn("Mongo snapshot unavailable, falling back to direct YouTube fetch:", mongoErr);
    }

    if (videos) {
      // Use cached snapshot (no YouTube API calls)
      // videos already assigned from snapshot
    } else {
      // No snapshot for today yet: fetch from YouTube once, store in MongoDB, and use that for the rest of the day

      // 1) Fetch multiple search queries and merge (dedupe) to get enough candidates for long-form videos
      const seenIds = new Set<string>();
      const videoIds: string[] = [];

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

          const searchRes = await fetch(
            `https://www.googleapis.com/youtube/v3/search?${searchParams}`,
            { next: { revalidate: 3600 } }
          );
          if (!searchRes.ok) {
            const error = await searchRes.json().catch(() => ({}));
            const reason = (error as any)?.error?.errors?.[0]?.reason;
            const message =
              reason === "quotaExceeded"
                ? "YouTube API quota exceeded. Try again tomorrow or increase quota in Google Cloud Console."
                : reason === "rateLimitExceeded"
                  ? "YouTube API rate limit exceeded. Please try again in a few minutes."
                  : "YouTube API error";
            return NextResponse.json(
              { error: message, details: error },
              { status: searchRes.status }
            );
          }
          const searchData = await searchRes.json();
          const pageIds = (searchData.items ?? [])
            .map((item: { id?: { videoId?: string } }) => item.id?.videoId)
            .filter(Boolean) as string[];
          for (const id of pageIds) {
            if (!seenIds.has(id)) {
              seenIds.add(id);
              videoIds.push(id);
            }
          }
          pageToken = searchData.nextPageToken;
          if (!pageToken || pageIds.length === 0) break;
        }
      }

      if (videoIds.length === 0) {
        return NextResponse.json({
          success: true,
          count: 0,
          videos: [],
          pagination: {
            page: 1,
            totalPages: 1,
            totalCount: 0,
            hasNextPage: false,
            hasPrevPage: false,
          },
        });
      }

      // 2) Get details in batches of 50 (videos.list max id count)
      const BATCH_SIZE = 50;
      const allItems: Array<{
        id: string;
        snippet?: {
          title?: string;
          channelTitle?: string;
          publishedAt?: string;
          thumbnails?: {
            medium?: { url?: string };
            high?: { url?: string };
            default?: { url?: string };
          };
        };
        statistics?: { viewCount?: string; likeCount?: string };
        contentDetails?: { duration?: string };
      }> = [];

      for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
        const batchIds = videoIds.slice(i, i + BATCH_SIZE);
        const videosParams = new URLSearchParams({
          part: "snippet,statistics,contentDetails",
          id: batchIds.join(","),
          key: API_KEY,
        });
        const videosRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?${videosParams}`,
          { next: { revalidate: 3600 } }
        );
        if (!videosRes.ok) {
          const error = await videosRes.json().catch(() => ({}));
          const reason = (error as any)?.error?.errors?.[0]?.reason;
          const message =
            reason === "quotaExceeded"
              ? "YouTube API quota exceeded. Try again tomorrow or increase quota in Google Cloud Console."
              : reason === "rateLimitExceeded"
                ? "YouTube API rate limit exceeded. Please try again in a few minutes."
                : "YouTube API error";
          return NextResponse.json(
            { error: message, details: error },
            { status: videosRes.status }
          );
        }
        const videosData = await videosRes.json();
        allItems.push(...(videosData.items ?? []));
      }

      const videosData = { items: allItems };
      type VideoItemInternal = SnapshotVideo & { durationSeconds?: number };
      let internalVideos: VideoItemInternal[] = (videosData.items ?? []).map((item: {
        id: string;
        snippet?: {
          title?: string;
          channelTitle?: string;
          publishedAt?: string;
          thumbnails?: {
            medium?: { url?: string };
            high?: { url?: string };
            default?: { url?: string };
          };
        };
        statistics?: { viewCount?: string; likeCount?: string };
        contentDetails?: { duration?: string };
      }) => {
        const durationSeconds = durationToSeconds(item.contentDetails?.duration);
        return {
          id: item.id,
          title: item.snippet?.title,
          channelTitle: item.snippet?.channelTitle,
          publishedAt: item.snippet?.publishedAt,
          thumbnailUrl:
            item.snippet?.thumbnails?.high?.url ??
            item.snippet?.thumbnails?.medium?.url ??
            item.snippet?.thumbnails?.default?.url,
          viewCount: item.statistics?.viewCount ?? undefined,
          likeCount: item.statistics?.likeCount ?? undefined,
          durationSeconds,
        };
      });

      // Long-form only: exclude Shorts (≤60s), sort by view count, cap at MAX_VIDEOS
      internalVideos = internalVideos.filter(
        (v: VideoItemInternal) => (v.durationSeconds ?? 0) > SHORTS_MAX_SECONDS
      );
      internalVideos = internalVideos.sort(
        (a: VideoItemInternal, b: VideoItemInternal) =>
          Number(b.viewCount ?? 0) - Number(a.viewCount ?? 0)
      );
      internalVideos = internalVideos.slice(0, MAX_VIDEOS);

      // Drop durationSeconds for storage / response
      videos = internalVideos.map(({ durationSeconds: _d, ...rest }) => rest);

      // Store snapshot for today if Mongo is available; ignore cache-write failures.
      if (snapshots) {
        try {
          await snapshots.updateOne(
            { date: todayKey },
            { $set: { date: todayKey, videos, createdAt: new Date() } },
            { upsert: true }
          );
        } catch (mongoWriteErr) {
          console.warn("Failed to write Mongo snapshot; serving live YouTube data:", mongoWriteErr);
        }
      }
    }

    const totalCount = videos.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));
    const page = Math.min(currentPage, totalPages);
    const start = (page - 1) * PER_PAGE;
    const paginatedVideos = videos.slice(start, start + PER_PAGE);

    return NextResponse.json({
      success: true,
      count: paginatedVideos.length,
      videos: paginatedVideos,
      pagination: {
        page,
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    console.error('YouTube API error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch from YouTube API' },
      { status: 500 }
    );
  }
}
