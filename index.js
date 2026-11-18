/**
 * MEMOCLICK - PUBLIC CLIENT & FILING SYSTEM
 * File: index.js
 */
'use strict';

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Schemas & Models
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

// Safe Database Connection
async function ensureDb() {
  if (mongoose.connection.readyState === 1) return;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 5000 });
}

app.use(async (req, res, next) => {
  try {
    await ensureDb();
    next();
  } catch (err) {
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: 'Database connecting, retry shortly: ' + err.message });
    }
    next();
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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// APIs
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

// Upload Document Endpoint
app.post('/api/documents/upload', async (req, res) => {
  try {
    const { fileBase64, mimeType, fileName, fileSize, partyName } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'No file received' });

    const currentYear = '2082';
    const randCode = Math.floor(100000 + Math.random() * 900000);
    const docRef = `MC-${currentYear}-${randCode}`;

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

// Organize / Move Document Endpoint
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

// Password Protected View
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
      businessName: doc.businessId?.businessName || (doc.isInbox ? 'Uncategorized' : 'General'),
      categoryName: doc.categoryId?.name || (doc.isInbox ? 'Inbox' : 'File')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UI
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

    /* Action Buttons (Native HTML Labels - Immune to Chrome Click Blocking) */
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 20px; }
    .btn-act { padding: 22px; border-radius: 26px; color: #fff; text-align: center; cursor: pointer; font-weight: 800; font-size: 1.15rem; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; user-select: none; border:none; outline:none; text-decoration:none; }
    .btn-cap { background: linear-gradient(135deg, #668EF0, #426fe4); box-shadow: 0 10px 20px rgba(102,142,240,0.3); }
    .btn-up { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 0 10px 20px rgba(43,181,148,0.3); }
    .btn-act span.sub { font-size: 0.78rem; font-weight: 500; opacity: 0.9; }

    /* Accessible Native Hidden Input (Maintains render layout box so Chrome never drops click) */
    .accessible-hidden-input {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
      opacity: 0;
    }

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

    /* WHATSAPP-STYLE MEDIA PREVIEW (Matches Screenshot) */
    #whatsappPreviewModal { display:none; position:fixed; inset:0; background:#0b141a; z-index:10001; flex-direction:column; justify-content:space-between; }
    .wa-top-bar { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; background:rgba(11,20,26,0.95); color:#e9edef; }
    .wa-top-left { display:flex; align-items:center; gap:12px; font-weight:700; font-size:1.1rem; }
    .wa-top-actions { display:flex; align-items:center; gap:20px; }
    .wa-icon-btn { font-size:1.25rem; cursor:pointer; color:#e9edef; border:none; background:none; }
    .wa-crop-btn { color:#ff6b22; font-size:1.35rem; }
    .wa-trash-btn { color:#ff3b30; font-size:1.35rem; }
    .wa-send-btn { color:#007aff; font-weight:800; font-size:1.05rem; cursor:pointer; background:none; border:none; }
    
    .wa-preview-area { flex:1; display:flex; align-items:center; justify-content:center; padding:10px; overflow:hidden; }
    #waPreviewImg { max-width:100%; max-height:68vh; object-fit:contain; border-radius:8px; }

    /* PDF Badge Preview */
    #pdfPreviewCard { display:none; flex-direction:column; align-items:center; justify-content:center; color:#fff; text-align:center; padding:20px; }
    .pdf-big-icon { font-size:4rem; color:#ff3b30; margin-bottom:12px; }

    .wa-bottom-bar { padding:14px 18px; background:rgba(11,20,26,0.95); display:flex; gap:10px; align-items:center; }
    .wa-caption-input { flex:1; padding:12px 18px; border-radius:24px; border:1px solid #374248; background:#202c33; color:#fff; font-size:0.95rem; outline:none; }
    .wa-float-send { width:46px; height:46px; border-radius:50%; background:#007aff; color:#fff; border:none; display:flex; align-items:center; justify-content:center; font-size:1.15rem; cursor:pointer; flex-shrink:0; }

    /* Crop / Scanner Toggle Strip */
    .scan-strip { display:none; background:#202c33; padding:10px 14px; gap:8px; overflow-x:auto; }
    .scan-opt-btn { padding:6px 14px; border-radius:12px; font-size:0.75rem; font-weight:700; background:#374248; color:#fff; border:none; cursor:pointer; white-space:nowrap; }
    .scan-opt-btn.active { background:#007aff; }

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

    /* Uploading Spinner */
    .spinner-ring { border: 4px solid #f3f3f3; border-top: 4px solid #007aff; border-radius: 50%; width: 44px; height: 44px; animation: spin 0.9s linear infinite; margin: 0 auto 14px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
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

  <!-- ACTIONS (Native HTML Labels: 100% Guaranteed to trigger OS File Chooser & Camera) -->
  <div class="actions">
    <label class="btn-act btn-cap" for="captureFileInput">
      <i class="fa-solid fa-camera" style="font-size:1.8rem;"></i>
      <span>CAPTURE</span>
      <span class="sub">Take Photo Voucher</span>
    </label>
    <label class="btn-act btn-up" for="uploadFileInput">
      <i class="fa-solid fa-cloud-arrow-up" style="font-size:1.8rem;"></i>
      <span>UPLOAD</span>
      <span class="sub">Gallery & PDFs</span>
    </label>
  </div>

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

  <!-- 1. WHATSAPP STYLE REVIEW PREVIEW MODAL (Exact match to screenshot) -->
  <div id="whatsappPreviewModal">
    <div class="wa-top-bar">
      <div class="wa-top-left">
        <i class="fa-regular fa-image" style="font-size:1.3rem;"></i>
        <span>Image preview</span>
      </div>
      <div class="wa-top-actions">
        <button class="wa-icon-btn wa-crop-btn" title="Crop & Scan Options" onclick="toggleScanStrip()"><i class="fa-solid fa-crop-simple"></i></button>
        <button class="wa-icon-btn wa-trash-btn" title="Discard" onclick="discardPreview()"><i class="fa-regular fa-trash-can"></i></button>
        <button class="wa-send-btn" onclick="executeUpload()">Send</button>
      </div>
    </div>

    <!-- Scanner Filter Strip -->
    <div class="scan-strip" id="scanStrip">
      <button class="scan-opt-btn active" onclick="applyFilter('original')">Original</button>
      <button class="scan-opt-btn" onclick="applyFilter('enhance')">Auto-Scan</button>
      <button class="scan-opt-btn" onclick="applyFilter('crop')">Crop Border</button>
      <button class="scan-opt-btn" onclick="applyFilter('grayscale')">Grayscale</button>
      <button class="scan-opt-btn" onclick="applyFilter('bw')">High Contrast</button>
      <button class="scan-opt-btn" onclick="rotatePreview()"><i class="fa-solid fa-rotate-right"></i> Rotate</button>
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

    <!-- Bottom Caption Bar -->
    <div class="wa-bottom-bar">
      <input type="text" id="waCaptionInput" class="wa-caption-input" placeholder="Add a caption / Party name..." autocomplete="off">
      <button class="wa-float-send" title="Upload" onclick="executeUpload()"><i class="fa-solid fa-paper-plane"></i></button>
    </div>
  </div>

  <!-- 2. UPLOADING ANIMATION MODAL -->
  <div class="modal" id="uploadingMod
