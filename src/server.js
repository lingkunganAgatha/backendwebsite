'use strict';

require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const PDFDocument = require('pdfkit');

// ─────────────────────────────────────────────
// Constants & Environment
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
const GOOGLE_PRIVATE_KEY_RAW = process.env.GOOGLE_PRIVATE_KEY || '';
// Sanitasi GOOGLE_DRIVE_ROOT_FOLDER_ID: ekstrak ID murni dari URL jika perlu
// Contoh URL: https://drive.google.com/drive/folders/1CFz4jnnha...?hl=ID
function extractDriveFolderId(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  // Cek apakah ini URL Google Drive
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  // Cek apakah ada query string yang perlu dibuang
  const queryMatch = trimmed.match(/^([a-zA-Z0-9_-]+)/);
  if (queryMatch && trimmed.includes('?')) return queryMatch[1];
  // Sudah berupa ID murni
  return trimmed;
}
const GOOGLE_DRIVE_ROOT_FOLDER_ID = extractDriveFolderId(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '');

const ROMAN_MONTHS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

// ─────────────────────────────────────────────
// Supabase Client
// ─────────────────────────────────────────────
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// ─────────────────────────────────────────────
// Google Drive Client
// Mendukung 3 format env var:
//   1. GOOGLE_PRIVATE_KEY berisi JSON lengkap service account
//   2. GOOGLE_PRIVATE_KEY berisi hanya private key string
//   3. GOOGLE_SERVICE_ACCOUNT_JSON berisi JSON lengkap (opsional)
// ─────────────────────────────────────────────
let driveEnabled = false;
let driveClient = null;

function resolveGoogleCredentials() {
  // Prioritas 1: env var GOOGLE_SERVICE_ACCOUNT_JSON (JSON lengkap)
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (saJson) {
    try {
      const parsed = JSON.parse(saJson);
      if (parsed.client_email && parsed.private_key) return parsed;
    } catch (_) {}
  }

  // Prioritas 2: GOOGLE_PRIVATE_KEY berisi JSON lengkap service account
  if (GOOGLE_PRIVATE_KEY_RAW && GOOGLE_PRIVATE_KEY_RAW.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(GOOGLE_PRIVATE_KEY_RAW);
      if (parsed.client_email && parsed.private_key) {
        console.log('[Drive] GOOGLE_PRIVATE_KEY berisi JSON service account — parsing otomatis');
        return parsed;
      }
    } catch (_) {}
  }

  // Prioritas 3: GOOGLE_PRIVATE_KEY berisi PEM key string + GOOGLE_CLIENT_EMAIL terpisah
  if (GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY_RAW) {
    // Normalise escaped newlines \\n → \n
    const normalised = GOOGLE_PRIVATE_KEY_RAW.replace(/\\n/g, '\n');
    return { client_email: GOOGLE_CLIENT_EMAIL, private_key: normalised };
  }

  return null;
}

if (GOOGLE_DRIVE_ROOT_FOLDER_ID) {
  try {
    const creds = resolveGoogleCredentials();
    if (creds) {
      const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      driveClient = google.drive({ version: 'v3', auth });
      driveEnabled = true;
      console.log('[Drive] Inisialisasi berhasil, email:', creds.client_email);
    } else {
      console.warn('[Drive] Credentials tidak ditemukan — Google Drive dinonaktifkan');
    }
  } catch (err) {
    console.error('[Drive] Gagal inisialisasi Google Drive:', err.message);
  }
}

// ─────────────────────────────────────────────
// Multer (memory storage, 50 MB limit)
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ─────────────────────────────────────────────
// CORS Configuration
// ─────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://arsip-surat-app.vercel.app',
  'https://portalagatha.com',
  'https://www.portalagatha.com',
];

// Add origins from CORS_ORIGINS env (comma-separated)
if (process.env.CORS_ORIGINS) {
  process.env.CORS_ORIGINS.split(',').forEach((o) => {
    const trimmed = o.trim();
    if (trimmed && !allowedOrigins.includes(trimmed)) {
      allowedOrigins.push(trimmed);
    }
  });
}

// Add FRONTEND_URL and APP_ORIGIN if set
[process.env.FRONTEND_URL, process.env.APP_ORIGIN].forEach((o) => {
  if (o && !allowedOrigins.includes(o.trim())) {
    allowedOrigins.push(o.trim());
  }
});

const corsOptions = {
  origin(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow all *.vercel.app subdomains
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} tidak diizinkan`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Letter-Number', 'X-Archive-Id', 'Content-Disposition'],
  credentials: true,
  optionsSuccessStatus: 204,
};

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────
const app = express();

// Security headers
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token diperlukan' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'Token tidak valid atau sudah kadaluarsa' });
  }
}

// ─────────────────────────────────────────────
// Multer Error Handler Middleware
// ─────────────────────────────────────────────
function multerErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Ukuran file melebihi batas 50MB' });
    }
    return res.status(400).json({ message: `Upload error: ${err.message}` });
  }
  next(err);
}

// ─────────────────────────────────────────────
// Helper: Upload file ke Google Drive
// ─────────────────────────────────────────────
async function uploadToDrive(fileBuffer, fileName, mimeType, folderId) {
  if (!driveEnabled || !driveClient) return null;
  const { Readable } = require('stream');
  const stream = Readable.from(fileBuffer);

  const res = await driveClient.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId || GOOGLE_DRIVE_ROOT_FOLDER_ID],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  return {
    drive_file_id: res.data.id,
    drive_web_view_link: res.data.webViewLink,
  };
}

// ─────────────────────────────────────────────
// Helper: Generate Nomor Surat
// Format: {nomor_urut}/{kode_jenis}/SA-PB/{bulan_romawi}/{tahun}
// Contoh: 001/PINDAH/SA-PB/VII/2026
// ─────────────────────────────────────────────
async function generateLetterNumber(kategoriSurat, tanggalPermohonan) {
  if (!supabase) throw new Error('Supabase tidak dikonfigurasi');

  const date = tanggalPermohonan ? new Date(tanggalPermohonan) : new Date();
  const year = date.getFullYear();
  const monthRoman = ROMAN_MONTHS[date.getMonth()];

  // Map kategori → kode jenis
  const kodeMap = {
    PINDAH: 'PINDAH',
    pindah: 'PINDAH',
    KETERANGAN: 'KETERANGAN',
    keterangan: 'KETERANGAN',
  };
  const kodeJenis = kodeMap[kategoriSurat] || kategoriSurat.toUpperCase();

  // Hitung nomor urut: jumlah arsip dengan letter_type sama di tahun yang sama + 1
  const { count, error } = await supabase
    .from('archives')
    .select('id', { count: 'exact', head: true })
    .eq('letter_type', kodeJenis)
    .gte('created_at', `${year}-01-01T00:00:00.000Z`)
    .lt('created_at', `${year + 1}-01-01T00:00:00.000Z`);

  if (error) throw new Error(`Gagal menghitung nomor urut: ${error.message}`);

  const sequence = (count || 0) + 1;
  const nomorUrut = String(sequence).padStart(3, '0');
  const letterNumber = `${nomorUrut}/${kodeJenis}/SA-PB/${monthRoman}/${year}`;

  return { letterNumber, letterDate: date.toISOString(), kodeJenis, year, monthRoman };
}

// ─────────────────────────────────────────────
// Helper: Generate PDF dengan PDFKit
// ─────────────────────────────────────────────
function generateSuratPindahPDF(data) {
  return new Promise((resolve, reject) => {
    const {
      letterNumber,
      letterDate,
      nama,
      alamatAsal,
      alamatBaru,
      lingkunganTujuan,
      stasiTujuan,
      paroki,
      penandatangan,
      perihalSurat,
    } = data;

    const doc = new PDFDocument({ size: 'A4', margin: 72 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const formattedDate = new Date(letterDate).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // ── Header ──
    doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .text('GEREJA KATOLIK ST. AGATHA', { align: 'center' })
      .fontSize(11)
      .font('Helvetica')
      .text('Paroki Pluit Penjaringan', { align: 'center' })
      .moveDown(0.5);

    // Garis horizontal
    doc
      .moveTo(72, doc.y)
      .lineTo(doc.page.width - 72, doc.y)
      .lineWidth(2)
      .stroke()
      .moveDown(0.5);

    // ── Judul Surat ──
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text('SURAT KETERANGAN PINDAH', { align: 'center' })
      .moveDown(0.3);

    doc
      .fontSize(11)
      .font('Helvetica')
      .text(`Nomor: ${letterNumber}`, { align: 'center' })
      .moveDown(1);

    // ── Pembuka ──
    doc
      .fontSize(11)
      .font('Helvetica')
      .text(`Tanggal: ${formattedDate}`, { align: 'right' })
      .moveDown(0.5);

    if (perihalSurat) {
      doc
        .text(`Perihal: ${perihalSurat}`)
        .moveDown(1);
    }

    doc
      .text(
        'Yang bertanda tangan di bawah ini, Pastor Paroki St. Agatha, dengan ini menerangkan bahwa:',
        { align: 'justify' }
      )
      .moveDown(1);

    // ── Data Umat ──
    const labelWidth = 160;
    const lineHeight = 1.3;

    const rows = [
      ['Nama', nama || '-'],
      ['Alamat Asal', alamatAsal || '-'],
      ['Alamat Baru', alamatBaru || '-'],
      ['Lingkungan Tujuan', lingkunganTujuan || '-'],
      ['Stasi Tujuan', stasiTujuan || '-'],
      ['Paroki', paroki || '-'],
    ];

    rows.forEach(([label, value]) => {
      const startY = doc.y;
      doc
        .font('Helvetica-Bold')
        .text(`${label}`, 72, startY, { width: labelWidth, continued: false })
        .font('Helvetica')
        .text(`: ${value}`, 72 + labelWidth, startY, {
          width: doc.page.width - 72 - labelWidth - 72,
        })
        .moveDown(lineHeight - 1);
    });

    doc.moveDown(1.5);

    // ── Penutup ──
    doc
      .font('Helvetica')
      .text(
        'Demikian surat keterangan ini dibuat dengan sebenarnya untuk dapat dipergunakan sebagaimana mestinya.',
        { align: 'justify' }
      )
      .moveDown(2);

    // ── Tanda Tangan ──
    const sigX = doc.page.width - 72 - 180;
    const sigStartY = doc.y;

    doc
      .text(`Pluit, ${formattedDate}`, sigX, sigStartY, { width: 180, align: 'center' })
      .moveDown(0.3)
      .text('Pastor Paroki', sigX, doc.y, { width: 180, align: 'center' })
      .moveDown(3);

    doc
      .font('Helvetica-Bold')
      .text(penandatangan || 'Pastor Paroki', sigX, doc.y, { width: 180, align: 'center' })
      .font('Helvetica')
      .moveDown(0.2)
      .text('St. Agatha', sigX, doc.y, { width: 180, align: 'center' });

    doc.end();
  });
}

// ═════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const supabaseOk = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
  const googleOk = driveEnabled;
  const jwtOk = !!JWT_SECRET;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      supabase: supabaseOk,
      google: googleOk,
      jwt: jwtOk,
    },
  });
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username dan password diperlukan' });
  }

  if (username !== 'admin' || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Username atau password salah' });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });

  res.json({ token, username });
});

// ─────────────────────────────────────────────
// GET /api/templates
// ─────────────────────────────────────────────
app.get('/api/templates', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ message: `Gagal mengambil template: ${error.message}` });

  res.json(data);
});

// ─────────────────────────────────────────────
// POST /api/templates
// ─────────────────────────────────────────────
app.post('/api/templates', requireAuth, upload.single('template'), async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  // Support both 'templateName' (dari frontend) dan 'name' (API langsung)
  const name = req.body.templateName || req.body.name;
  const category = req.body.category;
  if (!name || !category) {
    return res.status(400).json({ message: 'Field name/templateName dan category diperlukan' });
  }

  let driveFileId = null;
  let driveWebViewLink = null;

  if (req.file && driveEnabled) {
    try {
      const fileName = `${Date.now()}_${req.file.originalname}`;
      const result = await uploadToDrive(
        req.file.buffer,
        fileName,
        req.file.mimetype ||
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        GOOGLE_DRIVE_ROOT_FOLDER_ID
      );
      if (result) {
        driveFileId = result.drive_file_id;
        driveWebViewLink = result.drive_web_view_link;
      }
    } catch (driveErr) {
      console.error('[Drive] Upload template gagal:', driveErr.message);
      // Lanjut tanpa Drive
    }
  }

  const { data, error } = await supabase
    .from('templates')
    .insert([
      {
        name,
        category,
        drive_file_id: driveFileId,
        drive_web_view_link: driveWebViewLink,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ message: `Gagal menyimpan template: ${error.message}` });

  res.status(201).json(data);
});

// ─────────────────────────────────────────────
// DELETE /api/templates/:id
// ─────────────────────────────────────────────
app.delete('/api/templates/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { id } = req.params;

  // Cek apakah template ada
  const { data: existing, error: fetchErr } = await supabase
    .from('templates')
    .select('id')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    return res.status(404).json({ message: 'Template tidak ditemukan' });
  }

  const { error } = await supabase.from('templates').delete().eq('id', id);
  if (error) return res.status(500).json({ message: `Gagal menghapus template: ${error.message}` });

  res.json({ message: 'Template berhasil dihapus' });
});

// ─────────────────────────────────────────────
// GET /api/archives/dashboard
// (harus sebelum /api/archives/:id)
// ─────────────────────────────────────────────
app.get('/api/archives/dashboard', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { month, year } = req.query;

  let query = supabase.from('archives').select('id', { count: 'exact', head: false });

  if (month) query = query.eq('archive_month', parseInt(month, 10));
  if (year) query = query.eq('archive_year', parseInt(year, 10));

  const { data: allArchives, count: totalCount, error: archErr } = await query;
  if (archErr) return res.status(500).json({ message: `Gagal mengambil data: ${archErr.message}` });

  // Letters = arsip yang punya letter_number
  let letterQuery = supabase
    .from('archives')
    .select('id', { count: 'exact', head: true })
    .not('letter_number', 'is', null);

  if (month) letterQuery = letterQuery.eq('archive_month', parseInt(month, 10));
  if (year) letterQuery = letterQuery.eq('archive_year', parseInt(year, 10));

  const { count: letterCount, error: letterErr } = await letterQuery;
  if (letterErr)
    return res.status(500).json({ message: `Gagal menghitung surat: ${letterErr.message}` });

  // Uploads = arsip yang punya drive_file_id
  let uploadQuery = supabase
    .from('archives')
    .select('id', { count: 'exact', head: true })
    .not('drive_file_id', 'is', null);

  if (month) uploadQuery = uploadQuery.eq('archive_month', parseInt(month, 10));
  if (year) uploadQuery = uploadQuery.eq('archive_year', parseInt(year, 10));

  const { count: uploadCount, error: uploadErr } = await uploadQuery;
  if (uploadErr)
    return res.status(500).json({ message: `Gagal menghitung upload: ${uploadErr.message}` });

  res.json({
    letters: letterCount || 0,
    uploads: uploadCount || 0,
  });
});

// ─────────────────────────────────────────────
// GET /api/archives
// ─────────────────────────────────────────────
app.get('/api/archives', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { month, year, jenisArsip, namaArsip } = req.query;

  let query = supabase.from('archives').select('*').order('created_at', { ascending: false });

  if (month) query = query.eq('archive_month', parseInt(month, 10));
  if (year) query = query.eq('archive_year', parseInt(year, 10));
  if (jenisArsip) query = query.eq('jenis_arsip', jenisArsip);
  if (namaArsip) query = query.ilike('nama_arsip', `%${namaArsip}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ message: `Gagal mengambil arsip: ${error.message}` });

  res.json(data);
});

// ─────────────────────────────────────────────
// POST /api/archives/take-number
// ─────────────────────────────────────────────
app.post('/api/archives/take-number', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { kategoriSurat, tanggalPermohonan, perihalSurat } = req.body;

  if (!kategoriSurat) {
    return res.status(400).json({ message: 'Field kategoriSurat diperlukan' });
  }

  const { letterNumber, letterDate, kodeJenis, year } = await generateLetterNumber(
    kategoriSurat,
    tanggalPermohonan
  );

  const date = new Date(letterDate);
  const archiveMonth = date.getMonth() + 1;
  const archiveYear = date.getFullYear();

  const { data, error } = await supabase
    .from('archives')
    .insert([
      {
        nama_arsip: perihalSurat || `Surat ${kodeJenis} - ${letterNumber}`,
        jenis_arsip: kodeJenis,
        letter_number: letterNumber,
        letter_type: kodeJenis,
        letter_subject: perihalSurat || null,
        request_date: letterDate,
        archive_month: archiveMonth,
        archive_year: archiveYear,
        sync_status: 'local',
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ message: `Gagal menyimpan nomor surat: ${error.message}` });

  res.status(201).json({ letterNumber, letterDate });
});

// ─────────────────────────────────────────────
// POST /api/archives/manual-upload
// ─────────────────────────────────────────────
app.post('/api/archives/manual-upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { jenisArsip, namaArsip, archiveMonth, archiveYear } = req.body;

  if (!namaArsip) {
    return res.status(400).json({ message: 'Field namaArsip diperlukan' });
  }

  let driveFileId = null;
  let driveWebViewLink = null;
  let syncStatus = 'local';

  if (req.file && driveEnabled) {
    try {
      const fileName = `${Date.now()}_${req.file.originalname}`;
      const result = await uploadToDrive(
        req.file.buffer,
        fileName,
        req.file.mimetype || 'application/octet-stream',
        GOOGLE_DRIVE_ROOT_FOLDER_ID
      );
      if (result) {
        driveFileId = result.drive_file_id;
        driveWebViewLink = result.drive_web_view_link;
        syncStatus = 'synced';
      }
    } catch (driveErr) {
      console.error('[Drive] Upload arsip gagal:', driveErr.message);
      // Lanjut tanpa Drive
    }
  }

  const { data, error } = await supabase
    .from('archives')
    .insert([
      {
        nama_arsip: namaArsip,
        jenis_arsip: jenisArsip || null,
        archive_month: archiveMonth ? parseInt(archiveMonth, 10) : null,
        archive_year: archiveYear ? parseInt(archiveYear, 10) : null,
        sync_status: syncStatus,
        drive_file_id: driveFileId,
        drive_web_view_link: driveWebViewLink,
      },
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ message: `Gagal menyimpan arsip: ${error.message}` });

  res.status(201).json(data);
});

// ─────────────────────────────────────────────
// POST /api/archives/generate-pdf
// ─────────────────────────────────────────────
app.post('/api/archives/generate-pdf', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const {
    kategoriSurat,
    nama,
    tanggalPermohonan,
    alamatAsal,
    alamatBaru,
    lingkunganTujuan,
    stasiTujuan,
    paroki,
    penandatangan,
    perihalSurat,
  } = req.body;

  if (!kategoriSurat) {
    return res.status(400).json({ message: 'Field kategoriSurat diperlukan' });
  }
  if (!nama) {
    return res.status(400).json({ message: 'Field nama diperlukan' });
  }

  // Generate nomor surat
  const { letterNumber, letterDate, kodeJenis } = await generateLetterNumber(
    kategoriSurat,
    tanggalPermohonan
  );

  const date = new Date(letterDate);
  const archiveMonth = date.getMonth() + 1;
  const archiveYear = date.getFullYear();

  // Simpan ke DB
  const { data: archiveData, error: dbError } = await supabase
    .from('archives')
    .insert([
      {
        nama_arsip: nama,
        jenis_arsip: kodeJenis,
        letter_number: letterNumber,
        letter_type: kodeJenis,
        letter_subject: perihalSurat || null,
        request_date: letterDate,
        archive_month: archiveMonth,
        archive_year: archiveYear,
        sync_status: 'local',
      },
    ])
    .select()
    .single();

  if (dbError)
    return res.status(500).json({ message: `Gagal menyimpan arsip: ${dbError.message}` });

  // Generate PDF
  let pdfBuffer;
  try {
    pdfBuffer = await generateSuratPindahPDF({
      letterNumber,
      letterDate,
      nama,
      alamatAsal,
      alamatBaru,
      lingkunganTujuan,
      stasiTujuan,
      paroki,
      penandatangan,
      perihalSurat,
    });
  } catch (pdfErr) {
    return res.status(500).json({ message: `Gagal membuat PDF: ${pdfErr.message}` });
  }

  // Upload PDF ke Drive jika tersedia
  if (driveEnabled) {
    try {
      const fileName = `${letterNumber.replace(/\//g, '-')}.pdf`;
      const result = await uploadToDrive(
        pdfBuffer,
        fileName,
        'application/pdf',
        GOOGLE_DRIVE_ROOT_FOLDER_ID
      );
      if (result) {
        await supabase
          .from('archives')
          .update({
            drive_file_id: result.drive_file_id,
            drive_web_view_link: result.drive_web_view_link,
            sync_status: 'synced',
          })
          .eq('id', archiveData.id);
      }
    } catch (driveErr) {
      console.error('[Drive] Upload PDF gagal:', driveErr.message);
      // Lanjut, PDF tetap dikirim ke client
    }
  }

  // Kirim PDF sebagai response
  const safeLetterNumber = letterNumber.replace(/\//g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Letter-Number', letterNumber);
  res.setHeader('X-Archive-Id', archiveData.id);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="surat-${safeLetterNumber}.pdf"`
  );
  res.send(pdfBuffer);
});

// ─────────────────────────────────────────────
// PUT /api/archives/:id
// ─────────────────────────────────────────────
app.put('/api/archives/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { id } = req.params;
  const { namaArsip, jenisArsip, perihalSurat, tanggalPermohonan } = req.body;

  // Cek apakah arsip ada
  const { data: existing, error: fetchErr } = await supabase
    .from('archives')
    .select('id')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    return res.status(404).json({ message: 'Arsip tidak ditemukan' });
  }

  const updateFields = {};
  if (namaArsip !== undefined) updateFields.nama_arsip = namaArsip;
  if (jenisArsip !== undefined) updateFields.jenis_arsip = jenisArsip;
  if (perihalSurat !== undefined) updateFields.letter_subject = perihalSurat;
  if (tanggalPermohonan !== undefined) updateFields.request_date = tanggalPermohonan;

  if (Object.keys(updateFields).length === 0) {
    return res.status(400).json({ message: 'Tidak ada field yang diperbarui' });
  }

  const { data, error } = await supabase
    .from('archives')
    .update(updateFields)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ message: `Gagal memperbarui arsip: ${error.message}` });

  res.json(data);
});

// ─────────────────────────────────────────────
// DELETE /api/archives/:id
// ─────────────────────────────────────────────
app.delete('/api/archives/:id', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database tidak dikonfigurasi' });

  const { id } = req.params;

  // Cek apakah arsip ada
  const { data: existing, error: fetchErr } = await supabase
    .from('archives')
    .select('id')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    return res.status(404).json({ message: 'Arsip tidak ditemukan' });
  }

  const { error } = await supabase.from('archives').delete().eq('id', id);
  if (error) return res.status(500).json({ message: `Gagal menghapus arsip: ${error.message}` });

  res.json({ message: 'Arsip berhasil dihapus' });
});

// ═════════════════════════════════════════════
// Error Handlers
// ═════════════════════════════════════════════

// Multer error handler (harus setelah routes)
app.use(multerErrorHandler);

// CORS error handler
app.use((err, req, res, next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ message: err.message });
  }
  next(err);
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.stack || err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    message: err.message || 'Terjadi kesalahan pada server',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} tidak ditemukan` });
});

// ═════════════════════════════════════════════
// Start Server (skip on Vercel serverless)
// ═════════════════════════════════════════════
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`[Server] Berjalan di port ${PORT}`);
    console.log(`[Supabase] ${supabase ? 'Terhubung' : 'Tidak dikonfigurasi'}`);
    console.log(`[Google Drive] ${driveEnabled ? 'Aktif' : 'Tidak dikonfigurasi'}`);
  });
}

module.exports = app;
