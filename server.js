// =============================================================================
// server.js — VIDROOM Streaming Server with YouTube Integration
// =============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_API_KEY = process.env.TMDB_API_KEY || '480f73d92f9395eb2140f092c746b3bc';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// YouTube API Configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_EMBED_BASE = 'https://www.youtube.com/embed';

// Vidsrc Configuration
const VSRC_BASE_URL = 'https://vidsrc.sbs/embed';

// Cache Configuration
const CACHE_DURATION = 86400; // 24 hours

// =============================================================================
// YOUTUBE CLIENT
// =============================================================================
class YouTubeClient {
    constructor() {
        this.apiKey = YOUTUBE_API_KEY;
        this.youtube = google.youtube({
            version: 'v3',
            auth: this.apiKey
        });
        this.cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache for YouTube
        this.isConfigured = !!this.apiKey && this.apiKey !== '';
    }

    async searchVideos(query, maxResults = 10) {
        if (!this.isConfigured) {
            // Fallback: Use direct embed URLs without API
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
                thumbnail: item.snippet.thumbnails.medium.url,
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

    async getVideoDetails(videoId) {
        if (!this.isConfigured) {
            return {
                id: videoId,
                embedUrl: `${YOUTUBE_EMBED_BASE}/${videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`
            };
        }

        const cacheKey = `video_${videoId}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        try {
            const response = await this.youtube.videos.list({
                part: ['snippet', 'contentDetails', 'statistics'],
                id: [videoId]
            });

            if (!response.data.items || response.data.items.length === 0) {
                throw new Error('Video not found');
            }

            const item = response.data.items[0];
            const result = {
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

            this.cache.set(cacheKey, result);
            return result;
        } catch (error) {
            console.error('YouTube video details error:', error.message);
            return {
                id: videoId,
                embedUrl: `${YOUTUBE_EMBED_BASE}/${videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`
            };
        }
    }

    async getMovieTrailers(movieTitle, year = null) {
        let searchQuery = `${movieTitle} movie trailer`;
        if (year) {
            searchQuery += ` ${year}`;
        }

        const results = await this.searchVideos(searchQuery, 5);
        
        // Filter for trailers specifically
        const trailers = results.filter(v => {
            const title = v.title.toLowerCase();
            return title.includes('trailer') || 
                   title.includes('teaser') || 
                   title.includes('official') ||
                   title.includes('preview');
        });

        return trailers.length > 0 ? trailers : results;
    }

    async getTVShowTrailers(showTitle, season = null) {
        let searchQuery = `${showTitle} TV show trailer`;
        if (season) {
            searchQuery += ` season ${season}`;
        }

        const results = await this.searchVideos(searchQuery, 5);
        
        const trailers = results.filter(v => {
            const title = v.title.toLowerCase();
            return title.includes('trailer') || 
                   title.includes('teaser') || 
                   title.includes('official') ||
                   title.includes('preview');
        });

        return trailers.length > 0 ? trailers : results;
    }

    async getSoundtrack(movieTitle) {
        const searchQuery = `${movieTitle} soundtrack`;
        const results = await this.searchVideos(searchQuery, 8);
        
        // Filter for music/soundtrack
        const music = results.filter(v => {
            const title = v.title.toLowerCase();
            return title.includes('soundtrack') || 
                   title.includes('score') || 
                   title.includes('music') ||
                   title.includes('song') ||
                   title.includes('theme');
        });

        return music.length > 0 ? music : results;
    }

    async getMusicVideos(query, maxResults = 10) {
        return await this.searchVideos(query, maxResults);
    }

    getFallbackResults(query, maxResults = 10) {
        // Return embed URLs without API validation
        const results = [];
        const searchTerm = encodeURIComponent(query);
        for (let i = 0; i < maxResults; i++) {
            // This is a placeholder - actual search requires YouTube API
            results.push({
                id: `fallback_${i}`,
                title: `${query} - Search Result ${i + 1}`,
                description: 'Search result from YouTube (API key required for full results)',
                thumbnail: 'https://via.placeholder.com/320x180?text=YouTube',
                channelTitle: 'YouTube',
                embedUrl: `https://www.youtube.com/embed?q=${searchTerm}`,
                watchUrl: `https://www.youtube.com/results?search_query=${searchTerm}`,
                isFallback: true
            });
        }
        return results;
    }
}

// =============================================================================
// YOUTUBE EMBED GENERATOR (No API Key Required)
// =============================================================================
class YouTubeEmbedGenerator {
    constructor() {
        this.embedBase = YOUTUBE_EMBED_BASE;
    }

    // Generate direct embed URL from video ID
    getEmbedUrl(videoId, options = {}) {
        const params = new URLSearchParams();
        
        if (options.autoplay) params.append('autoplay', '1');
        if (options.controls !== undefined) params.append('controls', options.controls ? '1' : '0');
        if (options.rel !== undefined) params.append('rel', options.rel ? '1' : '0');
        if (options.modestbranding !== undefined) params.append('modestbranding', options.modestbranding ? '1' : '0');
        if (options.showinfo !== undefined) params.append('showinfo', options.showinfo ? '1' : '0');
        if (options.start) params.append('start', options.start);
        if (options.end) params.append('end', options.end);
        if (options.loop) params.append('loop', '1');
        if (options.playlist) params.append('playlist', options.playlist);
        
        const paramString = params.toString();
        return `${this.embedBase}/${videoId}${paramString ? '?' + paramString : ''}`;
    }

    // Generate embed URL with search query
    getSearchEmbed(query) {
        return `${this.embedBase}?q=${encodeURIComponent(query)}`;
    }

    // Get YouTube thumbnail URLs
    getThumbnails(videoId) {
        return {
            default: `https://img.youtube.com/vi/${videoId}/default.jpg`,
            medium: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
            high: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            standard: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
            maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
        };
    }

    // Extract video ID from various YouTube URL formats
    extractVideoId(url) {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }

        return null;
    }
}

// =============================================================================
// YOUTUBE TRAILER CACHE
// =============================================================================
class TrailerCache {
    constructor() {
        this.cache = new NodeCache({ stdTTL: 86400 }); // 24 hours
        this.trailerMap = new Map();
        
        // Pre-cache popular trailer mappings
        this.initializeTrailerMap();
    }

    initializeTrailerMap() {
        // Common movie trailer searches that work well
        const trailers = {
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
            'lord of the rings': 'V75dMMIW2B4'
        };

        Object.entries(trailers).forEach(([key, value]) => {
            this.trailerMap.set(key, value);
        });
    }

    getTrailerId(movieTitle) {
        const lowerTitle = movieTitle.toLowerCase();
        
        // Check exact match
        if (this.trailerMap.has(lowerTitle)) {
            return this.trailerMap.get(lowerTitle);
        }

        // Check partial match
        for (const [key, value] of this.trailerMap) {
            if (lowerTitle.includes(key) || key.includes(lowerTitle)) {
                return value;
            }
        }

        return null;
    }

    setTrailerId(movieTitle, videoId) {
        const lowerTitle = movieTitle.toLowerCase();
        this.trailerMap.set(lowerTitle, videoId);
        this.cache.set(lowerTitle, videoId);
    }
}

// =============================================================================
// TMDB PROXY (with YouTube integration)
// =============================================================================
class TMDBProxy {
    constructor() {
        this.youtubeClient = new YouTubeClient();
        this.youtubeEmbed = new YouTubeEmbedGenerator();
        this.trailerCache = new TrailerCache();
    }

    async getMovie(id) {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/movie/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits,images,similar,videos,keywords`
            );
            const movie = response.data;

            // Add YouTube trailers
            const trailers = await this.getMovieTrailers(movie.title, new Date(movie.release_date).getFullYear());
            
            return {
                ...movie,
                youtube: {
                    trailers: trailers,
                    embed: {
                        url: (trailers.length > 0) ? trailers[0].embedUrl : null,
                        watchUrl: (trailers.length > 0) ? trailers[0].watchUrl : null
                    },
                    thumbnails: (trailers.length > 0) ? this.youtubeEmbed.getThumbnails(trailers[0].id) : null
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

            // Add YouTube trailers
            const trailers = await this.getTVShowTrailers(show.name);

            return {
                ...show,
                youtube: {
                    trailers: trailers,
                    embed: {
                        url: (trailers.length > 0) ? trailers[0].embedUrl : null,
                        watchUrl: (trailers.length > 0) ? trailers[0].watchUrl : null
                    },
                    thumbnails: (trailers.length > 0) ? this.youtubeEmbed.getThumbnails(trailers[0].id) : null
                }
            };
        } catch (error) {
            throw new Error(`TMDB TV fetch failed: ${error.message}`);
        }
    }

    async getMovieTrailers(title, year) {
        // Check cache first
        const cacheKey = `trailer_${title}_${year || ''}`;
        const cached = this.trailerCache.cache.get(cacheKey);
        if (cached) return cached;

        // Check pre-mapped trailers
        const mappedId = this.trailerCache.getTrailerId(title);
        if (mappedId) {
            const trailer = {
                id: mappedId,
                title: `${title} Official Trailer`,
                embedUrl: this.youtubeEmbed.getEmbedUrl(mappedId, { autoplay: false }),
                watchUrl: `https://www.youtube.com/watch?v=${mappedId}`,
                thumbnail: this.youtubeEmbed.getThumbnails(mappedId)
            };
            this.trailerCache.cache.set(cacheKey, [trailer]);
            return [trailer];
        }

        try {
            // Search YouTube for trailers
            const results = await this.youtubeClient.getMovieTrailers(title, year);
            
            // Cache results
            if (results.length > 0) {
                this.trailerCache.cache.set(cacheKey, results);
                // Store first result in map
                if (results[0].id) {
                    this.trailerCache.setTrailerId(title, results[0].id);
                }
            }
            
            return results;
        } catch (error) {
            console.error('Failed to fetch YouTube trailers:', error.message);
            // Return empty array if YouTube fails
            return [];
        }
    }

    async getTVShowTrailers(title, season) {
        const cacheKey = `tv_trailer_${title}_${season || ''}`;
        const cached = this.trailerCache.cache.get(cacheKey);
        if (cached) return cached;

        try {
            const results = await this.youtubeClient.getTVShowTrailers(title, season);
            if (results.length > 0) {
                this.trailerCache.cache.set(cacheKey, results);
            }
            return results;
        } catch (error) {
            console.error('Failed to fetch TV trailers:', error.message);
            return [];
        }
    }

    async getSoundtrack(title) {
        try {
            return await this.youtubeClient.getSoundtrack(title);
        } catch (error) {
            console.error('Failed to fetch soundtrack:', error.message);
            return [];
        }
    }

    async getVideos(id, type = 'movie') {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/${type}/${id}/videos?api_key=${TMDB_API_KEY}`
            );
            
            const videos = response.data.results || [];
            
            // Enhance with YouTube embed URLs
            const enhancedVideos = videos.map(video => {
                if (video.site === 'YouTube') {
                    return {
                        ...video,
                        embedUrl: this.youtubeEmbed.getEmbedUrl(video.key, { autoplay: false }),
                        watchUrl: `https://www.youtube.com/watch?v=${video.key}`,
                        thumbnail: this.youtubeEmbed.getThumbnails(video.key)
                    };
                }
                return video;
            });

            return {
                ...response.data,
                results: enhancedVideos
            };
        } catch (error) {
            return { results: [] };
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
}

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
        'https://vidroom.netlify.app'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 150,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Health check
app.get('/api/health', (req, res) => {
    const youtubeClient = new YouTubeClient();
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        youtube: {
            configured: youtubeClient.isConfigured,
            apiKey: YOUTUBE_API_KEY ? '✅ Set' : '❌ Missing'
        }
    });
});

// =============================================================================
// YOUTUBE API ENDPOINTS
// =============================================================================

// Search YouTube
app.get('/api/youtube/search', async (req, res) => {
    try {
        const { q, maxResults = 10 } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Missing search query (q)' });
        }

        const youtube = new YouTubeClient();
        const results = await youtube.searchVideos(q, parseInt(maxResults));
        res.json({
            query: q,
            results: results,
            total: results.length
        });
    } catch (error) {
        logError('YOUTUBE_SEARCH', error);
        res.status(500).json({ error: error.message });
    }
});

// Get YouTube video details
app.get('/api/youtube/video/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const youtube = new YouTubeClient();
        const details = await youtube.getVideoDetails(id);
        res.json(details);
    } catch (error) {
        logError('YOUTUBE_VIDEO', error);
        res.status(500).json({ error: error.message });
    }
});

// Get movie trailers from YouTube
app.get('/api/youtube/trailers/movie', async (req, res) => {
    try {
        const { title, year } = req.query;
        if (!title) {
            return res.status(400).json({ error: 'Missing movie title' });
        }

        const tmdb = new TMDBProxy();
        const trailers = await tmdb.getMovieTrailers(title, year ? parseInt(year) : null);
        res.json({
            movie: title,
            year: year || null,
            trailers: trailers
        });
    } catch (error) {
        logError('YOUTUBE_TRAILERS_MOVIE', error);
        res.status(500).json({ error: error.message });
    }
});

// Get TV show trailers from YouTube
app.get('/api/youtube/trailers/tv', async (req, res) => {
    try {
        const { title, season } = req.query;
        if (!title) {
            return res.status(400).json({ error: 'Missing TV show title' });
        }

        const tmdb = new TMDBProxy();
        const trailers = await tmdb.getTVShowTrailers(title, season ? parseInt(season) : null);
        res.json({
            show: title,
            season: season || null,
            trailers: trailers
        });
    } catch (error) {
        logError('YOUTUBE_TRAILERS_TV', error);
        res.status(500).json({ error: error.message });
    }
});

// Get soundtrack from YouTube
app.get('/api/youtube/soundtrack', async (req, res) => {
    try {
        const { title } = req.query;
        if (!title) {
            return res.status(400).json({ error: 'Missing movie title' });
        }

        const tmdb = new TMDBProxy();
        const soundtrack = await tmdb.getSoundtrack(title);
        res.json({
            movie: title,
            soundtrack: soundtrack
        });
    } catch (error) {
        logError('YOUTUBE_SOUNDTRACK', error);
        res.status(500).json({ error: error.message });
    }
});

// Generate YouTube embed URL
app.get('/api/youtube/embed', async (req, res) => {
    try {
        const { videoId, autoplay, controls, start, end } = req.query;
        if (!videoId) {
            return res.status(400).json({ error: 'Missing videoId' });
        }

        const embed = new YouTubeEmbedGenerator();
        const url = embed.getEmbedUrl(videoId, {
            autoplay: autoplay === 'true',
            controls: controls !== 'false',
            start: start ? parseInt(start) : null,
            end: end ? parseInt(end) : null
        });

        const thumbnails = embed.getThumbnails(videoId);

        res.json({
            videoId,
            embedUrl: url,
            thumbnails: thumbnails,
            watchUrl: `https://www.youtube.com/watch?v=${videoId}`
        });
    } catch (error) {
        logError('YOUTUBE_EMBED', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// TMDB PROXY ENDPOINTS (with YouTube integration)
// =============================================================================

app.get('/api/tmdb/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const tmdb = new TMDBProxy();
        const data = await tmdb.getMovie(id);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_MOVIE', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/tv/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const tmdb = new TMDBProxy();
        const data = await tmdb.getTV(id);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_TV', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/:type/:id/videos', async (req, res) => {
    try {
        const { type, id } = req.params;
        const tmdb = new TMDBProxy();
        const data = await tmdb.getVideos(id, type);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_VIDEOS', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'Missing query parameter' });
        }
        const tmdb = new TMDBProxy();
        const data = await tmdb.search(query);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_SEARCH', error);
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
        
        const tmdb = new TMDBProxy();
        const data = await tmdb.discover(category, params);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_DISCOVER', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// VSRC STREAM ENDPOINTS
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
        logError('API_STREAM', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// ERROR LOGGING
// =============================================================================
function logError(context, error, metadata = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        context,
        error: error.message,
        stack: error.stack,
        metadata
    };
    
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    
    const logFile = path.join(logDir, `error-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    console.error(`❌ [${context}]`, error.message);
}

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    const youtubeClient = new YouTubeClient();
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    VIDROOM BACKEND v2.1                    ║
║         TMDB Proxy · YouTube Integration · Cache          ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://${HOST}:${PORT}                                ║
║  YouTube API: ${youtubeClient.isConfigured ? '✅ Configured' : '❌ Missing'}        ║
║  TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}            ║
╚════════════════════════════════════════════════════════════╝
    `);
});
