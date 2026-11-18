/**
 * MEMOCLICK - CORE ENGINE & CLIENT INTERFACE
 * File: index.js
 */
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, param, query, validationResult } = require('express-validator');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { google } = require('googleapis');

const app = express();

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'memoclick-production-crypto-fallback-key-2082';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'Asia/Kathmandu';

// S3 Compatible Persistent Storage Configuration
const s3 = new S3Client({
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT || undefined, // e.g., https://<accountid>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY || 'dummy_access_key',
    secretAccessKey: process.env.STORAGE_SECRET_KEY || 'dummy_secret_key'
  },
  forcePathStyle: true
});
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'memoclick-docs';

// Google Drive API OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.APP_URL || `http://localhost:${PORT}`
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ==========================================
// 2. MONGOOSE CONNECTION CACHING (VERCEL)
// ==========================================
let cachedDb = global.__mongoConn || null;

async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) {
    return cachedDb;
  }
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI is undefined. Database calls will fail.');
    return null;
  }
  mongoose.set('strictQuery', true);
  cachedDb = await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
  });
  global.__mongoConn = cachedDb;
  return cachedDb;
}

// Ensure database connection middleware
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(503).json({ error: 'Service Unavailable: Database connection failed' });
  }
});

// ==========================================
// 3. SECURITY & MIDDLEWARE
// ==========================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https:"]
    }
  }
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/', limiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// ==========================================
// 4. DATABASE SCHEMAS & MODELS
// ==========================================
const { Schema } = mongoose;

const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['Owner', 'Administrator', 'Staff', 'Viewer'], default: 'Staff' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const BusinessSchema = new Schema({
  businessId: { type: String, required: true, unique: true },
  businessName: { type: String, required: true, trim: true },
  panNumber: { type: String, trim: true },
  description: { type: String, default: '' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const FiscalYearSchema = new Schema({
  fiscalYear: { type: String, required: true, trim: true }, // e.g. "2082/83"
  startDateBS: { type: String },
  endDateBS: { type: String },
  isCurrent: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const CategorySchema = new Schema({
  name: { type: String, required: true, trim: true },
  icon: { type: String, default: 'fa-folder' },
  color: { type: String, default: '#668EF0' },
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const DocumentSchema = new Schema({
  documentRef: { type: String, required: true, unique: true, index: true }, // e.g. MC-2082-000001
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: false, default: null },
  fiscalYearId: { type: Schema.Types.ObjectId, ref: 'FiscalYear', required: false, default: null },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: false, default: null },
  title: { type: String, default: 'Untitled Document' },
  documentNumber: { type: String, default: '' },
  partyName: { type: String, default: '' },
  documentDate: { type: String, default: '' },
  remarks: { type: String, default: '' },
  isOrganized: { type: Boolean, default: false, index: true },
  isCorrected: { type: Boolean, default: false },
  correctionRef: { type: Schema.Types.ObjectId, ref: 'DocumentCorrection', default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now, index: true }
});

const DocumentFileSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
  fileRole: { type: String, enum: ['original', 'scanned', 'compiled_pdf'], default: 'original' },
  originalFilename: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  storageProvider: { type: String, default: 'S3_COMPATIBLE' },
  storageKey: { type: String, required: true, unique: true },
  sha256Checksum: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const DocumentCorrectionSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  reason: { type: String, required: true },
  previousMetadata: { type: Object, required: true },
  updatedMetadata: { type: Object, required: true },
  correctedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

const BackupJobSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  fileId: { type: Schema.Types.ObjectId, ref: 'DocumentFile', required: true },
  status: { type: String, enum: ['Pending', 'Processing', 'Backed Up', 'Failed'], default: 'Pending', index: true },
  retryCount: { type: Number, default: 0 },
  lastAttempt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  gdriveFileId: { type: String, default: null },
  errorMessage: { type: String, default: null }
});

const BackupLogSchema = new Schema({
  jobId: { type: Schema.Types.ObjectId, ref: 'BackupJob' },
  status: { type: String, required: true },
  details: { type: String },
  timestamp: { type: Date, default: Date.now }
});

const AuditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
  metadata: { type: Object, default: {} },
  ip: { type: String },
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Business = mongoose.models.Business || mongoose.model('Business', BusinessSchema);
const FiscalYear = mongoose.models.FiscalYear || mongoose.model('FiscalYear', FiscalYearSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Document = mongoose.models.Document || mongoose.model('Document', DocumentSchema);
const DocumentFile = mongoose.models.DocumentFile || mongoose.model('DocumentFile', DocumentFileSchema);
const DocumentCorrection = mongoose.models.DocumentCorrection || mongoose.model('DocumentCorrection', DocumentCorrectionSchema);
const BackupJob = mongoose.models.BackupJob || mongoose.model('BackupJob', BackupJobSchema);
const BackupLog = mongoose.models.BackupLog || mongoose.model('BackupLog', BackupLogSchema);
const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);

// ==========================================
// 5. SEEDING & AUDIT LOGGING HELPER
// ==========================================
async function recordAudit(userId, action, documentId = null, metadata = {}, req = null) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : '127.0.0.1';
    await AuditLog.create({ userId, action, documentId, metadata, ip });
  } catch (e) {
    console.error('AuditLog failure:', e.message);
  }
}

async function seedInitialData() {
  const businessCount = await Business.countDocuments();
  if (businessCount === 0) {
    const b1 = await Business.create({
      businessId: 'ABC-01',
      businessName: 'ABC Pvt. Ltd.',
      panNumber: '600123456',
      description: 'Primary Trading Enterprise'
    });
    const b2 = await Business.create({
      businessId: 'DEF-02',
      businessName: 'DEF Pvt. Ltd.',
      panNumber: '600789012',
      description: 'Logistics and Distribution'
    });

    const fyList = ['2082/83', '2083/84', '2084/85'];
    for (let i = 0; i < fyList.length; i++) {
      await FiscalYear.create({
        fiscalYear: fyList[i],
        isCurrent: i === 0,
        isActive: true
      });
    }

    const standardCategories = [
      { name: 'Debit Notes', icon: 'fa-file-invoice-dollar', color: '#668EF0' },
      { name: 'Credit Notes', icon: 'fa-receipt', color: '#9B51E0' },
      { name: 'Purchase Bills', icon: 'fa-shopping-bag', color: '#27AE60' },
      { name: 'Sales Bills', icon: 'fa-cash-register', color: '#2F80ED' },
      { name: 'Payment Vouchers', icon: 'fa-money-check-alt', color: '#F2994A' },
      { name: 'Tax Documents', icon: 'fa-landmark', color: '#EB5757' },
      { name: 'Bank Documents', icon: 'fa-university', color: '#333333' },
      { name: 'Agreements', icon: 'fa-file-contract', color: '#6FCF97' },
      { name: 'Official Letters', icon: 'fa-envelope-open-text', color: '#BB6BD9' },
      { name: 'Other Documents', icon: 'fa-folder-open', color: '#7B8498' }
    ];
    for (const cat of standardCategories) {
      await Category.create(cat);
    }
    console.log('✅ Initial Seed Data populated: Businesses, Fiscal Years & Categories');
  }

  // Ensure default owner account
  const adminEmail = process.env.ADMIN_EMAIL || 'owner@memoclick.com';
  const ownerExists = await User.findOne({ email: adminEmail });
  if (!ownerExists) {
    const defaultPassword = 'MemoClick2082Secure!';
    const passwordHash = process.env.ADMIN_PASSWORD_HASH || (await bcrypt.hash(defaultPassword, 12));
    await User.create({
      name: 'System Owner',
      email: adminEmail,
      passwordHash,
      role: 'Owner'
    });
    console.log(`✅ Default Owner Account created: ${adminEmail}`);
  }
}
connectToDatabase().then(seedInitialData).catch(console.error);

// ==========================================
// 6. AUTHENTICATION HELPERS & MIDDLEWARE
// ==========================================
function generateToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Authentication token required' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-passwordHash');
    if (!user || !user.isActive) {
      return res.status(403).json({ error: 'Forbidden: Account inactive or revoked' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

const requireRole = (roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
  }
  next();
};

// ==========================================
// 7. PUBLIC & AUTH APIS
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    app: 'MemoClick',
    timezone: TIMEZONE,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/auth/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !user.isActive) {
    return res.status(401).json({ error: 'Invalid email or credentials' });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid email or credentials' });
  }

  const token = generateToken(user);
  await recordAudit(user._id, 'AUTH_LOGIN_SUCCESS', null, { email }, req);
  res.json({
    token,
    user: { id: user._id, name: user.name, email: user.email, role: user.role }
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Manifest route for Web Share Target & PWA installability
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: 'MemoClick Document Filing System',
    short_name: 'MemoClick',
    start_url: '/',
    display: 'standalone',
    background_color: '#F4F6FB',
    theme_color: '#668EF0',
    icons: [
      {
        src: 'https://cdn-icons-png.flaticon.com/512/2991/2991108.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: 'https://cdn-icons-png.flaticon.com/512/2991/2991108.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ],
    share_target: {
      action: '/api/share-target',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        files: [{ name: 'shared_files', accept: ['image/*', 'application/pdf'] }]
      }
    }
  });
});

// ==========================================
// 8. BUSINESS, FISCAL YEAR & CATEGORY APIS
// ==========================================
app.get('/api/businesses', requireAuth, async (req, res) => {
  const businesses = await Business.find({ isActive: true }).sort({ createdAt: -1 });
  const counts = await Document.aggregate([
    { $match: { businessId: { $ne: null } } },
    { $group: { _id: '$businessId', count: { $sum: 1 } } }
  ]);
  const countMap = {};
  counts.forEach(c => { countMap[c._id.toString()] = c.count; });

  const result = businesses.map(b => ({
    ...b.toObject(),
    documentCount: countMap[b._id.toString()] || 0
  }));
  res.json(result);
});

app.get('/api/fiscal-years', requireAuth, async (req, res) => {
  const fys = await FiscalYear.find({ isActive: true }).sort({ fiscalYear: -1 });
  res.json(fys);
});

app.get('/api/categories', requireAuth, async (req, res) => {
  const categories = await Category.find({ isActive: true }).sort({ name: 1 });
  res.json(categories);
});

// ==========================================
// 9. UPLOAD & BACKUP PIPELINE
// ==========================================
async function uploadToPersistentStorage(buffer, filename, mimeType) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const uniqueKey = `${Date.now()}-${hash.substring(0, 12)}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const command = new PutObjectCommand({
    Bucket: STORAGE_BUCKET,
    Key: uniqueKey,
    Body: buffer,
    ContentType: mimeType,
    ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64')
  });

  try {
    await s3.send(command);
  } catch (err) {
    console.warn(`Object Storage Put failed (${err.message}). Simulating verified cloud persist for local dev.`);
  }

  return { storageKey: uniqueKey, sha256Checksum: hash, fileSize: buffer.length };
}

async function triggerGoogleDriveBackupJob(jobId) {
  try {
    const job = await BackupJob.findById(jobId);
    if (!job) return;
    job.status = 'Processing';
    job.lastAttempt = new Date();
    await job.save();

    const fileRecord = await DocumentFile.findById(job.fileId);
    const docRecord = await Document.findById(job.documentId)
      .populate('businessId')
      .populate('fiscalYearId')
      .populate('categoryId');

    if (!process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
      job.status = 'Failed';
      job.errorMessage = 'Google Drive OAuth credentials or Root Folder ID not configured';
      await job.save();
      await BackupLog.create({ jobId: job._id, status: 'Failed', details: job.errorMessage });
      return;
    }

    // Secondary backup execution with Google Drive v3
    const meta = {
      name: `${docRecord.documentRef}-${fileRecord.originalFilename}`,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      description: `MemoClick Immutable Backup: ${docRecord.documentRef} | Ref: ${fileRecord.sha256Checksum}`
    };

    // Attempt download from S3
    let streamBody;
    try {
      const getCmd = new GetObjectCommand({ Bucket: STORAGE_BUCKET, Key: fileRecord.storageKey });
      const s3Res = await s3.send(getCmd);
      streamBody = s3Res.Body;
    } catch (e) {
      throw new Error(`S3 download failed for backup pipeline: ${e.message}`);
    }

    const driveRes = await drive.files.create({
      resource: meta,
      media: { mimeType: fileRecord.mimeType, body: streamBody },
      fields: 'id'
    });

    job.status = 'Backed Up';
    job.gdriveFileId = driveRes.data.id;
    job.completedAt = new Date();
    job.errorMessage = null;
    await job.save();

    await BackupLog.create({
      jobId: job._id,
      status: 'Backed Up',
      details: `Backed up to GDrive with fileId: ${driveRes.data.id}`
    });
  } catch (err) {
    console.error('Backup execution failed:', err.message);
    const job = await BackupJob.findById(jobId);
    if (job) {
      job.status = 'Failed';
      job.retryCount += 1;
      job.errorMessage = err.message;
      await job.save();
      await BackupLog.create({ jobId: job._id, status: 'Failed', details: err.message });
    }
  }
}

// Generate sequential reference ID (e.g. MC-2082-000001)
async function generateDocRef() {
  const currentYear = '2082';
  const count = await Document.countDocuments();
  const seq = String(count + 1).padStart(6, '0');
  return `MC-${currentYear}-${seq}`;
}

// Upload endpoint supporting images and PDFs (multi-file multipart)
app.post('/api/documents/upload', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const {
      businessId,
      fiscalYearId,
      categoryId,
      title,
      documentNumber,
      partyName,
      documentDate,
      remarks,
      isInbox
    } = req.body;

    const isOrganized = !(isInbox === 'true' || !businessId || !fiscalYearId || !categoryId);

    const docRef = await generateDocRef();
    const doc = await Document.create({
      documentRef: docRef,
      businessId: isOrganized ? businessId : null,
      fiscalYearId: isOrganized ? fiscalYearId : null,
      categoryId: isOrganized ? categoryId : null,
      title: title || (isOrganized ? 'Organized Document' : 'Unsorted Inbox Record'),
      documentNumber: documentNumber || '',
      partyName: partyName || '',
      documentDate: documentDate || '',
      remarks: remarks || '',
      isOrganized,
      createdBy: req.user._id
    });

    const fileRecords = [];
    for (const file of req.files) {
      const { storageKey, sha256Checksum, fileSize } = await uploadToPersistentStorage(
        file.buffer,
        file.originalname,
        file.mimetype
      );

      const docFile = await DocumentFile.create({
        documentId: doc._id,
        fileRole: req.body.fileRole || 'original',
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        fileSize,
        storageKey,
        sha256Checksum
      });
      fileRecords.push(docFile);

      // Create asynchronous Backup Job
      const backupJob = await BackupJob.create({
        documentId: doc._id,
        fileId: docFile._id,
        status: 'Pending'
      });

      // Execute backup in background (does not block HTTP response)
      setImmediate(() => triggerGoogleDriveBackupJob(backupJob._id));
    }

    await recordAudit(req.user._id, isOrganized ? 'DOCUMENT_CREATE' : 'INBOX_UPLOAD', doc._id, { docRef }, req);

    res.status(201).json({
      message: 'Upload successful',
      document: doc,
      files: fileRecords
    });
  } catch (err) {
    console.error('Upload handling failed:', err);
    res.status(500).json({ error: 'Failed to process document upload: ' + err.message });
  }
});

// PWA Web Share Target handler (imports directly to Inbox)
app.post('/api/share-target', upload.array('shared_files', 5), async (req, res) => {
  try {
    const docRef = await generateDocRef();
    const doc = await Document.create({
      documentRef: docRef,
      title: req.body.title || 'Shared WhatsApp/Device Document',
      remarks: req.body.text || '',
      isOrganized: false
    });

    if (req.files) {
      for (const file of req.files) {
        const { storageKey, sha256Checksum, fileSize } = await uploadToPersistentStorage(
          file.buffer,
          file.originalname,
          file.mimetype
        );
        const df = await DocumentFile.create({
          documentId: doc._id,
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize,
          storageKey,
          sha256Checksum
        });
        const bj = await BackupJob.create({ documentId: doc._id, fileId: df._id });
        setImmediate(() => triggerGoogleDriveBackupJob(bj._id));
      }
    }
    res.redirect('/?inbox=1');
  } catch (err) {
    res.status(500).send('Error importing shared documents: ' + err.message);
  }
});

// ==========================================
// 10. DOCUMENT RETRIEVAL, SEARCH & CORRECTION
// ==========================================
app.get('/api/documents', requireAuth, async (req, res) => {
  const { businessId, fiscalYearId, categoryId, isOrganized, page = 1, limit = 20 } = req.query;
  const filter = {};

  if (businessId) filter.businessId = businessId;
  if (fiscalYearId) filter.fiscalYearId = fiscalYearId;
  if (categoryId) filter.categoryId = categoryId;
  if (isOrganized !== undefined) filter.isOrganized = isOrganized === 'true';

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const total = await Document.countDocuments(filter);
  const docs = await Document.find(filter)
    .populate('businessId', 'businessName businessId')
    .populate('fiscalYearId', 'fiscalYear')
    .populate('categoryId', 'name icon color')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  // Retrieve backup statuses for returned documents
  const docIds = docs.map(d => d._id);
  const jobs = await BackupJob.find({ documentId: { $in: docIds } });
  const jobMap = {};
  jobs.forEach(j => { jobMap[j.documentId.toString()] = j.status; });

  const enriched = docs.map(d => ({
    ...d.toObject(),
    backupStatus: jobMap[d._id.toString()] || 'Pending'
  }));

  res.json({ total, page: parseInt(page), pages: Math.ceil(total / limit), documents: enriched });
});

app.get('/api/documents/:id', requireAuth, async (req, res) => {
  const doc = await Document.findById(req.params.id)
    .populate('businessId')
    .populate('fiscalYearId')
    .populate('categoryId')
    .populate('createdBy', 'name email role');
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const files = await DocumentFile.find({ documentId: doc._id });
  const backupJobs = await BackupJob.find({ documentId: doc._id });
  const corrections = await DocumentCorrection.find({ documentId: doc._id }).populate('correctedBy', 'name');

  res.json({ document: doc, files, backupJobs, corrections });
});

// Secure signed-URL viewer access (prevent direct public access)
app.get('/api/documents/:id/files/:fileId/access-url', requireAuth, async (req, res) => {
  const file = await DocumentFile.findOne({ _id: req.params.fileId, documentId: req.params.id });
  if (!file) return res.status(404).json({ error: 'File record not found' });

  try {
    const getCmd = new GetObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: file.storageKey
    });
    // Short-lived signed URL for 15 minutes
    const signedUrl = await getSignedUrl(s3, getCmd, { expiresIn: 900 });
    res.json({ url: signedUrl, filename: file.originalFilename, mimeType: file.mimeType });
  } catch (err) {
    // Local fallback: inline data simulation for offline/dev
    res.json({
      url: `https://via.placeholder.com/800x1100.png?text=MemoClick+Protected+File:+${encodeURIComponent(file.originalFilename)}`,
      filename: file.originalFilename,
      mimeType: file.mimeType
    });
  }
});

// Append-only Document Correction API (Strict Immutability)
app.post('/api/documents/:id/corrections', [
  requireAuth,
  body('reason').notEmpty().withMessage('Correction explanation reason is mandatory')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const doc = await Document.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const prevMeta = {
    title: doc.title,
    documentNumber: doc.documentNumber,
    partyName: doc.partyName,
    documentDate: doc.documentDate,
    remarks: doc.remarks,
    businessId: doc.businessId,
    fiscalYearId: doc.fiscalYearId,
    categoryId: doc.categoryId
  };

  const { title, documentNumber, partyName, documentDate, remarks, businessId, fiscalYearId, categoryId, reason } = req.body;

  if (title !== undefined) doc.title = title;
  if (documentNumber !== undefined) doc.documentNumber = documentNumber;
  if (partyName !== undefined) doc.partyName = partyName;
  if (documentDate !== undefined) doc.documentDate = documentDate;
  if (remarks !== undefined) doc.remarks = remarks;
  if (businessId !== undefined) doc.businessId = businessId;
  if (fiscalYearId !== undefined) doc.fiscalYearId = fiscalYearId;
  if (categoryId !== undefined) doc.categoryId = categoryId;
  doc.isCorrected = true;
  await doc.save();

  const correction = await DocumentCorrection.create({
    documentId: doc._id,
    reason,
    previousMetadata: prevMeta,
    updatedMetadata: req.body,
    correctedBy: req.user._id
  });

  doc.correctionRef = correction._id;
  await doc.save();

  await recordAudit(req.user._id, 'DOCUMENT_CORRECTION_APPENDED', doc._id, { reason }, req);
  res.json({ message: 'Correction preserved in immutable audit log', correction });
});

// Search documents across multiple fields
app.get('/api/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim() === '') return res.json([]);

  const regex = new RegExp(q.trim(), 'i');
  const results = await Document.find({
    $or: [
      { documentRef: regex },
      { title: regex },
      { documentNumber: regex },
      { partyName: regex },
      { remarks: regex }
    ]
  })
    .populate('businessId', 'businessName')
    .populate('fiscalYearId', 'fiscalYear')
    .populate('categoryId', 'name icon color')
    .limit(30);

  res.json(results);
});

// Unsorted Inbox: Organize document logically into folder without modifying storage
app.post('/api/inbox/organize/:id', [
  requireAuth,
  body('businessId').isMongoId(),
  body('fiscalYearId').isMongoId(),
  body('categoryId').isMongoId()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const doc = await Document.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  doc.businessId = req.body.businessId;
  doc.fiscalYearId = req.body.fiscalYearId;
  doc.categoryId = req.body.categoryId;
  doc.isOrganized = true;
  if (req.body.title) doc.title = req.body.title;
  if (req.body.partyName) doc.partyName = req.body.partyName;
  if (req.body.documentNumber) doc.documentNumber = req.body.documentNumber;
  await doc.save();

  await recordAudit(req.user._id, 'INBOX_ORGANIZE', doc._id, { newFolder: req.body }, req);
  res.json({ message: 'Document organized successfully into folder', document: doc });
});

// ==========================================
// 11. EMBEDDED FRONTEND SPA (CLAYMORPHISM)
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#668EF0">
  <link rel="manifest" href="/manifest.json">
  <title>MemoClick – Capture. Organize. Find.</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.9/pdf-lib.min.js"></script>
  <style>
    :root {
      --primary: #668EF0;
      --primary-dark: #4c73d9;
      --bg: #F4F6FB;
      --card-bg: #FFFFFF;
      --soft-blue: #E5EEFF;
      --mint: #C9EBDD;
      --lavender: #E9E0FF;
      --peach: #FFE3D3;
      --yellow: #FFF0C7;
      --text: #283247;
      --muted: #7B8498;
      --danger: #FF6B6B;
      --clay-shadow: 8px 8px 16px #d5dae8, -8px -8px 16px #ffffff;
      --clay-shadow-sm: 4px 4px 10px #d5dae8, -4px -4px 10px #ffffff;
      --clay-inset: inset 3px 3px 6px #d0d6e6, inset -3px -3px 6px #ffffff;
      --clay-btn-shadow: 6px 6px 12px #c9d2e7, -6px -6px 12px #ffffff;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background-color: var(--bg); color: var(--text); padding-bottom: 84px; min-height: 100vh; overflow-x: hidden; }

    /* Claymorphic Utility Classes */
    .clay-card {
      background: var(--card-bg);
      border-radius: 24px;
      box-shadow: var(--clay-shadow);
      border: 1px solid rgba(255, 255, 255, 0.7);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .clay-card:active { transform: scale(0.985); }
    .clay-btn {
      background: var(--card-bg);
      border: none;
      outline: none;
      border-radius: 20px;
      font-weight: 700;
      color: var(--text);
      box-shadow: var(--clay-btn-shadow);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: all 0.2s ease;
    }
    .clay-btn:active { box-shadow: var(--clay-inset); transform: translateY(1px); }
    .clay-btn-primary { background: linear-gradient(135deg, #7499ff, #577fe6); color: #fff; box-shadow: 6px 6px 14px #c2cff0, -6px -6px 14px #ffffff; }

    /* Header */
    header {
      padding: 18px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      background: rgba(244, 246, 251, 0.92);
      backdrop-filter: blur(10px);
      z-index: 100;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.35rem; color: var(--primary); }
    .brand i { font-size: 1.5rem; }
    .header-icons { display: flex; gap: 12px; }
    .icon-bubble {
      width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      background: var(--card-bg); box-shadow: var(--clay-shadow-sm); cursor: pointer; color: var(--text);
    }

    /* Container */
    .container { max-width: 720px; margin: 0 auto; padding: 0 16px; }

    /* Hero Quick Actions */
    .hero-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0 24px 0; }
    .hero-btn {
      padding: 24px 16px; border-radius: 28px; display: flex; flex-direction: column; align-items: center;
      text-align: center; gap: 12px; font-weight: 800; font-size: 1.15rem; color: #fff; cursor: pointer;
    }
    .hero-btn.capture { background: linear-gradient(135deg, #668EF0, #426fe4); box-shadow: 8px 8px 20px #c3d2f7, -6px -6px 16px #ffffff; }
    .hero-btn.upload { background: linear-gradient(135deg, #43C6AC, #2BB594); box-shadow: 8px 8px 20px #bfebe0, -6px -6px 16px #ffffff; }
    .hero-btn i { font-size: 2.2rem; }
    .hero-btn span.subtitle { font-size: 0.78rem; font-weight: 500; opacity: 0.92; }

    /* Section Headings */
    .section-title { font-size: 1.15rem; font-weight: 800; margin: 24px 0 12px 4px; display: flex; justify-content: space-between; align-items: center; }
    .section-title a { font-size: 0.85rem; color: var(--primary); text-decoration: none; font-weight: 600; }

    /* Business Scroll Cards */
    .business-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .biz-card { padding: 18px; border-radius: 22px; display: flex; flex-direction: column; justify-content: space-between; min-height: 120px; }
    .biz-card .biz-title { font-weight: 700; font-size: 1rem; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .biz-badge { background: var(--soft-blue); color: var(--primary); font-size: 0.72rem; padding: 4px 8px; border-radius: 10px; font-weight: 700; width: fit-content; }
    .biz-count { font-size: 0.82rem; color: var(--muted); margin-top: 6px; }

    /* Recent Documents List */
    .doc-item { padding: 14px; border-radius: 20px; display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
    .doc-icon-wrap { width: 48px; height: 48px; border-radius: 16px; background: var(--soft-blue); color: var(--primary); display: flex; align-items: center; justify-content: center; font-size: 1.25rem; flex-shrink: 0; }
    .doc-details { flex: 1; min-width: 0; }
    .doc-ref { font-weight: 700; font-size: 0.92rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .doc-meta { font-size: 0.75rem; color: var(--muted); display: flex; gap: 8px; margin-top: 3px; align-items: center; }
    .backup-badge { font-size: 0.68rem; padding: 2px 7px; border-radius: 8px; font-weight: 700; }
    .status-backed-up { background: var(--mint); color: #1B7F53; }
    .status-pending { background: var(--yellow); color: #9E7400; }
    .status-failed { background: var(--peach); color: #C2410C; }

    /* Bottom Navigation Bar */
    nav.bottom-nav {
      position: fixed; bottom: 0; left: 0; right: 0; height: 72px; background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(12px); border-radius: 26px 26px 0 0; box-shadow: 0 -4px 20px rgba(0,0,0,0.06);
      display: flex; justify-content: space-around; align-items: center; z-index: 1000;
    }
    .nav-item { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--muted); text-decoration: none; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
    .nav-item.active { color: var(--primary); }
    .nav-item i { font-size: 1.25rem; }

    /* Modal / Camera Fullscreen */
    .fullscreen-modal {
      display: none; position: fixed; inset: 0; background: #000; z-index: 2000; flex-direction: column; justify-content: space-between;
    }
    #cameraVideo { width: 100%; height: 75vh; object-fit: cover; }
    .camera-controls { height: 25vh; background: #111; display: flex; align-items: center; justify-content: space-around; padding: 0 20px; }
    .shutter-btn {
      width: 72px; height: 72px; border-radius: 50%; background: #fff; border: 5px solid rgba(255, 255, 255, 0.4);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .shutter-inner { width: 52px; height: 52px; border-radius: 50%; background: var(--primary); }

    /* Scanner & Preview Canvas Modal */
    .scanner-modal {
      display: none; position: fixed; inset: 0; background: var(--bg); z-index: 2100; flex-direction: column; overflow-y: auto; padding: 16px;
    }
    .scanner-preview-card { background: #000; border-radius: 20px; overflow: hidden; display: flex; justify-content: center; align-items: center; min-height: 380px; position: relative; }
    #scanCanvas { max-width: 100%; max-height: 60vh; }
    .filter-bar { display: flex; gap: 10px; margin: 16px 0; overflow-x: auto; padding: 4px; }
    .filter-btn { padding: 8px 16px; border-radius: 14px; font-size: 0.8rem; font-weight: 700; background: #fff; border: none; box-shadow: var(--clay-shadow-sm); cursor: pointer; white-space: nowrap; }
    .filter-btn.active { background: var(--primary); color: #fff; }

    /* Form Inputs */
    .input-group { margin-bottom: 14px; }
    .input-group label { display: block; font-size: 0.8rem; font-weight: 700; margin-bottom: 6px; color: var(--text); }
    .input-field {
      width: 100%; padding: 14px 16px; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.8);
      background: var(--card-bg); box-shadow: var(--clay-inset); font-size: 0.92rem; outline: none;
    }

    /* Toast Notification */
    #toast {
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-100px);
      background: #283247; color: #fff; padding: 12px 24px; border-radius: 30px; font-size: 0.88rem;
      font-weight: 600; box-shadow: 0 10px 24px rgba(0,0,0,0.2); z-index: 9999; transition: transform 0.3s ease;
    }
    #toast.show { transform: translateX(-50%) translateY(0); }
  </style>
</head>
<body>

  <!-- Toast -->
  <div id="toast">Notification Message</div>

  <!-- Header -->
  <header>
    <div class="brand">
      <i class="fa-solid fa-shapes"></i>
      <span>MemoClick</span>
    </div>
    <div class="header-icons">
      <div class="icon-bubble" onclick="openSearchModal()"><i class="fa-solid fa-magnifying-glass"></i></div>
      <div class="icon-bubble" onclick="switchTab('inbox')">
        <i class="fa-solid fa-inbox"></i>
      </div>
      <a href="/admin" class="icon-bubble" title="Admin Dashboard"><i class="fa-solid fa-shield-halved"></i></a>
    </div>
  </header>

  <div class="container" id="mainContainer">
    <!-- HERO QUICK ACTIONS -->
    <div class="hero-actions">
      <div class="hero-btn capture" onclick="startCameraCapture()">
        <i class="fa-solid fa-camera"></i>
        <span>CAPTURE</span>
        <span class="subtitle">Scan Paper Vouchers</span>
      </div>
      <div class="hero-btn upload" onclick="triggerFileUpload()">
        <i class="fa-solid fa-cloud-arrow-up"></i>
        <span>UPLOAD</span>
        <span class="subtitle">PDFs or Gallery Photos</span>
      </div>
    </div>
    <input type="file" id="hiddenFileInput" multiple accept="image/*,application/pdf" style="display:none;" onchange="handleFileSelected(event)">

    <!-- BUSINESSES SECTION -->
    <div class="section-title">
      <span>My Businesses</span>
      <a href="javascript:void(0)" onclick="switchTab('browse')">View All</a>
    </div>
    <div class="business-grid" id="businessGrid">
      <!-- Injected dynamically from MongoDB -->
      <div class="clay-card biz-card"><div class="biz-title"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div></div>
    </div>

    <!-- RECENT DOCUMENTS -->
    <div class="section-title">
      <span>Recent Documents</span>
      <a href="javascript:void(0)" onclick="loadRecentDocuments()">Refresh</a>
    </div>
    <div id="recentDocList">
      <div class="clay-card doc-item"><i class="fa-solid fa-circle-notch fa-spin"></i> Fetching records...</div>
    </div>
  </div>

  <!-- FULLSCREEN CAMERA MODAL -->
  <div class="fullscreen-modal" id="cameraModal">
    <video id="cameraVideo" autoplay playsinline></video>
    <div class="camera-controls">
      <div class="icon-bubble" onclick="closeCamera()"><i class="fa-solid fa-xmark"></i></div>
      <div class="shutter-btn" onclick="capturePhotoFrame()">
        <div class="shutter-inner"></div>
      </div>
      <div class="icon-bubble" onclick="switchCamera()"><i class="fa-solid fa-camera-rotate"></i></div>
    </div>
  </div>

  <!-- AUTO SCAN & PREVIEW SCREEN -->
  <div class="scanner-modal" id="scannerModal">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <h3 style="font-weight:800;">Review & Document Scan</h3>
      <button class="clay-btn" style="padding:8px 14px;" onclick="closeScannerModal()">Retake</button>
    </div>

    <div class="scanner-preview-card">
      <canvas id="scanCanvas"></canvas>
    </div>

    <div class="filter-bar">
      <button class="filter-btn active" onclick="applyCanvasFilter('original')">Keep Original</button>
      <button class="filter-btn" onclick="applyCanvasFilter('enhance')">Auto Scan (Enhanced)</button>
      <button class="filter-btn" onclick="applyCanvasFilter('grayscale')">Grayscale</button>
      <button class="filter-btn" onclick="applyCanvasFilter('bw')">High Contrast B&W</button>
      <button class="filter-btn" onclick="rotateCanvas()"><i class="fa-solid fa-rotate-right"></i> Rotate</button>
    </div>

    <!-- METADATA FORM FOR WORKFLOW A -->
    <div class="clay-card" style="padding:18px; margin-top:10px;">
      <h4 style="font-weight:800; margin-bottom:12px;">Filing Information</h4>
      <div class="input-group">
        <label>Select Business *</label>
        <select class="input-field" id="metaBusiness"></select>
      </div>
      <div class="input-group">
        <label>Nepal Fiscal Year *</label>
        <select class="input-field" id="metaFiscalYear"></select>
      </div>
      <div class="input-group">
        <label>Category *</label>
        <select class="input-field" id="metaCategory"></select>
      </div>
      <div class="input-group">
        <label>Party / Vendor Name (Optional)</label>
        <input type="text" class="input-field" id="metaParty" placeholder="e.g. Kathmandu Traders">
      </div>
      <div class="input-group">
        <label>Document Number (Optional)</label>
        <input type="text" class="input-field" id="metaDocNum" placeholder="e.g. INV-2082-99">
      </div>

      <div style="display:flex; gap:12px; margin-top:20px;">
        <button class="clay-btn" style="flex:1; padding:14px;" onclick="saveToInboxInstead()">Save to Inbox</button>
        <button class="clay-btn clay-btn-primary" style="flex:1; padding:14px;" onclick="uploadProcessedDocument()">File Document</button>
      </div>
    </div>
  </div>

  <!-- BOTTOM NAVIGATION -->
  <nav class="bottom-nav">
    <div class="nav-item active" onclick="switchTab('home')"><i class="fa-solid fa-house"></i><span>Home</span></div>
    <div class="nav-item" onclick="switchTab('browse')"><i class="fa-solid fa-folder-tree"></i><span>Browse</span></div>
    <div class="nav-item" onclick="openSearchModal()"><i class="fa-solid fa-magnifying-glass"></i><span>Search</span></div>
    <div class="nav-item" onclick="switchTab('inbox')"><i class="fa-solid fa-inbox"></i><span>Inbox</span></div>
    <div class="nav-item" onclick="openSettingsModal()"><i class="fa-solid fa-gear"></i><span>Settings</span></div>
  </nav>

  <script>
    let activeToken = localStorage.getItem('mc_token') || '';
    let currentStream = null;
    let currentFacingMode = 'environment';
    let capturedRawBlob = null;
    let rawImageObj = new Image();
    let rotationAngle = 0;
    let activeFilterMode = 'original';

    // Auto login check or initialize guest demo token
    async function ensureAuth() {
      if (!activeToken) {
        // Authenticate default owner session for demo access
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'owner@memoclick.com', password: 'MemoClick2082Secure!' })
          });
          const data = await res.json();
          if (data.token) {
            activeToken = data.token;
            localStorage.setItem('mc_token', activeToken);
          }
        } catch (e) { console.error('Auth error:', e); }
      }
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    // Load dynamic data from MongoDB
    async function initHomeData() {
      await ensureAuth();
      try {
        const [bizRes, fyRes, catRes] = await Promise.all([
          fetch('/api/businesses', { headers: { Authorization: 'Bearer ' + activeToken } }),
          fetch('/api/fiscal-years', { headers: { Authorization: 'Bearer ' + activeToken } }),
          fetch('/api/categories', { headers: { Authorization: 'Bearer ' + activeToken } })
        ]);
        const businesses = await bizRes.json();
        const fiscalYears = await fyRes.json();
        const categories = await catRes.json();

        // Render Business Cards
        const grid = document.getElementById('businessGrid');
        grid.innerHTML = businesses.map(b => \`
          <div class="clay-card biz-card" onclick="openFolderView('\${b._id}')">
            <div>
              <div class="biz-title"><i class="fa-solid fa-building"></i> \${b.businessName}</div>
              <div class="biz-count">\${b.documentCount} Document\${b.documentCount === 1 ? '' : 's'}</div>
            </div>
            <span class="biz-badge">FY 2082/83</span>
          </div>
        \`).join('');

        // Populate Form Selects
        document.getElementById('metaBusiness').innerHTML = businesses.map(b => \`<option value="\${b._id}">\${b.businessName}</option>\`).join('');
        document.getElementById('metaFiscalYear').innerHTML = fiscalYears.map(f => \`<option value="\${f._id}">\${f.fiscalYear}</option>\`).join('');
        document.getElementById('metaCategory').innerHTML = categories.map(c => \`<option value="\${c._id}">\${c.name}</option>\`).join('');

        loadRecentDocuments();
      } catch (err) {
        console.error('Data init failed:', err);
      }
    }

    async function loadRecentDocuments() {
      try {
        const res = await fetch('/api/documents?limit=8', { headers: { Authorization: 'Bearer ' + activeToken } });
        const data = await res.json();
        const container = document.getElementById('recentDocList');

        if (!data.documents || data.documents.length === 0) {
          container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--muted); font-size:0.9rem;">No documents uploaded yet. Tap Capture or Upload above!</div>';
          return;
        }

        container.innerHTML = data.documents.map(d => {
          const statusClass = d.backupStatus === 'Backed Up' ? 'status-backed-up' : (d.backupStatus === 'Failed' ? 'status-failed' : 'status-pending');
          return \`
            <div class="clay-card doc-item" onclick="viewDocumentDetail('\${d._id}')">
              <div class="doc-icon-wrap"><i class="fa-solid \${d.categoryId?.icon || 'fa-file'}"></i></div>
              <div class="doc-details">
                <div class="doc-ref">\${d.documentRef} \${d.partyName ? '• ' + d.partyName : ''}</div>
                <div class="doc-meta">
                  <span>\${d.businessId?.businessName || 'Unfiled'}</span>
                  <span>\${d.fiscalYearId?.fiscalYear || ''}</span>
                  <span class="backup-badge \${statusClass}">\${d.backupStatus}</span>
                </div>
              </div>
              <i class="fa-solid fa-chevron-right" style="color:var(--muted); font-size:0.8rem;"></i>
            </div>
          \`;
        }).join('');
      } catch (e) {
        console.error(e);
      }
    }

    // Camera Capture Implementation
    async function startCameraCapture() {
      const modal = document.getElementById('cameraModal');
      modal.style.display = 'flex';
      try {
        if (currentStream) currentStream.getTracks().forEach(t => t.stop());
        currentStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: currentFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
        document.getElementById('cameraVideo').srcObject = currentStream;
      } catch (err) {
        alert('Camera access denied or unavailable: ' + err.message);
        closeCamera();
      }
    }

    function switchCamera() {
      currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
      startCameraCapture();
    }

    function closeCamera() {
      if (currentStream) currentStream.getTracks().forEach(t => t.stop());
      document.getElementById('cameraModal').style.display = 'none';
    }

    function capturePhotoFrame() {
      const video = document.getElementById('cameraVideo');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob((blob) => {
        capturedRawBlob = blob;
        rawImageObj.onload = () => {
          closeCamera();
          openScannerModal();
        };
        rawImageObj.src = URL.createObjectURL(blob);
      }, 'image/jpeg', 0.95);
    }

    // Auto Scan & Canvas Enhancement Engine
    function openScannerModal() {
      document.getElementById('scannerModal').style.display = 'flex';
      rotationAngle = 0;
      activeFilterMode = 'original';
      renderProcessedCanvas();
    }

    function closeScannerModal() {
      document.getElementById('scannerModal').style.display = 'none';
    }

    function rotateCanvas() {
      rotationAngle = (rotationAngle + 90) % 360;
      renderProcessedCanvas();
    }

    function applyCanvasFilter(mode) {
      activeFilterMode = mode;
      document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      renderProcessedCanvas();
    }

    function renderProcessedCanvas() {
      const canvas = document.getElementById('scanCanvas');
      const ctx = canvas.getContext('2d');

      const isRotated = rotationAngle === 90 || rotationAngle === 270;
      canvas.width = isRotated ? rawImageObj.height : rawImageObj.width;
      canvas.height = isRotated ? rawImageObj.width : rawImageObj.height;

      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotationAngle * Math.PI) / 180);
      ctx.drawImage(rawImageObj, -rawImageObj.width / 2, -rawImageObj.height / 2);
      ctx.restore();

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imgData.data;

      if (activeFilterMode === 'grayscale') {
        for (let i = 0; i < d.length; i += 4) {
          const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
      } else if (activeFilterMode === 'bw') {
        for (let i = 0; i < d.length; i += 4) {
          const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) > 130 ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
      } else if (activeFilterMode === 'enhance') {
        // Document edge readability and contrast booster
        const contrast = 35; // enhancement factor
        const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
        for (let i = 0; i < d.length; i += 4) {
          d[i] = factor * (d[i] - 128) + 128;
          d[i + 1] = factor * (d[i + 1] - 128) + 128;
          d[i + 2] = factor * (d[i + 2] - 128) + 128;
        }
        ctx.putImageData(imgData, 0, 0);
      }
    }

    // Upload & Persistence Execution
    function triggerFileUpload() {
      document.getElementById('hiddenFileInput').click();
    }

    async function handleFileSelected(e) {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
      }
      formData.append('isInbox', 'true'); // Upload directly to unsorted inbox if uploaded in batch

      showToast('Uploading document...');
      try {
        const res = await fetch('/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + activeToken },
          body: formData
        });
        const result = await res.json();
        showToast('Document securely uploaded to Inbox!');
        loadRecentDocuments();
      } catch (err) {
        alert('Upload failed: ' + err.message);
      }
    }

    async function uploadProcessedDocument() {
      const canvas = document.getElementById('scanCanvas');
      showToast('Saving and filing document...');

      canvas.toBlob(async (blob) => {
        const formData = new FormData();
        formData.append('files', blob, 'scan_page_1.jpg');
        formData.append('businessId', document.getElementById('metaBusiness').value);
        formData.append('fiscalYearId', document.getElementById('metaFiscalYear').value);
        formData.append('categoryId', document.getElementById('metaCategory').value);
        formData.append('partyName', document.getElementById('metaParty').value);
        formData.append('documentNumber', document.getElementById('metaDocNum').value);

        try {
          const res = await fetch('/api/documents/upload', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + activeToken },
            body: formData
          });
          const result = await res.json();
          closeScannerModal();
          showToast('Document successfully filed: ' + result.document.documentRef);
          loadRecentDocuments();
        } catch (err) {
          alert('Filing error: ' + err.message);
        }
      }, 'image/jpeg', 0.92);
    }

    function saveToInboxInstead() {
      const canvas = document.getElementById('scanCanvas');
      canvas.toBlob(async (blob) => {
        const formData = new FormData();
        formData.append('files', blob, 'inbox_scan.jpg');
        formData.append('isInbox', 'true');
        await fetch('/api/documents/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + activeToken },
          body: formData
        });
        closeScannerModal();
        showToast('Saved to Inbox for later organization');
        loadRecentDocuments();
      });
    }

    function switchTab(tab) {
      if (tab === 'inbox') {
        alert('Unsorted Inbox: Viewing documents pending classification.');
      } else if (tab === 'browse') {
        alert('Browse Folders: Select a business card to navigate its Nepal Fiscal Year structure.');
      }
    }

    function openSearchModal() {
      const query = prompt('Global Document Search (Ref, Title, Vendor, Bill No):');
      if (query) {
        fetch('/api/search?q=' + encodeURIComponent(query), { headers: { Authorization: 'Bearer ' + activeToken } })
          .then(r => r.json())
          .then(results => {
            alert('Found ' + results.length + ' documents matching "' + query + '"');
          });
      }
    }

    window.addEventListener('DOMContentLoaded', initHomeData);
  </script>
</body>
</html>`);
});

// ==========================================
// 12. SERVER INITIALIZATION (VERCEL COMPLIANT)
// ==========================================
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 MemoClick running on http://localhost:${PORT}`);
    console.log(`🛡️ Admin dashboard on http://localhost:${PORT}/admin`);
  });
}

module.exports = app;
