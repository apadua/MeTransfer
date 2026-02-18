require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

// Admin password loaded from .env file
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// File size limits (from .env, in MB)
const MAX_PHOTO_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '200') * 1024 * 1024;
const MAX_BACKGROUND_BYTES = parseInt(process.env.MAX_BACKGROUND_MB || '20') * 1024 * 1024;

// Data directory — set DATA_DIR in .env to decouple app code from runtime data (e.g. Docker volumes)
const DATA_DIR = process.env.DATA_DIR || __dirname;

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

loadGalleries();

// Ensure directories exist
['uploads', 'backgrounds'].forEach(dir => {
    const dirPath = path.join(DATA_DIR, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}

// Configure multer for file uploads
let currentGalleryId = null;

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Use the galleryId set before multer runs, or from params for adding to existing
        const galleryId = req.galleryId || req.params.galleryId;
        const uploadPath = path.join(DATA_DIR, 'uploads', galleryId);
        
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        // Preserve original filename but make it safe
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safeName);
    }
});

const backgroundStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(DATA_DIR, 'backgrounds'));
    },
    filename: (req, file, cb) => {
        const galleryId = req.params.galleryId;
        const ext = path.extname(file.originalname);
        cb(null, `${galleryId}${ext}`);
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

const uploadBackground = multer({
    storage: backgroundStorage,
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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// UUID v4 validation — prevents path traversal attacks on filesystem operations
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateGalleryId(req, res, next) {
    if (!UUID_V4_REGEX.test(req.params.galleryId)) {
        return res.status(400).json({ error: 'Invalid gallery ID' });
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
    
    if (gallery && req.files) {
        gallery.files = req.files.map(f => f.filename);
        gallery.eventName = req.body.eventName || 'Untitled Event';
        saveGalleries();
    }
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${baseUrl}/download/${galleryId}`;
    
    res.json({
        success: true,
        galleryId,
        downloadUrl,
        fileCount: req.files ? req.files.length : 0
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
        gallery.files.push(...req.files.map(f => f.filename));
        saveGalleries();
    }
    
    res.json({
        success: true,
        fileCount: gallery.files.length
    });
});

// Upload background image
app.post('/api/gallery/:galleryId/background', requireAuth, validateGalleryId, uploadBackground.single('background'), (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    
    if (!gallery) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    
    if (req.file) {
        // Remove old background if exists
        if (gallery.background) {
            const oldPath = path.join(__dirname, 'backgrounds', gallery.background);
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }
        gallery.background = req.file.filename;
        saveGalleries();
    }
    
    res.json({
        success: true,
        background: gallery.background
    });
});

// Customer download page
app.get('/download/:galleryId', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const gallery = galleries.get(galleryId);
    
    // Check if gallery folder exists even if not in memory (for persistence)
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
    if (!fs.existsSync(galleryPath)) {
        return res.status(404).send('Gallery not found');
    }
    
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

// Get gallery info (for customer page)
app.get('/api/gallery/:galleryId/info', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    
    // Check backgrounds directory for this gallery
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    let backgroundFile = null;
    
    if (fs.existsSync(backgroundsDir)) {
        const files = fs.readdirSync(backgroundsDir);
        backgroundFile = files.find(f => f.startsWith(galleryId));
    }
    
    // Count files in gallery
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
    let fileCount = 0;
    
    if (fs.existsSync(galleryPath)) {
        fileCount = fs.readdirSync(galleryPath).length;
    }
    
    // Get event name from metadata
    const gallery = galleries.get(galleryId);
    const eventName = gallery ? gallery.eventName : 'Your Photos';
    
    res.json({
        galleryId,
        eventName,
        background: backgroundFile ? `/api/background/${galleryId}` : null,
        fileCount
    });
});

// Serve background image
app.get('/api/background/:galleryId', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    
    if (fs.existsSync(backgroundsDir)) {
        const files = fs.readdirSync(backgroundsDir);
        const backgroundFile = files.find(f => f.startsWith(galleryId));
        
        if (backgroundFile) {
            return res.sendFile(path.join(backgroundsDir, backgroundFile));
        }
    }
    
    res.status(404).send('Background not found');
});

// Download all photos as ZIP
app.get('/api/gallery/:galleryId/download', validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
    
    if (!fs.existsSync(galleryPath)) {
        return res.status(404).json({ error: 'Gallery not found' });
    }
    
    const files = fs.readdirSync(galleryPath);
    
    if (files.length === 0) {
        return res.status(404).json({ error: 'No files in gallery' });
    }
    
    // Get event name for filename
    const gallery = galleries.get(galleryId);
    const eventName = gallery && gallery.eventName ? gallery.eventName : 'photos';
    
    // Sanitize event name for filename (remove special characters)
    const safeFileName = eventName
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50) || 'photos';
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 5 } });
    
    archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
    });
    
    archive.pipe(res);
    
    files.forEach(file => {
        const filePath = path.join(galleryPath, file);
        archive.file(filePath, { name: file });
    });
    
    archive.finalize();
});

// List all galleries (admin)
app.get('/api/galleries', requireAuth, (req, res) => {
    const galleryList = [];
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const uploadsDir = path.join(DATA_DIR, 'uploads');
    
    // Scan the uploads directory for all gallery folders
    if (fs.existsSync(uploadsDir)) {
        const dirs = fs.readdirSync(uploadsDir);
        
        dirs.forEach(galleryId => {
            const galleryPath = path.join(uploadsDir, galleryId);
            const stats = fs.statSync(galleryPath);
            
            if (stats.isDirectory()) {
                const files = fs.readdirSync(galleryPath);
                
                // Check if we have metadata for this gallery
                let gallery = galleries.get(galleryId);
                
                // If no metadata exists, create it from filesystem
                if (!gallery) {
                    gallery = {
                        id: galleryId,
                        eventName: 'Untitled Event',
                        created: stats.birthtime.toISOString(),
                        files: files,
                        background: null
                    };
                    galleries.set(galleryId, gallery);
                    saveGalleries();
                }
                
                galleryList.push({
                    id: galleryId,
                    eventName: gallery.eventName || 'Untitled Event',
                    created: gallery.created || stats.birthtime.toISOString(),
                    fileCount: files.length,
                    downloadUrl: `${baseUrl}/download/${galleryId}`
                });
            }
        });
    }
    
    // Sort by creation date, newest first
    galleryList.sort((a, b) => new Date(b.created) - new Date(a.created));
    
    res.json(galleryList);
});

// Delete gallery
app.delete('/api/gallery/:galleryId', requireAuth, validateGalleryId, (req, res) => {
    const { galleryId } = req.params;
    const galleryPath = path.join(DATA_DIR, 'uploads', galleryId);
    
    // Delete gallery files
    if (fs.existsSync(galleryPath)) {
        fs.rmSync(galleryPath, { recursive: true });
    }
    
    // Delete background
    const backgroundsDir = path.join(DATA_DIR, 'backgrounds');
    if (fs.existsSync(backgroundsDir)) {
        const files = fs.readdirSync(backgroundsDir);
        const backgroundFile = files.find(f => f.startsWith(galleryId));
        if (backgroundFile) {
            fs.unlinkSync(path.join(backgroundsDir, backgroundFile));
        }
    }
    
    // Remove from memory and save
    galleries.delete(galleryId);
    saveGalleries();
    
    res.json({ success: true });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
    console.log(`\n📸 Photo Portal is running!\n`);
    console.log(`   Admin Interface: http://${HOST}:${PORT}`);
    console.log(`   Upload photos and share the generated link with your customers.\n`);
});
