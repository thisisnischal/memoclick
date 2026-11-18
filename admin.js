/**
 * MEMOCLICK - ADMINISTRATIVE DASHBOARD & AUDIT CONTROL
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

// Database connection
let cachedDb = global.__mongoConn || null;
async function ensureDb() {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  if (!MONGODB_URI) return null;
  mongoose.set('strictQuery', true);
  cachedDb = await mongoose.connect(MONGODB_URI, { maxPoolSize: 5 });
  global.__mongoConn = cachedDb;
  return cachedDb;
}
app.use(async (req, res, next) => {
  await ensureDb();
  next();
});

// Admin Login Endpoint (Prefixed with /admin/api so Vercel routes it directly to admin.js)
app.post('/admin/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Please enter both email and password' });

    const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
      email: String,
      passwordHash: String,
      role: String,
      isActive: Boolean
    }));

    const cleanEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: cleanEmail });

    // Fallback if accessed before index.js initial seed
    if (!user) {
      const defaultPassword = 'MemoClick2082Secure!';
      const passwordHash = await bcrypt.hash(defaultPassword, 12);
      user = await User.create({
        name: 'System Owner',
        email: cleanEmail,
        passwordHash,
        role: 'Owner',
        isActive: true
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

    res.json({ token, user: { email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Server authentication error: ' + err.message });
  }
});

// Admin Metrics API
app.get('/admin/api/metrics', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    jwt.verify(authHeader.split(' ')[1], JWT_SECRET);

    const Business = mongoose.models.Business;
    const Document = mongoose.models.Document;

    const [bizCount, docCount] = await Promise.all([
      Business ? Business.countDocuments() : 0,
      Document ? Document.countDocuments() : 0
    ]);

    res.json({ totalBusinesses: bizCount, totalDocuments: docCount });
  } catch (err) {
    res.status(401).json({ error: 'Session expired' });
  }
});

// Admin Dashboard UI
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MemoClick – Admin Console</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root { --primary: #668EF0; --bg: #F4F6FB; --text: #283247; --muted: #7B8498; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; min-height: 100vh; }
    .box { background: #fff; padding: 24px; border-radius: 20px; box-shadow: 0 4px 14px rgba(0,0,0,0.06); max-width: 440px; margin: 30px auto; }
    .input { width: 100%; padding: 14px; margin: 10px 0; border: 1px solid #d1d5db; border-radius: 12px; font-size: 1rem; outline: none; }
    .btn { width: 100%; padding: 14px; background: var(--primary); color: #fff; border: none; border-radius: 12px; font-weight: 700; cursor: pointer; font-size: 1rem; }
    .val { font-size: 2.2rem; font-weight: 800; color: var(--primary); margin-top: 6px; }
  </style>
</head>
<body>
  <div style="max-width:440px; margin:0 auto; display:flex; justify-content:space-between; align-items:center;">
    <h3 style="font-weight:800;"><i class="fa-solid fa-shield-halved" style="color:var(--primary);"></i> Admin Console</h3>
    <a href="/" style="color:var(--primary); text-decoration:none; font-weight:700;"><i class="fa-solid fa-arrow-left"></i> Public App</a>
  </div>

  <!-- LOGIN BOX -->
  <div class="box" id="loginBox">
    <h3 style="font-weight:800; margin-bottom:6px;">Administrator Sign In</h3>
    <p style="font-size:0.85rem; color:var(--muted); margin-bottom:14px;">Enter your admin email and password.</p>
    
    <input type="email" id="adminEmail" class="input" placeholder="Admin Email" autocomplete="off">
    <input type="password" id="adminPassword" class="input" placeholder="Password" autocomplete="off">
    
    <button class="btn" type="button" onclick="submitAdminLogin()">Sign In</button>
    <div id="loginMsg" style="color:#e53e3e; font-size:0.85rem; margin-top:12px; font-weight:600; text-align:center;"></div>
  </div>

  <!-- DASHBOARD BOX -->
  <div id="dashboardBox" style="display:none; max-width:440px; margin:20px auto;">
    <div class="box" style="margin:16px 0;">
      <div style="color:var(--muted); font-size:0.85rem; font-weight:700;">TOTAL BUSINESSES</div>
      <div class="val" id="totalBiz">-</div>
    </div>
    <div class="box" style="margin:16px 0;">
      <div style="color:var(--muted); font-size:0.85rem; font-weight:700;">TOTAL DOCUMENTS</div>
      <div class="val" id="totalDocs">-</div>
    </div>
    <button class="btn" style="background:#7B8498;" onclick="adminLogout()">Log Out</button>
  </div>

  <script>
    async function checkAuth() {
      const token = localStorage.getItem('mc_admin_token');
      if (!token) {
        document.getElementById('loginBox').style.display = 'block';
        document.getElementById('dashboardBox').style.display = 'none';
        return;
      }

      try {
        const res = await fetch('/admin/api/metrics', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        
        document.getElementById('totalBiz').innerText = data.totalBusinesses;
        document.getElementById('totalDocs').innerText = data.totalDocuments;
        document.getElementById('loginBox').style.display = 'none';
        document.getElementById('dashboardBox').style.display = 'block';
      } catch (e) {
        adminLogout();
      }
    }

    async function submitAdminLogin() {
      const email = document.getElementById('adminEmail').value.trim();
      const password = document.getElementById('adminPassword').value.trim();
      const msg = document.getElementById('loginMsg');
      msg.innerText = '';

      if (!email || !password) {
        msg.innerText = 'Please enter email and password';
        return;
      }

      msg.innerText = 'Verifying credentials...';

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
          checkAuth();
        } else {
          msg.innerText = data.error || 'Login failed';
        }
      } catch (err) {
        msg.innerText = 'Connection error: ' + err.message;
      }
    }

    function adminLogout() {
      localStorage.removeItem('mc_admin_token');
      document.getElementById('loginBox').style.display = 'block';
      document.getElementById('dashboardBox').style.display = 'none';
    }

    window.addEventListener('DOMContentLoaded', checkAuth);
  </script>
</body>
</html>`);
});

module.exports = app;
