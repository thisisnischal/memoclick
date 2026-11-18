/**
 * MEMOCLICK - FAST ADMINISTRATIVE DASHBOARD
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
  title: { type: String, default: 'Document' }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Setting = mongoose.models.Setting || mongoose.model('Setting', SettingSchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);

// Fast Cached DB Connection
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
    res.status(503).json({ error: 'Database connection failed: ' + err.message });
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

// FAST LOGIN (Under 200ms)
app.post('/admin/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Enter email and password' });

    const cleanEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: cleanEmail });

    // Seed admin if missing (optimized rounds)
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
    if (!match) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: '3d' }
    );

    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: 'Auth error: ' + e.message });
  }
});

// Dashboard Data
app.get('/admin/api/dashboard-data', verifyAdmin, async (req, res) => {
  try {
    const [businesses, categories, docCount, viewPass] = await Promise.all([
      Business.find().sort({ createdAt: -1 }),
      Category.find().sort({ name: 1 }),
      Document.countDocuments(),
      Setting.findOne({ key: 'view_password' })
    ]);

    res.json({
      totalBusinesses: businesses.length,
      totalDocuments: docCount,
      businesses,
      categories,
      currentViewPassword: (viewPass && viewPass.value) || '1234'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Business Management (Add, Rename, Delete)
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

// Category Directory Management (Add, Delete)
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

// Update View Password
app.post('/admin/api/view-password', verifyAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password cannot be blank' });
    await Setting.findOneAndUpdate({ key: 'view_password' }, { value: password }, { upsert: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin UI
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Portal – MemoClick</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root { --primary: #668EF0; --bg: #F4F6FB; --text: #283247; --muted: #7B8498; --danger: #EB5757; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 20px; min-height: 100vh; }
    .box { background: #fff; padding: 22px; border-radius: 20px; box-shadow: 0 4px 14px rgba(0,0,0,0.06); margin-bottom: 20px; }
    .input { width: 100%; padding: 12px; margin: 6px 0 12px; border: 1px solid #d1d5db; border-radius: 12px; font-size: 0.95rem; outline: none; }
    .btn { padding: 12px 18px; background: var(--primary); color: #fff; border: none; border-radius: 12px; font-weight: 700; cursor: pointer; }
    .btn-danger { background: var(--danger); }
    .item-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f0f2f5; }
  </style>
</head>
<body>
  <div style="max-width:680px; margin:0 auto;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <h3 style="font-weight:800;"><i class="fa-solid fa-shield-halved" style="color:var(--primary);"></i> Admin Console</h3>
      <a href="/" style="color:var(--primary); text-decoration:none; font-weight:700;"><i class="fa-solid fa-arrow-left"></i> Public App</a>
    </div>

    <!-- LOGIN SCREEN -->
    <div class="box" id="loginBox" style="max-width:440px; margin:40px auto;">
      <h3 style="font-weight:800; margin-bottom:6px;">Administrator Sign In</h3>
      <p style="font-size:0.85rem; color:var(--muted); margin-bottom:14px;">Log in to manage businesses and folder paths.</p>
      
      <input type="email" id="adminEmail" class="input" placeholder="Admin Email" autocomplete="off">
      <input type="password" id="adminPassword" class="input" placeholder="Admin Password" autocomplete="off">
      <button class="btn" style="width:100%;" id="signInBtn" onclick="submitLogin()">Sign In</button>
      <div id="loginMsg" style="color:red; font-size:0.85rem; margin-top:10px; font-weight:600; text-align:center;"></div>
    </div>

    <!-- MAIN DASHBOARD -->
    <div id="dashBox" style="display:none;">
      
      <!-- VIEW PASSWORD SETTING -->
      <div class="box" style="border: 2px solid #E5EEFF;">
        <h4 style="font-weight:800; margin-bottom:4px;"><i class="fa-solid fa-key" style="color:var(--primary);"></i> Document View Password</h4>
        <p style="font-size:0.82rem; color:var(--muted); margin-bottom:12px;">Password required by visitors to open and inspect documents.</p>
        <div style="display:flex; gap:10px;">
          <input type="text" id="curViewPass" class="input" style="margin:0;" placeholder="View Password">
          <button class="btn" onclick="saveViewPassword()">Update</button>
        </div>
      </div>

      <!-- BUSINESSES -->
      <div class="box">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <h4 style="font-weight:800;"><i class="fa-solid fa-building"></i> Businesses</h4>
          <button class="btn" onclick="openAddBizPrompt()">+ Add Business</button>
        </div>
        <div id="bizList">Loading...</div>
      </div>

      <!-- FOLDERS -->
      <div class="box">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <h4 style="font-weight:800;"><i class="fa-solid fa-folder-tree"></i> Directory Folders / Categories</h4>
          <button class="btn" onclick="openAddCatPrompt()">+ New Folder</button>
        </div>
        <div id="catList">Loading...</div>
      </div>

      <button class="btn" style="background:#7B8498; width:100%; margin-top:10px;" onclick="adminLogout()">Log Out</button>
    </div>
  </div>

  <script>
    async function initAdmin() {
      const token = localStorage.getItem('mc_admin_token');
      if (!token) {
        document.getElementById('loginBox').style.display = 'block';
        document.getElementById('dashBox').style.display = 'none';
        return;
      }

      try {
        const res = await fetch('/admin/api/dashboard-data', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (!res.ok) throw new Error();
        const data = await res.json();

        document.getElementById('curViewPass').value = data.currentViewPassword;

        document.getElementById('bizList').innerHTML = data.businesses.map(b => \`
          <div class="item-row">
            <div>
              <strong>\${b.businessName}</strong>
              <div style="font-size:0.75rem; color:var(--muted);">Code: \${b.businessId}</div>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn" style="padding:6px 12px; font-size:0.8rem;" onclick="renameBiz('\${b._id}', '\${b.businessName}')">Rename</button>
              <button class="btn btn-danger" style="padding:6px 12px; font-size:0.8rem;" onclick="deleteBiz('\${b._id}')"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
        \`).join('') || '<div style="color:var(--muted);">No businesses found.</div>';

        document.getElementById('catList').innerHTML = data.categories.map(c => \`
          <div class="item-row">
            <div><i class="fa-solid fa-folder" style="color:var(--primary); margin-right:6px;"></i><strong>\${c.name}</strong></div>
            <button class="btn btn-danger" style="padding:6px 12px; font-size:0.8rem;" onclick="deleteCat('\${c._id}')"><i class="fa-solid fa-trash"></i></button>
          </div>
        \`).join('') || '<div style="color:var(--muted);">No folders configured.</div>';

        document.getElementById('loginBox').style.display = 'none';
        document.getElementById('dashBox').style.display = 'block';
      } catch (e) {
        adminLogout();
      }
    }

    async function submitLogin() {
      const email = document.getElementById('adminEmail').value.trim();
      const password = document.getElementById('adminPassword').value.trim();
      const msg = document.getElementById('loginMsg');
      const btn = document.getElementById('signInBtn');

      if (!email || !password) {
        msg.innerText = 'Please enter email and password';
        return;
      }

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
          initAdmin();
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
      const res = await fetch('/admin/api/view-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ password })
      });
      if (res.ok) alert('View password updated successfully!');
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
      initAdmin();
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
      initAdmin();
    }

    async function deleteBiz(id) {
      if (!confirm('Delete this business?')) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/businesses/' + id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      initAdmin();
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
      initAdmin();
    }

    async function deleteCat(id) {
      if (!confirm('Delete this folder category?')) return;
      const token = localStorage.getItem('mc_admin_token');
      await fetch('/admin/api/categories/' + id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      initAdmin();
    }

    function adminLogout() {
      localStorage.removeItem('mc_admin_token');
      document.getElementById('loginBox').style.display = 'block';
      document.getElementById('dashBox').style.display = 'none';
    }

    window.addEventListener('DOMContentLoaded', initAdmin);
  </script>
</body>
</html>`);
});

module.exports = app;
