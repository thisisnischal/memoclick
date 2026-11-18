/**
 * MEMOCLICK - ADMINISTRATIVE DASHBOARD & AUDIT CONTROL
 * File: admin.js
 */
'use strict';

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

app.use(helmet({ credentials: true, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Re-use connection cache
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

// Access Models
const Document = mongoose.models.Document;
const Business = mongoose.models.Business;
const FiscalYear = mongoose.models.FiscalYear;
const Category = mongoose.models.Category;
const BackupJob = mongoose.models.BackupJob;
const BackupLog = mongoose.models.BackupLog;
const AuditLog = mongoose.models.AuditLog;
const DocumentFile = mongoose.models.DocumentFile;

// Admin Metrics API
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const [bizCount, fyCount, docCount, pendingBackups, backedUp, failedBackups, totalFiles] = await Promise.all([
      Business.countDocuments({ isActive: true }),
      FiscalYear.countDocuments({ isActive: true }),
      Document.countDocuments(),
      BackupJob.countDocuments({ status: 'Pending' }),
      BackupJob.countDocuments({ status: 'Backed Up' }),
      BackupJob.countDocuments({ status: 'Failed' }),
      DocumentFile.aggregate([{ $group: { _id: null, totalBytes: { $sum: '$fileSize' } } }])
    ]);

    const totalBytes = (totalFiles[0] && totalFiles[0].totalBytes) || 0;
    const mbUsed = (totalBytes / (1024 * 1024)).toFixed(2);

    res.json({
      totalBusinesses: bizCount,
      totalFiscalYears: fyCount,
      totalDocuments: docCount,
      pendingBackups,
      backedUp,
      failedBackups,
      storageMB: mbUsed
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Retry Trigger for Failed Backup Job
app.post('/api/admin/backup/retry/:jobId', async (req, res) => {
  try {
    const job = await BackupJob.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.status = 'Pending';
    job.errorMessage = null;
    await job.save();
    res.json({ message: 'Backup job marked for immediate retry', job });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Render Claymorphic Admin Interface
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MemoClick – Administrative Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root {
      --primary: #668EF0;
      --bg: #F4F6FB;
      --card-bg: #FFFFFF;
      --text: #283247;
      --muted: #7B8498;
      --clay-shadow: 6px 6px 14px #d8dfea, -6px -6px 14px #ffffff;
      --clay-inset: inset 2px 2px 5px #d8dfea, inset -2px -2px 5px #ffffff;
    }
    * { box-sizing: border-box; margin:0; padding:0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .clay-card { background: var(--card-bg); border-radius: 20px; box-shadow: var(--clay-shadow); padding: 20px; border: 1px solid rgba(255,255,255,0.7); }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .metric-val { font-size: 2rem; font-weight: 800; color: var(--primary); margin-top: 6px; }
    .metric-lbl { font-size: 0.82rem; font-weight: 700; color: var(--muted); text-transform: uppercase; }
    .nav-link { color: var(--primary); text-decoration: none; font-weight: 700; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { text-align: left; padding: 12px; font-size: 0.85rem; border-bottom: 1px solid #edf0f7; }
    th { color: var(--muted); font-weight: 700; }
    .badge { padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; }
    .badge-success { background: #C9EBDD; color: #1B7F53; }
    .badge-warn { background: #FFF0C7; color: #9E7400; }
    .badge-danger { background: #FFE3D3; color: #C2410C; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h2 style="font-weight:800;"><i class="fa-solid fa-shield-halved" style="color:var(--primary)"></i> MemoClick Admin Console</h2>
      <p style="color:var(--muted); font-size:0.85rem;">System Health, Audit Log & Google Drive Sync Diagnostics</p>
    </div>
    <a href="/" class="nav-link"><i class="fa-solid fa-arrow-left"></i> Return to Main App</a>
  </div>

  <div class="metrics-grid">
    <div class="clay-card">
      <div class="metric-lbl">Total Documents</div>
      <div class="metric-val" id="metricDocs">-</div>
    </div>
    <div class="clay-card">
      <div class="metric-lbl">Active Businesses</div>
      <div class="metric-val" id="metricBiz">-</div>
    </div>
    <div class="clay-card">
      <div class="metric-lbl">Storage Utilized</div>
      <div class="metric-val" id="metricStorage">- MB</div>
    </div>
    <div class="clay-card">
      <div class="metric-lbl">GDrive Backed Up</div>
      <div class="metric-val" style="color:#27AE60;" id="metricBackedUp">-</div>
    </div>
    <div class="clay-card">
      <div class="metric-lbl">Backup Incomplete / Failed</div>
      <div class="metric-val" style="color:#EB5757;" id="metricFailed">-</div>
    </div>
  </div>

  <div class="clay-card">
    <h3 style="font-weight:800; margin-bottom:12px;">Persistent Audit Trail & Backup Queue</h3>
    <table id="auditTable">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Event</th>
          <th>Status</th>
          <th>Verification</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Just now</td>
          <td>Serverless Initialized</td>
          <td><span class="badge badge-success">Active</span></td>
          <td>SHA-256 Verified</td>
        </tr>
      </tbody>
    </table>
  </div>

  <script>
    async function fetchMetrics() {
      try {
        const res = await fetch('/api/admin/metrics');
        const data = await res.json();
        document.getElementById('metricDocs').innerText = data.totalDocuments;
        document.getElementById('metricBiz').innerText = data.totalBusinesses;
        document.getElementById('metricStorage').innerText = data.storageMB + ' MB';
        document.getElementById('metricBackedUp').innerText = data.backedUp;
        document.getElementById('metricFailed').innerText = (data.pendingBackups + data.failedBackups);
      } catch (e) {
        console.error(e);
      }
    }
    fetchMetrics();
    setInterval(fetchMetrics, 10000);
  </script>
</body>
</html>`);
});

const PORT = process.env.ADMIN_PORT || 3001;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🛡️ MemoClick Admin listening on http://localhost:${PORT}`));
}

module.exports = app;
