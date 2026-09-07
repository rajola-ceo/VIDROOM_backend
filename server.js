// =============================================================================
// server.js — VIDROOM Streaming Server
// Complete system with TMDB proxy, YouTube integration, and Vidsrc support
// =============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const NodeCache = require('node-cache');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_API_KEY = process.env.TMDB_API_KEY || '480f73d92f9395eb2140f092c746b3bc';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_EMBED_BASE = 'https://www.youtube.com/embed';
const VSRC_BASE_URL = 'https://vidsrc.sbs/embed';
const CACHE_DURATION = 86400; // 24 hours

// =============================================================================
// MIDDLEWARE
// =============================================================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            frameSrc: ["'self'", "https://vidsrc.sbs", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
            imgSrc: ["'self'", "data:", "https://image.tmdb.org", "https://img.youtube.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
        },
    },
}));

app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
        'https://vidroom.vercel.app',
        'https://vidroom.netlify.app',
        '*'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// =============================================================================
// CACHE SYSTEM
// =============================================================================
const linkCache = new NodeCache({
    stdTTL: CACHE_DURATION,
    checkperiod: 3600,
    useClones: false
});

// =============================================================================
// YOUTUBE CLIENT
// =============================================================================
class YouTubeClient {
    constructor() {
        this.apiKey = YOUTUBE_API_KEY;
        this.isConfigured = !!this.apiKey && this.apiKey !== '';
        this.cache = new NodeCache({ stdTTL: 3600 });
        
        if (this.isConfigured) {
            this.youtube = google.youtube({
                version: 'v3',
                auth: this.apiKey
            });
            console.log('✅ YouTube API configured');
        } else {
            console.log('⚠️ YouTube API key missing - using fallback mode');
        }
    }

    async searchVideos(query, maxResults = 10) {
        if (!this.isConfigured) {
            return this.getFallbackResults(query, maxResults);
        }

        const cacheKey = `search_${query}_${maxResults}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        try {
            const response = await this.youtube.search.list({
                part: ['snippet'],
                q: query,
                maxResults: maxResults,
                type: ['video'],
                videoEmbeddable: 'true',
                safeSearch: 'moderate'
            });

            const results = response.data.items.map(item => ({
                id: item.id.videoId,
                title: item.snippet.title,
                description: item.snippet.description,
                thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
                channelTitle: item.snippet.channelTitle,
                publishedAt: item.snippet.publishedAt,
                embedUrl: `${YOUTUBE_EMBED_BASE}/${item.id.videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${item.id.videoId}`
            }));

            this.cache.set(cacheKey, results);
            return results;
        } catch (error) {
            console.error('YouTube search error:', error.message);
            return this.getFallbackResults(query, maxResults);
        }
    }

    getFallbackResults(query, maxResults = 10) {
        // Pre-defined trailer IDs for popular movies
        const trailerMap = {
            'dune': '8Bk1TtHj_0o',
            'dune part two': 'cTAlr6m6ijU',
            'oppenheimer': 'uYPbbksJxIg',
            'barbie': 'pBk4NYhWNMM',
            'the batman': 'mqqft2x_Aa4',
            'spider-man': 'qI22U71gGng',
            'avatar': 'd9MyW72ELq0',
            'interstellar': 'zSWdZVtXT7E',
            'inception': 'YoHD9XEInc0',
            'the dark knight': 'EXeTwQWrcwY',
            'gladiator': 'owK1qxDselE',
            'the matrix': 'vKQi3bBA1y8',
            'pulp fiction': 's7EdQ4FqbhY',
            'the godfather': 'sY1S34973zA',
            'titanic': 'zCy5WQ9S4c0',
            'star wars': 'vZ734NWnAHA',
            'harry potter': 'V6xLVtpbpJg',
            'lord of the rings': 'V75dMMIW2B4',
            'deadpool': 'Xithigfg7dA',
            'venom': 'u9Mv98Gr5pY',
            'joker': 'zAGVQLHvwOY',
            'no way home': 'rt-2cxAiPJk',
            'far from home': 'nt8kUcMA_oQ',
            'homecoming': '39udgPcKBAc',
            'endgame': 'TcMBFSGVi1c',
            'infinity war': '6ZfuNTqbHE8'
        };

        const lowerQuery = query.toLowerCase();
        let videoId = null;

        for (const [key, value] of Object.entries(trailerMap)) {
            if (lowerQuery.includes(key) || key.includes(lowerQuery)) {
                videoId = value;
                break;
            }
        }

        if (videoId) {
            return [{
                id: videoId,
                title: `${query} - Trailer`,
                description: `Trailer for ${query}`,
                thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                channelTitle: 'YouTube',
                embedUrl: `${YOUTUBE_EMBED_BASE}/${videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
                isFallback: true
            }];
        }

        return Array.from({ length: Math.min(maxResults, 3) }, (_, i) => ({
            id: `fallback_${i}`,
            title: `${query} - Search Result ${i + 1}`,
            description: 'YouTube API key required for full search results',
            thumbnail: 'https://via.placeholder.com/320x180?text=YouTube+Search',
            channelTitle: 'YouTube',
            embedUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
            watchUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
            isFallback: true
        }));
    }

    async getMovieTrailers(title, year = null) {
        let searchQuery = `${title} movie trailer`;
        if (year) searchQuery += ` ${year}`;
        const results = await this.searchVideos(searchQuery, 5);
        // Filter for trailers
        const trailers = results.filter(v => {
            const t = v.title.toLowerCase();
            return t.includes('trailer') || t.includes('teaser') || t.includes('official') || t.includes('preview');
        });
        return trailers.length > 0 ? trailers : results;
    }

    async getTVShowTrailers(title, season = null) {
        let searchQuery = `${title} TV show trailer`;
        if (season) searchQuery += ` season ${season}`;
        const results = await this.searchVideos(searchQuery, 5);
        const trailers = results.filter(v => {
            const t = v.title.toLowerCase();
            return t.includes('trailer') || t.includes('teaser') || t.includes('official') || t.includes('preview');
        });
        return trailers.length > 0 ? trailers : results;
    }

    async getSoundtrack(title) {
        const searchQuery = `${title} soundtrack`;
        const results = await this.searchVideos(searchQuery, 8);
        const music = results.filter(v => {
            const t = v.title.toLowerCase();
            return t.includes('soundtrack') || t.includes('score') || t.includes('music') || 
                   t.includes('song') || t.includes('theme') || t.includes('official audio');
        });
        return music.length > 0 ? music : results;
    }

    async getVideoDetails(videoId) {
        if (!this.isConfigured) {
            return {
                id: videoId,
                embedUrl: `${YOUTUBE_EMBED_BASE}/${videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`
            };
        }

        try {
            const response = await this.youtube.videos.list({
                part: ['snippet', 'contentDetails', 'statistics'],
                id: [videoId]
            });

            if (!response.data.items || response.data.items.length === 0) {
                throw new Error('Video not found');
            }

            const item = response.data.items[0];
            return {
                id: videoId,
                title: item.snippet.title,
                description: item.snippet.description,
                thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
                channelTitle: item.snippet.channelTitle,
                publishedAt: item.snippet.publishedAt,
                duration: item.contentDetails.duration,
                viewCount: item.statistics.viewCount,
                likeCount: item.statistics.likeCount,
                embedUrl: `${YOUTUBE_EMBED_BASE}/${videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`
            };
        } catch (error) {
            console.error('YouTube video details error:', error.message);
            return {
                id: videoId,
                embedUrl: `${YOUTUBE_EMBED_BASE}/${videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`
            };
        }
    }
}

// =============================================================================
// TMDB PROXY
// =============================================================================
class TMDBProxy {
    constructor() {
        this.youtubeClient = new YouTubeClient();
    }

    async getMovie(id) {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/movie/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits,images,similar,videos,keywords`
            );
            const movie = response.data;

            // Add YouTube trailers
            const trailers = await this.youtubeClient.getMovieTrailers(
                movie.title, 
                new Date(movie.release_date).getFullYear()
            );

            return {
                ...movie,
                youtube: {
                    trailers: trailers,
                    embed: (trailers.length > 0) ? {
                        url: trailers[0].embedUrl,
                        watchUrl: trailers[0].watchUrl
                    } : null
                }
            };
        } catch (error) {
            throw new Error(`TMDB movie fetch failed: ${error.message}`);
        }
    }

    async getTV(id) {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/tv/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits,images,similar,videos,keywords`
            );
            const show = response.data;

            const trailers = await this.youtubeClient.getTVShowTrailers(show.name);

            return {
                ...show,
                youtube: {
                    trailers: trailers,
                    embed: (trailers.length > 0) ? {
                        url: trailers[0].embedUrl,
                        watchUrl: trailers[0].watchUrl
                    } : null
                }
            };
        } catch (error) {
            throw new Error(`TMDB TV fetch failed: ${error.message}`);
        }
    }

    async getTVSeason(tvId, seasonNumber) {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`
            );
            return response.data;
        } catch (error) {
            throw new Error(`TMDB season fetch failed: ${error.message}`);
        }
    }

    async search(query) {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
            );
            return response.data;
        } catch (error) {
            throw new Error(`TMDB search failed: ${error.message}`);
        }
    }

    async discover(category, params = {}) {
        try {
            const queryParams = new URLSearchParams({
                api_key: TMDB_API_KEY,
                ...params
            });
            const response = await axios.get(
                `${TMDB_BASE_URL}/${category}?${queryParams.toString()}`
            );
            return response.data;
        } catch (error) {
            throw new Error(`TMDB discover failed: ${error.message}`);
        }
    }

    async getVideos(id, type = 'movie') {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/${type}/${id}/videos?api_key=${TMDB_API_KEY}`
            );
            return response.data;
        } catch (error) {
            return { results: [] };
        }
    }

    async getSimilar(id, type = 'movie') {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/${type}/${id}/similar?api_key=${TMDB_API_KEY}`
            );
            return response.data;
        } catch (error) {
            return { results: [] };
        }
    }
}

// =============================================================================
// INITIALIZE
// =============================================================================
const tmdbProxy = new TMDBProxy();
const youtubeClient = new YouTubeClient();

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        youtube: {
            configured: youtubeClient.isConfigured,
            apiKey: YOUTUBE_API_KEY ? '✅ Set' : '❌ Missing'
        },
        tmdb: {
            configured: !!TMDB_API_KEY,
            apiKey: TMDB_API_KEY ? '✅ Set' : '❌ Missing'
        }
    });
});

// Root
app.get('/', (req, res) => {
    res.json({
        name: 'VIDROOM Backend',
        version: '2.0.0',
        endpoints: {
            health: '/api/health',
            tmdb: '/api/tmdb/{movie|tv|search|discover}',
            youtube: '/api/youtube/{search|trailers|soundtrack}',
            stream: '/api/stream/{movie|tv}/{id}'
        }
    });
});

// =============================================================================
// TMDB PROXY ENDPOINTS
// =============================================================================

app.get('/api/tmdb/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await tmdbProxy.getMovie(id);
        res.json(data);
    } catch (error) {
        console.error('TMDB movie error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/tv/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await tmdbProxy.getTV(id);
        res.json(data);
    } catch (error) {
        console.error('TMDB TV error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/tv/:id/season/:season', async (req, res) => {
    try {
        const { id, season } = req.params;
        const data = await tmdbProxy.getTVSeason(id, parseInt(season));
        res.json(data);
    } catch (error) {
        console.error('TMDB season error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/search/multi', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'Missing query parameter' });
        }
        const data = await tmdbProxy.search(query);
        res.json(data);
    } catch (error) {
        console.error('TMDB search error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/discover/:category', async (req, res) => {
    try {
        const { category } = req.params;
        const { page, with_genres, sort_by } = req.query;
        
        const params = {
            page: page || 1,
            with_genres: with_genres || '',
            sort_by: sort_by || 'popularity.desc'
        };
        
        const data = await tmdbProxy.discover(category, params);
        res.json(data);
    } catch (error) {
        console.error('TMDB discover error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/:type/:id/videos', async (req, res) => {
    try {
        const { type, id } = req.params;
        const data = await tmdbProxy.getVideos(id, type);
        res.json(data);
    } catch (error) {
        console.error('TMDB videos error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/movie/:id/similar', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await tmdbProxy.getSimilar(id, 'movie');
        res.json(data);
    } catch (error) {
        console.error('TMDB similar error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Popular endpoints
app.get('/api/tmdb/movie/popular', async (req, res) => {
    try {
        const { page = 1 } = req.query;
        const data = await tmdbProxy.discover('movie', { page, sort_by: 'popularity.desc' });
        res.json(data);
    } catch (error) {
        console.error('Popular movies error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/tv/popular', async (req, res) => {
    try {
        const { page = 1 } = req.query;
        const data = await tmdbProxy.discover('tv', { page, sort_by: 'popularity.desc' });
        res.json(data);
    } catch (error) {
        console.error('Popular TV error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/movie/top_rated', async (req, res) => {
    try {
        const { page = 1 } = req.query;
        const data = await tmdbProxy.discover('movie', { page, sort_by: 'vote_average.desc', 'vote_count.gte': 100 });
        res.json(data);
    } catch (error) {
        console.error('Top rated error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/movie/now_playing', async (req, res) => {
    try {
        const { page = 1 } = req.query;
        const data = await tmdbProxy.discover('movie', { 
            page, 
            sort_by: 'primary_release_date.desc',
            'primary_release_date.lte': new Date().toISOString().split('T')[0]
        });
        res.json(data);
    } catch (error) {
        console.error('Now playing error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// YOUTUBE API ENDPOINTS
// =============================================================================

app.get('/api/youtube/search', async (req, res) => {
    try {
        const { q, maxResults = 10 } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Missing search query (q)' });
        }

        const results = await youtubeClient.searchVideos(q, parseInt(maxResults));
        res.json({
            query: q,
            results: results,
            total: results.length
        });
    } catch (error) {
        console.error('YouTube search error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/youtube/trailers/movie', async (req, res) => {
    try {
        const { title, year } = req.query;
        if (!title) {
            return res.status(400).json({ error: 'Missing movie title' });
        }

        const trailers = await youtubeClient.getMovieTrailers(title, year ? parseInt(year) : null);
        res.json({
            movie: title,
            year: year || null,
            trailers: trailers
        });
    } catch (error) {
        console.error('Movie trailers error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/youtube/trailers/tv', async (req, res) => {
    try {
        const { title, season } = req.query;
        if (!title) {
            return res.status(400).json({ error: 'Missing TV show title' });
        }

        const trailers = await youtubeClient.getTVShowTrailers(title, season ? parseInt(season) : null);
        res.json({
            show: title,
            season: season || null,
            trailers: trailers
        });
    } catch (error) {
        console.error('TV trailers error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/youtube/soundtrack', async (req, res) => {
    try {
        const { title } = req.query;
        if (!title) {
            return res.status(400).json({ error: 'Missing movie title' });
        }

        const soundtrack = await youtubeClient.getSoundtrack(title);
        res.json({
            movie: title,
            soundtrack: soundtrack
        });
    } catch (error) {
        console.error('Soundtrack error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/youtube/video/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const details = await youtubeClient.getVideoDetails(id);
        res.json(details);
    } catch (error) {
        console.error('Video details error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// STREAM ENDPOINTS
// =============================================================================

app.get('/api/stream/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const { season, episode } = req.query;
        
        let url;
        if (type === 'tv') {
            const s = season || 1;
            const e = episode || 1;
            url = `${VSRC_BASE_URL}/tv/${id}/${s}/${e}`;
        } else {
            url = `${VSRC_BASE_URL}/movie/${id}`;
        }
        
        res.json({
            url,
            type,
            id,
            season: season || null,
            episode: episode || null
        });
    } catch (error) {
        console.error('Stream error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    VIDROOM BACKEND v2.0                    ║
║         TMDB Proxy · YouTube Integration · Cache          ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://${HOST}:${PORT}                                ║
║  YouTube API: ${youtubeClient.isConfigured ? '✅ Configured' : '❌ Missing'}        ║
║  TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}            ║
╚════════════════════════════════════════════════════════════╝
    `);
});
