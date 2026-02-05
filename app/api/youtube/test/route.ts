import { NextResponse } from 'next/server';

const API_KEY = process.env.YOUTUBE_API_KEY;

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
const MAX_VIDEOS = 50; // 50 videos = 2 pages; long-form only
// 2 queries × 3 pages ≈ 606 units/load → ~16 loads/day on 10k quota; long-form only
const SEARCH_PAGES = 3;
const SEARCH_QUERIES = ['vpop music videos', 'nhạc pop việt nam mv'];

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

    // 1) Fetch multiple search queries and merge (dedupe) to get enough candidates for long-form videos
    const seenIds = new Set<string>();
    const videoIds: string[] = [];

    for (const query of SEARCH_QUERIES) {
      let pageToken: string | undefined;
      for (let p = 0; p < SEARCH_PAGES; p++) {
        const searchParams = new URLSearchParams({
          part: 'snippet',
          type: 'video',
          order: 'viewCount',
          regionCode: 'VN',
          q: query,
          maxResults: '50',
          key: API_KEY,
        });
        if (pageToken) searchParams.set('pageToken', pageToken);

        const searchRes = await fetch(
          `https://www.googleapis.com/youtube/v3/search?${searchParams}`,
          { next: { revalidate: 3600 } }
        );
        if (!searchRes.ok) {
          const error = await searchRes.json().catch(() => ({}));
          const reason = error?.error?.errors?.[0]?.reason;
          const message =
            reason === 'quotaExceeded'
              ? 'YouTube API quota exceeded. Try again tomorrow or increase quota in Google Cloud Console.'
              : reason === 'rateLimitExceeded'
                ? 'YouTube API rate limit exceeded. Please try again in a few minutes.'
                : 'YouTube API error';
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
        pagination: { page: 1, totalPages: 1, totalCount: 0, hasNextPage: false, hasPrevPage: false },
      });
    }

    // 2) Get details in batches of 50 (videos.list max id count)
    const BATCH_SIZE = 50;
    const allItems: Array<{
      id: string;
      snippet?: { title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string }; default?: { url?: string } } };
      statistics?: { viewCount?: string; likeCount?: string };
      contentDetails?: { duration?: string };
    }> = [];

    for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
      const batchIds = videoIds.slice(i, i + BATCH_SIZE);
      const videosParams = new URLSearchParams({
        part: 'snippet,statistics,contentDetails',
        id: batchIds.join(','),
        key: API_KEY,
      });
      const videosRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?${videosParams}`,
        { next: { revalidate: 3600 } }
      );
      if (!videosRes.ok) {
        const error = await videosRes.json().catch(() => ({}));
        const reason = error?.error?.errors?.[0]?.reason;
        const message =
          reason === 'quotaExceeded'
            ? 'YouTube API quota exceeded. Try again tomorrow or increase quota in Google Cloud Console.'
            : reason === 'rateLimitExceeded'
              ? 'YouTube API rate limit exceeded. Please try again in a few minutes.'
              : 'YouTube API error';
        return NextResponse.json(
          { error: message, details: error },
          { status: videosRes.status }
        );
      }
      const videosData = await videosRes.json();
      allItems.push(...(videosData.items ?? []));
    }

    const videosData = { items: allItems };
    type VideoItem = { id: string; viewCount?: string; durationSeconds?: number };
    let videos = (videosData.items ?? []).map((item: {
      id: string;
      snippet?: { title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string }; default?: { url?: string } } };
      statistics?: { viewCount?: string; likeCount?: string };
      contentDetails?: { duration?: string };
    }) => {
      const durationSeconds = durationToSeconds(item.contentDetails?.duration);
      return {
        id: item.id,
        title: item.snippet?.title,
        channelTitle: item.snippet?.channelTitle,
        publishedAt: item.snippet?.publishedAt,
        thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url,
        viewCount: item.statistics?.viewCount ?? undefined,
        likeCount: item.statistics?.likeCount ?? undefined,
        durationSeconds,
      };
    });
    // Long-form only: exclude Shorts (≤60s), sort by view count, cap at MAX_VIDEOS
    videos = videos.filter((v: VideoItem) => (v.durationSeconds ?? 0) > SHORTS_MAX_SECONDS);
    videos = videos.sort((a: VideoItem, b: VideoItem) => Number(b.viewCount ?? 0) - Number(a.viewCount ?? 0));
    videos = videos.slice(0, MAX_VIDEOS);

    const totalCount = videos.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));
    const page = Math.min(currentPage, totalPages);
    const start = (page - 1) * PER_PAGE;
    const paginatedVideos = videos.slice(start, start + PER_PAGE);

    // Drop durationSeconds from response
    const videosForResponse = paginatedVideos.map((v: VideoItem & Record<string, unknown>) => {
      const { durationSeconds: _d, ...rest } = v;
      return rest;
    });

    return NextResponse.json({
      success: true,
      count: videosForResponse.length,
      videos: videosForResponse,
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
