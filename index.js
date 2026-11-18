/**
 * MEMOCLICK - PUBLIC CLIENT & FILING SYSTEM
 * File: index.js
 */
'use strict';

require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('Process Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Process Unhandled Rejection:', reason);
});

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const { Schema } = mongoose;

const BusinessSchema = new Schema({
  businessId: { type: String, required: true, unique: true },
  businessName: { type: String, required: true },
  panNumber: { type: String, default: '' },
  isActive: { type: Boolean, default: true }
});

const FiscalYearSchema = new Schema({
  fiscalYear: { type: String, required: true },
  isCurrent: { type: Boolean, default: false }
});

const CategorySchema = new Schema({
  name: { type: String, required: true },
  icon: { type: String, default: 'fa-folder' },
  color: { type: String, default: '#668EF0' }
});

const SettingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, required: true }
});

const DocumentSchema = new Schema({
  documentRef: { type: String, required: true, unique: true, index: true },
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
  fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear', default: null },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
  title: { type: String, default: 'Document' },
  partyName: { type: String, default: '' },
  isInbox: { type: Boolean, default: true, index: true },
  fileData: { type: String, required: true },
  fileType: { type: String, default: 'image/jpeg' },
  fileName: { type: String, default: 'file' },
  fileSize: { type: String, default: '0 KB' },
  createdAt: { type: Date, default: Date.now, index: true }
});

const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Setting = mongoose.models.Setting || mongoose.model('Setting', SettingSchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);

let cachedDb = null;
async function connectDb() {
  if (mongoose.connection.readyState >= 1) return mongoose.connection;
  if (!cachedDb) {
    if (!MONGODB_URI) return null;
    mongoose.set('strictQuery', true);
    mongoose.set('autoIndex', false);
    cachedDb = mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 4000,
      connectTimeoutMS: 4000
    }).catch(err => {
      cachedDb = null;
      console.error('Mongoose connection failed:', err.message);
      return null;
    });
  }
  return cachedDb;
}

app.use(async (req, res, next) => {
  try { await connectDb(); } catch (e) { console.error('Middleware DB check:', e.message); }
  next();
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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.get('/api/businesses', async (req, res) => {
  try {
    let list = await Business.find({ isActive: true });
    if (list.length === 0) {
      list = await Business.create([
        { businessId: 'ABC-01', businessName: 'ABC Pvt. Ltd.', panNumber: '600123456' },
        { businessId: 'DEF-02', businessName: 'DEF Pvt. Ltd.', panNumber: '600789012' }
      ]);
    }
    const counts = await Document.aggregate([{ $group: { _id: '$businessId', count: { $sum: 1 } } }]);
    const countMap = {};
    counts.forEach(c => { if (c._id) countMap[c._id.toString()] = c.count; });
    res.json(list.map(b => ({ ...b.toObject(), documentCount: countMap[b._id.toString()] || 0 })));
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/fiscal-years', async (req, res) => {
  try {
    let list = await FiscalYear.find().sort({ fiscalYear: -1 });
    if (list.length === 0) {
      list = await FiscalYear.create([{ fiscalYear: '2082/83', isCurrent: true }, { fiscalYear: '2083/84' }]);
    }
    res.json(list);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    let list = await Category.find();
    if (list.length === 0) {
      list = await Category.create([
        { name: 'Purchase Bills', icon: 'fa-shopping-bag', color: '#27AE60' },
        { name: 'Sales Bills', icon: 'fa-cash-register', color: '#2F80ED' },
        { name: 'Debit Notes', icon: 'fa-file-invoice-dollar', color: '#668EF0' },
        { name: 'Credit Notes', icon: 'fa-receipt', color: '#9B51E0' },
        { name: 'Tax Documents', icon: 'fa-landmark', color: '#EB5757' },
        { name: 'Other Documents', icon: 'fa-folder-open', color: '#7B8498' }
      ]);
    }
    res.json(list);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/documents', async (req, res) => {
  try {
    const docs = await Document.find()
      .select('-fileData')
      .populate('businessId', 'businessName')
      .populate('fiscalYearId', 'fiscalYear')
      .populate('categoryId', 'name')
      .sort({ createdAt: -1 })
      .limit(30);
    res.json({ documents: docs });
  } catch (e) {
    res.json({ documents: [] });
  }
});

app.post('/api/documents/upload', async (req, res) => {
  try {
    const { fileBase64, mimeType, fileName, fileSize, partyName } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'No file received' });

    const currentYear = '2082';
    const randCode = Math.floor(100000 + Math.random() * 900000);
    const docRef = 'MC-' + currentYear + '-' + randCode;

    const doc = await Document.create({
      documentRef: docRef,
      partyName: partyName || '',
      fileName: fileName || 'document',
      fileSize: fileSize || 'Unknown size',
      fileData: fileBase64,
      fileType: mimeType || 'image/jpeg',
      isInbox: true
    });

    res.json({ success: true, document: doc });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: 'Save failed: ' + err.message });
  }
});

app.post('/api/documents/:id/organize', async (req, res) => {
  try {
    const { businessId, fiscalYearId, categoryId, isUncategorized } = req.body;
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    if (isUncategorized) {
      doc.businessId = null;
      doc.fiscalYearId = null;
      doc.categoryId = null;
      doc.isInbox = true;
    } else {
      doc.businessId = businessId || null;
      doc.fiscalYearId = fiscalYearId || null;
      doc.categoryId = categoryId || null;
      doc.isInbox = false;
    }

    await doc.save();
    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents/:id/view', async (req, res) => {
  try {
    const { password } = req.body;
    const setting = await Setting.findOne({ key: 'view_password' });
    const correctPassword = (setting && setting.value) || process.env.VIEW_PASSWORD || '1234';

    if (!password || password.trim() !== correctPassword.trim()) {
      return res.status(401).json({ error: 'Incorrect view password.' });
    }

    const doc = await Document.findById(req.params.id)
      .populate('businessId', 'businessName')
      .populate('categoryId', 'name');

    if (!doc) return res.status(404).json({ error: 'Document not found' });

    res.json({
      success: true,
      fileData: doc.fileData,
      fileType: doc.fileType,
      fileName: doc.fileName,
      documentRef: doc.documentRef,
      businessName: doc.businessId ? doc.businessId.businessName : (doc.isInbox ? 'Uncategorized' : 'General'),
      categoryName: doc.categoryId ? doc.categoryId.name : (doc.isInbox ? 'Inbox' : 'File')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>MemoClick – Document Filing</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root {
      --primary: #007aff;
      --soft-blue: #E5EEFF;
      --mint: #C9EBDD;
      --bg: #F4F6FB;
      --card: #FFFFFF;
      --text: #1e293b;
      --muted: #64748b;
      --clay-shadow: 6px 6px 14px #d8dfea, -6px -6px 14px #ffffff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background: var(--bg); color: var(--text); padding-bottom: 90px; }
    header { padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top:0; background:rgba(244,246,251,0.92); backdrop-filter:blur(8px); z-index:100; }
    .brand { font-size: 1.4rem; font-weight: 800; color: #668EF0; display: flex; align-items: center; gap: 8px; }
    .icon-bubble { width: 42px; height: 42px; border-radius: 50%; background: #fff; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; color: #668EF0; text-decoration: none; font-size: 1.15rem; cursor: pointer; }

    /* Action Buttons */
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 20px; }
    .btn-act { padding: 22px; border-radius: 26px; color: #fff; text-align: center; cursor: pointer; font-weight: 800; font-size: 1.15rem; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; user-select: none; border:none; outline:none; }
    .btn-cap { background: linear-gradient(135deg, #668EF0, #426fe4); box-shadow: 0 10px 20px rgba(102,142,240,0.3); }
    .btn-up { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 0 10px 20px rgba(43,181,148,0.3); }
    .btn-act span.sub { font-size: 0.78rem; font-weight: 500; opacity: 0.9; }

    /* Hide inputs completely from the user */
    .hidden-input { display: none; }

    .sec-header { display: flex; justify-content: space-between; align-items: center; margin: 24px 24px 10px; }
    .sec-title { font-weight: 800; font-size: 1.1rem; }
    
    .biz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 0 20px; }
    .biz-card { background: #fff; border-radius: 20px; padding: 18px; box-shadow: var(--clay-shadow); cursor: pointer; transition: transform 0.15s ease; }
    .biz-card:hover { transform: translateY(-2px); }

    .doc-item { background: #fff; border-radius: 18px; padding: 16px; margin: 10px 20px; box-shadow: var(--clay-shadow); display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: transform 0.15s ease; }
    .doc-item:hover { transform: translateY(-2px); }
    .doc-ref { font-weight: 800; font-size: 0.95rem; }
    .doc-sub { font-size: 0.8rem; color: var(--muted); margin-top: 3px; }

    /* Modals */
    .modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:9999; justify-content:center; align-items:center; backdrop-filter: blur(5px); }
    .modal-box { background:#fff; padding:24px; border-radius:26px; width:92%; max-width:440px; max-height:90vh; overflow-y:auto; box-shadow: 0 20px 40px rgba(0,0,0,0.25); }
    .input { width:100%; padding:14px; margin:8px 0 14px; border-radius:14px; border:1px solid #d1d5db; font-size:0.95rem; outline:none; }
    .btn-primary { width:100%; padding:15px; background:#007aff; color:#fff; border:none; border-radius:14px; font-weight:800; cursor:pointer; font-size:1rem; display:flex; align-items:center; justify-content:center; gap:8px; }
    .btn-secondary { width:100%; padding:13px; background:#f1f5f9; color:var(--text); border:none; border-radius:14px; font-weight:700; cursor:pointer; font-size:0.95rem; margin-top:8px; }

    /* PREVIEW MODAL (WhatsApp Style) */
    #whatsappPreviewModal { display:none; position:fixed; inset:0; background:#0b141a; z-index:10001; flex-direction:column; justify-content:space-between; }
    .wa-top-bar { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; background:rgba(11,20,26,0.95); color:#e9edef; }
    .wa-top-left { display:flex; align-items:center; gap:12px; font-weight:700; font-size:1.1rem; }
    .wa-icon-btn { font-size:1.25rem; cursor:pointer; color:#e9edef; border:none; background:none; }
    
    .wa-preview-area { flex:1; display:flex; align-items:center; justify-content:center; padding:10px; overflow:hidden; }
    #waPreviewImg { max-width:100%; max-height:60vh; object-fit:contain; border-radius:8px; }

    /* PDF Badge Preview */
    #pdfPreviewCard { display:none; flex-direction:column; align-items:center; justify-content:center; color:#fff; text-align:center; padding:20px; }
    .pdf-big-icon { font-size:4rem; color:#ff3b30; margin-bottom:12px; }

    /* Filter strip for images */
    .scan-strip { display:flex; background:#202c33; padding:12px 14px; gap:10px; overflow-x:auto; justify-content:center; border-top: 1px solid #334149; border-bottom: 1px solid #334149;}
    .scan-opt-btn { padding:8px 16px; border-radius:20px; font-size:0.85rem; font-weight:700; background:#374248; color:#fff; border:none; cursor:pointer; white-space:nowrap; transition: 0.2s; }
    .scan-opt-btn.active { background:#007aff; box-shadow: 0 0 10px rgba(0,122,255,0.4); }

    .wa-bottom-bar { padding:14px 18px; background:rgba(11,20,26,0.95); display:flex; flex-direction: column; gap: 12px; padding-bottom: 24px;}
    .wa-caption-input { width:100%; padding:12px 18px; border-radius:24px; border:1px solid #374248; background:#202c33; color:#fff; font-size:0.95rem; outline:none; }
    .wa-float-send { width:100%; padding:16px; border-radius:14px; background:#007aff; color:#fff; border:none; font-weight:800; font-size:1rem; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; }

    /* Toast */
    #statusToast {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-100px);
      background: #283247; color: #fff; padding: 14px 24px; border-radius: 30px; font-weight: 700;
      font-size: 0.9rem; z-index: 20000; box-shadow: 0 10px 30px rgba(0,0,0,0.25); display: flex;
      align-items: center; gap: 10px; transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    #statusToast.show { transform: translateX(-50%) translateY(0); }
    #statusToast.success { background: #10B981; }
    #statusToast.error { background: #EF4444; }

    /* Uploading Spinner & Progress Bar */
    .spinner-ring { border: 4px solid #f3f3f3; border-top: 4px solid #007aff; border-radius: 50%; width: 44px; height: 44px; animation: spin 0.9s linear infinite; margin: 0 auto 14px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .progress-container { width: 100%; background: #e2e8f0; border-radius: 10px; margin-top: 15px; overflow: hidden; height: 8px; }
    .progress-bar { height: 100%; background: #007aff; width: 0%; transition: width 0.2s; border-radius: 10px; }
  </style>
</head>
<body>
  <div id="statusToast"><i class="fa-solid fa-spinner fa-spin" id="toastIcon"></i> <span id="toastMsg">Ready</span></div>

  <header>
    <div class="brand"><i class="fa-solid fa-shapes"></i> MemoClick</div>
    <div style="display:flex; gap:10px;">
      <a href="/admin" class="icon-bubble" title="Admin Portal"><i class="fa-solid fa-shield-halved"></i></a>
    </div>
  </header>

  <!-- ACTIONS -->
  <div class="actions">
    <!-- Call the function using inline onclick to prevent weird browser conflicts -->
    <button type="button" class="btn-act btn-cap" onclick="document.getElementById('directCamInput').click()">
      <i class="fa-solid fa-camera" style="font-size:1.8rem;"></i>
      <span>CAPTURE</span>
      <span class="sub">Take Photo Voucher</span>
    </button>

    <button type="button" class="btn-act btn-up" onclick="document.getElementById('directUploadInput').click()">
      <i class="fa-solid fa-cloud-arrow-up" style="font-size:1.8rem;"></i>
      <span>UPLOAD</span>
      <span class="sub">Gallery & PDFs</span>
    </button>
  </div>

  <!-- Hidden Inputs -->
  <input type="file" id="directCamInput" class="hidden-input" accept="image/*" capture="environment" onchange="handleIncomingFile(this)">
  <input type="file" id="directUploadInput" class="hidden-input" accept="image/*,application/pdf" onchange="handleIncomingFile(this)">

  <!-- DIRECTORY SECTION -->
  <div class="sec-header">
    <div class="sec-title">Directory / Businesses</div>
  </div>
  <div class="biz-grid" id="bizContainer"><div class="biz-card">Connecting to database...</div></div>

  <!-- RECENT DOCUMENTS -->
  <div class="sec-header">
    <div class="sec-title">Recent Documents</div>
    <span style="font-size:0.8rem; color:var(--muted);"><i class="fa-solid fa-lock"></i> Protected View</span>
  </div>
  <div id="docsContainer"><div class="doc-item">Fetching documents...</div></div>

  <!-- 1. PREVIEW MODAL -->
  <div id="whatsappPreviewModal">
    <div class="wa-top-bar">
      <div class="wa-top-left">
        <i class="fa-regular fa-image" style="font-size:1.3rem;"></i>
        <span>Review & Upload</span>
      </div>
      <div class="wa-top-actions">
        <button class="wa-icon-btn" title="Discard" onclick="discardPreview()"><i class="fa-regular fa-trash-can"></i> Cancel</button>
      </div>
    </div>

    <!-- Center Preview Area -->
    <div class="wa-preview-area">
      <img id="waPreviewImg" src="" alt="Preview">
      <div id="pdfPreviewCard">
        <i class="fa-solid fa-file-pdf pdf-big-icon"></i>
        <h4 id="pdfFileName" style="font-weight:800; margin-bottom:4px;">Document.pdf</h4>
        <p id="pdfFileSize" style="font-size:0.8rem; color:#94a3b8;">PDF Document</p>
      </div>
      <canvas id="hiddenCanvas" style="display:none;"></canvas>
    </div>

    <!-- Scanner Filter Strip (Hidden for PDFs) -->
    <div class="scan-strip" id="scanStrip">
      <button class="scan-opt-btn active" onclick="applyFilter('original')">Keep Original</button>
      <button class="scan-opt-btn" onclick="applyFilter('enhance')">Auto-Scan</button>
      <button class="scan-opt-btn" onclick="applyFilter('crop')">Crop Border</button>
    </div>

    <!-- Bottom Caption Bar & Upload Button -->
    <div class="wa-bottom-bar">
      <input type="text" id="waCaptionInput" class="wa-caption-input" placeholder="Add a caption / Party name..." autocomplete="off">
      <button class="wa-float-send" onclick="executeUpload()">
        <i class="fa-solid fa-cloud-arrow-up"></i> Upload Document
      </button>
    </div>
  </div>

  <!-- 2. UPLOADING ANIMATION MODAL -->
  <div class="modal" id="uploadingModal">
    <div class="modal-box" style="text-align:center; padding:36px 24px;">
      <div class="spinner-ring"></div>
      <h3 style="font-weight:800; margin-bottom:6px;">Uploading Document</h3>
      <p style="font-size:0.85rem; color:var(--muted);">Compressing & saving to database...</p>
      <div class="progress-container">
        <div class="progress-bar" id="uploadProgressBar"></div>
      </div>
    </div>
  </div>

  <!-- 3. DESTINATION FOLDER MODAL -->
  <div class="modal" id="destinationModal">
    <div class="modal-box">
      <div style="text-align:center; margin-bottom:14px;">
        <div style="width:52px; height:52px; background:var(--mint); color:#10B981; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:1.6rem; margin-bottom:8px;">
          <i class="fa-solid fa-check"></i>
        </div>
        <h3 style="font-weight:800;">Upload Complete!</h3>
        <p style="font-size:0.82rem; color:var(--muted);">Choose destination folder or save as uncategorized.</p>
      </div>

      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:18px; padding:16px; margin-bottom:16px;">
        <label style="font-size:0.8rem; font-weight:700; color:var(--muted);"><i class="fa-solid fa-building"></i> Destination Business</label>
        <select id="destBiz" class="input" style="background:#fff;"></select>

        <label style="font-size:0.8rem; font-weight:700; color:var(--muted);"><i class="fa-solid fa-calendar"></i> Nepal Fiscal Year</label>
        <select id="destFY" class="input" style="background:#fff;"></select>

        <label style="font-size:0.8rem; font-weight:700; color:var(--muted);"><i class="fa-solid fa-folder"></i> Destination Directory Folder</label>
        <select id="destCat" class="input" style="background:#fff;"></select>
      </div>

      <button class="btn-primary" onclick="confirmMoveToFolder()">
        <i class="fa-solid fa-folder-open"></i> Move Here
      </button>
      <button class="btn-secondary" onclick="confirmKeepUncategorized()">
        <i class="fa-solid fa-inbox"></i> Save as Uncategorized
      </button>
    </div>
  </div>

  <!-- PASSWORD PROMPT MODAL -->
  <div class="modal" id="pwdModal">
    <div class="modal-box">
      <div style="text-align:center; margin-bottom:12px;"><i class="fa-solid fa-lock" style="font-size:2.2rem; color:#007aff;"></i></div>
      <h3 style="font-weight:800; text-align:center; margin-bottom:6px;">Protected Document</h3>
      <p style="font-size:0.82rem; color:var(--muted); text-align:center; margin-bottom:16px;">Enter view password to view this file.</p>
      <input type="password" id="viewPwdInput" class="input" placeholder="Enter View Password" autocomplete="off">
      <button class="btn-primary" onclick="confirmPasswordView()">Unlock Document</button>
      <div id="pwdError" style="color:red; font-size:0.82rem; margin-top:8px; text-align:center; font-weight:600;"></div>
      <button class="btn-secondary" onclick="closeModal('pwdModal')">Cancel</button>
    </div>
  </div>

  <!-- VIEWER MODAL -->
  <div class="modal" id="viewModal">
    <div class="modal-box" style="max-width:540px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <div>
          <h4 id="vTitle" style="font-weight:800;"></h4>
          <span id="vMeta" style="font-size:0.8rem; color:var(--muted);"></span>
        </div>
        <button onclick="closeModal('viewModal')" style="border:none; background:#eee; width:32px; height:32px; border-radius:50%; font-weight:800; cursor:pointer;">&times;</button>
      </div>
      <div id="vContent" style="text-align:center; min-height:220px; display:flex; justify-content:center; align-items:center;"></div>
    </div>
  </div>

  <script>
    let currentRawBase64 = null;
    let processedBase64 = null;
    let currentMimeType = 'image/jpeg';
    let currentFileName = 'document';
    let currentFileSize = '0 KB';
    let activeFilter = 'original';
    let latestUploadedDocId = null;
    let selectedDocIdToView = null;

    function showToast(msg, type) {
      const toast = document.getElementById('statusToast');
      const icon = document.getElementById('toastIcon');
      const text = document.getElementById('toastMsg');
      toast.className = '';
      if (type === 'success') {
        toast.classList.add('success');
        icon.className = 'fa-solid fa-circle-check';
      } else if (type === 'error') {
        toast.classList.add('error');
        icon.className = 'fa-solid fa-triangle-exclamation';
      } else {
        icon.className = 'fa-solid fa-spinner fa-spin';
      }
      text.innerText = msg;
      toast.classList.add('show');
      if (type !== 'info') setTimeout(() => toast.classList.remove('show'), 3500);
    }

    function handleIncomingFile(input) {
      const file = input.files && input.files[0];
      if (!file) return;

      currentFileName = file.name || 'document';
      currentMimeType = file.type || 'image/jpeg';
      currentFileSize = (file.size / 1024).toFixed(1) + ' KB';

      if (currentMimeType === 'application/pdf' && file.size > 4 * 1024 * 1024) {
        alert('This PDF exceeds 4MB (Vercel serverless limit). Please upload a file under 4MB.');
        input.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = function(e) {
        currentRawBase64 = e.target.result;
        processedBase64 = e.target.result;
        openPreviewModal();
        input.value = ''; 
      };
      reader.readAsDataURL(file);
    }

    function openPreviewModal() {
      activeFilter = 'original';
      document.querySelectorAll('.scan-opt-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.scan-opt-btn').classList.add('active');
      
      document.getElementById('waCaptionInput').value = '';

      if (currentMimeType.startsWith('image/')) {
        document.getElementById('waPreviewImg').src = processedBase64;
        document.getElementById('waPreviewImg').style.display = 'block';
        document.getElementById('pdfPreviewCard').style.display = 'none';
        document.getElementById('scanStrip').style.display = 'flex';
      } else {
        document.getElementById('waPreviewImg').style.display = 'none';
        document.getElementById('pdfPreviewCard').style.display = 'flex';
        document.getElementById('pdfFileName').innerText = currentFileName;
        document.getElementById('pdfFileSize').innerText = currentFileSize;
        document.getElementById('scanStrip').style.display = 'none'; // Hide for PDF
      }

      document.getElementById('whatsappPreviewModal').style.display = 'flex';
    }

    function discardPreview() {
      document.getElementById('whatsappPreviewModal').style.display = 'none';
      currentRawBase64 = null;
      processedBase64 = null;
    }

    function applyFilter(mode) {
      activeFilter = mode;
      document.querySelectorAll('.scan-opt-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      renderProcessedImage();
    }

    function renderProcessedImage() {
      if (!currentRawBase64) return;
      
      const img = new Image();
      img.onload = function() {
        const canvas = document.getElementById('hiddenCanvas');
        const ctx = canvas.getContext('2d');

        let sw = img.width;
        let sh = img.height;
        let sx = 0, sy = 0;

        if (activeFilter === 'crop') {
          sx = Math.round(sw * 0.05);
          sy = Math.round(sh * 0.05);
          sw = Math.round(sw * 0.9);
          sh = Math.round(sh * 0.9);
        }

        canvas.width = sw;
        canvas.height = sh;

        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;

        if (activeFilter === 'enhance') {
          const factor = (259 * (45 + 255)) / (255 * (259 - 45));
          for (let i = 0; i < d.length; i += 4) {
            d[i] = factor * (d[i] - 128) + 128;
            d[i + 1] = factor * (d[i + 1] - 128) + 128;
            d[i + 2] = factor * (d[i + 2] - 128) + 128;
          }
          ctx.putImageData(imgData, 0, 0);
        }

        processedBase64 = canvas.toDataURL('image/jpeg', 0.8);
        document.getElementById('waPreviewImg').src = processedBase64;
      };
      img.src = currentRawBase64;
    }

    async function executeUpload() {
      if (!processedBase64) {
        showToast('No file selected', 'error');
        return;
      }

      const caption = document.getElementById('waCaptionInput').value.trim();

      document.getElementById('whatsappPreviewModal').style.display = 'none';
      document.getElementById('uploadingModal').style.display = 'flex';
      
      const progressBar = document.getElementById('uploadProgressBar');
      progressBar.style.width = '0%';

      const uploadPayload = await getDownscaledPayload(processedBase64);

      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/documents/upload', true);
        xhr.setRequestHeader('Content-Type', 'application/json');

        xhr.upload.onprogress = function(event) {
          if (event.lengthComputable) {
            const percentComplete = (event.loaded / event.total) * 100;
            progressBar.style.width = percentComplete + '%';
          }
        };

        xhr.onload = function() {
          closeModal('uploadingModal');
          if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            if (data.success) {
              latestUploadedDocId = data.document._id;
              document.getElementById('destinationModal').style.display = 'flex';
              loadData();
            } else {
              showToast('Upload error: ' + (data.error || 'Server error'), 'error');
            }
          } else {
            showToast('Upload failed: Server error ' + xhr.status, 'error');
          }
        };

        xhr.onerror = function() {
          closeModal('uploadingModal');
          showToast('Connection error during upload.', 'error');
        };

        xhr.send(JSON.stringify({
          fileBase64: uploadPayload,
          mimeType: currentMimeType,
          fileName: currentFileName,
          fileSize: currentFileSize,
          partyName: caption
        }));

      } catch (err) {
        closeModal('uploadingModal');
        showToast('Connection error: ' + err.message, 'error');
      }
    }

    function getDownscaledPayload(base64) {
      return new Promise((resolve) => {
        if (!currentMimeType.startsWith('image/')) return resolve(base64);

        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width;
          let h = img.height;
          const maxDim = 850;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
            else { w = Math.round((w * maxDim) / h); h = maxDim; }
          }
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.68));
        };
        img.onerror = () => resolve(base64);
        img.src = base64;
      });
    }

    async function confirmMoveToFolder() {
      if (!latestUploadedDocId) return;

      const bizId = document.getElementById('destBiz').value;
      const fyId = document.getElementById('destFY').value;
      const catId = document.getElementById('destCat').value;

      closeModal('destinationModal');
      showToast('Filing document to folder...', 'info');

      try {
        const res = await fetch('/api/documents/' + latestUploadedDocId + '/organize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessId: bizId, fiscalYearId: fyId, categoryId: catId, isUncategorized: false })
        });
        if (res.ok) {
          showToast('Document moved to folder successfully!', 'success');
          loadData();
        }
      } catch (e) {
        showToast('Error organizing folder', 'error');
      }
    }

    async function confirmKeepUncategorized() {
      if (!latestUploadedDocId) return;
      closeModal('destinationModal');

      try {
        await fetch('/api/documents/' + latestUploadedDocId + '/organize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isUncategorized: true })
        });
        showToast('Saved to Uncategorized Inbox!', 'success');
        loadData();
      } catch (e) {
        showToast('Saved', 'success');
      }
    }

    async function loadData() {
      try {
        const [bRes, fRes, cRes, dRes] = await Promise.all([
          fetch('/api/businesses').catch(() => null),
          fetch('/api/fiscal-years').catch(() => null),
          fetch('/api/categories').catch(() => null),
          fetch('/api/documents').catch(() => null)
        ]);

        const businesses = (bRes && bRes.ok) ? await bRes.json() : [];
        const fiscalYears = (fRes && fRes.ok) ? await fRes.json() : [];
        const categories = (cRes && cRes.ok) ? await cRes.json() : [];
        const docs = (dRes && dRes.ok) ? await dRes.json() : { documents: [] };

        const bizArr = Array.isArray(businesses) ? businesses : [];
        const fyArr = Array.isArray(fiscalYears) ? fiscalYears : [];
        const catArr = Array.isArray(categories) ? categories : [];
        const docArr = (docs && Array.isArray(docs.documents)) ? docs.documents : [];

        if (bizArr.length > 0) {
          document.getElementById('bizContainer').innerHTML = bizArr.map(function(b) {
            return '<div class="biz-card">' +
              '<div style="font-weight:700;"><i class="fa-solid fa-folder-open" style="color:#007aff; margin-right:6px;"></i>' + b.businessName + '</div>' +
              '<div style="font-size:0.8rem; color:var(--muted); margin-top:4px;">' + b.documentCount + ' Document' + (b.documentCount === 1 ? '' : 's') + '</div>' +
            '</div>';
          }).join('');

          document.getElementById('destBiz').innerHTML = bizArr.map(function(b) {
            return '<option value="' + b._id + '">' + b.businessName + '</option>';
          }).join('');
        }

        if (fyArr.length > 0) {
          document.getElementById('destFY').innerHTML = fyArr.map(function(f) {
            return '<option value="' + f._id + '">FY ' + f.fiscalYear + '</option>';
          }).join('');
        }
        if (catArr.length > 0) {
          document.getElementById('destCat').innerHTML = catArr.map(function(c) {
            return '<option value="' + c._id + '">📁 ' + c.name + '</option>';
          }).join('');
        }

        if (docArr.length > 0) {
          document.getElementById('docsContainer').innerHTML = docArr.map(function(d) {
            const iconClass = d.fileType === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-lines';
            const bName = d.businessId ? d.businessId.businessName : (d.isInbox ? 'Uncategorized Inbox' : 'General');
            const cName = d.categoryId ? d.categoryId.name : (d.fileType === 'application/pdf' ? 'PDF Document' : 'File');
            const pName = d.partyName ? ' (' + d.partyName + ')' : '';

            return '<div class="doc-item" data-id="' + d._id + '" onclick="promptView(this.dataset.id)">' +
              '<div>' +
                '<div class="doc-ref"><i class="fa-solid ' + iconClass + '" style="color:#007aff; margin-right:6px;"></i>' + d.documentRef + '</div>' +
                '<div class="doc-sub">' + bName + ' • ' + cName + pName + '</div>' +
              '</div>' +
              '<i class="fa-solid fa-lock" style="color:#c5cbe0;"></i>' +
            '</div>';
          }).join('');
        } else {
          document.getElementById('docsContainer').innerHTML = '<div class="doc-item" style="color:var(--muted); justify-content:center;">No documents uploaded yet. Tap CAPTURE or UPLOAD!</div>';
        }
      } catch (err) {
        console.error(err);
      }
    }

    function promptView(id) {
      selectedDocIdToView = id;
      document.getElementById('pwdError').innerText = '';
      document.getElementById('viewPwdInput').value = '';
      document.getElementById('pwdModal').style.display = 'flex';
    }

    async function confirmPasswordView() {
      const pwd = document.getElementById('viewPwdInput').value;
      if (!pwd) return;

      try {
        const res = await fetch('/api/documents/' + selectedDocIdToView + '/view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          closeModal('pwdModal');
          document.getElementById('vTitle').innerText = data.documentRef;
          document.getElementById('vMeta').innerText = data.businessName + ' • ' + data.categoryName;
          
          if (data.fileType.startsWith('image/')) {
            document.getElementById('vContent').innerHTML = '<img src="' + data.fileData + '" style="max-width:100%; max-height:65vh; border-radius:12px; object-fit:contain;">';
          } else {
            document.getElementById('vContent').innerHTML = '<iframe src="' + data.fileData + '" style="width:100%; height:60vh; border:none;"></iframe>';
          }
          document.getElementById('viewModal').style.display = 'flex';
        } else {
          document.getElementById('pwdError').innerText = data.error || 'Incorrect password';
        }
      } catch (err) {
        document.getElementById('pwdError').innerText = 'Connection error';
      }
    }

    function closeModal(id) {
      document.getElementById(id).style.display = 'none';
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
