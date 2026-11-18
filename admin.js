/**
 * MEMOCLICK - ADMINISTRATIVE FILE MANAGER & SETTINGS
 * File: admin.js
 */
'use strict';

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'memoclick-production-crypto-fallback-key-2082';
const MONGODB_URI = process.env.MONGODB_URI;

// Schemas & Models
const { Schema } = mongoose;

const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'Owner' },
  isActive: { type: Boolean, default: true }
});

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
  businessId: { type: Schema.Types.ObjectId, ref: 'Business' },
  fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear' },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
  title: { type: String, default: 'Document' },
  partyName: { type: String, default: '' },
  fileData: { type: String },
  fileType: { type: String, default: 'image/jpeg' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Setting = mongoose.models.Setting || mongoose.model('Setting', SettingSchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);

// Connection
let connPromise = null;
async function connectDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connPromise) {
    if (!MONGODB_URI) throw new Error('MONGODB_URI is missing');
    connPromise = mongoose.connect(MONGODB_URI, {
      maxPoolSize: 5,
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
    res.status(503).json({ error: 'DB connecting: ' + err.message });
  }
});

function verifyAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Auth required' });
    req.admin = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired' });
  }
}

// 1. Login
app.post('/admin/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Enter email and password' });

    const cleanEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: cleanEmail });

    if (!user) {
      const defaultPassword = 'MemoClick2082Secure!';
      const passwordHash = await bcrypt.hash(defaultPassword, 10);
      user = await User.create({
        name: 'System Owner',
        email: cleanEmail,
        passwordHash,
        role: 'Owner'
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password' });

    const token = jwt.sign({ id: user._id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '3d' });
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: 'Auth error: ' + e.message });
  }
});

// 2. File Manager Hierarchy API
app.get('/admin/api/file-manager', verifyAdmin, async (req, res) => {
  try {
    const [businesses, fiscalYears, categories, documents, viewPass] = await Promise.all([
      Business.find().sort({ createdAt: -1 }),
      FiscalYear.find().sort({ fiscalYear: -1 }),
      Category.find().sort({ name: 1 }),
      Document.find().populate('businessId', 'businessName').populate('fiscalYearId', 'fiscalYear').populate('categoryId', 'name').sort({ createdAt: -1 }),
      Setting.findOne({ key: 'view_password' })
    ]);

    res.json({
      businesses,
      fiscalYears,
      categories,
      documents,
      currentViewPassword: (viewPass && viewPass.value) || '1234'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Delete Document from File Manager
app.delete('/admin/api/documents/:id', verifyAdmin, async (req, res) => {
  try {
    await Document.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. Business Management
app.post('/admin/api/businesses', verifyAdmin, async (req, res) => {
  try {
    const { businessName, panNumber } = req.body;
    if (!businessName) return res.status(400).json({ error: 'Business name is required' });
    const count = await Business.countDocuments();
    const businessId = 'BIZ-' + String(count + 1).padStart(3, '0');
    const b = await Business.create({ businessId, businessName, panNumber: panNumber || '', isActive: true });
    res.json(b);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/admin/api/businesses/:id', verifyAdmin, async (req, res) => {
  try {
    const { businessName, panNumber } = req.body;
    const b = await Business.findByIdAndUpdate(req.params.id, { businessName, panNumber }, { new: true });
    res.json(b);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/api/businesses/:id', verifyAdmin, async (req, res) => {
  try {
    await Business.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. Category Management
app.post('/admin/api/categories', verifyAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    const c = await Category.create({ name, icon: 'fa-folder', color: '#668EF0' });
    res.json(c);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/api/categories/:id', verifyAdmin, async (req, res) => {
  try {
    await Category.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. View Password Update
app.post('/admin/api/view-password', verifyAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    await Setting.findOneAndUpdate({ key: 'view_password' }, { value: password }, { upsert: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UI View
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MemoClick – Admin File Manager</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root {
      --primary: #668EF0;
      --bg: #F4F6FB;
      --text: #283247;
      --muted: #7B8498;
      --danger: #EF4444;
      --clay-shadow: 6px 6px 14px #d8dfea, -6px -6px 14px #ffffff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 20px; min-height: 100vh; }
    
    .nav-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .box { background: #fff; padding: 22px; border-radius: 20px; box-shadow: 0 4px 14px rgba(0,0,0,0.06); margin-bottom: 20px; }
    .input { width: 100%; padding: 12px; margin: 6px 0 12px; border: 1px solid #d1d5db; border-radius: 12px; font-size: 0.95rem; outline: none; }
    .btn { padding: 10px 18px; background: var(--primary); color: #fff; border: none; border-radius: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
    .btn-danger { background: var(--danger); }

    /* Breadcrumbs Bar */
    .breadcrumbs { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; font-weight: 700; padding: 12px 18px; background: #fff; border-radius: 14px; box-shadow: var(--clay-shadow); margin-bottom: 18px; flex-wrap: wrap; }
    .crumb-link { color: var(--primary); cursor: pointer; }
    .crumb-sep { color: var(--muted); }

    /* File Manager Grid */
    .fm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; }
    .fm-card { background: #fff; border-radius: 18px; padding: 18px; box-shadow: var(--clay-shadow); cursor: pointer; transition: transform 0.15s ease; position: relative; }
    .fm-card:hover { transform: translateY(-3px); }
    .fm-icon { font-size: 2.2rem; color: var(--primary); margin-bottom: 10px; }
    .fm-title { font-weight: 800; font-size: 0.95rem; word-break: break-word; }
    .fm-sub { font-size: 0.75rem; color: var(--muted); margin-top: 4px; }

    /* Modal */
    .modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:9999; justify-content:center; align-items:center; backdrop-filter: blur(4px); }
    .modal-box { background:#fff; padding:24px; border-radius:24px; width:92%; max-width:560px; max-height:90vh; overflow-y:auto; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
    .item-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f0f2f5; }
  </style>
</head>
<body>
  <div style="max-width:960px; margin:0 auto;">
    
    <!-- Top Header -->
    <div class="nav-bar">
      <div>
        <h3 style="font-weight:800;"><i class="fa-solid fa-folder-closed" style="color:var(--primary);"></i> MemoClick File Manager</h3>
        <span style="font-size:0.8rem; color:var(--muted);">Digital Filing Directory</span>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn" style="background:#fff; color:var(--text); box-shadow:var(--clay-shadow);" onclick="openSettingsModal()"><i class="fa-solid fa-gear"></i> Settings</button>
        <a href="/" class="btn" style="background:#fff; color:var(--primary); text-decoration:none; box-shadow:var(--clay-shadow);"><i class="fa-solid fa-arrow-left"></i> Public App</a>
      </div>
    </div>

    <!-- LOGIN SCREEN -->
    <div class="box" id="loginBox" style="max-width:440px; margin:40px auto;">
      <h3 style="font-weight:800; margin-bottom:6px;">Admin Sign In</h3>
      <p style="font-size:0.85rem; color:var(--muted); margin-bottom:14px;">Sign in to view your file manager & document records.</p>
      
      <input type="email" id="adminEmail" class="input" placeholder="Admin Email" autocomplete="off">
      <input type="password" id="adminPassword" class="input" placeholder="Admin Password" autocomplete="off">
      <button class="btn" style="width:100%; justify-content:center;" id="signInBtn" onclick="submitLogin()">Sign In to Console</button>
      <div id="loginMsg" style="color:red; font-size:0.85rem; margin-top:10px; font-weight:600; text-align:center;"></div>
    </div>

    <!-- MAIN FILE MANAGER VIEW -->
    <div id="fileManagerBox" style="display:none;">
      
      <!-- Interactive Breadcrumb -->
      <div class="breadcrumbs" id="crumbBar">
        <span class="crumb-link" onclick="navToRoot()"><i class="fa-solid fa-house"></i> Home</span>
      </div>

      <!-- Main Directory Grid -->
      <div class="fm-grid" id="fmGrid">Loading file manager...</div>
    </div>

    <!-- SETTINGS MODAL -->
    <div class="modal" id="settingsModal">
      <div class="modal-box">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h3 style="font-weight:800;"><i class="fa-solid fa-gear" style="color:var(--primary);"></i> Admin Settings</h3>
          <button onclick="closeSettingsModal()" style="border:none; background:#eee; width:30px; height:30px; border-radius:50%; font-weight:800; cursor:pointer;">&times;</button>
        </div>

        <!-- 1. View Password -->
        <div class="box" style="box-shadow:none; border:1px solid #e5e7eb; padding:16px; margin-bottom:16px;">
          <h4 style="font-weight:800; margin-bottom:4px;"><i class="fa-solid fa-key" style="color:var(--primary);"></i> Document View Password</h4>
          <p style="font-size:0.75rem; color:var(--muted); margin-bottom:10px;">Password required by visitors to inspect files.</p>
          <div style="display:flex; gap:10px;">
            <input type="text" id="curViewPass" class="input" style="margin:0;" placeholder="View Password">
            <button class="btn" onclick="saveViewPassword()">Update</button>
          </div>
        </div>

        <!-- 2. Businesses -->
        <div class="box" style="box-shadow:none; border:1px solid #e5e7eb; padding:16px; margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h4 style="font-weight:800;"><i class="fa-solid fa-building"></i> Businesses</h4>
            <button class="btn" style="padding:6px 12px; font-size:0.8rem;" onclick="openAddBizPrompt()">+ Add</button>
          </div>
          <div id="bizList">Loading...</div>
        </div>

        <!-- 3. Folders -->
        <div class="box" style="box-shadow:none; border:1px solid #e5e7eb; padding:16px; margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h4 style="font-weight:800;"><i class="fa-solid fa-folder-tree"></i> Directory Folders</h4>
            <button class="btn" style="padding:6px 12px; font-size:0.8rem;" onclick="openAddCatPrompt()">+ Add</button>
          </div>
          <div id="catList">Loading...</div>
        </div>

        <button class="btn btn-danger" style="width:100%; justify-content:center;" onclick="adminLogout()">Log Out</button>
      </div>
    </div>

    <!-- FILE PREVIEW MODAL -->
    <div class="modal" id="adminPreviewModal">
      <div class="modal-box" style="max-width:600px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <h4 id="prevTitle" style="font-weight:800;"></h4>
          <button onclick="closeModal('adminPreviewModal')" style="border:none; background:#eee; width:30px; height:30px; border-radius:50%; font-weight:800; cursor:pointer;">&times;</button>
        </div>
        <div id="prevContent" style="text-align:center; min-height:260px; display:flex; justify-content:center; align-items:center;"></div>
      </div>
    </div>

  </div>

  <script>
    let treeData = null;
    let currentPath = { level: 'root', bizId: null, fyId: null, catId: null };

    async function initFileManager() {
      const token = localStorage.getItem('mc_admin_token');
      if (!token) {
        document.getElementById('loginBox').style.display = 'block';
        document.getElementById('fileManagerBox').style.display = 'none';
        return;
      }

      try {
        const res = await fetch('/admin/api/file-manager', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (!res.ok) throw new Error();
        treeData = await res.json();

        document.getElementById('loginBox').style.display = 'none';
        document.getElementById('fileManagerBox').style.display = 'block';
        renderCurrentLevel();
        populateSettingsLists();
      } catch (e) {
        adminLogout();
      }
    }

    // Interactive File Manager Navigation
    function renderCurrentLevel() {
      const grid = document.getElementById('fmGrid');
      const crumb = document.getElementById('crumbBar');

      if (currentPath.level === 'root') {
        crumb.innerHTML = '<span class="crumb-link" onclick="navToRoot()"><i class="fa-solid fa-house"></i> Home</span>';
        grid.innerHTML = treeData.businesses.map(b => {
          const docCount = treeData.documents.filter(d => d.businessId && d.businessId._id === b._id).length;
          return \`
            <div class="fm-card" onclick="navToBiz('\${b._id}', '\${b.businessName}')">
              <i class="fa-solid fa-folder-open fm-icon"></i>
              <div class="fm-title">\${b.businessName}</div>
              <div class="fm-sub">\${docCount} Documents</div>
            </div>
          \`;
        }).join('') || '<div style="color:var(--muted);">No businesses found. Add one in Settings.</div>';
      } 
      else if (currentPath.level === 'biz') {
        crumb.innerHTML = \`
          <span class="crumb-link" onclick="navToRoot()"><i class="fa-solid fa-house"></i> Home</span>
          <span class="crumb-sep">/</span>
          <span style="color:var(--text);">\${currentPath.bizName}</span>
        \`;
        grid.innerHTML = treeData.fiscalYears.map(f => {
          const docCount = treeData.documents.filter(d => 
            d.businessId && d.businessId._id === currentPath.bizId &&
            d.fiscalYearId && d.fiscalYearId._id === f._id
          ).length;
          return \`
            <div class="fm-card" onclick="navToFY('\${f._id}', '\${f.fiscalYear}')">
              <i class="fa-solid fa-folder fm-icon" style="color:#2BB594;"></i>
              <div class="fm-title">FY \${f.fiscalYear}</div>
              <div class="fm-sub">\${docCount} Documents</div>
            </div>
          \`;
        }).join('');
      }
      else if (currentPath.level === 'fy') {
        crumb.innerHTML = \`
          <span class="crumb-link" onclick="navToRoot()"><i class="fa-solid fa-house"></i> Home</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-link" onclick="navToBiz('\${currentPath.bizId}', '\${currentPath.bizName}')">\${currentPath.bizName}</span>
          <span class="crumb-sep">/</span>
          <span style="color:var(--text);">FY \${currentPath.fyName}</span>
        \`;
        grid.innerHTML = treeData.categories.map(c => {
          const docCount = treeData.documents.filter(d => 
            d.businessId && d.businessId._id === currentPath.bizId &&
            d.fiscalYearId && d.fiscalYearId._id === currentPath.fyId &&
            d.categoryId && d.categoryId._id === c._id
          ).length;
          return \`
            <div class="fm-card" onclick="navToCat('\${c._id}', '\${c.name}')">
              <i class="fa-solid fa-folder-closed fm-icon" style="color:#F2994A;"></i>
              <div class="fm-title">\${c.name}</div>
              <div class="fm-sub">\${docCount} Files</div>
            </div>
          \`;
        }).join('');
      }
      else if (currentPath.level === 'cat') {
        crumb.innerHTML = \`
          <span class="crumb-link" onclick="navToRoot()"><i class="fa-solid fa-house"></i> Home</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-link" onclick="navToBiz('\${currentPath.bizId}', '\${currentPath.bizName}')">\${currentPath.bizName}</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-link" onclick="navToFY('\${currentPath.fyId}', '\${currentPath.fyName}')">FY \${currentPath.fyName}</span>
          <span class="crumb-sep">/</span>
          <span style="color:var(--text);">\${currentPath.catName}</span>
        \`;
        const matchedDocs = treeData.documents.filter(d => 
          d.businessId && d.businessId._id === currentPath.bizId &&
          d.fiscalYearId && d.fiscalYearId._id === currentPath.fyId &&
          d.categoryId && d.categoryId._id === currentPath.catId
        );

        grid.innerHTML = matchedDocs.map(d => \`
          <div class="fm-card" style="cursor:default;">
            <div style="cursor:pointer;" onclick="adminPreviewDoc('\${d._id}')">
              <i class="fa-solid fa-file-lines fm-icon"></i>
              <div class="fm-title">\${d.documentRef}</div>
              <div class="fm-sub">\${d.partyName ? d.partyName : 'Document'}</div>
            </div>
            <button class="btn btn-danger" style="padding:4px 8px; font-size:0.75rem; margin-top:8px;" onclick="adminDeleteDoc('\${d._id}')"><i class="fa-solid fa-trash"></i> Delete</button>
          </div>
        \`).join('') || '<div style="color:var(--muted); grid-column: 1 / -1;">This folder is empty. Upload documents from the public app!</div>';
      }
    }

    function navToRoot() { currentPath = { level: 'root' }; renderCurrentLevel(); }
    function navToBiz(id, name) { currentPath = { level: 'biz', bizId: id, bizName: name }; renderCurrentLevel(); }
    function navToFY(id, name) { currentPath = { level: 'fy', bizId: currentPath.bizId, bizName: currentPath.bizName, fyId: id, fyName: name }; renderCurrentLevel(); }
    function navToCat(id, name) { currentPath = { level: 'cat', bizId: currentPath.bizId, bizName: currentPath.bizName, fyId: currentPath.fyId, fyName: currentPath.fyName, catId: id, catName: name }; renderCurrentLevel(); }

    function adminPreviewDoc(id) {
      const doc = treeData.documents.find(d => d._id === id);
      if (!doc) return;
      document.getElementById('prevTitle').innerText = doc.documentRef + ' (' + (doc.partyName || 'Document') + ')';
      if (doc.fileType && doc.fileType.startsWith('image/')) {
        document.getElementById('prevContent').innerHTML = \`<img src="\${doc.fileData}" style="max-width:100%; max-height:65vh; border-radius:12px; object-fit:contain;">\`;
      } else {
        document.getElementById('prevContent').innerHTML = \`<iframe src="\${doc.fileData}" style="width:100%; height:60vh; border:none;"></iframe>\`;
      }
      document.getElementById('adminPreviewModal').style.display = 'flex';
    }

    async function adminDeleteDoc(id) {
      if (!confirm('Permanently delete this document from the filing system?')) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/documents/' + id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      initFileManager();
    }

    // Settings Modal
    function openSettingsModal() { document.getElementById('settingsModal').style.display = 'flex'; }
    function closeSettingsModal() { document.getElementById('settingsModal').style.display = 'none'; }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    function populateSettingsLists() {
      document.getElementById('curViewPass').value = treeData.currentViewPassword;
      document.getElementById('bizList').innerHTML = treeData.businesses.map(b => \`
        <div class="item-row">
          <div><strong>\${b.businessName}</strong></div>
          <div style="display:flex; gap:6px;">
            <button class="btn" style="padding:4px 8px; font-size:0.75rem;" onclick="renameBiz('\${b._id}', '\${b.businessName}')">Rename</button>
            <button class="btn btn-danger" style="padding:4px 8px; font-size:0.75rem;" onclick="deleteBiz('\${b._id}')"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      \`).join('');

      document.getElementById('catList').innerHTML = treeData.categories.map(c => \`
        <div class="item-row">
          <div><i class="fa-solid fa-folder" style="color:var(--primary); margin-right:6px;"></i><strong>\${c.name}</strong></div>
          <button class="btn btn-danger" style="padding:4px 8px; font-size:0.75rem;" onclick="deleteCat('\${c._id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      \`).join('');
    }

    async function submitLogin() {
      const email = document.getElementById('adminEmail').value.trim();
      const password = document.getElementById('adminPassword').value.trim();
      const msg = document.getElementById('loginMsg');
      const btn = document.getElementById('signInBtn');

      if (!email || !password) return msg.innerText = 'Enter email and password';
      msg.innerText = 'Verifying...';
      btn.disabled = true;

      try {
        const res = await fetch('/admin/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('mc_admin_token', data.token);
          msg.innerText = '';
          initFileManager();
        } else {
          msg.innerText = data.error || 'Incorrect email or password';
        }
      } catch (err) {
        msg.innerText = 'Connection error';
      } finally {
        btn.disabled = false;
      }
    }

    async function saveViewPassword() {
      const password = document.getElementById('curViewPass').value;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/view-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ password })
      });
      alert('View password updated!');
      initFileManager();
    }

    async function openAddBizPrompt() {
      const name = prompt('Business Name:');
      if (!name) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/businesses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ businessName: name })
      });
      initFileManager();
    }

    async function renameBiz(id, oldName) {
      const name = prompt('Rename Business:', oldName);
      if (!name) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/businesses/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ businessName: name })
      });
      initFileManager();
    }

    async function deleteBiz(id) {
      if (!confirm('Delete this business?')) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/businesses/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      initFileManager();
    }

    async function openAddCatPrompt() {
      const name = prompt('New Folder Name:');
      if (!name) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name })
      });
      initFileManager();
    }

    async function deleteCat(id) {
      if (!confirm('Delete this folder?')) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/categories/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      initFileManager();
    }

    function adminLogout() {
      localStorage.removeItem('mc_admin_token');
      document.getElementById('loginBox').style.display = 'block';
      document.getElementById('fileManagerBox').style.display = 'none';
      closeSettingsModal();
    }

    window.addEventListener('DOMContentLoaded', initFileManager);
  </script>
</body>
</html>`);
});

module.exports = app;
