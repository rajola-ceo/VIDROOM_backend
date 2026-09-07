// =============================================================================
// server.js — VIDROOM Streaming Server
// Complete system with TMDB proxy, video source extraction, and caching
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
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_API_KEY = process.env.TMDB_API_KEY || '480f73d92f9395eb2140f092c746b3bc';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const VSRC_BASE_URL = 'https://vidsrc.sbs/embed';
const CACHE_DURATION = 86400; // 24 hours in seconds
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

// Directories
const CACHE_DIR = path.join(__dirname, 'cache');
const LOG_DIR = path.join(__dirname, 'logs');

[CACHE_DIR, LOG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =============================================================================
// MIDDLEWARE
// =============================================================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            frameSrc: ["'self'", "https://vidsrc.sbs", "https://www.youtube.com"],
            imgSrc: ["'self'", "data:", "https://image.tmdb.org"],
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
    windowMs: 60 * 1000, // 1 minute
    max: 150, // 150 requests per minute
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// =============================================================================
// LOGGING SYSTEM
// =============================================================================
function logInfo(context, message, data = {}) {
    console.log(`📌 [${context}]`, message, Object.keys(data).length ? JSON.stringify(data) : '');
}

function logError(context, error, metadata = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        context,
        error: error.message,
        stack: error.stack,
        metadata
    };
    
    const logFile = path.join(LOG_DIR, `error-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    console.error(`❌ [${context}]`, error.message);
}

// =============================================================================
// CACHE SYSTEM
// =============================================================================
const linkCache = new NodeCache({
    stdTTL: CACHE_DURATION,
    checkperiod: 3600,
    useClones: false
});

const CACHE_FILE = path.join(CACHE_DIR, 'links-cache.json');

function loadCacheFromDisk() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            Object.entries(data).forEach(([key, value]) => {
                linkCache.set(key, value);
            });
            console.log(`✅ Loaded ${Object.keys(data).length} cached entries`);
        }
    } catch (error) {
        console.error('Failed to load cache:', error.message);
    }
}

function saveCacheToDisk() {
    try {
        const keys = linkCache.keys();
        const cacheData = {};
        keys.forEach(key => {
            cacheData[key] = linkCache.get(key);
        });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`💾 Saved ${keys.length} entries to disk cache`);
    } catch (error) {
        console.error('Failed to save cache:', error.message);
    }
}

setInterval(saveCacheToDisk, 5 * 60 * 1000);
loadCacheFromDisk();

// =============================================================================
// AXIOS INSTANCE
// =============================================================================
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               error.response?.status >= 500;
    }
});

const axiosWithProxy = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: status => status < 400,
    headers: {
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    }
});

// =============================================================================
// TITLE MATCHER
// =============================================================================
class TitleMatcher {
    constructor() {
        this.minScore = 0.7;
    }

    calculateSimilarity(title1, title2) {
        const normalize = (str) => {
            return str.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        };

        const a = normalize(title1);
        const b = normalize(title2);

        if (a === b) return 1.0;

        if (a.includes(b) || b.includes(a)) {
            const longer = a.length > b.length ? a : b;
            const shorter = a.length > b.length ? b : a;
            return shorter.length / longer.length;
        }

        const distance = this.levenshteinDistance(a, b);
        const maxLength = Math.max(a.length, b.length);
        return 1 - (distance / maxLength);
    }

    levenshteinDistance(a, b) {
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    isMatch(sourceTitle, sourceYear, targetTitle, targetYear) {
        let score = this.calculateSimilarity(sourceTitle, targetTitle);
        
        if (sourceYear && targetYear && Math.abs(sourceYear - targetYear) <= 1) {
            score += 0.15;
        }
        
        if (sourceYear && targetYear && Math.abs(sourceYear - targetYear) > 2) {
            score -= 0.3;
        }
        
        return Math.min(1, Math.max(0, score)) >= this.minScore;
    }
}

// =============================================================================
// SOURCE EXTRACTORS
// =============================================================================

class VidsrcExtractor {
    constructor() {
        this.name = 'vidsrc';
    }

    async extract(movieId, title, year) {
        const embedUrl = `https://vidsrc.to/embed/movie/${movieId}`;
        const links = [];

        try {
            const response = await axiosWithProxy.get(embedUrl);
            const $ = cheerio.load(response.data);

            // Extract from video sources
            $('source').each((i, el) => {
                const src = $(el).attr('src');
                if (src && src.includes('.mp4')) {
                    links.push({
                        url: src,
                        quality: this.detectQuality(src),
                        type: 'mp4'
                    });
                }
            });

            // Extract from iframes
            $('iframe').each((i, el) => {
                const src = $(el).attr('src');
                if (src && (src.includes('embed') || src.includes('play'))) {
                    links.push({
                        url: src,
                        type: 'embed'
                    });
                }
            });

            // Extract from data attributes
            $('[data-src], [data-url], [data-video]').each((i, el) => {
                const dataSrc = $(el).attr('data-src') || $(el).attr('data-url') || $(el).attr('data-video');
                if (dataSrc && dataSrc.includes('http')) {
                    links.push({
                        url: dataSrc,
                        quality: this.detectQuality(dataSrc),
                        type: 'mp4'
                    });
                }
            });

            return {
                source: this.name,
                links: this.deduplicateLinks(links)
            };
        } catch (error) {
            throw new Error(`Vidsrc extraction failed: ${error.message}`);
        }
    }

    detectQuality(url) {
        if (url.includes('1080') || url.includes('1080p')) return '1080p';
        if (url.includes('720') || url.includes('720p')) return '720p';
        if (url.includes('480') || url.includes('480p')) return '480p';
        return 'auto';
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}

class EmbedExtractor {
    constructor() {
        this.name = 'embed';
    }

    async extract(movieId, title, year) {
        const domains = [
            `https://multiembed.mov/directstream.php?video_id=${movieId}&s=movie`,
            `https://embed.su/embed/movie/${movieId}`,
            `https://moviesapi.club/movie/${movieId}`
        ];

        const links = [];

        for (const domain of domains) {
            try {
                const response = await axiosWithProxy.get(domain, {
                    headers: {
                        'Referer': 'https://www.google.com/',
                        'Origin': 'https://www.google.com'
                    }
                });

                // JSON responses
                if (typeof response.data === 'object') {
                    if (response.data.sources) {
                        response.data.sources.forEach(source => {
                            if (source.file || source.url) {
                                links.push({
                                    url: source.file || source.url,
                                    quality: source.label || source.quality || 'auto',
                                    type: 'mp4'
                                });
                            }
                        });
                    }
                }

                // HTML parsing
                const $ = cheerio.load(response.data);

                $('video source, video[src], .player source, .video-js source').each((i, el) => {
                    const src = $(el).attr('src') || $(el).parent().attr('src');
                    if (src && src.match(/\.(mp4|m3u8)/)) {
                        links.push({
                            url: src,
                            quality: $(el).attr('data-quality') || 'auto',
                            type: src.includes('.m3u8') ? 'hls' : 'mp4'
                        });
                    }
                });

                // Script extraction
                const scripts = $('script').map((i, el) => $(el).html()).get();
                scripts.forEach(script => {
                    if (script) {
                        const urlMatches = script.match(/https?:\/\/[^"'\s]+\.(mp4|m3u8)[^"'\s]*/g);
                        if (urlMatches) {
                            urlMatches.forEach(url => {
                                links.push({
                                    url: url,
                                    quality: url.includes('1080') ? '1080p' : 
                                            url.includes('720') ? '720p' : 'auto',
                                    type: url.includes('.m3u8') ? 'hls' : 'mp4'
                                });
                            });
                        }
                    }
                });

            } catch (error) {
                continue;
            }
        }

        return {
            source: this.name,
            links: this.deduplicateLinks(links)
        };
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}

class MultiEmbedExtractor {
    constructor() {
        this.name = 'multisrc';
    }

    async extract(movieId, title, year) {
        const baseUrls = [
            `https://vidsrc.xyz/embed/movie/${movieId}`,
            `https://www.2embed.cc/embed/${movieId}`,
            `https://autoembed.co/movie/tmdb/${movieId}`,
            `https://dbgo.fun/movie/${movieId}`
        ];

        const links = [];

        for (const baseUrl of baseUrls) {
            try {
                const response = await axiosWithProxy.get(baseUrl, {
                    headers: {
                        'Referer': 'https://www.google.com/'
                    }
                });

                const $ = cheerio.load(response.data);

                const patterns = [
                    'iframe[src]',
                    'source[src]',
                    '[data-player]',
                    '[data-video]',
                    '[data-src]',
                    '#player source',
                    '.player source'
                ];

                patterns.forEach(pattern => {
                    $(pattern).each((i, el) => {
                        let src = $(el).attr('src') || 
                                 $(el).attr('data-player') || 
                                 $(el).attr('data-video') || 
                                 $(el).attr('data-src');
                        
                        if (src) {
                            if (src.startsWith('//')) {
                                src = 'https:' + src;
                            } else if (src.startsWith('/')) {
                                src = new URL(src, baseUrl).href;
                            }
                            
                            if (src.match(/\.(mp4|m3u8)/) || src.includes('embed') || src.includes('video')) {
                                links.push({
                                    url: src,
                                    quality: this.detectQuality(src),
                                    type: src.includes('.m3u8') ? 'hls' : 
                                          src.includes('embed') ? 'embed' : 'mp4'
                                });
                            }
                        }
                    });
                });

                // JSON configs in scripts
                const scripts = $('script').map((i, el) => $(el).html()).get();
                scripts.forEach(script => {
                    if (script && script.includes('sources') && script.includes('file')) {
                        try {
                            const jsonMatch = script.match(/sources:\s*(\[.*?\])/s);
                            if (jsonMatch) {
                                const sources = JSON.parse(jsonMatch[1].replace(/'/g, '"'));
                                sources.forEach(source => {
                                    if (source.file) {
                                        links.push({
                                            url: source.file,
                                            quality: source.label || 'auto',
                                            type: 'mp4'
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            // Ignore JSON parse errors
                        }
                    }
                });

            } catch (error) {
                continue;
            }
        }

        return {
            source: this.name,
            links: this.deduplicateLinks(links)
        };
    }

    detectQuality(url) {
        if (url.includes('1080') || url.includes('1080p')) return '1080p';
        if (url.includes('720') || url.includes('720p')) return '720p';
        if (url.includes('480') || url.includes('480p')) return '480p';
        return 'auto';
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}

// =============================================================================
// LINK EXTRACTOR MAIN
// =============================================================================
class LinkExtractor {
    constructor() {
        this.sources = [
            new VidsrcExtractor(),
            new EmbedExtractor(),
            new MultiEmbedExtractor()
        ];
    }

    async extractLinks(movieId, title, year) {
        const cacheKey = `movie_${movieId}_${year}`;
        const cached = linkCache.get(cacheKey);
        
        if (cached) {
            logInfo('CACHE', `Cache hit for ${title}`, { movieId });
            return { ...cached, cached: true };
        }

        logInfo('EXTRACT', `Extracting links for ${title} (${year})`);
        
        const results = [];

        const extractPromises = this.sources.map(async (source) => {
            try {
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Source timeout')), 15000);
                });

                const sourcePromise = source.extract(movieId, title, year);
                const result = await Promise.race([sourcePromise, timeoutPromise]);
                
                if (result && result.links && result.links.length > 0) {
                    results.push(result);
                }
            } catch (error) {
                logError('EXTRACTOR', error, { source: source.name, movieId });
            }
        });

        await Promise.allSettled(extractPromises);

        if (results.length === 0) {
            return { error: 'No working links found' };
        }

        const output = {
            movieId,
            title,
            year,
            timestamp: Date.now(),
            sources: results,
            primary: results[0]?.links[0] || null
        };

        linkCache.set(cacheKey, output);
        
        return output;
    }
}

// =============================================================================
// TMDB PROXY
// =============================================================================
class TMDBProxy {
    async getMovie(id) {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/movie/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits,images,similar,videos`
            );
            return response.data;
        } catch (error) {
            throw new Error(`TMDB movie fetch failed: ${error.message}`);
        }
    }

    async getTV(id) {
        try {
            const response = await axios.get(
                `${TMDB_BASE_URL}/tv/${id}?api_key=${TMDB_API_KEY}&append_to_response=credits,images,similar,videos`
            );
            return response.data;
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
}

// =============================================================================
// DOWNLOAD MANAGER
// =============================================================================
class DownloadManager {
    constructor() {
        this.extractor = new LinkExtractor();
        this.tmdb = new TMDBProxy();
        this.matcher = new TitleMatcher();
    }

    async getDownloadLinks(movieId, title, year) {
        try {
            const links = await this.extractor.extractLinks(movieId, title, year);
            
            if (links.error) {
                throw new Error(links.error);
            }

            const processed = this.processLinks(links);
            return processed;

        } catch (error) {
            logError('DOWNLOAD_MANAGER', error, { movieId, title });
            throw error;
        }
    }

    processLinks(links) {
        const processed = {
            movieId: links.movieId,
            title: links.title,
            year: links.year,
            timestamp: links.timestamp,
            cached: links.cached || false,
            sources: [],
            qualityOptions: {}
        };

        for (const source of links.sources) {
            const sourceLinks = source.links.map(link => ({
                ...link,
                quality: this.normalizeQuality(link.quality)
            }));

            sourceLinks.sort((a, b) => this.qualityRank(b.quality) - this.qualityRank(a.quality));

            processed.sources.push({
                source: source.source,
                links: sourceLinks,
                bestQuality: sourceLinks[0]?.quality || 'unknown'
            });
        }

        processed.sources.sort((a, b) => 
            this.qualityRank(b.bestQuality) - this.qualityRank(a.bestQuality)
        );

        processed.qualityOptions = this.generateQualityOptions(processed.sources);

        return processed;
    }

    normalizeQuality(quality) {
        if (!quality || quality === 'auto') return '720p';
        
        quality = quality.toString().toLowerCase();
        
        if (quality.includes('1080') || quality.includes('1080p')) return '1080p';
        if (quality.includes('720') || quality.includes('720p')) return '720p';
        if (quality.includes('480') || quality.includes('480p')) return '480p';
        if (quality.includes('360') || quality.includes('360p')) return '360p';
        
        return '720p';
    }

    qualityRank(quality) {
        const ranks = {
            '1080p': 5,
            '720p': 4,
            '480p': 3,
            '360p': 2,
            'unknown': 1
        };
        return ranks[quality] || 1;
    }

    generateQualityOptions(sources) {
        const options = {};
        
        for (const source of sources) {
            for (const link of source.links) {
                if (!options[link.quality]) {
                    options[link.quality] = [];
                }
                options[link.quality].push({
                    source: source.source,
                    url: link.url,
                    type: link.type
                });
            }
        }

        const sorted = {};
        const qualities = ['1080p', '720p', '480p', '360p'];
        
        for (const quality of qualities) {
            if (options[quality]) {
                sorted[quality] = options[quality];
            }
        }

        return sorted;
    }

    async getStreamUrl(movieId, type, season, episode) {
        const tmdbId = movieId;
        
        if (type === 'tv') {
            return `${VSRC_BASE_URL}/tv/${tmdbId}/${season}/${episode}`;
        }
        return `${VSRC_BASE_URL}/movie/${tmdbId}`;
    }
}

// =============================================================================
// INITIALIZE MANAGERS
// =============================================================================
const downloadManager = new DownloadManager();
const tmdbProxy = new TMDBProxy();

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        cacheSize: linkCache.keys().length,
        tmdbConfigured: !!TMDB_API_KEY && TMDB_API_KEY !== 'YOUR_TMDB_API_KEY_HERE'
    });
});

// TMDB Proxy Endpoints
app.get('/api/tmdb/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await tmdbProxy.getMovie(id);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_MOVIE', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/tv/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await tmdbProxy.getTV(id);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_TV', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/tv/:id/season/:season', async (req, res) => {
    try {
        const { id, season } = req.params;
        const data = await tmdbProxy.getTVSeason(id, parseInt(season));
        res.json(data);
    } catch (error) {
        logError('API_TMDB_SEASON', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'Missing query parameter' });
        }
        const data = await tmdbProxy.search(query);
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
        
        const data = await tmdbProxy.discover(category, params);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_DISCOVER', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/:type/:id/videos', async (req, res) => {
    try {
        const { type, id } = req.params;
        const data = await tmdbProxy.getVideos(id, type);
        res.json(data);
    } catch (error) {
        logError('API_TMDB_VIDEOS', error);
        res.status(500).json({ error: error.message });
    }
});

// Popular and trending endpoints
app.get('/api/tmdb/movie/popular', async (req, res) => {
    try {
        const { page = 1 } = req.query;
        const data = await tmdbProxy.discover('movie', { 
            page, 
            sort_by: 'popularity.desc' 
        });
        res.json(data);
    } catch (error) {
        logError('API_POPULAR', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/tv/popular', async (req, res) => {
    try {
        const { page = 1 } = req.query;
        const data = await tmdbProxy.discover('tv', { 
            page, 
            sort_by: 'popularity.desc' 
        });
        res.json(data);
    } catch (error) {
        logError('API_TV_POPULAR', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tmdb/movie/top_rated', async (req, res) => {
    try {
        const { page = 1 } = req.query;
        const data = await tmdbProxy.discover('movie', { 
            page, 
            sort_by: 'vote_average.desc',
            'vote_count.gte': 100
        });
        res.json(data);
    } catch (error) {
        logError('API_TOP_RATED', error);
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
        logError('API_NOW_PLAYING', error);
        res.status(500).json({ error: error.message });
    }
});

// Get video source URL
app.get('/api/stream/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const { season, episode } = req.query;
        
        let url;
        if (type === 'tv') {
            const s = season || 1;
            const e = episode || 1;
            url = await downloadManager.getStreamUrl(id, type, s, e);
        } else {
            url = await downloadManager.getStreamUrl(id, 'movie');
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

// Get download options
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const movieRes = await tmdbProxy.getMovie(id);
        const movie = movieRes;
        const year = new Date(movie.release_date).getFullYear();

        const links = await downloadManager.getDownloadLinks(id, movie.title, year);
        
        const qualityOptions = Object.entries(links.qualityOptions || {}).map(([quality, sources]) => {
            const runtime = movie.runtime || 120;
            const sizePerMin = quality === '1080p' ? 25 : 
                              quality === '720p' ? 12 : 
                              quality === '480p' ? 8 : 5;
            const sizeMB = Math.round(runtime * sizePerMin);

            return {
                quality,
                label: `${quality} - H.264`,
                size: sizeMB,
                sizeText: sizeMB >= 1024 ? `${(sizeMB/1024).toFixed(2)} GB` : `${sizeMB} MB`,
                sources: sources.map(s => s.url),
                available: true
            };
        });

        res.json({
            movie: {
                id: movie.id,
                title: movie.title,
                year,
                runtime: movie.runtime || 120,
                poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                backdrop: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null
            },
            options: qualityOptions,
            cached: links.cached || false,
            timestamp: links.timestamp
        });

    } catch (error) {
        logError('API_DOWNLOAD_OPTIONS', error);
        res.status(500).json({ 
            error: 'Failed to fetch download options',
            details: error.message 
        });
    }
});

// Initiate download
app.get('/api/download', async (req, res) => {
    try {
        const { movieId, quality, title } = req.query;

        if (!movieId || !quality || !title) {
            return res.status(400).json({ 
                error: 'Missing required parameters: movieId, quality, title' 
            });
        }

        const downloadInfo = await downloadManager.getDownloadLinks(movieId, title, null);
        
        if (!downloadInfo.qualityOptions[quality]) {
            return res.status(404).json({ 
                error: `Quality ${quality} not available` 
            });
        }

        const sources = downloadInfo.qualityOptions[quality];
        let workingUrl = null;

        for (const source of sources) {
            try {
                const response = await axios.head(source.url, {
                    timeout: 10000,
                    maxRedirects: 5,
                    validateStatus: status => status < 400
                });

                if (response.status === 200 || response.status === 302) {
                    workingUrl = source.url;
                    break;
                }
            } catch (error) {
                continue;
            }
        }

        if (!workingUrl) {
            return res.status(404).json({ 
                error: 'No working download link found for this quality' 
            });
        }

        res.json({
            success: true,
            url: workingUrl,
            quality: quality,
            source: sources[0]?.source || 'unknown',
            filename: `${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4`
        });

    } catch (error) {
        logError('API_DOWNLOAD', error);
        res.status(500).json({ 
            error: 'Download failed',
            details: error.message 
        });
    }
});

// Proxy download (for CORS issues)
app.get('/api/download/proxy', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'Missing URL parameter' });
        }

        const response = await axios({
            method: 'GET',
            url: decodeURIComponent(url),
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Referer': 'https://www.google.com/'
            }
        });

        Object.entries(response.headers).forEach(([key, value]) => {
            if (key.toLowerCase().startsWith('content-')) {
                res.setHeader(key, value);
            }
        });

        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
        response.data.pipe(res);

    } catch (error) {
        logError('PROXY_DOWNLOAD', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy download failed' });
        }
    }
});

// Cache management
app.get('/api/cache/status', (req, res) => {
    const keys = linkCache.keys();
    res.json({
        totalEntries: keys.length,
        keys: keys.slice(0, 20),
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

app.post('/api/cache/clear', (req, res) => {
    linkCache.flushAll();
    saveCacheToDisk();
    res.json({ success: true, message: 'Cache cleared' });
});

// =============================================================================
// BACKGROUND TASKS
// =============================================================================
async function refreshCache() {
    const keys = linkCache.keys();
    const refreshKeys = keys.filter(key => {
        const value = linkCache.get(key);
        const age = Date.now() - (value.timestamp || 0);
        return age > 6 * 60 * 60 * 1000;
    });

    for (const key of refreshKeys.slice(0, 5)) {
        try {
            const movieId = key.replace('movie_', '').split('_')[0];
            logInfo('REFRESH', `Refreshing cache for ${movieId}`);
            
            const movieRes = await tmdbProxy.getMovie(movieId);
            const year = new Date(movieRes.release_date).getFullYear();
            
            const links = await downloadManager.extractor.extractLinks(movieId, movieRes.title, year);
            
            if (!links.error) {
                linkCache.set(key, {
                    ...links,
                    timestamp: Date.now()
                });
            }
            
            await new Promise(r => setTimeout(r, 5000));
            
        } catch (error) {
            logError('REFRESH', error, { key });
        }
    }
}

setInterval(refreshCache, 60 * 60 * 1000);

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    VIDROOM BACKEND v2.0                    ║
║         TMDB Proxy · Video Extraction · Cache             ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://${HOST}:${PORT}                                ║
║  Cache: ${linkCache.keys().length} entries                         ║
║  Sources: vidsrc, embed, multisrc                          ║
║  TMDB Key: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}        ║
╚════════════════════════════════════════════════════════════╝
    `);
});

// =============================================================================
// CLEANUP
// =============================================================================
process.on('SIGINT', () => {
    logInfo('SHUTDOWN', 'Saving cache and cleaning up...');
    saveCacheToDisk();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logInfo('SHUTDOWN', 'Saving cache and cleaning up...');
    saveCacheToDisk();
    process.exit(0);
});
