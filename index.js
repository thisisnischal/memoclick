/**
 * MEMOCLICK - FAST ENGINE & PUBLIC CLIENT INTERFACE
 * File: index.js
 */
'use strict';

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');

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
  documentRef: { type: String, required: true, unique: true },
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear', required: true },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
  title: { type: String, default: 'Document' },
  partyName: { type: String, default: '' },
  fileData: { type: String, required: true },
  fileType: { type: String, default: 'image/jpeg' },
  createdAt: { type: Date, default: Date.now }
});

const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Setting = mongoose.models.Setting || mongoose.model('Setting', SettingSchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);

// Fast Cached DB Connection
let connPromise = null;
async function connectDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connPromise) {
    if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured');
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
    res.status(503).json({ error: 'Database unavailable: ' + err.message });
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
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

// ==========================================
// PUBLIC APIs
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fiscal-years', async (req, res) => {
  try {
    let list = await FiscalYear.find().sort({ fiscalYear: -1 });
    if (list.length === 0) {
      list = await FiscalYear.create([
        { fiscalYear: '2082/83', isCurrent: true },
        { fiscalYear: '2083/84' }
      ]);
    }
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    let list = await Category.find();
    if (list.length === 0) {
      list = await Category.create([
        { name: 'Purchase Bills', icon: 'fa-shopping-bag', color: '#27AE60' },
        { name: 'Sales Bills', icon: 'fa-cash-register', color: '#2F80ED' },
        { name: 'Tax Documents', icon: 'fa-landmark', color: '#EB5757' },
        { name: 'Other Documents', icon: 'fa-folder-open', color: '#7B8498' }
      ]);
    }
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/documents', async (req, res) => {
  try {
    const docs = await Document.find()
      .select('-fileData')
      .populate('businessId', 'businessName')
      .populate('fiscalYearId', 'fiscalYear')
      .populate('categoryId', 'name icon color')
      .sort({ createdAt: -1 })
      .limit(30);
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View Protected Document
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
      businessName: doc.businessId?.businessName,
      categoryName: doc.categoryId?.name
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fast Document Upload
app.post('/api/documents/upload', async (req, res) => {
  try {
    const { businessId, fiscalYearId, categoryId, partyName, fileBase64, mimeType } = req.body;

    if (!fileBase64) {
      return res.status(400).json({ error: 'No image or document received' });
    }

    // Resolve or fallback IDs if dropdowns were still loading
    let bId = businessId;
    let fId = fiscalYearId;
    let cId = categoryId;

    if (!bId || !mongoose.Types.ObjectId.isValid(bId)) {
      const firstBiz = await Business.findOne();
      bId = firstBiz ? firstBiz._id : null;
    }
    if (!fId || !mongoose.Types.ObjectId.isValid(fId)) {
      const firstFY = await FiscalYear.findOne();
      fId = firstFY ? firstFY._id : null;
    }
    if (!cId || !mongoose.Types.ObjectId.isValid(cId)) {
      const firstCat = await Category.findOne();
      cId = firstCat ? firstCat._id : null;
    }

    const count = await Document.countDocuments();
    const docRef = `MC-2082-${String(count + 1).padStart(6, '0')}`;

    const doc = await Document.create({
      documentRef: docRef,
      businessId: bId,
      fiscalYearId: fId,
      categoryId: cId,
      partyName: partyName || '',
      fileData: fileBase64,
      fileType: mimeType || 'image/jpeg'
    });

    res.json({ message: 'Success', documentRef: doc.documentRef });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Save failed: ' + err.message });
  }
});

// ==========================================
// USER INTERFACE
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background: var(--bg); color: var(--text); padding-bottom: 90px; }
    header { padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; }
    .brand { font-size: 1.4rem; font-weight: 800; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .admin-link { width: 44px; height: 44px; border-radius: 50%; background: #fff; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; color: var(--primary); text-decoration: none; font-size: 1.2rem; }
    
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 20px; }
    .btn-act { padding: 22px; border-radius: 24px; color: #fff; text-align: center; cursor: pointer; font-weight: 800; font-size: 1.15rem; border: none; outline: none; }
    .btn-cap { background: linear-gradient(135deg, #668EF0, #426fe4); box-shadow: 0 10px 20px rgba(102,142,240,0.3); }
    .btn-up { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 0 10px 20px rgba(43,181,148,0.3); }

    .sec-header { display: flex; justify-content: space-between; align-items: center; margin: 24px 24px 10px; }
    .sec-title { font-weight: 800; font-size: 1.1rem; }
    
    .biz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 0 20px; }
    .biz-card { background: #fff; border-radius: 20px; padding: 18px; box-shadow: var(--clay-shadow); }

    .doc-item { background: #fff; border-radius: 18px; padding: 16px; margin: 10px 20px; box-shadow: var(--clay-shadow); display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .doc-ref { font-weight: 800; font-size: 0.95rem; }
    .doc-sub { font-size: 0.8rem; color: var(--muted); margin-top: 3px; }

    /* Modals */
    .modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9999; justify-content:center; align-items:center; backdrop-filter: blur(4px); }
    .modal-box { background:#fff; padding:24px; border-radius:24px; width:92%; max-width:440px; max-height:90vh; overflow-y:auto; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
    .input { width:100%; padding:14px; margin:8px 0 14px; border-radius:12px; border:1px solid #d1d5db; font-size:0.95rem; outline:none; }
    .btn-sub { width:100%; padding:14px; background:var(--primary); color:#fff; border:none; border-radius:14px; font-weight:800; cursor:pointer; font-size:1rem; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><i class="fa-solid fa-shapes"></i> MemoClick</div>
    <a href="/admin" class="admin-link" title="Open Admin Panel"><i class="fa-solid fa-shield-halved"></i></a>
  </header>

  <div class="actions">
    <button class="btn-act btn-cap" onclick="openPicker('cameraPicker')"><i class="fa-solid fa-camera"></i><br>CAPTURE</button>
    <button class="btn-act btn-up" onclick="openPicker('filePicker')"><i class="fa-solid fa-cloud-arrow-up"></i><br>UPLOAD</button>
  </div>

  <!-- Direct Native Inputs -->
  <input type="file" id="cameraPicker" accept="image/*" capture="environment" style="display:none;" onchange="handlePickedFile(event)">
  <input type="file" id="filePicker" accept="image/*,application/pdf" style="display:none;" onchange="handlePickedFile(event)">

  <div class="sec-header">
    <div class="sec-title">Directory / Businesses</div>
  </div>
  <div class="biz-grid" id="bizContainer"><div class="biz-card">Loading businesses...</div></div>

  <div class="sec-header">
    <div class="sec-title">Recent Documents</div>
    <span style="font-size:0.8rem; color:var(--muted);"><i class="fa-solid fa-lock"></i> Protected View</span>
  </div>
  <div id="docsContainer"><div class="doc-item">Fetching documents...</div></div>

  <!-- FILING MODAL -->
  <div class="modal" id="filingModal">
    <div class="modal-box">
      <h3 style="font-weight:800; margin-bottom:6px;">File Document</h3>
      <p id="compressStatus" style="font-size:0.82rem; color:var(--primary); font-weight:700; margin-bottom:12px;"></p>
      
      <div id="previewWrap" style="text-align:center; margin-bottom:12px; display:none;">
        <img id="imgPreview" style="max-height:160px; max-width:100%; border-radius:12px; object-fit:contain; border:1px solid #eee;">
      </div>

      <label style="font-size:0.8rem; font-weight:700;">Business *</label>
      <select id="filingBiz" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Nepal Fiscal Year *</label>
      <select id="filingFY" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Directory Folder / Category *</label>
      <select id="filingCat" class="input"></select>

      <label style="font-size:0.8rem; font-weight:700;">Party / Supplier (Optional)</label>
      <input type="text" id="filingParty" class="input" placeholder="e.g. Pokhara Traders">

      <button id="saveDocBtn" class="btn-sub" onclick="submitDocumentFiling()">Save Document</button>
      <button style="width:100%; padding:10px; background:none; border:none; color:var(--muted); cursor:pointer; margin-top:8px; font-weight:700;" onclick="closeModal('filingModal')">Cancel</button>
    </div>
  </div>

  <!-- PASSWORD PROMPT MODAL -->
  <div class="modal" id="pwdModal">
    <div class="modal-box">
      <div style="text-align:center; margin-bottom:12px;"><i class="fa-solid fa-lock" style="font-size:2.2rem; color:var(--primary);"></i></div>
      <h3 style="font-weight:800; text-align:center; margin-bottom:6px;">Protected Document</h3>
      <p style="font-size:0.82rem; color:var(--muted); text-align:center; margin-bottom:16px;">Enter the view password to view this file.</p>
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
    let preparedBase64 = null;
    let preparedMime = 'image/jpeg';
    let selectedDocIdToView = null;

    function openPicker(id) {
      document.getElementById(id).click();
    }

    // Reliable Canvas Resizing with Image & PDF Fallback
    async function compressFile(file) {
      return new Promise((resolve) => {
        if (!file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => resolve({ base64: reader.result, mime: file.type });
          reader.readAsDataURL(file);
          return;
        }

        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          const maxDim = 1200;

          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve({ base64: canvas.toDataURL('image/jpeg', 0.8), mime: 'image/jpeg' });
        };
        img.onerror = () => {
          // Fallback if browser can't decode (e.g. HEIC)
          const reader = new FileReader();
          reader.onload = () => resolve({ base64: reader.result, mime: file.type });
          reader.readAsDataURL(file);
        };
        img.src = URL.createObjectURL(file);
      });
    }

    async function handlePickedFile(e) {
      const file = e.target.files[0];
      if (!file) return;

      document.getElementById('filingModal').style.display = 'flex';
      document.getElementById('compressStatus').innerText = 'Optimizing file...';
      document.getElementById('saveDocBtn').disabled = true;

      const { base64, mime } = await compressFile(file);
      preparedBase64 = base64;
      preparedMime = mime;

      document.getElementById('compressStatus').innerText = '';
      document.getElementById('saveDocBtn').disabled = false;

      if (mime.startsWith('image/')) {
        document.getElementById('imgPreview').src = base64;
        document.getElementById('previewWrap').style.display = 'block';
      } else {
        document.getElementById('previewWrap').style.display = 'none';
      }
      e.target.value = '';
    }

    async function submitDocumentFiling() {
      if (!preparedBase64) return alert('No file prepared');

      const btn = document.getElementById('saveDocBtn');
      btn.innerText = 'Saving Document...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/documents/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileBase64: preparedBase64,
            mimeType: preparedMime,
            businessId: document.getElementById('filingBiz').value,
            fiscalYearId: document.getElementById('filingFY').value,
            categoryId: document.getElementById('filingCat').value,
            partyName: document.getElementById('filingParty').value
          })
        });

        const data = await res.json();
        if (res.ok) {
          closeModal('filingModal');
          alert('Saved! Document ID: ' + data.documentRef);
          loadData();
        } else {
          alert('Upload failed: ' + (data.error || 'Server error'));
        }
      } catch (err) {
        alert('Network connection error: ' + err.message);
      } finally {
        btn.innerText = 'Save Document';
        btn.disabled = false;
      }
    }

    async function loadData() {
      try {
        const [bRes, fRes, cRes, dRes] = await Promise.all([
          fetch('/api/businesses'),
          fetch('/api/fiscal-years'),
          fetch('/api/categories'),
          fetch('/api/documents')
        ]);

        const businesses = await bRes.json();
        const fiscalYears = await fRes.json();
        const categories = await cRes.json();
        const docs = await dRes.json();

        // Render Directory
        document.getElementById('bizContainer').innerHTML = businesses.map(b => \`
          <div class="biz-card">
            <div style="font-weight:700;"><i class="fa-solid fa-folder-open" style="color:var(--primary); margin-right:6px;"></i>\${b.businessName}</div>
            <div style="font-size:0.8rem; color:var(--muted); margin-top:4px;">\${b.documentCount} Document\${b.documentCount === 1 ? '' : 's'}</div>
          </div>
        \`).join('');

        // Populate Selects
        document.getElementById('filingBiz').innerHTML = businesses.map(b => \`<option value="\${b._id}">\${b.businessName}</option>\`).join('');
        document.getElementById('filingFY').innerHTML = fiscalYears.map(f => \`<option value="\${f._id}">\${f.fiscalYear}</option>\`).join('');
        document.getElementById('filingCat').innerHTML = categories.map(c => \`<option value="\${c._id}">\${c.name}</option>\`).join('');

        // Render Documents
        document.getElementById('docsContainer').innerHTML = (docs.documents && docs.documents.length) ? docs.documents.map(d => \`
          <div class="doc-item" onclick="promptView('\${d._id}')">
            <div>
              <div class="doc-ref"><i class="fa-solid fa-file-lines" style="color:var(--primary); margin-right:6px;"></i>\${d.documentRef}</div>
              <div class="doc-sub">\${d.businessId?.businessName || 'Folder'} • \${d.categoryId?.name || 'File'} \${d.partyName ? '(' + d.partyName + ')' : ''}</div>
            </div>
            <i class="fa-solid fa-lock" style="color:#c5cbe0;"></i>
          </div>
        \`).join('') : '<div class="doc-item" style="color:var(--muted); justify-content:center;">No documents uploaded yet. Tap CAPTURE or UPLOAD!</div>';
      } catch (e) {
        console.error(e);
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
