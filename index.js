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
app.use(cors({ o
