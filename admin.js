/**
 * MEMOCLICK - ADMINISTRATIVE DASHBOARD & AUDIT CONTROL
 * File: admin.js
 */
'use strict';

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'memoclick-production-crypto-fallback-key-2082';
const MONGODB_URI = process.env.MONGODB_URI;
let cachedDb = global.__mongoConn || null;

async function ensureDb() {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  if (!MONGODB_URI) return null;
  cachedDb = await mongoose.connect(MONGODB_URI, { maxPoolSize: 5 });
  global.__mongoConn = cachedDb;
  return cachedDb;
}
app.use(async (req, res, next) => {
  await ensureDb();
  next();
});

// Middleware to verify Admin/Owner role
const requireAdmin = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Admin authentication required' });
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    if (decoded.role !== 'Owner' && decoded.role !== 'Administrator') {
      return res.status(403).json({ error: 'Access denied: Requires Admin privileges' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
};

app.get('/api/admin/metrics', requireAdmin, async (req, res) => {
  try {
    const Business = mongoose.models.Business;
    const Document = mongoose.models.Document;
    const [bizCount, docCount] = await Promise.all([
      Business ? Business.countDocuments() : 0,
      Document ? Document.countDocuments() : 0
    ]);
    res.json({ totalBusinesses: bizCount, totalDocuments: docCount, serverStatus: 'HEALTHY' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Admin Portal - MemoClick</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: #F4F6FB; color: #283247; padding: 24px; }
    .card { background: #fff; padding: 20px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); max-width: 600px; margin: 20px auto; }
    .val { font-size: 2rem; font-weight: 800; color: #668EF0; margin-top: 6px; }
  </style>
</head>
<body>
  <div style="max-width:600px; margin:0 auto; display:flex; justify-content:space-between; align-items:center;">
    <h2>Admin Dashboard</h2>
    <a href="/" style="color:#668EF0; text-decoration:none; font-weight:700;">Back to App</a>
  </div>
  <div id="adminContent">
    <div class="card" id="lockMsg">
      <h3>🔒 Admin Authorization Required</h3>
      <p style="color:#7B8498; margin:8px 0 16px;">Please log in as an administrator from the main app first.</p>
      <a href="/" style="display:inline-block; padding:10px 18px; background:#668EF0; color:#fff; border-radius:10px; text-decoration:none; font-weight:700;">Go to Login</a>
    </div>
  </div>
  <script>
    const token = localStorage.getItem('mc_token');
    if (token) {
      fetch('/api/admin/metrics', { headers: { Authorization: 'Bearer ' + token } })
        .then(r => {
          if (!r.ok) throw new Error('Unauthorized');
          return r.json();
        })
        .then(data => {
          document.getElementById('adminContent').innerHTML = \`
            <div class="card">
              <div>Total Businesses</div>
              <div class="val">\${data.totalBusinesses}</div>
            </div>
            <div class="card">
              <div>Total Documents</div>
              <div class="val">\${data.totalDocuments}</div>
            </div>
          \`;
        })
        .catch(() => {
          document.getElementById('lockMsg').style.display = 'block';
        });
    }
  </script>
</body>
</html>`);
});

module.exports = app;
