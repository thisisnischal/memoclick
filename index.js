/**
 * MEMOCLICK - CORE ENGINE & PUBLIC CLIENT INTERFACE
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
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const bcrypt = require('bcryptjs');

const app = express();

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Storage configuration
const s3 = new S3Client({
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT || undefined,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY || 'dummy_key',
    secretAccessKey: process.env.STORAGE_SECRET_KEY || 'dummy_secret'
  },
  forcePathStyle: true
});
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'memoclick-docs';

// Database connection caching
let cachedDb = global.__mongoConn || null;
async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  if (!MONGODB_URI) return null;
  mongoose.set('strictQuery', true);
  cachedDb = await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000
  });
  global.__mongoConn = cachedDb;
  return cachedDb;
}

app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database connection failed. Verify MongoDB Atlas IP Access (0.0.0.0/0)' });
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"]
    }
  }
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300
});
app.use('/api/', limiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Schemas & Models
const { Schema } = mongoose;

const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'Owner' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const BusinessSchema = new Schema({
  businessId: { type: String, required: true, unique: true },
  businessName: { type: String, required: true },
  panNumber: { type: String },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true }
});

const FiscalYearSchema = new Schema({
  fiscalYear: { type: String, required: true },
  isCurrent: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true }
});

const CategorySchema = new Schema({
  name: { type: String, required: true },
  icon: { type: String, default: 'fa-folder' },
  color: { type: String, default: '#668EF0' },
  isActive: { type: Boolean, default: true }
});

const DocumentSchema = new Schema({
  documentRef: { type: String, required: true, unique: true },
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
  fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear', default: null },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
  title: { type: String, default: 'Document' },
  partyName: { type: String, default: '' },
  documentNumber: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const DocumentFileSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  originalFilename: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  storageKey: { type: String, required: true },
  sha256Checksum: { type: String, required: true }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);
const DocumentFile = mongoose.models.DocumentFile || mongoose.model('DocumentFile', DocumentFileSchema);

// Initial Data Seeder (runs automatically on first boot)
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

  // Ensure Admin User Exists
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

// ==========================================
// PUBLIC APIS (NO LOGIN REQUIRED)
// ==========================================
app.get('/api/businesses', async (req, res) => {
  const businesses = await Business.find({ isActive: true });
  const counts = await Document.aggregate([{ $group: { _id: '$businessId', count: { $sum: 1 } } }]);
  const countMap = {};
  counts.forEach(c => { if (c._id) countMap[c._id.toString()] = c.count; });
  res.json(businesses.map(b => ({ ...b.toObject(), documentCount: countMap[b._id.toString()] || 0 })));
});

app.get('/api/fiscal-years', async (req, res) => {
  res.json(await FiscalYear.find({ isActive: true }).sort({ fiscalYear: -1 }));
});

app.get('/api/categories', async (req, res) => {
  res.json(await Category.find({ isActive: true }));
});

app.get('/api/documents', async (req, res) => {
  const docs = await Document.find()
    .populate('businessId', 'businessName')
    .populate('fiscalYearId', 'fiscalYear')
    .populate('categoryId', 'name icon color')
    .sort({ createdAt: -1 })
    .limit(10);
  res.json({ documents: docs });
});

app.post('/api/documents/upload', upload.array('files', 5), async (req, res) => {
  try {
    const count = await Document.countDocuments();
    const docRef = `MC-2082-${String(count + 1).padStart(6, '0')}`;
    const doc = await Document.create({
      documentRef: docRef,
      businessId: req.body.businessId || null,
      fiscalYearId: req.body.fiscalYearId || null,
      categoryId: req.body.categoryId || null,
      title: req.body.title || 'Scanned Document',
      partyName: req.body.partyName || ''
    });

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const key = `${Date.now()}-${hash.substring(0, 8)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        try {
          await s3.send(new PutObjectCommand({
            Bucket: STORAGE_BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype
          }));
        } catch (e) {
          console.warn('Storage push bypassed for dev:', e.message);
        }
        await DocumentFile.create({
          documentId: doc._id,
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          storageKey: key,
          sha256Checksum: hash
        });
      }
    }

    res.json({ message: 'Document uploaded successfully', document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PUBLIC USER INTERFACE
// ==========================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MemoClick – Document Filing</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root {
      --primary: #668EF0;
      --bg: #F4F6FB;
      --card: #FFFFFF;
      --text: #283247;
      --muted: #7B8498;
      --clay-shadow: 6px 6px 14px #d8dfea, -6px -6px 14px #ffffff;
      --clay-inset: inset 2px 2px 5px #d8dfea, inset -2px -2px 5px #ffffff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); padding-bottom: 80px; }
    header { padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; }
    .brand { font-size: 1.4rem; font-weight: 800; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 20px; }
    .btn-act { padding: 22px; border-radius: 24px; color: #fff; text-align: center; cursor: pointer; font-weight: 800; font-size: 1.1rem; border: none; }
    .btn-cap { background: linear-gradient(135deg, #668EF0, #4672e0); box-shadow: 0 10px 20px rgba(102,142,240,0.3); }
    .btn-up { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 0 10px 20px rgba(43,181,148,0.3); }
    .card { background: var(--card); border-radius: 20px; padding: 18px; margin: 12px 20px; box-shadow: var(--clay-shadow); }
    .biz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 10px 20px; }
    .biz-card { background: #fff; border-radius: 18px; padding: 16px; box-shadow: var(--clay-shadow); }
    .admin-link { width: 40px; height: 40px; border-radius: 50%; background: #fff; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; color: var(--primary); text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><i class="fa-solid fa-shapes"></i> MemoClick</div>
    <a href="/admin" class="admin-link" title="Open Admin Panel"><i class="fa-solid fa-shield-halved"></i></a>
  </header>

  <div class="actions">
    <button class="btn-act btn-cap" onclick="triggerCamera()"><i class="fa-solid fa-camera"></i><br>CAPTURE</button>
    <button class="btn-act btn-up" onclick="document.getElementById('fileInput').click()"><i class="fa-solid fa-cloud-arrow-up"></i><br>UPLOAD</button>
  </div>
  <input type="file" id="fileInput" multiple style="display:none;" onchange="uploadFiles(event)">

  <h4 style="margin:20px 24px 6px;">My Businesses</h4>
  <div class="biz-grid" id="businessesList"><div class="biz-card">Loading businesses...</div></div>

  <h4 style="margin:20px 24px 6px;">Recent Documents</h4>
  <div id="docsList"><div class="card">Fetching records...</div></div>

  <script>
    async function loadData() {
      try {
        const [bRes, dRes] = await Promise.all([
          fetch('/api/businesses'),
          fetch('/api/documents')
        ]);
        const businesses = await bRes.json();
        const docs = await dRes.json();

        document.getElementById('businessesList').innerHTML = businesses.map(b => \`
          <div class="biz-card">
            <div style="font-weight:700;"><i class="fa-solid fa-building" style="color:var(--primary); margin-right:6px;"></i>\${b.businessName}</div>
            <div style="font-size:0.8rem; color:var(--muted); margin-top:4px;">\${b.documentCount} document\${b.documentCount === 1 ? '' : 's'}</div>
          </div>
        \`).join('');

        document.getElementById('docsList').innerHTML = (docs.documents && docs.documents.length) ? docs.documents.map(d => \`
          <div class="card" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>\${d.documentRef}</strong>
              <div style="font-size:0.8rem; color:var(--muted);">\${d.title} \${d.partyName ? '• ' + d.partyName : ''}</div>
            </div>
            <span style="font-size:0.75rem; background:#E5EEFF; color:#668EF0; padding:4px 8px; border-radius:8px; font-weight:700;">FY 2082/83</span>
          </div>
        \`).join('') : '<div class="card" style="color:var(--muted); text-align:center;">No documents uploaded yet. Tap CAPTURE or UPLOAD!</div>';
      } catch (err) {
        console.error(err);
      }
    }

    function triggerCamera() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.onchange = uploadFiles;
      input.click();
    }

    async function uploadFiles(e) {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append('files', files[i]);
      fd.append('title', 'Quick Document Upload');

      alert('Uploading document...');
      try {
        const res = await fetch('/api/documents/upload', { method: 'POST', body: fd });
        const data = await res.json();
        alert('Saved: ' + data.document.documentRef);
        loadData();
      } catch (err) {
        alert('Upload failed: ' + err.message);
      }
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
