/**
 * Multi-source music discovery.
 *
 * Metadata is fetched from documented public APIs, never scraped from service
 * pages. A provider search URL is also returned for services whose public API
 * does not offer the kind of search/playback access we need.
 */

export interface ProviderSearchLink {
  id: string;
  label: string;
  description: string;
  url: string;
}

export interface ExternalRecording {
  id: string;
  title: string;
  artist: string;
  release: string | null;
  releaseDate: string | null;
  durationSeconds: number | null;
  url: string;
  provider: 'musicbrainz';
}

export interface LastFmTrack {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  listeners: number | null;
  durationSeconds: number | null;
  url: string;
  provider: 'lastfm';
}

export interface MusicDiscoveryResponse {
  query: string;
  sources: ProviderSearchLink[];
  musicBrainz: {
    status: 'available' | 'unavailable';
    recordings: ExternalRecording[];
  };
  lastFm: {
    status: 'available' | 'unavailable' | 'not-configured';
    tracks: LastFmTrack[];
  };
}

export interface MusicDiscoveryOptions {
  lastFmApiKey?: string;
  fetcher?: typeof fetch;
}

interface MusicBrainzRecording {
  id?: string;
  title?: string;
  length?: number;
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } } | string>;
  releases?: Array<{ id?: string; title?: string; date?: string }>;
}

interface LastFmImage {
  '#text'?: string;
  size?: string;
}

interface LastFmApiTrack {
  name?: string;
  artist?: string | { name?: string };
  url?: string;
  mbid?: string;
  duration?: string | number;
  listeners?: string | number;
  image?: LastFmImage[];
  album?: { title?: string };
}

const CACHE_TTL_MS = 45_000;
const responseCache = new Map<string, { expiresAt: number; value: MusicDiscoveryResponse }>();
let musicBrainzQueue: Promise<unknown> = Promise.resolve();
let lastMusicBrainzRequestAt = 0;

function buildSearchUrl(base: string, query: string, parameter: string): string {
  const url = new URL(base);
  url.searchParams.set(parameter, query);
  return url.toString();
}

export function buildProviderSearchLinks(query: string): ProviderSearchLink[] {
  const q = query.trim();
  const encoded = encodeURIComponent(q);
  return [
    {
      id: 'youtube-music',
      label: 'YouTube Music',
      description: 'Search tracks and music videos',
      url: `https://music.youtube.com/search?q=${encoded}`,
    },
    {
      id: 'soundcloud',
      label: 'SoundCloud',
      description: 'Discover independent artists and mixes',
      url: `https://soundcloud.com/search/sounds?q=${encoded}`,
    },
    {
      id: 'bandcamp',
      label: 'Bandcamp',
      description: 'Find releases and support artists directly',
      url: `https://bandcamp.com/search?q=${encoded}`,
    },
    {
      id: 'youtube',
      label: 'YouTube',
      description: 'Search official videos and live performances',
      url: `https://www.youtube.com/results?search_query=${encoded}`,
    },
    {
      id: 'lastfm',
      label: 'Last.fm',
      description: 'Explore listening stats and similar artists',
      url: buildSearchUrl('https://www.last.fm/search', q, 'q'),
    },
    {
      id: 'discogs',
      label: 'Discogs',
      description: 'Explore albums, editions and credits',
      url: `https://www.discogs.com/search/?q=${encoded}&type=all`,
    },
  ];
}

function parseNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function artistCredit(recording: MusicBrainzRecording): string {
  const credits = recording['artist-credit'] ?? [];
  return credits
    .map((credit) => typeof credit === 'string' ? credit : (credit.name ?? credit.artist?.name ?? ''))
    .join('')
    .trim() || 'Unknown artist';
}

export function normalizeMusicBrainzRecording(recording: MusicBrainzRecording): ExternalRecording | null {
  if (!recording.id || !recording.title?.trim()) return null;
  const release = recording.releases?.[0];
  return {
    id: recording.id,
    title: recording.title.trim(),
    artist: artistCredit(recording),
    release: release?.title?.trim() || null,
    releaseDate: release?.date?.slice(0, 10) || null,
    durationSeconds: parseNumber(recording.length) === null ? null : Math.round(Number(recording.length) / 1000),
    url: `https://musicbrainz.org/recording/${encodeURIComponent(recording.id)}`,
    provider: 'musicbrainz',
  };
}

export function normalizeLastFmTrack(track: LastFmApiTrack): LastFmTrack | null {
  if (!track.name?.trim()) return null;
  const artist = typeof track.artist === 'string' ? track.artist : track.artist?.name;
  const image = [...(track.image ?? [])].reverse().find((item) => item['#text']?.startsWith('https://'))?.['#text'] ?? null;
  const seconds = parseNumber(track.duration);
  return {
    id: track.mbid?.trim() || track.url || `${artist ?? 'unknown'}:${track.name}`,
    title: track.name.trim(),
    artist: artist?.trim() || 'Unknown artist',
    album: track.album?.title?.trim() || null,
    artworkUrl: image,
    listeners: parseNumber(track.listeners),
    durationSeconds: seconds === null || seconds === 0 ? null : Math.round(seconds > 10_000 ? seconds / 1000 : seconds),
    url: track.url?.startsWith('https://www.last.fm/') ? track.url : 'https://www.last.fm/',
    provider: 'lastfm',
  };
}

async function fetchJson<T>(url: string, fetcher: typeof fetch, headers: HeadersInit = {}): Promise<T> {
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(5_500),
  });
  if (!response.ok) throw new Error(`Provider responded with HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

/** MusicBrainz asks clients to avoid sending more than one request per second. */
function fetchMusicBrainz<T>(url: string, fetcher: typeof fetch): Promise<T> {
  const request = musicBrainzQueue.then(async () => {
    const waitMs = Math.max(0, 1_100 - (Date.now() - lastMusicBrainzRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastMusicBrainzRequestAt = Date.now();
    return fetchJson<T>(url, fetcher, {
      'User-Agent': 'ResonTune/0.1.0 (https://github.com/flessan/resontune)',
    });
  });
  musicBrainzQueue = request.then(() => undefined, () => undefined);
  return request;
}

async function searchMusicBrainz(query: string, fetcher: typeof fetch): Promise<ExternalRecording[]> {
  const url = new URL('https://musicbrainz.org/ws/2/recording/');
  url.searchParams.set('query', query);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', '8');
  const data = await fetchMusicBrainz<{ recordings?: MusicBrainzRecording[] }>(url.toString(), fetcher);
  return (data.recordings ?? []).map(normalizeMusicBrainzRecording).filter((item): item is ExternalRecording => item !== null);
}

async function searchLastFm(query: string, apiKey: string, fetcher: typeof fetch): Promise<LastFmTrack[]> {
  const url = new URL('https://ws.audioscrobbler.com/2.0/');
  url.searchParams.set('method', 'track.search');
  url.searchParams.set('track', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '8');
  const data = await fetchJson<{ results?: { trackmatches?: { track?: LastFmApiTrack[] | LastFmApiTrack } } }>(url.toString(), fetcher);
  const tracks = data.results?.trackmatches?.track;
  if (!tracks) return [];
  return (Array.isArray(tracks) ? tracks : [tracks])
    .map(normalizeLastFmTrack)
    .filter((item): item is LastFmTrack => item !== null);
}

export async function searchMusicDiscovery(
  rawQuery: string,
  options: MusicDiscoveryOptions = {},
): Promise<MusicDiscoveryResponse> {
  const query = rawQuery.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sources = buildProviderSearchLinks(query);
  const empty: MusicDiscoveryResponse = {
    query,
    sources,
    musicBrainz: { status: 'available', recordings: [] },
    lastFm: { status: options.lastFmApiKey?.trim() ? 'available' : 'not-configured', tracks: [] },
  };
  if (query.length < 2) return empty;

  const cacheKey = `${query.toLocaleLowerCase('en-US')}|lastfm:${Boolean(options.lastFmApiKey?.trim())}`;
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, query, sources };
  }

  const fetcher = options.fetcher ?? fetch;
  const [musicBrainzResult, lastFmResult] = await Promise.allSettled([
    searchMusicBrainz(query, fetcher),
    options.lastFmApiKey?.trim()
      ? searchLastFm(query, options.lastFmApiKey.trim(), fetcher)
      : Promise.resolve([] as LastFmTrack[]),
  ]);

  const response: MusicDiscoveryResponse = {
    query,
    sources,
    musicBrainz: musicBrainzResult.status === 'fulfilled'
      ? { status: 'available', recordings: musicBrainzResult.value }
      : { status: 'unavailable', recordings: [] },
    lastFm: !options.lastFmApiKey?.trim()
      ? { status: 'not-configured', tracks: [] }
      : lastFmResult.status === 'fulfilled'
        ? { status: 'available', tracks: lastFmResult.value }
        : { status: 'unavailable', tracks: [] },
  };

  responseCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: response });
  while (responseCache.size > 100) {
    const oldestKey = responseCache.keys().next().value;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
  return response;
}

/** Test-only helper to reset process-local caches between service tests. */
export function resetMusicDiscoveryCacheForTests(): void {
  responseCache.clear();
  musicBrainzQueue = Promise.resolve();
  lastMusicBrainzRequestAt = 0;
}
