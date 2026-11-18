/**
 * MEMOCLICK - FULL WORKING PUBLIC APP
 * File: index.js
 */
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const app = express();

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

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
  panNumber: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
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
  fileData: { type: String, default: '' }, // Inline preview base64
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);

// Connection & Guaranteed Seeding
let cachedDb = global.__mongoConn || null;
let isSeeded = false;

async function ensureDbAndSeed() {
  if (!cachedDb || mongoose.connection.readyState !== 1) {
    if (!MONGODB_URI) throw new Error('MONGODB_URI is missing');
    mongoose.set('strictQuery', true);
    cachedDb = await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000
    });
    global.__mongoConn = cachedDb;
  }

  if (!isSeeded) {
    // 1. Seed Admin User
    const adminEmail = (process.env.ADMIN_EMAIL || 'owner@nischal.com').toLowerCase().trim();
    let owner = await User.findOne({ email: adminEmail });
    const defaultPassword = 'MemoClick2082Secure!';
    const passwordHash = await bcrypt.hash(defaultPassword, 12);

    if (!owner) {
      await User.create({
        name: 'System Owner',
        email: adminEmail,
        passwordHash,
        role: 'Owner'
      });
      console.log(`Created admin user: ${adminEmail}`);
    }

    // 2. Seed Businesses
    const bizCount = await Business.countDocuments();
    if (bizCount === 0) {
      await Business.create([
        { businessId: 'ABC-01', businessName: 'ABC Pvt. Ltd.', panNumber: '600123456' },
        { businessId: 'DEF-02', businessName: 'DEF Pvt. Ltd.', panNumber: '600789012' }
      ]);
    }

    // 3. Seed Fiscal Years
    const fyCount = await FiscalYear.countDocuments();
    if (fyCount === 0) {
      await FiscalYear.create([
        { fiscalYear: '2082/83', isCurrent: true },
        { fiscalYear: '2083/84' },
        { fiscalYear: '2084/85' }
      ]);
    }

    // 4. Seed Categories
    const catCount = await Category.countDocuments();
    if (catCount === 0) {
      await Category.create([
        { name: 'Purchase Bills', icon: 'fa-shopping-bag', color: '#27AE60' },
        { name: 'Sales Bills', icon: 'fa-cash-register', color: '#2F80ED' },
        { name: 'Debit Notes', icon: 'fa-file-invoice-dollar', color: '#668EF0' },
        { name: 'Credit Notes', icon: 'fa-receipt', color: '#9B51E0' },
        { name: 'Tax Documents', icon: 'fa-landmark', color: '#EB5757' },
        { name: 'Other Documents', icon: 'fa-folder-open', color: '#7B8498' }
      ]);
    }

    isSeeded = true;
  }

  return cachedDb;
}

app.use(async (req, res, next) => {
  try {
    await ensureDbAndSeed();
    next();
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(503).json({ error: 'Database connection failed. Ensure 0.0.0.0/0 is added in MongoDB Network Access.' });
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"]
    }
  }
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ==========================================
// PUBLIC APIs
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
    .limit(15);
  res.json({ documents: docs });
});

app.post('/api/documents/upload', upload.array('files', 5), async (req, res) => {
  try {
    const count = await Document.countDocuments();
    const docRef = `MC-2082-${String(count + 1).padStart(6, '0')}`;

    let base64Preview = '';
    if (req.files && req.files.length > 0) {
      base64Preview = `data:${req.files[0].mimetype};base64,${req.files[0].buffer.toString('base64')}`;
    }

    const doc = await Document.create({
      documentRef: docRef,
      businessId: req.body.businessId || null,
      fiscalYearId: req.body.fiscalYearId || null,
      categoryId: req.body.categoryId || null,
      title: req.body.title || 'Uploaded Document',
      partyName: req.body.partyName || '',
      documentNumber: req.body.documentNumber || '',
      fileData: base64Preview
    });

    res.json({ message: 'Saved successfully', document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// USER INTERFACE (HTML/CSS/JS)
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>MemoClick – Business Filing</title>
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
      --clay-btn: 6px 6px 12px #c9d2e7, -6px -6px 12px #ffffff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); padding-bottom: 70px; }
    header { padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; }
    .brand { font-size: 1.4rem; font-weight: 800; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 20px; }
    .btn-act { padding: 22px; border-radius: 24px; color: #fff; text-align: center; cursor: pointer; font-weight: 800; font-size: 1.1rem; border: none; }
    .btn-cap { background: linear-gradient(135deg, #668EF0, #4672e0); box-shadow: 0 10px 20px rgba(102,142,240,0.3); }
    .btn-up { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 0 10px 20px rgba(43,181,148,0.3); }
    .card { background: var(--card); border-radius: 20px; padding: 18px; margin: 12px 20px; box-shadow: var(--clay-shadow); }
    .biz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 10px 20px; }
    .biz-card { background: #fff; border-radius: 18px; padding: 16px; box-shadow: var(--clay-shadow); cursor: pointer; }
    .admin-link { width: 42px; height: 42px; border-radius: 50%; background: #fff; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; color: var(--primary); text-decoration: none; font-size: 1.1rem; }

    /* Modal for Filing Document */
    .modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; justify-content:center; align-items:center; }
    .modal-box { background:#fff; padding:24px; border-radius:24px; width:92%; max-width:440px; max-height:90vh; overflow-y:auto; }
    .input { width:100%; padding:12px; margin:8px 0; border-radius:12px; border:1px solid #d1d5db; font-size:0.95rem; outline:none; }
    .btn-primary { width:100%; padding:14px; background:var(--primary); color:#fff; border:none; border-radius:14px; font-weight:700; cursor:pointer; margin-top:10px; font-size:1rem; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><i class="fa-solid fa-shapes"></i> MemoClick</div>
    <a href="/admin" class="admin-link" title="Admin Dashboard"><i class="fa-solid fa-shield-halved"></i></a>
  </header>

  <div class="actions">
    <button class="btn-act btn-cap" onclick="openCamera()"><i class="fa-solid fa-camera"></i><br>CAPTURE</button>
    <button class="btn-act btn-up" onclick="document.getElementById('fileUploadInput').click()"><i class="fa-solid fa-cloud-arrow-up"></i><br>UPLOAD</button>
  </div>
  <input type="file" id="fileUploadInput" multiple style="display:none;" onchange="handleFilePicked(event)">
  <input type="file" id="cameraInput" accept="image/*" capture="environment" style="display:none;" onchange="handleFilePicked(event)">

  <h4 style="margin:20px 24px 6px;">My Businesses</h4>
  <div class="biz-grid" id="businessesList"><div class="biz-card">Connecting to database...</div></div>

  <h4 style="margin:20px 24px 6px;">Recent Documents</h4>
  <div id="docsList"><div class="card">Fetching records...</div></div>

  <!-- Document Filing Modal -->
  <div class="modal" id="filingModal">
    <div class="modal-box">
      <h3 style="font-weight:800; margin-bottom:6px;">File This Document</h3>
      <p style="font-size:0.8rem; color:var(--muted); margin-bottom:14px;">Select the destination folder & details.</p>
      
      <div id="filePreviewWrap" style="text-align:center; margin-bottom:12px; display:none;">
        <img id="filePreview" style="max-height:160px; max-width:100%; border-radius:12px; object-fit:contain;">
      </div>

      <label style="font-size:0.8rem; font-weight:700;">Business *</label>
      <select id="selBusiness" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Nepal Fiscal Year *</label>
      <select id="selFiscalYear" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Category *</label>
      <select id="selCategory" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Party / Supplier Name (Optional)</label>
      <input type="text" id="inpParty" class="input" placeholder="e.g. Kathmandu Traders">

      <button class="btn-primary" onclick="submitFiling()">Save Document</button>
      <button style="width:100%; padding:10px; background:none; border:none; color:var(--muted); cursor:pointer; margin-top:6px; font-weight:700;" onclick="closeModal()">Cancel</button>
    </div>
  </div>

  <script>
    let activeFiles = null;
    let cachedBusinesses = [];
    let cachedFiscalYears = [];
    let cachedCategories = [];

    async function loadApp() {
      try {
        const [bRes, fRes, cRes, dRes] = await Promise.all([
          fetch('/api/businesses'),
          fetch('/api/fiscal-years'),
          fetch('/api/categories'),
          fetch('/api/documents')
        ]);

        cachedBusinesses = await bRes.json();
        cachedFiscalYears = await fRes.json();
        cachedCategories = await cRes.json();
        const docs = await dRes.json();

        // Render Businesses
        document.getElementById('businessesList').innerHTML = cachedBusinesses.map(b => \`
          <div class="biz-card">
            <div style="font-weight:700;"><i class="fa-solid fa-building" style="color:var(--primary); margin-right:6px;"></i>\${b.businessName}</div>
            <div style="font-size:0.8rem; color:var(--muted); margin-top:4px;">\${b.documentCount} Document\${b.documentCount === 1 ? '' : 's'}</div>
          </div>
        \`).join('');

        // Populate Modal Selects
        document.getElementById('selBusiness').innerHTML = cachedBusinesses.map(b => \`<option value="\${b._id}">\${b.businessName}</option>\`).join('');
        document.getElementById('selFiscalYear').innerHTML = cachedFiscalYears.map(f => \`<option value="\${f._id}">\${f.fiscalYear}</option>\`).join('');
        document.getElementById('selCategory').innerHTML = cachedCategories.map(c => \`<option value="\${c._id}">\${c.name}</option>\`).join('');

        // Render Recent Documents
        document.getElementById('docsList').innerHTML = (docs.documents && docs.documents.length) ? docs.documents.map(d => \`
          <div class="card" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong style="color:var(--text);">\${d.documentRef}</strong>
              <div style="font-size:0.8rem; color:var(--muted);">\${d.businessId?.businessName || 'General'} • \${d.categoryId?.name || 'Document'} \${d.partyName ? '(' + d.partyName + ')' : ''}</div>
            </div>
            <span style="font-size:0.75rem; background:#E5EEFF; color:#668EF0; padding:4px 8px; border-radius:8px; font-weight:700;">\${d.fiscalYearId?.fiscalYear || '2082/83'}</span>
          </div>
        \`).join('') : '<div class="card" style="color:var(--muted); text-align:center;">No documents uploaded yet. Tap CAPTURE or UPLOAD!</div>';

      } catch (err) {
        console.error(err);
        document.getElementById('businessesList').innerHTML = '<div class="biz-card" style="color:red;">Failed to connect to database. Check MongoDB IP Access (0.0.0.0/0).</div>';
      }
    }

    function openCamera() {
      document.getElementById('cameraInput').click();
    }

    function handleFilePicked(e) {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      activeFiles = files;

      // Show preview for image
      if (files[0].type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          document.getElementById('filePreview').src = ev.target.result;
          document.getElementById('filePreviewWrap').style.display = 'block';
        };
        reader.readAsDataURL(files[0]);
      } else {
        document.getElementById('filePreviewWrap').style.display = 'none';
      }

      document.getElementById('filingModal').style.display = 'flex';
    }

    async function submitFiling() {
      if (!activeFiles) return;
      const fd = new FormData();
      for (let i = 0; i < activeFiles.length; i++) fd.append('files', activeFiles[i]);
      fd.append('businessId', document.getElementById('selBusiness').value);
      fd.append('fiscalYearId', document.getElementById('selFiscalYear').value);
      fd.append('categoryId', document.getElementById('selCategory').value);
      fd.append('partyName', document.getElementById('inpParty').value);

      closeModal();
      alert('Uploading document...');

      try {
        const res = await fetch('/api/documents/upload', { method: 'POST', body: fd });
        const data = await res.json();
        alert('Filed successfully as: ' + data.document.documentRef);
        loadApp();
      } catch (err) {
        alert('Upload failed: ' + err.message);
      }
    }

    function closeModal() {
      document.getElementById('filingModal').style.display = 'none';
      document.getElementById('fileUploadInput').value = '';
      document.getElementById('cameraInput').value = '';
      activeFiles = null;
    }

    window.addEventListener('DOMContentLoaded', loadApp);
  </script>
</body>
</html>`);
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT);
}
module.exports = app;
