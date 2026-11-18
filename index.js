/**
 * MEMOCLICK - FULL-STACK BUSINESS DOCUMENT MANAGEMENT SYSTEM
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
  isInbox: { type: Boolean, default: false },
  fileData: { type: String, required: true },
  fileType: { type: String, default: 'image/jpeg' },
  createdAt: { type: Date, default: Date.now, index: true }
});

const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Setting = mongoose.models.Setting || mongoose.model('Setting', SettingSchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);

// Connection Pool
let connPromise = null;
async function connectDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connPromise) {
    if (!MONGODB_URI) throw new Error('MONGODB_URI is missing');
    connPromise = mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
  }
  return connPromise;
}

app.use(async (req, res, next) => {
  try {
    await connectDb();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database connecting...' });
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

// ==========================================
// PUBLIC REST APIS
// ==========================================
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
        { name: 'Agreements', icon: 'fa-file-contract', color: '#10B981' },
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
    const { isInbox, businessId, categoryId } = req.query;
    const filter = {};
    if (isInbox === 'true') filter.isInbox = true;
    if (businessId) filter.businessId = businessId;
    if (categoryId) filter.categoryId = categoryId;

    const docs = await Document.find(filter)
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

// Password Protected Document View
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
      title: doc.title,
      documentRef: doc.documentRef,
      businessName: doc.businessId?.businessName || 'General',
      categoryName: doc.categoryId?.name || 'File'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Collision-Free Document Upload API
app.post('/api/documents/upload', async (req, res) => {
  try {
    const { businessId, fiscalYearId, categoryId, partyName, fileBase64, mimeType, isInbox } = req.body;

    if (!fileBase64) {
      return res.status(400).json({ error: 'No image or file data received' });
    }

    let bId = (businessId && mongoose.Types.ObjectId.isValid(businessId)) ? businessId : null;
    let fId = (fiscalYearId && mongoose.Types.ObjectId.isValid(fiscalYearId)) ? fiscalYearId : null;
    let cId = (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) ? categoryId : null;

    if (!isInbox) {
      if (!bId) { const b = await Business.findOne(); if (b) bId = b._id; }
      if (!fId) { const f = await FiscalYear.findOne(); if (f) fId = f._id; }
      if (!cId) { const c = await Category.findOne(); if (c) cId = c._id; }
    }

    // Unique Collision-Free Reference Generator
    const currentYear = '2082';
    const randCode = Math.floor(100000 + Math.random() * 900000);
    const docRef = `MC-${currentYear}-${randCode}`;

    const doc = await Document.create({
      documentRef: docRef,
      businessId: bId,
      fiscalYearId: fId,
      categoryId: cId,
      partyName: partyName || '',
      isInbox: !!isInbox,
      fileData: fileBase64,
      fileType: mimeType || 'image/jpeg'
    });

    res.json({
      message: 'Success',
      documentRef: doc.documentRef,
      document: {
        _id: doc._id,
        documentRef: doc.documentRef,
        partyName: doc.partyName,
        createdAt: doc.createdAt
      }
    });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: 'Save failed: ' + err.message });
  }
});

// ==========================================
// USER INTERFACE (CLAYMORPHISM)
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>MemoClick – Business Document Management</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root {
      --primary: #668EF0;
      --soft-blue: #E5EEFF;
      --mint: #C9EBDD;
      --lavender: #E9E0FF;
      --peach: #FFE3D3;
      --yellow: #FFF0C7;
      --bg: #F4F6FB;
      --card: #FFFFFF;
      --text: #283247;
      --muted: #7B8498;
      --clay-shadow: 6px 6px 14px #d8dfea, -6px -6px 14px #ffffff;
      --clay-inset: inset 2px 2px 5px #d8dfea, inset -2px -2px 5px #ffffff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background: var(--bg); color: var(--text); padding-bottom: 90px; }
    header { padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top:0; background:rgba(244,246,251,0.92); backdrop-filter:blur(8px); z-index:100; }
    .brand { font-size: 1.4rem; font-weight: 800; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .icon-bubble { width: 42px; height: 42px; border-radius: 50%; background: #fff; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; color: var(--primary); text-decoration: none; font-size: 1.15rem; cursor: pointer; }

    /* Hero Buttons */
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 20px; }
    .btn-act { padding: 22px; border-radius: 26px; color: #fff; text-align: center; cursor: pointer; font-weight: 800; font-size: 1.15rem; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: none; outline: none; }
    .btn-cap { background: linear-gradient(135deg, #668EF0, #426fe4); box-shadow: 0 10px 20px rgba(102,142,240,0.3); }
    .btn-up { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 0 10px 20px rgba(43,181,148,0.3); }
    .btn-act span.sub { font-size: 0.78rem; font-weight: 500; opacity: 0.9; }

    .sec-header { display: flex; justify-content: space-between; align-items: center; margin: 24px 24px 10px; }
    .sec-title { font-weight: 800; font-size: 1.1rem; }
    
    .biz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 0 20px; }
    .biz-card { background: #fff; border-radius: 20px; padding: 18px; box-shadow: var(--clay-shadow); cursor: pointer; transition: transform 0.15s ease; }
    .biz-card:hover { transform: translateY(-2px); }

    .doc-item { background: #fff; border-radius: 18px; padding: 16px; margin: 10px 20px; box-shadow: var(--clay-shadow); display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: transform 0.15s ease; }
    .doc-item:hover { transform: translateY(-2px); }
    .doc-ref { font-weight: 800; font-size: 0.95rem; }
    .doc-sub { font-size: 0.8rem; color: var(--muted); margin-top: 3px; }

    /* Animated Toast Notification */
    #statusToast {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-100px);
      background: #283247; color: #fff; padding: 14px 24px; border-radius: 30px; font-weight: 700;
      font-size: 0.9rem; z-index: 10000; box-shadow: 0 10px 30px rgba(0,0,0,0.25); display: flex;
      align-items: center; gap: 10px; transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    #statusToast.show { transform: translateX(-50%) translateY(0); }
    #statusToast.success { background: #10B981; }
    #statusToast.error { background: #EF4444; }

    /* Modals */
    .modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9999; justify-content:center; align-items:center; backdrop-filter: blur(4px); }
    .modal-box { background:#fff; padding:24px; border-radius:24px; width:92%; max-width:440px; max-height:90vh; overflow-y:auto; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
    .input { width:100%; padding:14px; margin:8px 0 14px; border-radius:14px; border:1px solid #d1d5db; font-size:0.95rem; outline:none; }
    .btn-sub { width:100%; padding:14px; background:var(--primary); color:#fff; border:none; border-radius:14px; font-weight:800; cursor:pointer; font-size:1rem; }

    /* Live Camera Screen */
    #cameraOverlay { display:none; position:fixed; inset:0; background:#000; z-index:10001; flex-direction:column; justify-content:space-between; }
    #cameraVideo { width:100%; height:75vh; object-fit:cover; }
    .cam-ctrls { height:25vh; background:#111; display:flex; justify-content:space-around; align-items:center; padding:0 24px; }
    .shutter-btn { width:74px; height:74px; border-radius:50%; background:#fff; border:6px solid rgba(255,255,255,0.3); display:flex; align-items:center; justify-content:center; cursor:pointer; }
    .shutter-core { width:52px; height:52px; border-radius:50%; background:var(--primary); }

    /* Scanner Filter Strip */
    .filter-bar { display:flex; gap:8px; overflow-x:auto; margin:10px 0; padding:4px 0; }
    .f-btn { padding:6px 14px; border-radius:12px; font-size:0.75rem; font-weight:700; background:#f0f2f5; border:none; cursor:pointer; white-space:nowrap; }
    .f-btn.active { background:var(--primary); color:#fff; }
  </style>
</head>
<body>
  <!-- Status Toast -->
  <div id="statusToast"><i class="fa-solid fa-spinner fa-spin" id="toastIcon"></i> <span id="toastMsg">Ready</span></div>

  <header>
    <div class="brand"><i class="fa-solid fa-shapes"></i> MemoClick</div>
    <div style="display:flex; gap:10px;">
      <div class="icon-bubble" onclick="openInbox()"><i class="fa-solid fa-inbox"></i></div>
      <a href="/admin" class="icon-bubble" title="Admin Portal"><i class="fa-solid fa-shield-halved"></i></a>
    </div>
  </header>

  <!-- Hero Capture / Upload -->
  <div class="actions">
    <button class="btn-act btn-cap" onclick="initiateCapture()">
      <i class="fa-solid fa-camera" style="font-size:1.8rem;"></i>
      <span>CAPTURE</span>
      <span class="sub">Scan Bills & Vouchers</span>
    </button>
    <label class="btn-act btn-up" for="filePickerInput">
      <i class="fa-solid fa-cloud-arrow-up" style="font-size:1.8rem;"></i>
      <span>UPLOAD</span>
      <span class="sub">Gallery Photos & PDFs</span>
      <input type="file" id="filePickerInput" accept="image/*,application/pdf" style="display:none;" onchange="handleFilePicked(this)">
    </label>
  </div>
  <input type="file" id="fallbackCameraInput" accept="image/*" capture="environment" style="display:none;" onchange="handleFilePicked(this)">

  <!-- Directory Section -->
  <div class="sec-header">
    <div class="sec-title">Directory / Businesses</div>
  </div>
  <div class="biz-grid" id="bizContainer"><div class="biz-card">Connecting to database...</div></div>

  <!-- Recent Documents -->
  <div class="sec-header">
    <div class="sec-title" id="listHeading">Recent Documents</div>
    <span style="font-size:0.8rem; color:var(--muted);"><i class="fa-solid fa-lock"></i> Protected View</span>
  </div>
  <div id="docsContainer"><div class="doc-item">Fetching documents...</div></div>

  <!-- LIVE CAMERA VIEWFINDER OVERLAY -->
  <div id="cameraOverlay">
    <video id="cameraVideo" autoplay playsinline></video>
    <div class="cam-ctrls">
      <div class="icon-bubble" onclick="stopCamera()"><i class="fa-solid fa-xmark"></i></div>
      <div class="shutter-btn" onclick="captureLiveFrame()"><div class="shutter-core"></div></div>
      <div class="icon-bubble" onclick="flipCamera()"><i class="fa-solid fa-camera-rotate"></i></div>
    </div>
  </div>

  <!-- AUTO-SCAN & FILING MODAL -->
  <div class="modal" id="filingModal">
    <div class="modal-box">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3 style="font-weight:800;">Review & File Document</h3>
        <button onclick="retakeCurrent()" style="border:none; background:#f0f2f5; padding:6px 12px; border-radius:10px; font-weight:700; font-size:0.8rem; cursor:pointer;">Retake</button>
      </div>

      <div style="text-align:center; margin-bottom:8px; background:#000; border-radius:14px; overflow:hidden; min-height:180px; display:flex; align-items:center; justify-content:center;">
        <canvas id="previewCanvas" style="max-height:220px; max-width:100%; object-fit:contain;"></canvas>
      </div>

      <!-- Auto Scan Readability Controls -->
      <div class="filter-bar">
        <button class="f-btn active" onclick="setFilter('original')">Keep Original</button>
        <button class="f-btn" onclick="setFilter('enhance')">Auto Scan (Enhanced)</button>
        <button class="f-btn" onclick="setFilter('grayscale')">Grayscale</button>
        <button class="f-btn" onclick="setFilter('bw')">High Contrast B&W</button>
        <button class="f-btn" onclick="rotatePreview()"><i class="fa-solid fa-rotate-right"></i> Rotate</button>
      </div>

      <label style="font-size:0.8rem; font-weight:700;">Business *</label>
      <select id="filingBiz" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Nepal Fiscal Year *</label>
      <select id="filingFY" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Directory Folder / Category *</label>
      <select id="filingCat" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Party / Supplier Name (Optional)</label>
      <input type="text" id="filingParty" class="input" placeholder="e.g. Kathmandu Traders">

      <div style="display:flex; gap:10px; margin-top:8px;">
        <button class="btn-sub" style="background:#7B8498; flex:1;" onclick="submitFiling(true)">Save to Inbox</button>
        <button class="btn-sub" style="flex:1;" onclick="submitFiling(false)">Save to Folder</button>
      </div>
      <button style="width:100%; padding:10px; background:none; border:none; color:var(--muted); cursor:pointer; margin-top:4px; font-weight:700;" onclick="closeModal('filingModal')">Cancel</button>
    </div>
  </div>

  <!-- PASSWORD PROMPT MODAL -->
  <div class="modal" id="pwdModal">
    <div class="modal-box">
      <div style="text-align:center; margin-bottom:12px;"><i class="fa-solid fa-lock" style="font-size:2.2rem; color:var(--primary);"></i></div>
      <h3 style="font-weight:800; text-align:center; margin-bottom:6px;">Protected Document</h3>
      <p style="font-size:0.82rem; color:var(--muted); text-align:center; margin-bottom:16px;">Enter the view password to inspect this document.</p>
      <input type="password" id="viewPwdInput" class="input" placeholder="Enter View Password" autocomplete="off">
      <button class="btn-sub" onclick="confirmPasswordView()">Unlock Document</button>
      <div id="pwdError" style="color:red; font-size:0.82rem; margin-top:8px; text-align:center; font-weight:600;"></div>
      <button style="width:100%; padding:10px; background:none; border:none; color:var(--muted); cursor:pointer; margin-top:6px; font-weight:700;" onclick="closeModal('pwdModal')">Cancel</button>
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
    let rawImage = new Image();
    let currentFilter = 'original';
    let currentRotation = 0;
    let cameraStream = null;
    let facingMode = 'environment';
    let selectedDocIdToView = null;
    let preparedMime = 'image/jpeg';
    let isViewingInbox = false;

    function showToast(msg, type = 'info') {
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

    // Camera Capture Workflow (Section 6 of Master Prompt)
    async function initiateCapture() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera API unavailable');
        }
        document.getElementById('cameraOverlay').style.display = 'flex';
        if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facingMode, width: { ideal: 1280 } },
          audio: false
        });
        document.getElementById('cameraVideo').srcObject = cameraStream;
      } catch (err) {
        // Fallback to native camera input
        document.getElementById('cameraOverlay').style.display = 'none';
        document.getElementById('fallbackCameraInput').click();
      }
    }

    function flipCamera() {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      initiateCapture();
    }

    function stopCamera() {
      if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
      document.getElementById('cameraOverlay').style.display = 'none';
    }

    function captureLiveFrame() {
      const video = document.getElementById('cameraVideo');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1000;
      canvas.height = video.videoHeight || 750;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      stopCamera();
      rawImage.onload = () => {
        currentFilter = 'original';
        currentRotation = 0;
        document.getElementById('filingModal').style.display = 'flex';
        renderCanvas();
      };
      rawImage.src = canvas.toDataURL('image/jpeg', 0.85);
    }

    function handleFilePicked(input) {
      const file = input.files && input.files[0];
      if (!file) return;

      if (file.type && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          rawImage.onload = () => {
            currentFilter = 'original';
            currentRotation = 0;
            document.getElementById('filingModal').style.display = 'flex';
            renderCanvas();
          };
          rawImage.src = e.target.result;
        };
        reader.readAsDataURL(file);
      } else {
        // PDF document direct upload
        const reader = new FileReader();
        reader.onload = (e) => {
          uploadDirectBase64(e.target.result, file.type || 'application/pdf');
        };
        reader.readAsDataURL(file);
      }
      input.value = '';
    }

    // Auto-Scan Canvas Enhancement Engine
    function renderCanvas() {
      const canvas = document.getElementById('previewCanvas');
      const ctx = canvas.getContext('2d');

      const isSideways = currentRotation === 90 || currentRotation === 270;
      canvas.width = isSideways ? rawImage.height : rawImage.width;
      canvas.height = isSideways ? rawImage.width : rawImage.height;

      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((currentRotation * Math.PI) / 180);
      ctx.drawImage(rawImage, -rawImage.width / 2, -rawImage.height / 2);
      ctx.restore();

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imgData.data;

      if (currentFilter === 'grayscale') {
        for (let i = 0; i < d.length; i += 4) {
          const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
      } else if (currentFilter === 'bw') {
        for (let i = 0; i < d.length; i += 4) {
          const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) > 130 ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
      } else if (currentFilter === 'enhance') {
        const factor = (259 * (40 + 255)) / (255 * (259 - 40));
        for (let i = 0; i < d.length; i += 4) {
          d[i] = factor * (d[i] - 128) + 128;
          d[i + 1] = factor * (d[i + 1] - 128) + 128;
          d[i + 2] = factor * (d[i + 2] - 128) + 128;
        }
        ctx.putImageData(imgData, 0, 0);
      }
    }

    function setFilter(f) {
      currentFilter = f;
      document.querySelectorAll('.f-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      renderCanvas();
    }

    function rotatePreview() {
      currentRotation = (currentRotation + 90) % 360;
      renderCanvas();
    }

    function retakeCurrent() {
      closeModal('filingModal');
      initiateCapture();
    }

    // Submit Document Filing
    async function submitFiling(isInbox = false) {
      const canvas = document.getElementById('previewCanvas');
      const base64Data = canvas.toDataURL('image/jpeg', 0.72);
      closeModal('filingModal');
      await uploadDirectBase64(base64Data, 'image/jpeg', isInbox);
    }

    async function uploadDirectBase64(base64Data, mimeType, isInbox = false) {
      showToast('Uploading to database...', 'info');

      try {
        const res = await fetch('/api/documents/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileBase64: base64Data,
            mimeType: mimeType,
            businessId: document.getElementById('filingBiz').value,
            fiscalYearId: document.getElementById('filingFY').value,
            categoryId: document.getElementById('filingCat').value,
            partyName: document.getElementById('filingParty').value,
            isInbox: isInbox
          })
        });

        const data = await res.json();
        if (res.ok) {
          showToast('Saved: ' + data.documentRef, 'success');
          loadData();
        } else {
          showToast('Failed: ' + (data.error || 'Server error'), 'error');
        }
      } catch (err) {
        showToast('Connection error: ' + err.message, 'error');
      }
    }

    async function loadData() {
      try {
        const [bRes, fRes, cRes, dRes] = await Promise.all([
          fetch('/api/businesses').catch(() => null),
          fetch('/api/fiscal-years').catch(() => null),
          fetch('/api/categories').catch(() => null),
          fetch(isViewingInbox ? '/api/documents?isInbox=true' : '/api/documents').catch(() => null)
        ]);

        const businesses = (bRes && bRes.ok) ? await bRes.json() : [];
        const fiscalYears = (fRes && fRes.ok) ? await fRes.json() : [];
        const categories = (cRes && cRes.ok) ? await cRes.json() : [];
        const docs = (dRes && dRes.ok) ? await dRes.json() : { documents: [] };

        const bizArr = Array.isArray(businesses) ? businesses : [];
        const fyArr = Array.isArray(fiscalYears) ? fiscalYears : [];
        const catArr = Array.isArray(categories) ? categories : [];
        const docArr = (docs && Array.isArray(docs.documents)) ? docs.documents : [];

        // Directory
        if (bizArr.length > 0) {
          document.getElementById('bizContainer').innerHTML = bizArr.map(b => \`
            <div class="biz-card">
              <div style="font-weight:700;"><i class="fa-solid fa-folder-open" style="color:var(--primary); margin-right:6px;"></i>\${b.businessName}</div>
              <div style="font-size:0.8rem; color:var(--muted); margin-top:4px;">\${b.documentCount} Document\${b.documentCount === 1 ? '' : 's'}</div>
            </div>
          \`).join('');
          document.getElementById('filingBiz').innerHTML = bizArr.map(b => \`<option value="\${b._id}">\${b.businessName}</option>\`).join('');
        }

        if (fyArr.length > 0) {
          document.getElementById('filingFY').innerHTML = fyArr.map(f => \`<option value="\${f._id}">\${f.fiscalYear}</option>\`).join('');
        }
        if (catArr.length > 0) {
          document.getElementById('filingCat').innerHTML = catArr.map(c => \`<option value="\${c._id}">\${c.name}</option>\`).join('');
        }

        // Recent Documents List
        if (docArr.length > 0) {
          document.getElementById('docsContainer').innerHTML = docArr.map(d => \`
            <div class="doc-item" onclick="promptView('\${d._id}')">
              <div>
                <div class="doc-ref"><i class="fa-solid fa-file-lines" style="color:var(--primary); margin-right:6px;"></i>\${d.documentRef}</div>
                <div class="doc-sub">\${d.businessId?.businessName || (d.isInbox ? 'Unsorted Inbox' : 'General')} • \${d.categoryId?.name || 'File'} \${d.partyName ? '(' + d.partyName + ')' : ''}</div>
              </div>
              <i class="fa-solid fa-lock" style="color:#c5cbe0;"></i>
            </div>
          \`).join('');
        } else {
          document.getElementById('docsContainer').innerHTML = '<div class="doc-item" style="color:var(--muted); justify-content:center;">No documents uploaded yet. Tap CAPTURE or UPLOAD!</div>';
        }
      } catch (err) {
        console.error(err);
      }
    }

    function openInbox() {
      isViewingInbox = !isViewingInbox;
      document.getElementById('listHeading').innerText = isViewingInbox ? 'Unsorted Inbox' : 'Recent Documents';
      loadData();
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
            document.getElementById('vContent').innerHTML = \`<img src="\${data.fileData}" style="max-width:100%; max-height:65vh; border-radius:12px; object-fit:contain;">\`;
          } else {
            document.getElementById('vContent').innerHTML = \`<iframe src="\${data.fileData}" style="width:100%; height:60vh; border:none;"></iframe>\`;
          }
          document.getElementById('viewModal').style.display = 'flex';
        } else {
          document.getElementById('pwdError').innerText = data.error || 'Incorrect view password';
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
