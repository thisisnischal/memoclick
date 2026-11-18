/**
 * MEMOCLICK - CORE ENGINE & CLIENT INTERFACE
 * File: index.js
 */
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { google } = require('googleapis');

const app = express();

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'memoclick-production-crypto-fallback-key-2082';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'Asia/Kathmandu';

// Storage configuration
const s3 = new S3Client({
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT || undefined,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY || 'dummy_access_key',
    secretAccessKey: process.env.STORAGE_SECRET_KEY || 'dummy_secret_key'
  },
  forcePathStyle: true
});
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'memoclick-docs';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.APP_URL || `http://localhost:${PORT}`
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// MongoDB Connection Caching
let cachedDb = global.__mongoConn || null;
async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  if (!MONGODB_URI) return null;
  mongoose.set('strictQuery', true);
  cachedDb = await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
  });
  global.__mongoConn = cachedDb;
  return cachedDb;
}

app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database connection failed: check Atlas IP whitelist (0.0.0.0/0)' });
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https:"]
    }
  }
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Schemas & Models
const { Schema } = mongoose;
const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['Owner', 'Administrator', 'Staff', 'Viewer'], default: 'Staff' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const BusinessSchema = new Schema({
  businessId: { type: String, required: true, unique: true },
  businessName: { type: String, required: true },
  panNumber: { type: String },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const FiscalYearSchema = new Schema({
  fiscalYear: { type: String, required: true },
  isCurrent: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const CategorySchema = new Schema({
  name: { type: String, required: true },
  icon: { type: String, default: 'fa-folder' },
  color: { type: String, default: '#668EF0' },
  isActive: { type: Boolean, default: true }
});

const DocumentSchema = new Schema({
  documentRef: { type: String, required: true, unique: true, index: true },
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
  fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear', default: null },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
  title: { type: String, default: 'Untitled Document' },
  partyName: { type: String, default: '' },
  documentNumber: { type: String, default: '' },
  remarks: { type: String, default: '' },
  isOrganized: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
});

const DocumentFileSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  originalFilename: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  storageKey: { type: String, required: true },
  sha256Checksum: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const BackupJobSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  fileId: { type: Schema.Types.ObjectId, ref: 'DocumentFile', required: true },
  status: { type: String, enum: ['Pending', 'Processing', 'Backed Up', 'Failed'], default: 'Pending' }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);
const DocumentFile = mongoose.models.DocumentFile || mongoose.model('DocumentFile', DocumentFileSchema);
const BackupJob = mongoose.models.BackupJob || mongoose.model('BackupJob', BackupJobSchema);

// Initial Database Seeder
async function seedInitialData() {
  const businessCount = await Business.countDocuments();
  if (businessCount === 0) {
    await Business.create([
      { businessId: 'ABC-01', businessName: 'ABC Pvt. Ltd.', panNumber: '600123456' },
      { businessId: 'DEF-02', businessName: 'DEF Pvt. Ltd.', panNumber: '600789012' }
    ]);
    await FiscalYear.create([
      { fiscalYear: '2082/83', isCurrent: true },
      { fiscalYear: '2083/84' },
      { fiscalYear: '2084/85' }
    ]);
    await Category.create([
      { name: 'Debit Notes', icon: 'fa-file-invoice-dollar', color: '#668EF0' },
      { name: 'Credit Notes', icon: 'fa-receipt', color: '#9B51E0' },
      { name: 'Purchase Bills', icon: 'fa-shopping-bag', color: '#27AE60' },
      { name: 'Sales Bills', icon: 'fa-cash-register', color: '#2F80ED' },
      { name: 'Tax Documents', icon: 'fa-landmark', color: '#EB5757' },
      { name: 'Other Documents', icon: 'fa-folder-open', color: '#7B8498' }
    ]);
  }

  const adminEmail = (process.env.ADMIN_EMAIL || 'owner@memoclick.com').toLowerCase().trim();
  const ownerExists = await User.findOne({ email: adminEmail });
  if (!ownerExists) {
    const defaultPassword = 'MemoClick2082Secure!';
    const passwordHash = await bcrypt.hash(defaultPassword, 12);
    await User.create({
      name: 'System Owner',
      email: adminEmail,
      passwordHash,
      role: 'Owner'
    });
    console.log(`✅ Default Owner Account initialized: ${adminEmail}`);
  }
}
connectToDatabase().then(seedInitialData).catch(console.error);

// Auth Middleware
function generateToken(user) {
  return jwt.sign({ id: user._id, role: user.role, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Auth token required' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-passwordHash');
    if (!user || !user.isActive) return res.status(403).json({ error: 'Account inactive' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// APIs
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !user.isActive) {
    return res.status(401).json({ error: 'Invalid email or credentials' });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or credentials' });

  const token = generateToken(user);
  res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/businesses', requireAuth, async (req, res) => {
  const businesses = await Business.find({ isActive: true });
  const counts = await Document.aggregate([{ $group: { _id: '$businessId', count: { $sum: 1 } } }]);
  const countMap = {};
  counts.forEach(c => { if (c._id) countMap[c._id.toString()] = c.count; });
  res.json(businesses.map(b => ({ ...b.toObject(), documentCount: countMap[b._id.toString()] || 0 })));
});

app.get('/api/fiscal-years', requireAuth, async (req, res) => {
  res.json(await FiscalYear.find({ isActive: true }).sort({ fiscalYear: -1 }));
});

app.get('/api/categories', requireAuth, async (req, res) => {
  res.json(await Category.find({ isActive: true }));
});

app.get('/api/documents', requireAuth, async (req, res) => {
  const docs = await Document.find()
    .populate('businessId', 'businessName')
    .populate('fiscalYearId', 'fiscalYear')
    .populate('categoryId', 'name icon color')
    .sort({ createdAt: -1 })
    .limit(10);
  res.json({ documents: docs });
});

app.post('/api/documents/upload', requireAuth, upload.array('files', 5), async (req, res) => {
  try {
    const count = await Document.countDocuments();
    const docRef = `MC-2082-${String(count + 1).padStart(6, '0')}`;
    const doc = await Document.create({
      documentRef: docRef,
      businessId: req.body.businessId || null,
      fiscalYearId: req.body.fiscalYearId || null,
      categoryId: req.body.categoryId || null,
      title: req.body.title || 'Scanned Document',
      partyName: req.body.partyName || '',
      isOrganized: !!req.body.businessId
    });
    res.json({ message: 'Saved successfully', document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UI
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MemoClick</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root { --primary: #668EF0; --bg: #F4F6FB; --card: #FFFFFF; --text: #283247; --muted: #7B8498; }
    * { box-sizing: border-box; margin:0; padding:0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); padding-bottom: 90px; }
    header { padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; }
    .brand { font-size: 1.4rem; font-weight: 800; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 20px; }
    .btn-act { padding: 22px; border-radius: 24px; color: #fff; text-align: center; cursor: pointer; font-weight: 800; font-size: 1.1rem; }
    .btn-cap { background: linear-gradient(135deg, #668EF0, #4672e0); box-shadow: 0 10px 20px rgba(102,142,240,0.3); }
    .btn-up { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 0 10px 20px rgba(43,181,148,0.3); }
    .card { background: var(--card); border-radius: 20px; padding: 18px; margin: 12px 20px; box-shadow: 6px 6px 14px #d8dfea, -6px -6px 14px #ffffff; }
    .modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:999; justify-content:center; align-items:center; }
    .modal-box { background:#fff; padding:24px; border-radius:24px; width:90%; max-width:400px; }
    .input { width:100%; padding:12px; margin:10px 0; border-radius:12px; border:1px solid #ccc; font-size:1rem; }
  </style>
</head>
<body>
  <div id="loginModal" class="modal" style="display:none;">
    <div class="modal-box">
      <h3 style="margin-bottom:12px; font-weight:800;">Log In to MemoClick</h3>
      <p style="font-size:0.85rem; color:var(--muted); margin-bottom:10px;">Use your administrator email & password.</p>
      <input type="email" id="loginEmail" class="input" placeholder="Admin Email" value="${process.env.ADMIN_EMAIL || ''}">
      <input type="password" id="loginPass" class="input" placeholder="Password" value="MemoClick2082Secure!">
      <button onclick="doLogin()" style="width:100%; padding:12px; background:var(--primary); color:#fff; border:none; border-radius:12px; font-weight:700; cursor:pointer; margin-top:8px;">Sign In</button>
      <div id="loginError" style="color:red; font-size:0.8rem; margin-top:8px;"></div>
    </div>
  </div>

  <header>
    <div class="brand"><i class="fa-solid fa-shapes"></i> MemoClick</div>
    <div style="display:flex; gap:12px;">
      <a href="/admin" style="color:var(--text); text-decoration:none;"><i class="fa-solid fa-shield-halved"></i></a>
      <a href="javascript:void(0)" onclick="logout()" title="Logout" style="color:var(--text);"><i class="fa-solid fa-right-from-bracket"></i></a>
    </div>
  </header>

  <div class="actions">
    <div class="btn-act btn-cap" onclick="alert('Camera capture ready')"><i class="fa-solid fa-camera"></i><br>CAPTURE</div>
    <div class="btn-act btn-up" onclick="alert('Upload ready')"><i class="fa-solid fa-cloud-arrow-up"></i><br>UPLOAD</div>
  </div>

  <h4 style="margin:20px 24px 6px;">My Businesses</h4>
  <div id="businessesList"><div class="card">Loading...</div></div>

  <h4 style="margin:20px 24px 6px;">Recent Documents</h4>
  <div id="docsList"><div class="card">Fetching records...</div></div>

  <script>
    let token = localStorage.getItem('mc_token');

    async function loadData() {
      if (!token) {
        document.getElementById('loginModal').style.display = 'flex';
        return;
      }
      try {
        const [bRes, dRes] = await Promise.all([
          fetch('/api/businesses', { headers: { Authorization: 'Bearer ' + token } }),
          fetch('/api/documents', { headers: { Authorization: 'Bearer ' + token } })
        ]);
        if (bRes.status === 401 || dRes.status === 401) {
          logout();
          return;
        }
        const businesses = await bRes.json();
        const docs = await dRes.json();

        document.getElementById('businessesList').innerHTML = businesses.map(b => 
          \`<div class="card" style="font-weight:700;"><i class="fa-solid fa-building" style="color:var(--primary);"></i> \${b.businessName} <span style="float:right; font-size:0.8rem; color:var(--muted);">\${b.documentCount} docs</span></div>\`
        ).join('');

        document.getElementById('docsList').innerHTML = docs.documents.length ? docs.documents.map(d =>
          \`<div class="card">\${d.documentRef} - \${d.title}</div>\`
        ).join('') : '<div class="card" style="color:var(--muted);">No documents yet.</div>';

      } catch (err) {
        console.error(err);
      }
    }

    async function doLogin() {
      const email = document.getElementById('loginEmail').value;
      const password = document.getElementById('loginPass').value;
      const errDiv = document.getElementById('loginError');
      errDiv.innerText = '';

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (data.token) {
        localStorage.setItem('mc_token', data.token);
        token = data.token;
        document.getElementById('loginModal').style.display = 'none';
        loadData();
      } else {
        errDiv.innerText = data.error || 'Login failed';
      }
    }

    function logout() {
      localStorage.removeItem('mc_token');
      token = null;
      document.getElementById('loginModal').style.display = 'flex';
    }

    window.addEventListener('DOMContentLoaded', loadData);
  </script>
</body>
</html>`);
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT);
}
module.exports = app;
