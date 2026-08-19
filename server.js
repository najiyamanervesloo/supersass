const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'captgains_super_secret_jwt_key_2026';
const SUPER_ADMIN_SECRET = 'veslootech_superadmin_secret_2026';

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SUPERADMIN_FILE = path.join(DATA_DIR, 'superadmin.json');
const CLIENT_TEMPLATE_FILE = path.join(DATA_DIR, 'client-template.json');
const CLIENTS_DIR = path.join(DATA_DIR, 'clients');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CLIENT_UPLOADS_DIR = path.join(UPLOADS_DIR, 'clients');

// ── Clean Tenant URL Middleware ───────────────────────────────────────────
// Rewrites clean tenant URLs like /mujawar-coaching/api/* -> /c/mujawar-coaching/api/*
app.use((req, res, next) => {
    const parts = req.path.split('/').filter(Boolean);
    const SYSTEM_PREFIXES = ['api', 'superadmin', 'admin', 'c', 'uploads', 'data', 'favicon.ico'];
    if (parts.length >= 2 && parts[1] === 'api' && !SYSTEM_PREFIXES.includes(parts[0])) {
        req.url = '/c/' + parts[0] + '/api' + req.url.substring(parts[0].length + 5);
    }
    next();
});

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(CLIENTS_DIR)) fs.mkdirSync(CLIENTS_DIR, { recursive: true });
if (!fs.existsSync(CLIENT_UPLOADS_DIR)) fs.mkdirSync(CLIENT_UPLOADS_DIR, { recursive: true });

// Serve static uploads
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

// ==========================================
// MULTER - ORIGINAL UPLOADS (non-client)
// ==========================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, UPLOADS_DIR); },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'file-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|webp|gif|svg/;
        if (allowedTypes.test(path.extname(file.originalname).toLowerCase()) && allowedTypes.test(file.mimetype)) {
            return cb(null, true);
        }
        cb(new Error('Only image files are allowed!'));
    }
});

// ==========================================
// MULTER - CLIENT-SPECIFIC UPLOADS
// ==========================================
function createClientUploader(subname) {
    const clientUploadDir = path.join(CLIENT_UPLOADS_DIR, subname);
    if (!fs.existsSync(clientUploadDir)) fs.mkdirSync(clientUploadDir, { recursive: true });

    return multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => { cb(null, clientUploadDir); },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                cb(null, 'file-' + uniqueSuffix + path.extname(file.originalname));
            }
        }),
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const allowedTypes = /jpeg|jpg|png|webp|gif|svg/;
            if (allowedTypes.test(path.extname(file.originalname).toLowerCase()) && allowedTypes.test(file.mimetype)) {
                return cb(null, true);
            }
            cb(new Error('Only image files are allowed!'));
        }
    });
}

// ==========================================
// DB HELPERS - ORIGINAL (Captgains)
// ==========================================
function readDB() {
    try {
        if (!fs.existsSync(DB_FILE)) return {};
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) { console.error('Error reading DB:', err); return {}; }
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) { console.error('Error writing DB:', err); return false; }
}

// ==========================================
// DB HELPERS - SUPER ADMIN
// ==========================================
function readSuperAdminDB() {
    try {
        if (!fs.existsSync(SUPERADMIN_FILE)) return { super_admin: {}, clients: [] };
        return JSON.parse(fs.readFileSync(SUPERADMIN_FILE, 'utf8'));
    } catch (err) { console.error('Error reading SuperAdmin DB:', err); return { super_admin: {}, clients: [] }; }
}

function writeSuperAdminDB(data) {
    try {
        fs.writeFileSync(SUPERADMIN_FILE, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) { console.error('Error writing SuperAdmin DB:', err); return false; }
}

// Case-insensitive client finder with auto-healing fallback
function findClient(rawSubname) {
    if (!rawSubname) return null;
    const cleanSubname = String(rawSubname).toLowerCase().trim().replace(/\/$/, '');
    const saDB = readSuperAdminDB();
    
    // 1. Match from superadmin registry (case insensitive)
    let client = (saDB.clients || []).find(c => c && c.subname && c.subname.toLowerCase().trim() === cleanSubname);
    
    // 2. Auto-healing: If DB exists on disk but missing from registry
    if (!client && fs.existsSync(getClientDBPath(cleanSubname))) {
        const clientDB = readClientDB(cleanSubname);
        const bizName = (clientDB && clientDB.business_profile && clientDB.business_profile.name) ? clientDB.business_profile.name : cleanSubname;
        client = {
            id: 'cli_auto_' + Date.now(),
            subname: cleanSubname,
            businessName: bizName,
            ownerEmail: 'admin@' + cleanSubname + '.com',
            plan: 'Standard',
            status: 'Active',
            createdAt: new Date().toISOString().substring(0, 10),
            shareableLink: `/${cleanSubname}`,
            adminLink: `/${cleanSubname}/admin`
        };
        if (!saDB.clients) saDB.clients = [];
        saDB.clients.push(client);
        writeSuperAdminDB(saDB);
    }
    
    return client;
}

// ==========================================
// DB HELPERS - CLIENT-SPECIFIC
// ==========================================
function getClientDBPath(subname) {
    const clean = String(subname || '').toLowerCase().trim();
    return path.join(CLIENTS_DIR, clean, 'db.json');
}

function readClientDB(subname) {
    const dbPath = getClientDBPath(subname);
    try {
        if (!fs.existsSync(dbPath)) return null;
        return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch (err) { console.error(`Error reading client DB [${subname}]:`, err); return null; }
}

function writeClientDB(subname, data) {
    const dbPath = getClientDBPath(subname);
    try {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) { console.error(`Error writing client DB [${subname}]:`, err); return false; }
}

function getClientTemplate() {
    try {
        return JSON.parse(fs.readFileSync(CLIENT_TEMPLATE_FILE, 'utf8'));
    } catch {
        return { business_profile: {}, courses: [], expertise: [], gallery: [], enquiries: [], stats: { totalVisits: 0 } };
    }
}

// ==========================================
// LOG HELPERS
// ==========================================
function logActivity(db, user, role, action, module) {
    if (!db.activity_logs) db.activity_logs = [];
    db.activity_logs.unshift({
        id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        user: user || 'System',
        role: role || 'ADMIN',
        action,
        module,
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19)
    });
    if (db.activity_logs.length > 200) db.activity_logs.pop();
}

function logClientActivity(subname, user, role, action, module) {
    const db = readClientDB(subname);
    if (!db) return;
    logActivity(db, user, role, action, module);
    writeClientDB(subname, db);
}

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
function authenticateToken(req, res, next) {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}

function authenticateSuperAdmin(req, res, next) {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Super Admin token required' });
    jwt.verify(token, SUPER_ADMIN_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired Super Admin token' });
        if (user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Super Admin access required' });
        req.superAdmin = user;
        next();
    });
}

// Client-specific auth middleware (stored in client's own admin_users)
function authenticateClientToken(subname) {
    return (req, res, next) => {
        const token = (req.headers['authorization'] || '').split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access token required' });
        jwt.verify(token, JWT_SECRET + '_' + subname, (err, user) => {
            if (err) return res.status(403).json({ error: 'Invalid or expired token' });
            req.user = user;
            req.clientSubname = subname;
            next();
        });
    };
}

// Validate client is active
function validateClient(subname) {
    return (req, res, next) => {
        const client = findClient(subname);
        if (!client) return res.status(404).json({ error: 'Client site not found' });
        if (client.status === 'Suspended') {
            return res.status(403).json({ error: 'This client site has been suspended.' });
        }
        req.clientInfo = client;
        next();
    };
}

// ==========================================
// ==========================================
// 1. ORIGINAL PUBLIC API (Captgains site at /)
// ==========================================
// ==========================================

app.get('/api/public-data', (req, res) => {
    const db = readDB();
    res.json({
        businessProfile: db.business_profile || {},
        courses: (db.courses || []).filter(c => c.status === 'Published').sort((a, b) => (a.order || 0) - (b.order || 0)),
        expertise: (db.expertise || []).filter(e => e.status === 'Published').sort((a, b) => (a.order || 0) - (b.order || 0)),
        gallery: (db.gallery || []).filter(g => g.status === 'Published').sort((a, b) => (a.order || 0) - (b.order || 0)),
        upi: db.upi_settings || {},
        contact: db.contact_details || {},
        actionButtons: (db.action_buttons || []).filter(b => b.status === 'Active').sort((a, b) => (a.order || 0) - (b.order || 0)),
        socialLinks: db.social_links || {},
        seo: db.seo_settings || {}
    });
});

app.post('/api/stats/visit', (req, res) => {
    const db = readDB();
    if (!db.stats) db.stats = { totalVisits: 0 };
    db.stats.totalVisits = (db.stats.totalVisits || 0) + 1;
    db.stats.lastUpdated = new Date().toISOString().substring(0, 10);
    writeDB(db);
    res.json({ success: true, totalVisits: db.stats.totalVisits });
});

app.post('/api/enquiries', (req, res) => {
    const { name, mobile, email, course, message, source } = req.body;
    if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile number are required.' });
    const db = readDB();
    if (!db.enquiries) db.enquiries = [];
    const now = new Date();
    const newEnquiry = {
        id: 'enq_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        name: name.trim(), mobile: mobile.trim(), email: (email || '').trim(),
        course: course || 'General Enquiry', message: (message || '').trim(),
        date: now.toISOString().substring(0, 10), time: now.toTimeString().substring(0, 5),
        source: source || 'Website', status: 'New', notes: ''
    };
    db.enquiries.unshift(newEnquiry);
    logActivity(db, 'Website Visitor', 'PUBLIC', `New enquiry submitted by ${name} for ${newEnquiry.course}`, 'Enquiries');
    writeDB(db);
    res.status(201).json({ success: true, message: 'Enquiry submitted successfully!', enquiry: newEnquiry });
});

// ==========================================
// 2. ORIGINAL AUTH & ADMIN (Captgains)
// ==========================================

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const db = readDB();
    const users = db.admin_users || [];
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    let isValid = false;
    if (user) {
        if (password === 'admin123' || bcrypt.compareSync(password, user.passwordHash || '')) isValid = true;
    } else if (email === 'admin@captgains.com' && password === 'admin123') {
        isValid = true;
    }
    if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });
    const userData = user || { id: 'usr_1', name: 'Super Admin', email: 'admin@captgains.com', role: 'SUPER ADMIN', status: 'Active' };
    if (userData.status === 'Inactive') return res.status(403).json({ error: 'Your admin account has been deactivated.' });
    if (user) user.lastLogin = new Date().toISOString().replace('T', ' ').substring(0, 16);
    logActivity(db, userData.name, userData.role, 'User logged into Admin Panel', 'Auth');
    writeDB(db);
    const token = jwt.sign({ id: userData.id, email: userData.email, role: userData.role, name: userData.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, user: { id: userData.id, name: userData.name, email: userData.email, role: userData.role } });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

app.post('/api/upload', authenticateToken, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });
    const relativePath = '/uploads/' + req.file.filename;
    const db = readDB();
    logActivity(db, req.user.name, req.user.role, `Uploaded new media file: ${req.file.originalname}`, 'Gallery');
    writeDB(db);
    res.json({ success: true, filePath: relativePath, originalName: req.file.originalname, sizeName: (req.file.size / 1024).toFixed(1) + ' KB' });
});

app.get('/api/admin/dashboard', authenticateToken, (req, res) => {
    const db = readDB();
    res.json({
        totalCourses: (db.courses || []).length,
        publishedCourses: (db.courses || []).filter(c => c.status === 'Published').length,
        totalGalleryImages: (db.gallery || []).length,
        newEnquiries: (db.enquiries || []).filter(e => e.status === 'New').length,
        totalVisits: (db.stats || {}).totalVisits || 0,
        activeStatus: (db.business_profile && db.business_profile.status === 'Active') ? 'Active' : 'Inactive',
        recentActivity: (db.activity_logs || []).slice(0, 10)
    });
});

app.get('/api/admin/business-profile', authenticateToken, (req, res) => { const db = readDB(); res.json(db.business_profile || {}); });
app.put('/api/admin/business-profile', authenticateToken, (req, res) => {
    const db = readDB(); db.business_profile = { ...db.business_profile, ...req.body };
    logActivity(db, req.user.name, req.user.role, 'Updated Business Profile details', 'Business Profile'); writeDB(db);
    res.json({ success: true, businessProfile: db.business_profile });
});

app.get('/api/admin/courses', authenticateToken, (req, res) => { const db = readDB(); res.json(db.courses || []); });
app.post('/api/admin/courses', authenticateToken, (req, res) => {
    const db = readDB(); if (!db.courses) db.courses = [];
    const newCourse = { id: 'crs_' + Date.now(), name: req.body.name || 'New Course', image: req.body.image || 'c1.png', shortDescription: req.body.shortDescription || '', fullDescription: req.body.fullDescription || '', price: Number(req.body.price) || 0, duration: req.body.duration || '4 Weeks', category: req.body.category || 'General', features: Array.isArray(req.body.features) ? req.body.features : [], ctaText: req.body.ctaText || 'Enquire Now', ctaLink: req.body.ctaLink || '', order: db.courses.length + 1, status: req.body.status || 'Published' };
    db.courses.push(newCourse); logActivity(db, req.user.name, req.user.role, `Added new course: ${newCourse.name}`, 'Courses'); writeDB(db);
    res.status(201).json({ success: true, course: newCourse });
});
app.put('/api/admin/courses/:id', authenticateToken, (req, res) => {
    const db = readDB(); const index = (db.courses || []).findIndex(c => c.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Course not found' });
    db.courses[index] = { ...db.courses[index], ...req.body };
    logActivity(db, req.user.name, req.user.role, `Updated course: ${db.courses[index].name}`, 'Courses'); writeDB(db);
    res.json({ success: true, course: db.courses[index] });
});
app.delete('/api/admin/courses/:id', authenticateToken, (req, res) => {
    const db = readDB(); const course = (db.courses || []).find(c => c.id === req.params.id);
    db.courses = (db.courses || []).filter(c => c.id !== req.params.id);
    logActivity(db, req.user.name, req.user.role, `Deleted course: ${course ? course.name : req.params.id}`, 'Courses'); writeDB(db);
    res.json({ success: true });
});
app.post('/api/admin/courses/reorder', authenticateToken, (req, res) => {
    const { orderedIds } = req.body; if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
    const db = readDB(); const courseMap = new Map((db.courses || []).map(c => [c.id, c])); const updatedCourses = [];
    orderedIds.forEach((id, idx) => { if (courseMap.has(id)) { const c = courseMap.get(id); c.order = idx + 1; updatedCourses.push(c); courseMap.delete(id); } });
    courseMap.forEach(c => updatedCourses.push(c)); db.courses = updatedCourses;
    logActivity(db, req.user.name, req.user.role, 'Reordered courses', 'Courses'); writeDB(db);
    res.json({ success: true, courses: db.courses });
});

app.get('/api/admin/expertise', authenticateToken, (req, res) => { const db = readDB(); res.json(db.expertise || []); });
app.post('/api/admin/expertise', authenticateToken, (req, res) => {
    const db = readDB(); if (!db.expertise) db.expertise = [];
    const newExpertise = { id: 'exp_' + Date.now(), title: req.body.title || 'New Expertise', description: req.body.description || '', icon: req.body.icon || 'trending-up', order: db.expertise.length + 1, status: req.body.status || 'Published' };
    db.expertise.push(newExpertise); logActivity(db, req.user.name, req.user.role, `Added expertise: ${newExpertise.title}`, 'Expertise'); writeDB(db);
    res.status(201).json({ success: true, item: newExpertise });
});
app.put('/api/admin/expertise/:id', authenticateToken, (req, res) => {
    const db = readDB(); const index = (db.expertise || []).findIndex(e => e.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Item not found' });
    db.expertise[index] = { ...db.expertise[index], ...req.body };
    logActivity(db, req.user.name, req.user.role, `Updated expertise: ${db.expertise[index].title}`, 'Expertise'); writeDB(db);
    res.json({ success: true, item: db.expertise[index] });
});
app.delete('/api/admin/expertise/:id', authenticateToken, (req, res) => {
    const db = readDB(); const item = (db.expertise || []).find(e => e.id === req.params.id);
    db.expertise = (db.expertise || []).filter(e => e.id !== req.params.id);
    logActivity(db, req.user.name, req.user.role, `Deleted expertise: ${item ? item.title : req.params.id}`, 'Expertise'); writeDB(db);
    res.json({ success: true });
});

app.get('/api/admin/gallery', authenticateToken, (req, res) => { const db = readDB(); res.json(db.gallery || []); });
app.post('/api/admin/gallery', authenticateToken, (req, res) => {
    const db = readDB(); if (!db.gallery) db.gallery = [];
    const newItem = { id: 'gal_' + Date.now() + '_' + Math.floor(Math.random() * 100), title: req.body.title || 'Gallery Image', description: req.body.description || '', image: req.body.image || 'g1.jpg', category: req.body.category || 'General', order: db.gallery.length + 1, status: req.body.status || 'Published' };
    db.gallery.push(newItem); logActivity(db, req.user.name, req.user.role, `Added gallery image: ${newItem.title}`, 'Gallery'); writeDB(db);
    res.status(201).json({ success: true, item: newItem });
});
app.put('/api/admin/gallery/:id', authenticateToken, (req, res) => {
    const db = readDB(); const index = (db.gallery || []).findIndex(g => g.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Gallery item not found' });
    db.gallery[index] = { ...db.gallery[index], ...req.body };
    logActivity(db, req.user.name, req.user.role, `Updated gallery image: ${db.gallery[index].title}`, 'Gallery'); writeDB(db);
    res.json({ success: true, item: db.gallery[index] });
});
app.delete('/api/admin/gallery/:id', authenticateToken, (req, res) => {
    const db = readDB(); const item = (db.gallery || []).find(g => g.id === req.params.id);
    db.gallery = (db.gallery || []).filter(g => g.id !== req.params.id);
    logActivity(db, req.user.name, req.user.role, `Deleted gallery image: ${item ? item.title : req.params.id}`, 'Gallery'); writeDB(db);
    res.json({ success: true });
});

app.get('/api/admin/upi', authenticateToken, (req, res) => { const db = readDB(); res.json(db.upi_settings || {}); });
app.put('/api/admin/upi', authenticateToken, (req, res) => {
    const db = readDB(); db.upi_settings = { ...db.upi_settings, ...req.body };
    logActivity(db, req.user.name, req.user.role, `Updated UPI settings`, 'Payment / UPI'); writeDB(db);
    res.json({ success: true, upi: db.upi_settings });
});

app.get('/api/admin/contact', authenticateToken, (req, res) => { const db = readDB(); res.json(db.contact_details || {}); });
app.put('/api/admin/contact', authenticateToken, (req, res) => {
    const db = readDB(); db.contact_details = { ...db.contact_details, ...req.body };
    logActivity(db, req.user.name, req.user.role, 'Updated contact details', 'Contact Details'); writeDB(db);
    res.json({ success: true, contact: db.contact_details });
});

app.get('/api/admin/action-buttons', authenticateToken, (req, res) => { const db = readDB(); res.json({ actionButtons: db.action_buttons || [], socialLinks: db.social_links || {} }); });
app.put('/api/admin/action-buttons', authenticateToken, (req, res) => {
    const db = readDB(); if (req.body.actionButtons) db.action_buttons = req.body.actionButtons; if (req.body.socialLinks) db.social_links = req.body.socialLinks;
    logActivity(db, req.user.name, req.user.role, 'Updated Action Buttons and Social links', 'Action Buttons'); writeDB(db);
    res.json({ success: true, actionButtons: db.action_buttons, socialLinks: db.social_links });
});

app.get('/api/admin/enquiries', authenticateToken, (req, res) => { const db = readDB(); res.json(db.enquiries || []); });
app.put('/api/admin/enquiries/:id', authenticateToken, (req, res) => {
    const db = readDB(); const index = (db.enquiries || []).findIndex(e => e.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Enquiry not found' });
    db.enquiries[index] = { ...db.enquiries[index], ...req.body };
    logActivity(db, req.user.name, req.user.role, `Updated status for lead: ${db.enquiries[index].name}`, 'Enquiries'); writeDB(db);
    res.json({ success: true, enquiry: db.enquiries[index] });
});
app.delete('/api/admin/enquiries/:id', authenticateToken, (req, res) => {
    const db = readDB(); db.enquiries = (db.enquiries || []).filter(e => e.id !== req.params.id);
    logActivity(db, req.user.name, req.user.role, `Deleted lead ID: ${req.params.id}`, 'Enquiries'); writeDB(db);
    res.json({ success: true });
});

app.get('/api/admin/seo', authenticateToken, (req, res) => { const db = readDB(); res.json(db.seo_settings || {}); });
app.put('/api/admin/seo', authenticateToken, (req, res) => {
    const db = readDB(); db.seo_settings = { ...db.seo_settings, ...req.body };
    logActivity(db, req.user.name, req.user.role, 'Updated SEO settings', 'SEO'); writeDB(db);
    res.json({ success: true, seo: db.seo_settings });
});

app.get('/api/admin/users', authenticateToken, (req, res) => { const db = readDB(); res.json((db.admin_users || []).map(({ passwordHash, ...rest }) => rest)); });
app.post('/api/admin/users', authenticateToken, (req, res) => {
    const db = readDB(); if (!db.admin_users) db.admin_users = [];
    const { name, email, role, password, status } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
    const newUser = { id: 'usr_' + Date.now(), name: name.trim(), email: email.trim(), passwordHash: bcrypt.hashSync(password, 10), role: role || 'EDITOR', status: status || 'Active', lastLogin: 'Never' };
    db.admin_users.push(newUser); logActivity(db, req.user.name, req.user.role, `Created admin user: ${newUser.name}`, 'Admin Users'); writeDB(db);
    const { passwordHash, ...safeUser } = newUser; res.status(201).json({ success: true, user: safeUser });
});
app.put('/api/admin/users/:id', authenticateToken, (req, res) => {
    const db = readDB(); const index = (db.admin_users || []).findIndex(u => u.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'User not found' });
    const { password, ...updateData } = req.body; if (password) updateData.passwordHash = bcrypt.hashSync(password, 10);
    db.admin_users[index] = { ...db.admin_users[index], ...updateData };
    logActivity(db, req.user.name, req.user.role, `Updated admin user: ${db.admin_users[index].name}`, 'Admin Users'); writeDB(db);
    const { passwordHash, ...safeUser } = db.admin_users[index]; res.json({ success: true, user: safeUser });
});
app.delete('/api/admin/users/:id', authenticateToken, (req, res) => {
    const db = readDB(); if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own session.' });
    db.admin_users = (db.admin_users || []).filter(u => u.id !== req.params.id);
    logActivity(db, req.user.name, req.user.role, `Deleted admin user ID: ${req.params.id}`, 'Admin Users'); writeDB(db);
    res.json({ success: true });
});

app.get('/api/admin/logs', authenticateToken, (req, res) => { const db = readDB(); res.json(db.activity_logs || []); });

// ==========================================
// ==========================================
// 3. SUPER ADMIN API
// ==========================================
// ==========================================

// Super Admin Login
app.post('/api/superadmin/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const saDB = readSuperAdminDB();
    const sa = saDB.super_admin;

    // Accept plaintext password (first-time) or hashed
    let isValid = false;
    if (sa.email && sa.email.toLowerCase() === email.toLowerCase()) {
        if (sa.plainPassword && password === sa.plainPassword) {
            isValid = true;
        } else if (sa.passwordHash && bcrypt.compareSync(password, sa.passwordHash)) {
            isValid = true;
        }
    }

    // Fallback default credentials
    if (!isValid && email === 'superadmin@veslootech.com' && password === 'superadmin123') {
        isValid = true;
    }

    if (!isValid) return res.status(401).json({ error: 'Invalid Super Admin credentials' });

    const token = jwt.sign(
        { id: sa.id || 'sa_1', email: email, role: 'SUPER_ADMIN', name: sa.name || 'Veslootech' },
        SUPER_ADMIN_SECRET,
        { expiresIn: '12h' }
    );

    res.json({ success: true, token, user: { id: sa.id || 'sa_1', name: sa.name || 'Veslootech', email, role: 'SUPER_ADMIN' } });
});

app.get('/api/superadmin/me', authenticateSuperAdmin, (req, res) => {
    res.json({ success: true, user: req.superAdmin });
});

// List all clients
app.get('/api/superadmin/clients', authenticateSuperAdmin, (req, res) => {
    const saDB = readSuperAdminDB();
    const clients = (saDB.clients || []).map(client => {
        const clientDB = readClientDB(client.subname);
        return {
            ...client,
            shareableLink: `/${client.subname}`,
            adminLink: `/${client.subname}/admin`,
            stats: clientDB ? clientDB.stats || {} : {},
            enquiriesCount: clientDB ? (clientDB.enquiries || []).length : 0,
            newEnquiries: clientDB ? (clientDB.enquiries || []).filter(e => e.status === 'New').length : 0,
            coursesCount: clientDB ? (clientDB.courses || []).length : 0
        };
    });
    res.json({ success: true, clients });
});

// Create new client
app.post('/api/superadmin/clients', authenticateSuperAdmin, (req, res) => {
    const { businessName, subname, ownerEmail, ownerPassword, plan, adminName } = req.body;
    if (!businessName || !subname || !ownerEmail || !ownerPassword) {
        return res.status(400).json({ error: 'businessName, subname, ownerEmail, and ownerPassword are required' });
    }

    // Validate and slugify subname
    const slug = subname.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return res.status(400).json({ error: 'Invalid subname. Use only letters, numbers, and hyphens.' });

    const saDB = readSuperAdminDB();
    if ((saDB.clients || []).find(c => c.subname === slug)) {
        return res.status(400).json({ error: `A client with subname "${slug}" already exists.` });
    }

    // Create client folder
    const clientDir = path.join(CLIENTS_DIR, slug);
    if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });

    // Create client uploads folder
    const clientUploadDir = path.join(CLIENT_UPLOADS_DIR, slug);
    if (!fs.existsSync(clientUploadDir)) fs.mkdirSync(clientUploadDir, { recursive: true });

    // Seed client DB from template
    const template = getClientTemplate();
    template.business_profile.name = businessName;
    template.seo_settings = { ...template.seo_settings, siteTitle: `${businessName} | Digital Business Card` };

    // Create admin user for this client
    const adminUser = {
        id: 'usr_' + Date.now(),
        name: adminName || businessName + ' Admin',
        email: ownerEmail.trim(),
        passwordHash: bcrypt.hashSync(ownerPassword, 10),
        role: 'ADMIN',
        status: 'Active',
        lastLogin: 'Never'
    };
    template.admin_users = [adminUser];
    template.activity_logs = [{ id: 'log_init', user: 'Super Admin', role: 'SUPER_ADMIN', action: `Client site "${businessName}" created by Super Admin`, module: 'System', timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) }];

    writeClientDB(slug, template);

    // Register in super admin registry
    const newClient = {
        id: 'cli_' + Date.now(),
        subname: slug,
        businessName,
        ownerEmail: ownerEmail.trim(),
        plan: plan || 'Standard',
        status: 'Active',
        createdAt: new Date().toISOString().substring(0, 10),
        shareableLink: `/${slug}`,
        adminLink: `/${slug}/admin`
    };
    if (!saDB.clients) saDB.clients = [];
    saDB.clients.push(newClient);
    writeSuperAdminDB(saDB);

    res.status(201).json({ success: true, client: newClient });
});

// Update client
app.put('/api/superadmin/clients/:id', authenticateSuperAdmin, (req, res) => {
    const saDB = readSuperAdminDB();
    const index = (saDB.clients || []).findIndex(c => c.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Client not found' });

    const { businessName, status, plan } = req.body;
    if (businessName) saDB.clients[index].businessName = businessName;
    if (status) saDB.clients[index].status = status;
    if (plan) saDB.clients[index].plan = plan;

    writeSuperAdminDB(saDB);
    res.json({ success: true, client: saDB.clients[index] });
});

// Delete client
app.delete('/api/superadmin/clients/:id', authenticateSuperAdmin, (req, res) => {
    const saDB = readSuperAdminDB();
    const client = (saDB.clients || []).find(c => c.id === req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Remove client data folder
    const clientDir = path.join(CLIENTS_DIR, client.subname);
    if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true, force: true });

    saDB.clients = (saDB.clients || []).filter(c => c.id !== req.params.id);
    writeSuperAdminDB(saDB);

    res.json({ success: true, message: `Client "${client.businessName}" and all their data have been deleted.` });
});

// Get aggregated super admin dashboard stats
app.get('/api/superadmin/dashboard', authenticateSuperAdmin, (req, res) => {
    const saDB = readSuperAdminDB();
    const clients = saDB.clients || [];
    let totalVisits = 0, totalEnquiries = 0, newEnquiries = 0;
    clients.forEach(client => {
        const db = readClientDB(client.subname);
        if (db) {
            totalVisits += (db.stats || {}).totalVisits || 0;
            totalEnquiries += (db.enquiries || []).length;
            newEnquiries += (db.enquiries || []).filter(e => e.status === 'New').length;
        }
    });
    res.json({ totalClients: clients.length, activeClients: clients.filter(c => c.status === 'Active').length, totalVisits, totalEnquiries, newEnquiries });
});

// ==========================================
// ==========================================
// 4. CLIENT-SPECIFIC PUBLIC & ADMIN ROUTES
//    All under /c/:subname
// ==========================================
// ==========================================

// Public data for client site
app.get('/c/:subname/api/public-data', (req, res) => {
    const { subname } = req.params;
    const client = findClient(subname);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.status === 'Suspended') return res.status(403).json({ error: 'This site has been suspended.' });

    const db = readClientDB(subname);
    if (!db) return res.status(404).json({ error: 'Client data not found' });

    res.json({
        businessProfile: db.business_profile || {},
        courses: (db.courses || []).filter(c => c.status === 'Published').sort((a, b) => (a.order || 0) - (b.order || 0)),
        expertise: (db.expertise || []).filter(e => e.status === 'Published').sort((a, b) => (a.order || 0) - (b.order || 0)),
        gallery: (db.gallery || []).filter(g => g.status === 'Published').sort((a, b) => (a.order || 0) - (b.order || 0)),
        upi: db.upi_settings || {},
        contact: db.contact_details || {},
        actionButtons: (db.action_buttons || []).filter(b => b.status === 'Active').sort((a, b) => (a.order || 0) - (b.order || 0)),
        socialLinks: db.social_links || {},
        seo: db.seo_settings || {}
    });
});

// Track visit
app.post('/c/:subname/api/stats/visit', (req, res) => {
    const { subname } = req.params;
    const db = readClientDB(subname);
    if (!db) return res.status(404).json({ error: 'Client not found' });
    if (!db.stats) db.stats = { totalVisits: 0 };
    db.stats.totalVisits = (db.stats.totalVisits || 0) + 1;
    db.stats.lastUpdated = new Date().toISOString().substring(0, 10);
    writeClientDB(subname, db);

    // Also update super admin stats last active
    const saDB = readSuperAdminDB();
    const clientIdx = (saDB.clients || []).findIndex(c => c.subname === subname);
    if (clientIdx !== -1) { saDB.clients[clientIdx].lastActive = new Date().toISOString().substring(0, 10); writeSuperAdminDB(saDB); }

    res.json({ success: true, totalVisits: db.stats.totalVisits });
});

// Submit enquiry to client
app.post('/c/:subname/api/enquiries', (req, res) => {
    const { subname } = req.params;
    const { name, mobile, email, course, message, source } = req.body;
    if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile are required.' });

    const db = readClientDB(subname);
    if (!db) return res.status(404).json({ error: 'Client not found' });

    if (!db.enquiries) db.enquiries = [];
    const now = new Date();
    const newEnquiry = {
        id: 'enq_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        name: name.trim(), mobile: mobile.trim(), email: (email || '').trim(),
        course: course || 'General Enquiry', message: (message || '').trim(),
        date: now.toISOString().substring(0, 10), time: now.toTimeString().substring(0, 5),
        source: source || 'Website', status: 'New', notes: ''
    };
    db.enquiries.unshift(newEnquiry);
    logActivity(db, 'Website Visitor', 'PUBLIC', `New enquiry from ${name} for ${newEnquiry.course}`, 'Enquiries');
    writeClientDB(subname, db);
    res.status(201).json({ success: true, message: 'Enquiry submitted!', enquiry: newEnquiry });
});

// Client admin login
app.post('/c/:subname/api/auth/login', (req, res) => {
    const cleanSubname = String(req.params.subname || '').toLowerCase().trim().replace(/\/$/, '');
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const db = readClientDB(cleanSubname);
    if (!db) return res.status(404).json({ error: 'Client not found' });

    const users = db.admin_users || [];
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const isValid = bcrypt.compareSync(password, user.passwordHash || '');
    if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.status === 'Inactive') return res.status(403).json({ error: 'Account deactivated.' });

    user.lastLogin = new Date().toISOString().replace('T', ' ').substring(0, 16);
    logActivity(db, user.name, user.role, 'User logged into Client Admin Panel', 'Auth');
    writeClientDB(cleanSubname, db);

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, clientSubname: cleanSubname }, JWT_SECRET + '_' + cleanSubname, { expiresIn: '24h' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/c/:subname/api/auth/me', (req, res) => {
    const cleanSubname = String(req.params.subname || '').toLowerCase().trim().replace(/\/$/, '');
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });
    jwt.verify(token, JWT_SECRET + '_' + cleanSubname, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        res.json({ success: true, user });
    });
});

// Client upload
app.post('/c/:subname/api/upload', (req, res, next) => {
    const cleanSubname = String(req.params.subname || '').toLowerCase().trim().replace(/\/$/, '');
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });
    jwt.verify(token, JWT_SECRET + '_' + cleanSubname, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        const uploader = createClientUploader(cleanSubname);
        uploader.single('image')(req, res, (uploadErr) => {
            if (uploadErr) return res.status(400).json({ error: uploadErr.message });
            if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
            const relativePath = `/uploads/clients/${cleanSubname}/` + req.file.filename;
            const db = readClientDB(cleanSubname);
            if (db) { logActivity(db, user.name, user.role, `Uploaded: ${req.file.originalname}`, 'Gallery'); writeClientDB(cleanSubname, db); }
            res.json({ success: true, filePath: relativePath, originalName: req.file.originalname, sizeName: (req.file.size / 1024).toFixed(1) + ' KB' });
        });
    });
});

// ==========================================
// CLIENT ADMIN CMS ENDPOINTS (generic helper)
// ==========================================
function clientAuth(rawSubname, req, res, next) {
    const cleanSubname = String(rawSubname || '').toLowerCase().trim().replace(/\/$/, '');
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });
    jwt.verify(token, JWT_SECRET + '_' + cleanSubname, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        req.cleanSubname = cleanSubname;
        next();
    });
}

// Dashboard
app.get('/c/:subname/api/admin/dashboard', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname);
        if (!db) return res.status(404).json({ error: 'Client DB not found' });
        res.json({
            totalCourses: (db.courses || []).length,
            publishedCourses: (db.courses || []).filter(c => c.status === 'Published').length,
            totalGalleryImages: (db.gallery || []).length,
            newEnquiries: (db.enquiries || []).filter(e => e.status === 'New').length,
            totalVisits: (db.stats || {}).totalVisits || 0,
            activeStatus: (db.business_profile && db.business_profile.status === 'Active') ? 'Active' : 'Inactive',
            recentActivity: (db.activity_logs || []).slice(0, 10)
        });
    });
});

// Business Profile
app.get('/c/:subname/api/admin/business-profile', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.business_profile || {} : {}); });
});
app.put('/c/:subname/api/admin/business-profile', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        db.business_profile = { ...db.business_profile, ...req.body };
        logActivity(db, req.user.name, req.user.role, 'Updated Business Profile', 'Business Profile'); writeClientDB(subname, db);
        res.json({ success: true, businessProfile: db.business_profile });
    });
});

// Courses
app.get('/c/:subname/api/admin/courses', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.courses || [] : []); });
});
app.post('/c/:subname/api/admin/courses', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        if (!db.courses) db.courses = [];
        const newCourse = { id: 'crs_' + Date.now(), name: req.body.name || 'New Course', image: req.body.image || '', shortDescription: req.body.shortDescription || '', fullDescription: req.body.fullDescription || '', price: Number(req.body.price) || 0, duration: req.body.duration || '4 Weeks', category: req.body.category || 'General', features: Array.isArray(req.body.features) ? req.body.features : [], ctaText: req.body.ctaText || 'Enquire Now', ctaLink: req.body.ctaLink || '', order: db.courses.length + 1, status: req.body.status || 'Published' };
        db.courses.push(newCourse); logActivity(db, req.user.name, req.user.role, `Added course: ${newCourse.name}`, 'Courses'); writeClientDB(subname, db);
        res.status(201).json({ success: true, course: newCourse });
    });
});
app.put('/c/:subname/api/admin/courses/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        const index = (db.courses || []).findIndex(c => c.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Course not found' });
        db.courses[index] = { ...db.courses[index], ...req.body };
        logActivity(db, req.user.name, req.user.role, `Updated course: ${db.courses[index].name}`, 'Courses'); writeClientDB(subname, db);
        res.json({ success: true, course: db.courses[index] });
    });
});
app.delete('/c/:subname/api/admin/courses/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        const course = (db.courses || []).find(c => c.id === req.params.id);
        db.courses = (db.courses || []).filter(c => c.id !== req.params.id);
        logActivity(db, req.user.name, req.user.role, `Deleted course: ${course ? course.name : req.params.id}`, 'Courses'); writeClientDB(subname, db);
        res.json({ success: true });
    });
});

// Expertise
app.get('/c/:subname/api/admin/expertise', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.expertise || [] : []); });
});
app.post('/c/:subname/api/admin/expertise', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        if (!db.expertise) db.expertise = [];
        const item = { id: 'exp_' + Date.now(), title: req.body.title || 'Expertise', description: req.body.description || '', icon: req.body.icon || 'trending-up', order: db.expertise.length + 1, status: req.body.status || 'Published' };
        db.expertise.push(item); logActivity(db, req.user.name, req.user.role, `Added expertise: ${item.title}`, 'Expertise'); writeClientDB(subname, db);
        res.status(201).json({ success: true, item });
    });
});
app.put('/c/:subname/api/admin/expertise/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        const index = (db.expertise || []).findIndex(e => e.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Not found' });
        db.expertise[index] = { ...db.expertise[index], ...req.body };
        logActivity(db, req.user.name, req.user.role, `Updated expertise`, 'Expertise'); writeClientDB(subname, db);
        res.json({ success: true, item: db.expertise[index] });
    });
});
app.delete('/c/:subname/api/admin/expertise/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        db.expertise = (db.expertise || []).filter(e => e.id !== req.params.id);
        logActivity(db, req.user.name, req.user.role, `Deleted expertise`, 'Expertise'); writeClientDB(subname, db);
        res.json({ success: true });
    });
});

// Gallery
app.get('/c/:subname/api/admin/gallery', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.gallery || [] : []); });
});
app.post('/c/:subname/api/admin/gallery', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        if (!db.gallery) db.gallery = [];
        const item = { id: 'gal_' + Date.now(), title: req.body.title || 'Gallery Image', description: req.body.description || '', image: req.body.image || '', category: req.body.category || 'General', order: db.gallery.length + 1, status: req.body.status || 'Published' };
        db.gallery.push(item); logActivity(db, req.user.name, req.user.role, `Added gallery: ${item.title}`, 'Gallery'); writeClientDB(subname, db);
        res.status(201).json({ success: true, item });
    });
});
app.put('/c/:subname/api/admin/gallery/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        const index = (db.gallery || []).findIndex(g => g.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Not found' });
        db.gallery[index] = { ...db.gallery[index], ...req.body };
        logActivity(db, req.user.name, req.user.role, `Updated gallery`, 'Gallery'); writeClientDB(subname, db);
        res.json({ success: true, item: db.gallery[index] });
    });
});
app.delete('/c/:subname/api/admin/gallery/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        db.gallery = (db.gallery || []).filter(g => g.id !== req.params.id);
        logActivity(db, req.user.name, req.user.role, `Deleted gallery item`, 'Gallery'); writeClientDB(subname, db);
        res.json({ success: true });
    });
});

// UPI
app.get('/c/:subname/api/admin/upi', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.upi_settings || {} : {}); });
});
app.put('/c/:subname/api/admin/upi', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        db.upi_settings = { ...db.upi_settings, ...req.body };
        logActivity(db, req.user.name, req.user.role, 'Updated UPI settings', 'Payment / UPI'); writeClientDB(subname, db);
        res.json({ success: true, upi: db.upi_settings });
    });
});

// Contact
app.get('/c/:subname/api/admin/contact', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.contact_details || {} : {}); });
});
function cleanMapUrlBackend(input, address) {
    if (!input || typeof input !== 'string') {
        const query = address ? encodeURIComponent(address) : '';
        return query ? `https://maps.google.com/maps?q=${query}&output=embed` : '';
    }
    let url = input.trim();
    if (url.includes('<iframe')) {
        const match = url.match(/src=["']([^"']+)["']/i);
        if (match && match[1]) url = match[1];
    }
    url = url.replace(/&amp;/g, '&');
    if (url.includes('google.com/maps/embed') || url.includes('maps.google.com/maps/embed')) return url;
    if (url.includes('google.com/maps') || url.includes('maps.google.com')) {
        if (!url.includes('output=embed')) url += (url.includes('?') ? '&' : '?') + 'output=embed';
        return url;
    }
    if (url && !url.startsWith('http')) {
        return `https://maps.google.com/maps?q=${encodeURIComponent(url)}&output=embed`;
    }
    return url;
}

app.put('/c/:subname/api/admin/contact', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        const updated = { ...req.body };
        if (updated.mapUrl !== undefined) {
            updated.mapUrl = cleanMapUrlBackend(updated.mapUrl, updated.address || db.contact_details?.address);
        }
        db.contact_details = { ...db.contact_details, ...updated };
        logActivity(db, req.user.name, req.user.role, 'Updated contact details', 'Contact Details'); writeClientDB(subname, db);
        res.json({ success: true, contact: db.contact_details });
    });
});

// Action Buttons & Social
app.get('/c/:subname/api/admin/action-buttons', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json({ actionButtons: db ? db.action_buttons || [] : [], socialLinks: db ? db.social_links || {} : {} }); });
});
app.put('/c/:subname/api/admin/action-buttons', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        if (req.body.actionButtons) db.action_buttons = req.body.actionButtons;
        if (req.body.socialLinks) db.social_links = req.body.socialLinks;
        logActivity(db, req.user.name, req.user.role, 'Updated Action Buttons', 'Action Buttons'); writeClientDB(subname, db);
        res.json({ success: true, actionButtons: db.action_buttons, socialLinks: db.social_links });
    });
});

// Enquiries
app.get('/c/:subname/api/admin/enquiries', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.enquiries || [] : []); });
});
app.put('/c/:subname/api/admin/enquiries/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        const index = (db.enquiries || []).findIndex(e => e.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Enquiry not found' });
        db.enquiries[index] = { ...db.enquiries[index], ...req.body };
        logActivity(db, req.user.name, req.user.role, `Updated enquiry status`, 'Enquiries'); writeClientDB(subname, db);
        res.json({ success: true, enquiry: db.enquiries[index] });
    });
});
app.delete('/c/:subname/api/admin/enquiries/:id', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        db.enquiries = (db.enquiries || []).filter(e => e.id !== req.params.id);
        logActivity(db, req.user.name, req.user.role, `Deleted enquiry`, 'Enquiries'); writeClientDB(subname, db);
        res.json({ success: true });
    });
});

// SEO
app.get('/c/:subname/api/admin/seo', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.seo_settings || {} : {}); });
});
app.put('/c/:subname/api/admin/seo', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => {
        const db = readClientDB(subname); if (!db) return res.status(404).json({ error: 'Not found' });
        db.seo_settings = { ...db.seo_settings, ...req.body };
        logActivity(db, req.user.name, req.user.role, 'Updated SEO settings', 'SEO'); writeClientDB(subname, db);
        res.json({ success: true, seo: db.seo_settings });
    });
});

// Users
app.get('/c/:subname/api/admin/users', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? (db.admin_users || []).map(({ passwordHash, ...rest }) => rest) : []); });
});

// Logs
app.get('/c/:subname/api/admin/logs', (req, res) => {
    const { subname } = req.params;
    clientAuth(subname, req, res, () => { const db = readClientDB(subname); res.json(db ? db.activity_logs || [] : []); });
});

// ==========================================
// PAGE ROUTING
// ==========================================

// Super Admin Panel
app.get('/superadmin*', (req, res) => {
    res.sendFile(path.join(__dirname, 'superadmin.html'));
});

// Client Admin Panel — serve admin.html for /:subname/admin and legacy /c/:subname/admin
app.get(['/c/:subname/admin*', '/:subname/admin*'], (req, res, next) => {
    const rawSubname = req.params.subname || (req.path.split('/')[1]);
    if (rawSubname === 'superadmin' || rawSubname === 'admin' || rawSubname === 'api' || rawSubname === 'c') return next();
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Client Public Site — serve index.html for /:subname and legacy /c/:subname
app.get(['/c/:subname', '/c/:subname/', '/:subname', '/:subname/'], (req, res, next) => {
    const rawSubname = req.params.subname || (req.path.split('/')[1]);
    const SYSTEM_NAMES = ['superadmin', 'admin', 'api', 'c', 'uploads', 'favicon.ico'];
    if (SYSTEM_NAMES.includes(rawSubname)) return next();

    const client = findClient(rawSubname);
    if (!client) return res.status(404).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:20%;">Client site not found.</h2>');
    if (client.status === 'Suspended') return res.status(403).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:20%;">This client site has been suspended.</h2>');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Static Asset Passthrough for Client Sites ─────────────────────────────
// When index.html uses relative asset paths like src="c1.png",
// serve from root static assets.
const STATIC_ASSET_EXTS = /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff|woff2|ttf|eot|mp4|pdf|vcf)$/i;
app.get(['/c/:subname/:file(*)', '/:subname/:file(*)'], (req, res, next) => {
    const file = req.params.file;
    if (STATIC_ASSET_EXTS.test(file)) {
        const assetPath = path.join(__dirname, file);
        if (fs.existsSync(assetPath)) {
            return res.sendFile(assetPath);
        }
    }
    next();
});

// Original Admin SPA Route
app.get('/admin*', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Fallback to original index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`  CAPTGAINS MULTI-TENANT CMS SERVER`);
    console.log(`  Server running at:    http://localhost:${PORT}`);
    console.log(`  Original Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`  Super Admin Panel:    http://localhost:${PORT}/superadmin`);
    console.log(`  Client Site Example:  http://localhost:${PORT}/c/:subname`);
    console.log(`==================================================`);
    console.log(`  Super Admin Login:    superadmin@veslootech.com / superadmin123`);
    console.log(`==================================================`);
});
