// =============================================================================
// VIDROOM BACKEND v3.0
// TMDB Proxy + YouTube Integration + Caching + Diagnostics
// =============================================================================

'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();

// =============================================================================
// SERVER CONFIG
// =============================================================================

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

// IMPORTANT:
// Put these in Render Environment Variables.
// Do NOT hard-code API keys into your source code.

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_EMBED_BASE = 'https://www.youtube.com/embed';

const CACHE_DURATION = 24 * 60 * 60;

// =============================================================================
// APPLICATION CACHE
// =============================================================================

const cache = new NodeCache({
    stdTTL: CACHE_DURATION,
    checkperiod: 3600,
    useClones: false
});

const shortCache = new NodeCache({
    stdTTL: 60 * 60,
    checkperiod: 600,
    useClones: false
});

// =============================================================================
// CORS
// =============================================================================

// Allow the frontend to communicate with the API.
//
// For production you can restrict this to your actual frontend domain.
// The function below intentionally allows normal browser requests from
// different origins so localhost/Vercel/Netlify development doesn't break.

app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Accept'
    ],
    credentials: false,
    maxAge: 86400
}));

// =============================================================================
// HELMET
// =============================================================================

app.use(
    helmet({
        crossOriginResourcePolicy: false,
        contentSecurityPolicy: false
    })
);

// =============================================================================
// GENERAL MIDDLEWARE
// =============================================================================

app.use(compression());

app.use(
    express.json({
        limit: '2mb'
    })
);

// =============================================================================
// RATE LIMITING
// =============================================================================

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many requests. Please try again later.'
    }
});

app.use('/api/', apiLimiter);

// =============================================================================
// AXIOS CLIENT
// =============================================================================

const http = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'VIDROOM/3.0'
    }
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function requireTMDBKey() {
    if (!TMDB_API_KEY) {
        throw new Error(
            'TMDB_API_KEY is missing. Add TMDB_API_KEY to your server environment variables.'
        );
    }
}

function clean(value) {
    if (value === undefined || value === null) {
        return '';
    }

    return String(value).trim();
}

function cacheKey(prefix, value) {
    return `${prefix}:${String(value).toLowerCase()}`;
}

function getPosterUrl(path, size = 'w500') {
    if (!path) {
        return null;
    }

    if (String(path).startsWith('http')) {
        return path;
    }

    return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function getBackdropUrl(path, size = 'w1280') {
    if (!path) {
        return null;
    }

    if (String(path).startsWith('http')) {
        return path;
    }

    return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function normalizeTMDBItem(item) {
    if (!item) {
        return item;
    }

    const isTV = item.media_type === 'tv' ||
        item.first_air_date !== undefined ||
        item.name !== undefined;

    return {
        ...item,

        media_type: item.media_type || (isTV ? 'tv' : 'movie'),

        title: item.title || item.name || '',

        original_title:
            item.original_title ||
            item.original_name ||
            '',

        poster_url: getPosterUrl(item.poster_path, 'w500'),

        backdrop_url: getBackdropUrl(item.backdrop_path, 'w1280')
    };
}

function normalizeTMDBResults(results) {
    if (!Array.isArray(results)) {
        return [];
    }

    return results.map(normalizeTMDBItem);
}

// =============================================================================
// TMDB CLIENT
// =============================================================================

class TMDBClient {

    constructor() {
        this.baseURL = TMDB_BASE_URL;
        this.apiKey = TMDB_API_KEY;
    }

    async request(endpoint, params = {}) {

        requireTMDBKey();

        const response = await http.get(
            `${this.baseURL}${endpoint}`,
            {
                params: {
                    api_key: this.apiKey,
                    ...params
                }
            }
        );

        return response.data;
    }

    async getMovie(id) {

        const key = cacheKey('movie', id);

        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const movie = await this.request(
            `/movie/${encodeURIComponent(id)}`,
            {
                append_to_response:
                    'credits,images,similar,videos,keywords'
            }
        );

        const result = this.normalizeDetails(movie, 'movie');

        cache.set(key, result);

        return result;
    }

    async getTV(id) {

        const key = cacheKey('tv', id);

        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const show = await this.request(
            `/tv/${encodeURIComponent(id)}`,
            {
                append_to_response:
                    'credits,images,similar,videos,keywords'
            }
        );

        const result = this.normalizeDetails(show, 'tv');

        cache.set(key, result);

        return result;
    }

    async getSeason(tvId, seasonNumber) {

        const key = cacheKey(
            'season',
            `${tvId}:${seasonNumber}`
        );

        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const season = await this.request(
            `/tv/${encodeURIComponent(tvId)}/season/${encodeURIComponent(seasonNumber)}`
        );

        if (Array.isArray(season.episodes)) {
            season.episodes = season.episodes.map(episode => ({
                ...episode,
                still_url: getPosterUrl(
                    episode.still_path,
                    'w500'
                )
            }));
        }

        cache.set(key, season);

        return season;
    }

    async search(query, page = 1) {

        const normalizedQuery = clean(query);

        if (!normalizedQuery) {
            return {
                page: 1,
                results: [],
                total_pages: 0,
                total_results: 0
            };
        }

        const key = cacheKey(
            'search',
            `${normalizedQuery}:${page}`
        );

        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const data = await this.request(
            '/search/multi',
            {
                query: normalizedQuery,
                page
            }
        );

        data.results = normalizeTMDBResults(data.results);

        cache.set(key, data);

        return data;
    }

    async discover(category, params = {}) {

        if (!['movie', 'tv'].includes(category)) {
            throw new Error(
                'Invalid discover category. Use movie or tv.'
            );
        }

        const queryParams = {
            page: params.page || 1,
            sort_by: params.sort_by || 'popularity.desc'
        };

        if (params.with_genres) {
            queryParams.with_genres = params.with_genres;
        }

        if (params.vote_count_gte) {
            queryParams.vote_count_gte =
                params.vote_count_gte;
        }

        if (params.primary_release_date_lte) {
            queryParams.primary_release_date_lte =
                params.primary_release_date_lte;
        }

        if (params['vote_count.gte']) {
            queryParams['vote_count.gte'] =
                params['vote_count.gte'];
        }

        const key = cacheKey(
            'discover',
            `${category}:${JSON.stringify(queryParams)}`
        );

        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const data = await this.request(
            `/discover/${category}`,
            queryParams
        );

        data.results = normalizeTMDBResults(data.results);

        cache.set(key, data);

        return data;
    }

    async getVideos(id, type = 'movie') {

        if (!['movie', 'tv'].includes(type)) {
            throw new Error('Invalid media type.');
        }

        const key = cacheKey(
            'videos',
            `${type}:${id}`
        );

        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const data = await this.request(
            `/${type}/${encodeURIComponent(id)}/videos`,
            {
                language: 'en-US'
            }
        );

        cache.set(key, data);

        return data;
    }

    async getSimilar(id, type = 'movie') {

        if (!['movie', 'tv'].includes(type)) {
            throw new Error('Invalid media type.');
        }

        const key = cacheKey(
            'similar',
            `${type}:${id}`
        );

        const cached = cache.get(key);

        if (cached) {
            return cached;
        }

        const data = await this.request(
            `/${type}/${encodeURIComponent(id)}/similar`,
            {
                page: 1
            }
        );

        data.results = normalizeTMDBResults(data.results);

        cache.set(key, data);

        return data;
    }

    normalizeDetails(item, type) {

        const result = {
            ...item,

            media_type: type,

            title:
                item.title ||
                item.name ||
                '',

            original_title:
                item.original_title ||
                item.original_name ||
                '',

            poster_url:
                getPosterUrl(
                    item.poster_path,
                    'w500'
                ),

            backdrop_url:
                getBackdropUrl(
                    item.backdrop_path,
                    'w1280'
                ),

            poster_original:
                getPosterUrl(
                    item.poster_path,
                    'original'
                ),

            backdrop_original:
                getBackdropUrl(
                    item.backdrop_path,
                    'original'
                )
        };

        // Normalize cast.

        if (
            result.credits &&
            Array.isArray(result.credits.cast)
        ) {
            result.credits.cast =
                result.credits.cast.map(person => ({
                    ...person,
                    profile_url:
                        getPosterUrl(
                            person.profile_path,
                            'w185'
                        )
                }));
        }

        // Normalize images.

        if (
            result.images &&
            Array.isArray(result.images.backdrops)
        ) {
            result.images.backdrops =
                result.images.backdrops.map(image => ({
                    ...image,
                    image_url:
                        getPosterUrl(
                            image.file_path,
                            'w1280'
                        )
                }));
        }

        if (
            result.images &&
            Array.isArray(result.images.posters)
        ) {
            result.images.posters =
                result.images.posters.map(image => ({
                    ...image,
                    image_url:
                        getPosterUrl(
                            image.file_path,
                            'w500'
                        )
                }));
        }

        // Normalize similar movies/shows.

        if (
            result.similar &&
            Array.isArray(result.similar.results)
        ) {
            result.similar.results =
                normalizeTMDBResults(
                    result.similar.results
                );
        }

        // Extract useful YouTube videos from TMDB.

        if (
            result.videos &&
            Array.isArray(result.videos.results)
        ) {
            result.videos.results =
                result.videos.results.map(video => ({
                    ...video,
                    embed_url:
                        video.site === 'YouTube' &&
                        video.key
                            ? `${YOUTUBE_EMBED_BASE}/${video.key}`
                            : null,

                    thumbnail_url:
                        video.site === 'YouTube' &&
                        video.key
                            ? `https://img.youtube.com/vi/${video.key}/hqdefault.jpg`
                            : null
                }));
        }

        return result;
    }
}

// =============================================================================
// YOUTUBE CLIENT
// =============================================================================

class YouTubeClient {

    constructor() {

        this.apiKey = YOUTUBE_API_KEY;

        this.enabled =
            Boolean(this.apiKey);

        if (this.enabled) {
            console.log(
                '✅ YouTube API configured'
            );
        } else {
            console.log(
                '⚠️ YouTube API key not configured'
            );
        }
    }

    async searchVideos(query, maxResults = 10) {

        const normalizedQuery = clean(query);

        if (!normalizedQuery) {
            return [];
        }

        // If no API key exists, return an empty array instead
        // of fake results. TMDB videos are handled separately.

        if (!this.enabled) {
            return [];
        }

        maxResults = Math.min(
            Math.max(parseInt(maxResults) || 10, 1),
            50
        );

        const key = cacheKey(
            'youtube',
            `${normalizedQuery}:${maxResults}`
        );

        const cached =
            shortCache.get(key);

        if (cached) {
            return cached;
        }

        try {

            const response =
                await http.get(
                    `${YOUTUBE_API_BASE}/search`,
                    {
                        params: {
                            part: 'snippet',
                            q: normalizedQuery,
                            maxResults,
                            type: 'video',
                            videoEmbeddable: 'true',
                            safeSearch: 'moderate',
                            key: this.apiKey
                        }
                    }
                );

            const results =
                (response.data.items || [])
                    .filter(item =>
                        item.id &&
                        item.id.videoId
                    )
                    .map(item => {

                        const videoId =
                            item.id.videoId;

                        return {
                            id: videoId,

                            title:
                                item.snippet?.title ||
                                '',

                            description:
                                item.snippet?.description ||
                                '',

                            thumbnail:
                                item.snippet?.thumbnails?.high?.url ||
                                item.snippet?.thumbnails?.medium?.url ||
                                item.snippet?.thumbnails?.default?.url ||
                                null,

                            channelTitle:
                                item.snippet?.channelTitle ||
                                '',

                            publishedAt:
                                item.snippet?.publishedAt ||
                                null,

                            embedUrl:
                                `${YOUTUBE_EMBED_BASE}/${videoId}`,

                            watchUrl:
                                `https://www.youtube.com/watch?v=${videoId}`,

                            isFallback: false
                        };
                    });

            shortCache.set(
                key,
                results
            );

            return results;

        } catch (error) {

            console.error(
                'YouTube search error:',
                error.response?.data ||
                error.message
            );

            return [];
        }
    }

    async getMovieTrailers(title, year = null) {

        let query =
            `${clean(title)} official movie trailer`;

        if (year) {
            query += ` ${year}`;
        }

        const results =
            await this.searchVideos(
                query,
                10
            );

        return results.filter(video => {

            const text =
                `${video.title} ${video.description}`
                    .toLowerCase();

            return (
                text.includes('trailer') ||
                text.includes('teaser') ||
                text.includes('official')
            );

        });
    }

    async getTVTrailers(title) {

        const query =
            `${clean(title)} official TV trailer`;

        const results =
            await this.searchVideos(
                query,
                10
            );

        return results.filter(video => {

            const text =
                `${video.title} ${video.description}`
                    .toLowerCase();

            return (
                text.includes('trailer') ||
                text.includes('teaser') ||
                text.includes('official')
            );

        });
    }

    async getSoundtrack(title) {

        const query =
            `${clean(title)} official soundtrack`;

        return this.searchVideos(
            query,
            10
        );
    }
}

// =============================================================================
// INITIALIZE CLIENTS
// =============================================================================

const tmdb = new TMDBClient();
const youtube = new YouTubeClient();

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', (req, res) => {

    res.json({
        status: 'ok',

        service: 'VIDROOM Backend',

        version: '3.0.0',

        timestamp: new Date().toISOString(),

        uptime:
            Math.round(process.uptime()),

        environment: process.env.NODE_ENV || 'production',

        tmdb: {
            configured:
                Boolean(TMDB_API_KEY)
        },

        youtube: {
            configured:
                Boolean(YOUTUBE_API_KEY)
        },

        cache: {
            keys:
                cache.keys().length
        }
    });
});

// =============================================================================
// ROOT
// =============================================================================

app.get('/', (req, res) => {

    res.json({

        name: 'VIDROOM Backend',

        version: '3.0.0',

        status: 'online',

        endpoints: {

            health:
                '/api/health',

            tmdb:
                '/api/tmdb/...',

            youtube:
                '/api/youtube/...',

            stream:
                '/api/stream/...'
        }

    });
});

// =============================================================================
// TMDB — MOVIE
// =============================================================================

app.get('/api/tmdb/movie/:id', async (req, res) => {

    try {

        const movie =
            await tmdb.getMovie(
                req.params.id
            );

        res.json(movie);

    } catch (error) {

        console.error(
            'TMDB movie error:',
            error.message
        );

        res.status(500).json({
            error:
                'Unable to fetch movie data.',
            details:
                error.message
        });
    }
});

// =============================================================================
// TMDB — TV
// =============================================================================

app.get('/api/tmdb/tv/:id', async (req, res) => {

    try {

        const show =
            await tmdb.getTV(
                req.params.id
            );

        res.json(show);

    } catch (error) {

        console.error(
            'TMDB TV error:',
            error.message
        );

        res.status(500).json({
            error:
                'Unable to fetch TV data.',
            details:
                error.message
        });
    }
});

// =============================================================================
// TMDB — TV SEASON
// =============================================================================

app.get(
    '/api/tmdb/tv/:id/season/:season',
    async (req, res) => {

        try {

            const seasonNumber =
                parseInt(
                    req.params.season,
                    10
                );

            if (
                !Number.isInteger(seasonNumber) ||
                seasonNumber < 0
            ) {
                return res.status(400).json({
                    error:
                        'Invalid season number.'
                });
            }

            const season =
                await tmdb.getSeason(
                    req.params.id,
                    seasonNumber
                );

            res.json(season);

        } catch (error) {

            console.error(
                'TMDB season error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch season data.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — SEARCH
// =============================================================================

app.get(
    '/api/tmdb/search/multi',
    async (req, res) => {

        try {

            const query =
                clean(req.query.query);

            if (!query) {
                return res.status(400).json({
                    error:
                        'Missing query parameter.'
                });
            }

            const page =
                Math.max(
                    parseInt(req.query.page, 10) || 1,
                    1
                );

            const data =
                await tmdb.search(
                    query,
                    page
                );

            res.json(data);

        } catch (error) {

            console.error(
                'TMDB search error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to search TMDB.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — DISCOVER
// =============================================================================

app.get(
    '/api/tmdb/discover/:category',
    async (req, res) => {

        try {

            const category =
                req.params.category;

            const data =
                await tmdb.discover(
                    category,
                    {
                        page:
                            req.query.page || 1,

                        with_genres:
                            req.query.with_genres || '',

                        sort_by:
                            req.query.sort_by ||
                            'popularity.desc',

                        vote_count_gte:
                            req.query.vote_count_gte,

                        'vote_count.gte':
                            req.query['vote_count.gte'],

                        primary_release_date_lte:
                            req.query.primary_release_date_lte
                    }
                );

            res.json(data);

        } catch (error) {

            console.error(
                'TMDB discover error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to discover content.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — VIDEOS
// =============================================================================

app.get(
    '/api/tmdb/:type/:id/videos',
    async (req, res) => {

        try {

            const type =
                req.params.type;

            if (
                type !== 'movie' &&
                type !== 'tv'
            ) {
                return res.status(400).json({
                    error:
                        'Type must be movie or tv.'
                });
            }

            const videos =
                await tmdb.getVideos(
                    req.params.id,
                    type
                );

            res.json(videos);

        } catch (error) {

            console.error(
                'TMDB videos error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch videos.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — SIMILAR MOVIES
// =============================================================================

app.get(
    '/api/tmdb/movie/:id/similar',
    async (req, res) => {

        try {

            const data =
                await tmdb.getSimilar(
                    req.params.id,
                    'movie'
                );

            res.json(data);

        } catch (error) {

            console.error(
                'TMDB similar movie error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch similar movies.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — SIMILAR TV
// =============================================================================

app.get(
    '/api/tmdb/tv/:id/similar',
    async (req, res) => {

        try {

            const data =
                await tmdb.getSimilar(
                    req.params.id,
                    'tv'
                );

            res.json(data);

        } catch (error) {

            console.error(
                'TMDB similar TV error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch similar shows.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — POPULAR MOVIES
// =============================================================================

app.get(
    '/api/tmdb/movie/popular',
    async (req, res) => {

        try {

            const data =
                await tmdb.discover(
                    'movie',
                    {
                        page:
                            req.query.page || 1,

                        sort_by:
                            'popularity.desc'
                    }
                );

            res.json(data);

        } catch (error) {

            console.error(
                'Popular movies error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch popular movies.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — POPULAR TV
// =============================================================================

app.get(
    '/api/tmdb/tv/popular',
    async (req, res) => {

        try {

            const data =
                await tmdb.discover(
                    'tv',
                    {
                        page:
                            req.query.page || 1,

                        sort_by:
                            'popularity.desc'
                    }
                );

            res.json(data);

        } catch (error) {

            console.error(
                'Popular TV error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch popular TV.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — TOP RATED
// =============================================================================

app.get(
    '/api/tmdb/movie/top_rated',
    async (req, res) => {

        try {

            const data =
                await tmdb.discover(
                    'movie',
                    {
                        page:
                            req.query.page || 1,

                        sort_by:
                            'vote_average.desc',

                        'vote_count.gte':
                            100
                    }
                );

            res.json(data);

        } catch (error) {

            console.error(
                'Top rated error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch top rated movies.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// TMDB — NOW PLAYING
// =============================================================================

app.get(
    '/api/tmdb/movie/now_playing',
    async (req, res) => {

        try {

            const today =
                new Date()
                    .toISOString()
                    .split('T')[0];

            const data =
                await tmdb.discover(
                    'movie',
                    {
                        page:
                            req.query.page || 1,

                        sort_by:
                            'primary_release_date.desc',

                        primary_release_date_lte:
                            today
                    }
                );

            res.json(data);

        } catch (error) {

            console.error(
                'Now playing error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch now playing movies.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// YOUTUBE — SEARCH
// =============================================================================

app.get(
    '/api/youtube/search',
    async (req, res) => {

        try {

            const query =
                clean(req.query.q);

            if (!query) {
                return res.status(400).json({
                    error:
                        'Missing search query (q).'
                });
            }

            const maxResults =
                parseInt(
                    req.query.maxResults,
                    10
                ) || 10;

            const results =
                await youtube.searchVideos(
                    query,
                    maxResults
                );

            res.json({
                query,
                results,
                total:
                    results.length,

                youtubeConfigured:
                    youtube.enabled
            });

        } catch (error) {

            console.error(
                'YouTube search error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to search YouTube.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// YOUTUBE — MOVIE TRAILERS
// =============================================================================

app.get(
    '/api/youtube/trailers/movie',
    async (req, res) => {

        try {

            const title =
                clean(req.query.title);

            if (!title) {
                return res.status(400).json({
                    error:
                        'Missing movie title.'
                });
            }

            const year =
                req.query.year
                    ? parseInt(
                        req.query.year,
                        10
                    )
                    : null;

            const trailers =
                await youtube.getMovieTrailers(
                    title,
                    year
                );

            res.json({
                movie:
                    title,

                year:
                    year,

                trailers,

                youtubeConfigured:
                    youtube.enabled
            });

        } catch (error) {

            console.error(
                'Movie trailers error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch movie trailers.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// YOUTUBE — TV TRAILERS
// =============================================================================

app.get(
    '/api/youtube/trailers/tv',
    async (req, res) => {

        try {

            const title =
                clean(req.query.title);

            if (!title) {
                return res.status(400).json({
                    error:
                        'Missing TV show title.'
                });
            }

            const trailers =
                await youtube.getTVTrailers(
                    title
                );

            res.json({
                show:
                    title,

                trailers,

                youtubeConfigured:
                    youtube.enabled
            });

        } catch (error) {

            console.error(
                'TV trailers error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch TV trailers.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// YOUTUBE — SOUNDTRACK
// =============================================================================

app.get(
    '/api/youtube/soundtrack',
    async (req, res) => {

        try {

            const title =
                clean(req.query.title);

            if (!title) {
                return res.status(400).json({
                    error:
                        'Missing title.'
                });
            }

            const soundtrack =
                await youtube.getSoundtrack(
                    title
                );

            res.json({
                movie:
                    title,

                soundtrack,

                youtubeConfigured:
                    youtube.enabled
            });

        } catch (error) {

            console.error(
                'Soundtrack error:',
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch soundtrack.',
                details:
                    error.message
            });
        }
    }
);

// =============================================================================
// YOUTUBE — VIDEO DETAILS
// =============================================================================

app.get(
    '/api/youtube/video/:id',
    async (req, res) => {

        try {

            const videoId =
                clean(req.params.id);

            if (!videoId) {
                return res.status(400).json({
                    error:
                        'Missing video ID.'
                });
            }

            if (!youtube.enabled) {
                return res.status(503).json({
                    error:
                        'YouTube API is not configured.',
                    youtubeConfigured:
                        false
                });
            }

            const response =
                await http.get(
                    `${YOUTUBE_API_BASE}/videos`,
                    {
                        params: {
                            part:
                                'snippet,contentDetails,statistics',

                            id:
                                videoId,

                            key:
                                YOUTUBE_API_KEY
                        }
                    }
                );

            const item =
                response.data.items?.[0];

            if (!item) {
                return res.status(404).json({
                    error:
                        'YouTube video not found.'
                });
            }

            res.json({
                id:
                    videoId,

                title:
                    item.snippet?.title || '',

                description:
                    item.snippet?.description || '',

                thumbnail:
                    item.snippet?.thumbnails?.high?.url ||
                    item.snippet?.thumbnails?.medium?.url ||
                    null,

                channelTitle:
                    item.snippet?.channelTitle || '',

                publishedAt:
                    item.snippet?.publishedAt || null,

                duration:
                    item.contentDetails?.duration || null,

                viewCount:
                    item.statistics?.viewCount || null,

                likeCount:
                    item.statistics?.likeCount || null,

                embedUrl:
                    `${YOUTUBE_EMBED_BASE}/${videoId}`,

                watchUrl:
                    `https://www.youtube.com/watch?v=${videoId}`
            });

        } catch (error) {

            console.error(
                'YouTube video details error:',
                error.response?.data ||
                error.message
            );

            res.status(500).json({
                error:
                    'Unable to fetch YouTube video.',
                details:
                    error.response?.data ||
                    error.message
            });
        }
    }
);

// =============================================================================
// STREAM ENDPOINT
// =============================================================================
//
// This endpoint intentionally does NOT bypass protections or retrieve
// unauthorized movie streams.
//
// Connect this to a provider that you are authorized/licensed to use.
//
// Example expected response:
//
// {
//   "url": "https://your-authorized-provider.example/embed/...",
//   "type": "movie",
//   "id": "123"
// }
//
// =============================================================================

app.get(
    '/api/stream/:type/:id',
    async (req, res) => {

        const type =
            clean(req.params.type);

        const id =
            clean(req.params.id);

        const season =
            req.query.season || null;

        const episode =
            req.query.episode || null;

        if (
            type !== 'movie' &&
            type !== 'tv'
        ) {
            return res.status(400).json({
                error:
                    'Invalid stream type.'
            });
        }

        if (!id) {
            return res.status(400).json({
                error:
                    'Missing content ID.'
            });
        }

        // No unauthorized source is generated here.
        return res.status(501).json({

            error:
                'Streaming provider is not configured.',

            message:
                'Connect an authorized/licensed streaming provider to enable playback.',

            type,
            id,
            season,
            episode

        });
    }
);

// =============================================================================
// 404 HANDLER
// =============================================================================

app.use((req, res) => {

    res.status(404).json({

        error:
            'Endpoint not found.',

        path:
            req.originalUrl,

        method:
            req.method

    });
});

// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================

app.use(
    (error, req, res, next) => {

        console.error(
            'Unhandled server error:',
            error
        );

        if (res.headersSent) {
            return next(error);
        }

        res.status(500).json({

            error:
                'Internal server error.',

            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined

        });
    }
);

// =============================================================================
// START SERVER
// =============================================================================

app.listen(
    PORT,
    HOST,
    () => {

        console.log('');
        console.log(
            '============================================================'
        );
        console.log(
            '                 VIDROOM BACKEND v3.0'
        );
        console.log(
            '============================================================'
        );

        console.log(
            `Server: http://${HOST}:${PORT}`
        );

        console.log(
            `TMDB API: ${
                TMDB_API_KEY
                    ? '✅ CONFIGURED'
                    : '❌ MISSING'
            }`
        );

        console.log(
            `YouTube API: ${
                YOUTUBE_API_KEY
                    ? '✅ CONFIGURED'
                    : '⚠️ NOT CONFIGURED'
            }`
        );

        console.log(
            '============================================================'
        );

        console.log('');
    }
);

// =============================================================================
// PROCESS ERROR HANDLERS
// =============================================================================

process.on(
    'unhandledRejection',
    error => {

        console.error(
            'Unhandled Promise Rejection:',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        console.error(
            'Uncaught Exception:',
            error
        );
    }
);
