require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse-proxy headers (X-Forwarded-For, X-Forwarded-Proto) when TRUST_PROXY=1 in .env.
// Set to 1 when running behind Nginx/Caddy/Traefik; leave unset for direct exposure.
const TRUST_PROXY = parseInt(process.env.TRUST_PROXY || '0', 10);
if (TRUST_PROXY > 0) {
    app.set('trust proxy', TRUST_PROXY);
}

// Security headers — applied to every response
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Admin password loaded from .env file — must be set or the server refuses to start
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.error('FATAL: ADMIN_PASSWORD environment variable is not set. Set it in your .env file.');
    process.exit(1);
}

// File size limits (from .env, in MB)
const MAX_PHOTO_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '200') * 1024 * 1024;
const MAX_BACKGROUND_BYTES = parseInt(process.env.MAX_BACKGROUND_MB || '20') * 1024 * 1024;

// Install directory — where Node.js stores uploads, backgrounds, and galleries.json
// Docker: always /data (set via environment in docker-compose.yml)
// Bare-metal: defaults to the project directory
const DATA_DIR = process.env.INSTALL_DIR || __dirname;

const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const OG_CACHE_DIR   = path.join(DATA_DIR, 'og-cache');

// UUID v4 validation regex — used by middleware and reconcileGalleries (must be declared early)
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Data store for galleries (in production, use a database)
const galleries = new Map();

// File to persist gallery metadata
const GALLERIES_FILE = path.join(DATA_DIR, 'galleries.json');

// Load galleries from file on startup
function loadGalleries() {
    if (fs.existsSync(GALLERIES_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(GALLERIES_FILE, 'utf8'));
            data.forEach(g => galleries.set(g.id, g));
        } catch (err) {
            console.error('Error loading galleries:', err);
        }
    }
}

// Save galleries to file
function saveGalleries() {
    const data = Array.from(galleries.values());
    fs.writeFileSync(GALLERIES_FILE, JSON.stringify(data, null, 2));
}

// Reconcile galleries.json with the uploads directory on disk.
// Runs once on startup to handle two cases:
//   1. Entry in JSON but no uploads folder → remove the stale entry
//   2. Uploads folder exists but no JSON entry → recover with placeholder metadata
function reconcileGalleries() {
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    let changed = false;

    // Case 1: stale JSON entries with no corresponding uploads folder
    for (const galleryId of galleries.keys()) {
        if (!fs.existsSync(path.join(uploadsDir, galleryId))) {
            galleries.delete(galleryId);
            changed = true;
        }
    }

    // Case 2: uploads folders on disk with no JSON entry
    if (fs.existsSync(uploadsDir)) {
        for (const entry of fs.readdirSync(uploadsDir)) {
            if (!UUID_V4_REGEX.test(entry)) continue;
            if (galleries.has(entry)) continue;
            const galleryPath = path.join(uploadsDir, entry);
            if (!fs.statSync(galleryPath).isDirectory()) continue;
            const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
            galleries.set(entry, {
                id: entry,
                eventName: 'Untitled Event',
                created: fs.statSync(galleryPath).birthtime.toISOString(),
                files,
                background: null
            });
            changed = true;
        }
    }

    if (changed) saveGalleries();
}

loadGalleries();
reconcileGalleries();

// Ensure directories exist
['uploads', 'backgrounds', 'thumbnails', 'og-cache'].forEach(dir => {
    const dirPath = path.join(DATA_DIR, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}

// --- Helper functions ---

// Find a custom logo stored in DATA_DIR (any extension). Returns null if none exists.
function findLogoFile() {
    const LOGO_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
    for (const ext of LOGO_EXTS) {
        const p = path.join(DATA_DIR, `logo${ext}`);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// Escape a string for safe use in HTML attribute values (OG meta tag injection)
function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Generate a 400px-wide JPEG thumbnail for a single photo
async function generateThumbnail(galleryId, filename) {
    const src  = path.join(DATA_DIR, 'uploads', galleryId, filename);
    const dir  = path.join(THUMBNAILS_DIR, galleryId);
    const dest = path.join(dir, filename + '.jpg');
    if (fs.existsSync(dest)) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        await sharp(src).resize(400).jpeg({ quality: 80 }).toFile(dest);
    } catch (e) {
        // Skip non-image or corrupt files silently
    }
}

// Generate thumbnails for an array of filenames (fire-and-forget safe)
async function generateGalleryThumbnails(galleryId, files) {
    await Promise.all(files.map(f => generateThumbnail(galleryId, f)));
}

// Configure multer for photo uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const galleryId = req.galleryId || req.params.galleryId;
        const uploadPath = path.join(DATA_DIR, 'uploads', galleryId);
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_PHOTO_BYTES },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp|tiff|bmp|raw|cr2|nef|arw/i;
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        const mime = file.mimetype;
        if (allowedTypes.test(ext) || mime.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Background images are stored in memory so sharp can normalise them to JPEG
const uploadBackground = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BACKGROUND_BYTES },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/i;
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        if (allowedTypes.test(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, GIF, or WebP files are allowed for backgrounds'), false);
        }
    }
});

// Logo uploads accept raster images and SVG; stored in memory then written to DATA_DIR
const uploadLogo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap — logos should be small
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, GIF, WebP, or SVG files are allowed for the logo'), false);
        }
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function validateGalleryId(req, res, next) {
    if (!UUID_V4_REGEX.test(req.params.galleryId)) {
        return res.status(400).json({ error: 'Invalid gallery ID' });
    }
    next();
}

// Filename validation — prevents path traversal on per-photo endpoints
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._\-]+$/;

function validateFilename(req, res, next) {
    if (!SAFE_FILENAME_RE.test(req.params.filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    next();
}

// Simple password authentication middleware
function requireAuth(req, res, next) {
    const password = req.headers['x-admin-password'] || req.query.password;
    if (password === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// Rate limiter for the login endpoint — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again in 15 minutes' }
});

// Rate limiter for public image-generation endpoints — 600 requests per minute per IP
// Prevents abuse of CPU-intensive sharp processing on unauthenticated routes
const imageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many image requests, please slow down' }
});

// --- Routes ---

// Verify password endpoint
app.post('/api/auth/verify', authLimiter, (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// Admin interface - photographer uploads photos here
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve the logo — custom file in DATA_DIR takes precedence over the bundled logo.svg
const LOGO_CONTENT_TYPES = {
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
};

const LOGO_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

app.get('/api/logo', (_req, res) => {
    const custom = findLogoFile();
    // X-Custom-Logo lets the admin page know whether a custom logo is active
    res.setHeader('X-Custom-Logo', custom ? '1' : '0');
    if (custom) {
        const ext = path.extname(custom).toLowerCase();
        res.setHeader('Content-Type', LOGO_CONTENT_TYPES[ext] || 'application/octet-stream');
        return res.sendFile(custom);
    }
    // Fall back to the bundled logo.svg in public/
    res.sendFile(path.join(__dirname, 'public', 'logo.svg'));
});

// Replace the logo (admin only)
app.post('/api/logo', requireAuth, uploadLogo.single('logo'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    for (const ext of LOGO_EXTS) {
        const p = path.join(DATA_DIR, `logo${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    fs.writeFileSync(path.join(DATA_DIR, `logo${ext}`), req.file.buffer);

    res.json({ success: true });
});

// Reset logo to the bundled default (admin only)
app.delete('/api/logo', requireAuth, (_req, res) => {
    for (const ext of LOGO_EXTS) {
        const p = path.join(DATA_DIR, `logo${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    res.json({ success: true });
});

// Middleware to generate galleryId BEFORE multer processes files
function generateGalleryId(req, res, next) {
    const galleryId = uuidv4();
    req.galleryId = galleryId;
    galleries.set(galleryId, {
        id: galleryId,
        eventName: '',
        created: new Date().toISOString(),
        files: [],
        background: null
    });
    next();
}

// Create new gallery and upload photos
app.post('/api/gallery/create', requireAuth, generateGalleryId, upload.array('photos', 500), (req, res) => {
    const galleryId = req.galleryId;
    const gallery = galleries.get(galleryId);

    // If multer processed no files, clean up the skeleton gallery and return an error
    // so the admin never receives a link for an empty gallery that would 404
    if (!req.files || req.files.length === 0) {
        galleries.delete(galleryId);
        saveGalleries();
        return res.status(400).json({ error: 'No photos were uploaded. Please select at least one image.' });
    }

    if (gallery) {
        gallery.files = req.files.map(f => f.filename);
        gallery.eventName = (String(req.body.eventName || 'Untitled Event')).trim().substring(0, 200);
        saveGalleries();
        generateGalleryThumbnails(galleryId, gallery.files).catch(() => {});
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${baseUrl}/download/${galleryId}`;

    res.json({
        success: true,
        galleryId,
        downloadUrl,
        fileCount: req.files.length
    });
});

// Add more photos to existing gallery
app.post('/api/gallery/:galleryId/upload', requireAuth, validateGalleryId, upload.array('photos', 500), (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);

    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    if (req.files) {
        const newFiles = req.files.map(f => f.filename);
        gallery.files.push(...newFiles);
        saveGalleries();
        generateGalleryThumbnails(galleryId, newFiles).catch(() => {});
    }

    res.json({
        success: true,
        fileCount: gallery.files.length
    });
});

// Upload/replace background image — converts to JPEG via sharp
app.post('/api/gallery/:galleryId/background', requireAuth, validateGalleryId, uploadBackground.single('background'), async (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);

    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No background file provided' });
    }

    try {
        const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

        // Delete old background (any extension)
        if (fs.existsSync(backgroundsDir)) {
            const existing = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
            if (existing) fs.unlinkSync(path.join(backgroundsDir, existing));
        }

        // Invalidate og-cache so it is regenerated with the new image
        const ogFile = path.join(OG_CACHE_DIR, `${galleryId}.jpg`);
        if (fs.existsSync(ogFile)) fs.unlinkSync(ogFile);

        // Convert and save as JPEG
        const dest = path.join(backgroundsDir, `${galleryId}.jpg`);
        await sharp(req.file.buffer)
            .resize(2400, null, { withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toFile(dest);

        gallery.background = `${galleryId}.jpg`;
        saveGalleries();

        res.json({ success: true, background: gallery.background });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process background image' });
    }
});

// Serve background image (legacy route — kept for backwards compatibility)
app.get('/api/background/:galleryId', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    if (fs.existsSync(backgroundsDir)) {
        const backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (backgroundFile) {
            return res.sendFile(path.join(backgroundsDir, backgroundFile));
        }
    }

    res.status(404).send('Background not found');
});

// Serve background image (REST-style route used by admin.html and customer.html)
app.get('/api/gallery/:galleryId/background', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    if (fs.existsSync(backgroundsDir)) {
        const backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (backgroundFile) {
            return res.sendFile(path.join(backgroundsDir, backgroundFile));
        }
    }

    res.status(404).send('Background not found');
});

// Rename a gallery
app.post('/api/gallery/:galleryId/rename', requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);

    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    gallery.eventName = (String(req.body.eventName || 'Untitled Event')).trim().substring(0, 200);
    saveGalleries();

    res.json({ success: true, eventName: gallery.eventName });
});

// List photos in a gallery (used by preview.html)
app.get('/api/gallery/:galleryId/photos', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));

    const gallery = galleries.get(galleryId);

    const photos = files.map(filename => ({
        filename,
        url:         `/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}`,
        thumbnailUrl:`/api/gallery/${galleryId}/photo/${encodeURIComponent(filename)}?thumb=1`,
        downloadUrl: `/api/gallery/${galleryId}/download/${encodeURIComponent(filename)}`
    }));

    // Return shape matches what preview.html expects: { id, eventName, photos: [...] }
    res.json({
        id: galleryId,
        eventName: gallery ? gallery.eventName : 'Untitled Event',
        photos
    });
});

// Serve a single photo (original or thumbnail)
app.get('/api/gallery/:galleryId/photo/:filename', imageLimiter, validateGalleryId, validateFilename, async (req, res) => {
    const { galleryId, filename } = req.params;

    if (req.query.thumb === '1') {
        const thumbPath = path.join(THUMBNAILS_DIR, galleryId, filename + '.jpg');

        if (!fs.existsSync(thumbPath)) {
            // Generate on-the-fly if missing
            await generateThumbnail(galleryId, filename);
        }

        if (fs.existsSync(thumbPath)) {
            return res.sendFile(thumbPath);
        }
        // Fall through to original if thumbnail generation failed
    }

    const filePath = path.join(DATA_DIR, 'uploads', galleryId, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Photo not found');
    }
    res.sendFile(filePath);
});

// Download a single photo as an attachment
app.get('/api/gallery/:galleryId/download/:filename', validateGalleryId, validateFilename, (req, res) => {
    const { galleryId, filename } = req.params;
    const filePath = path.join(DATA_DIR, 'uploads', galleryId, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Photo not found');
    }

    res.download(filePath, filename);
});

// Serve/generate OG image (1200×630 JPEG, cached)
app.get('/api/gallery/:galleryId/og-image', imageLimiter, validateGalleryId, async (req, res) => {
    const { galleryId } = req.params;
    const cacheFile = path.join(OG_CACHE_DIR, `${galleryId}.jpg`);

    if (fs.existsSync(cacheFile)) {
        return res.sendFile(cacheFile);
    }

    // Find source: prefer background, fall back to first photo
    let sourceFile = null;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const bgFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (bgFile) sourceFile = path.join(backgroundsDir, bgFile);
    }

    if (!sourceFile) {
        const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
        if (!fs.existsSync(galleryPath)) return res.status(404).send('Gallery not found');
        const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));
        if (files.length === 0) return res.status(404).send('No photos');
        sourceFile = path.join(galleryPath, files[0]);
    }

    try {
        await sharp(sourceFile)
            .resize(1200, 630, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toFile(cacheFile);
        res.sendFile(cacheFile);
    } catch (err) {
        res.status(500).send('Could not generate OG image');
    }
});

// Customer download page — serves HTML with OG meta tags injected
app.get('/download/:galleryId', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).send('Gallery not found');
    }

    const gallery = galleries.get(galleryId);
    const eventName = gallery ? gallery.eventName : 'Your Photos';
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const ogTags = [
        `<meta property="og:title" content="${escapeAttr(eventName)}">`,
        `<meta property="og:description" content="Your photos are ready to download.">`,
        `<meta property="og:image" content="${baseUrl}/api/gallery/${galleryId}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${baseUrl}/download/${galleryId}">`
    ].join('\n    ');

    const html = fs.readFileSync(path.join(__dirname, 'public', 'customer.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// Preview page — serves HTML with OG meta tags injected
app.get('/preview/:galleryId', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).send('Gallery not found');
    }

    const gallery = galleries.get(galleryId);
    const eventName = gallery ? gallery.eventName : 'Your Photos';
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const ogTags = [
        `<meta property="og:title" content="${escapeAttr(eventName)}">`,
        `<meta property="og:description" content="Browse and download individual photos.">`,
        `<meta property="og:image" content="${baseUrl}/api/gallery/${galleryId}/og-image">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${baseUrl}/preview/${galleryId}">`
    ].join('\n    ');

    const html = fs.readFileSync(path.join(__dirname, 'public', 'preview.html'), 'utf8');
    res.send(html.replace('<head>', `<head>\n    ${ogTags}`));
});

// Get gallery info (for customer and preview pages)
app.get('/api/gallery/:galleryId/info', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;

    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    let backgroundFile = null;
    if (fs.existsSync(backgroundsDir)) {
        backgroundFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId)) || null;
    }

    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
    let fileCount = 0;
    if (fs.existsSync(galleryPath)) {
        fileCount = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.')).length;
    }

    const gallery = galleries.get(galleryId);
    const eventName = gallery ? gallery.eventName : 'Your Photos';

    res.json({
        galleryId,
        eventName,
        background: backgroundFile ? `/api/gallery/${galleryId}/background` : null,
        fileCount
    });
});

// Download all photos as ZIP
app.get('/api/gallery/:galleryId/download', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);

    if (!fs.existsSync(galleryPath)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));

    if (files.length === 0) {
        return res.status(404).json({ error: 'No files in gallery' });
    }

    const gallery = galleries.get(galleryId);
    const eventName = gallery && gallery.eventName ? gallery.eventName : 'photos';

    const safeFileName = eventName
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50) || 'photos';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => { res.status(500).send({ error: err.message }); });
    archive.pipe(res);
    files.forEach(file => archive.file(path.join(galleryPath, file), { name: file }));
    archive.finalize();
});

// List all galleries (admin)
app.get('/api/galleries', requireAuth, (req, res) => {
    const galleryList = [];
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');

    const bgFiles = fs.existsSync(backgroundsDir)
        ? new Set(fs.readdirSync(backgroundsDir))
        : new Set();

    if (fs.existsSync(uploadsDir)) {
        const dirs = fs.readdirSync(uploadsDir);

        dirs.forEach(galleryId => {
            const galleryPath = path.join(uploadsDir, galleryId);
            const stats = fs.statSync(galleryPath);

            if (stats.isDirectory()) {
                const files = fs.readdirSync(galleryPath).filter(f => !f.startsWith('.'));

                let gallery = galleries.get(galleryId);
                if (!gallery) {
                    gallery = {
                        id: galleryId,
                        eventName: 'Untitled Event',
                        created: stats.birthtime.toISOString(),
                        files,
                        background: null
                    };
                    galleries.set(galleryId, gallery);
                    saveGalleries();
                }

                const hasBackground = [...bgFiles].some(f => f.startsWith(galleryId));

                galleryList.push({
                    id: galleryId,
                    eventName: gallery.eventName || 'Untitled Event',
                    created: gallery.created || stats.birthtime.toISOString(),
                    fileCount: files.length,
                    hasBackground,
                    downloadUrl: `${baseUrl}/download/${galleryId}`
                });
            }
        });
    }

    galleryList.sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(galleryList);
});

// Delete gallery
app.delete('/api/gallery/:galleryId', requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;

    // Delete photo uploads
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
    if (fs.existsSync(galleryPath)) {
        fs.rmSync(galleryPath, { recursive: true });
    }

    // Delete background
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const bgFile = fs.readdirSync(backgroundsDir).find(f => f.startsWith(galleryId));
        if (bgFile) fs.unlinkSync(path.join(backgroundsDir, bgFile));
    }

    // Delete thumbnails
    fs.rmSync(path.join(THUMBNAILS_DIR, galleryId), { recursive: true, force: true });

    // Delete og-cache
    const ogFile = path.join(OG_CACHE_DIR, `${galleryId}.jpg`);
    if (fs.existsSync(ogFile)) fs.unlinkSync(ogFile);

    galleries.delete(galleryId);
    saveGalleries();

    res.json({ success: true });
});

// Error handling — never expose internal details (file paths, stack traces) to the client
app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || err.statusCode || 500;
    // Multer errors have a user-safe code; surface only those
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large' });
    }
    res.status(status).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`\n📸 MeTransfer is running on port ${PORT}\n`);
});
