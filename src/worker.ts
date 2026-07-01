/**
 * Backend Arsip Surat St. Agatha
 * Cloudflare Workers — Hono Framework
 * Semua endpoint dikonversi dari Express.js original
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
interface Env {
  JWT_SECRET: string;
  ADMIN_PASSWORD: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID: string;
  FRONTEND_URL?: string;
  APP_ORIGIN?: string;
  CORS_ORIGINS?: string;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const ROMAN_MONTHS = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];

// ─────────────────────────────────────────────
// Helpers: Folder ID sanitizer
// ─────────────────────────────────────────────
function extractDriveFolderId(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  const queryMatch = trimmed.match(/^([a-zA-Z0-9_-]+)/);
  if (queryMatch && trimmed.includes('?')) return queryMatch[1];
  return trimmed;
}

// ─────────────────────────────────────────────
// Helpers: Resolve Google Credentials
// ─────────────────────────────────────────────
interface GoogleCreds {
  client_email: string;
  private_key: string;
}

function resolveGoogleCredentials(env: Env): GoogleCreds | null {
  const raw = env.GOOGLE_PRIVATE_KEY || '';
  // Prioritas 1: GOOGLE_PRIVATE_KEY berisi JSON lengkap service account
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.client_email && parsed.private_key) {
        return { client_email: parsed.client_email, private_key: parsed.private_key };
      }
    } catch (_) {}
  }
  // Prioritas 2: GOOGLE_PRIVATE_KEY berisi PEM key string + GOOGLE_CLIENT_EMAIL terpisah
  if (env.GOOGLE_CLIENT_EMAIL && raw) {
    const normalised = raw.replace(/\\n/g, '\n');
    return { client_email: env.GOOGLE_CLIENT_EMAIL, private_key: normalised };
  }
  return null;
}

// ─────────────────────────────────────────────
// Google Drive via fetch manual (JWT)
// Web Crypto API — tidak butuh googleapis package
// ─────────────────────────────────────────────
async function getGoogleAccessToken(creds: GoogleCreds): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  // Import private key PEM
  const pemContents = creds.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const jwt = `${signingInput}.${signature}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    throw new Error(`Google token error: ${tokenData.error || 'unknown'}`);
  }
  return tokenData.access_token;
}

// ─────────────────────────────────────────────
// Upload file ke Google Drive via REST API
// ─────────────────────────────────────────────
async function uploadToDrive(
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
  folderId: string,
  creds: GoogleCreds
): Promise<{ drive_file_id: string; drive_web_view_link: string } | null> {
  try {
    const accessToken = await getGoogleAccessToken(creds);

    // Multipart upload ke Drive API v3
    const boundary = '-------314159265358979323846';
    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });

    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      'Content-Transfer-Encoding: base64',
      '',
      btoa(String.fromCharCode(...new Uint8Array(fileBuffer))),
      `--${boundary}--`,
    ].join('\r\n');

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
        },
        body,
      }
    );

    const uploadData = await uploadRes.json() as { id?: string; webViewLink?: string; error?: any };

    if (!uploadRes.ok || !uploadData.id) {
      console.error('[Drive] Upload gagal:', JSON.stringify(uploadData.error));
      return null;
    }

    return {
      drive_file_id: uploadData.id,
      drive_web_view_link: uploadData.webViewLink || `https://drive.google.com/file/d/${uploadData.id}/view`,
    };
  } catch (err: any) {
    console.error('[Drive] uploadToDrive error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// JWT Helpers (Web Crypto — tanpa jsonwebtoken)
// ─────────────────────────────────────────────
async function signJWT(payload: object, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encode = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return `${signingInput}.${sigB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const signingInput = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(signingInput));
  if (!valid) throw new Error('Invalid signature');

  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}

// ─────────────────────────────────────────────
// PDF Generator — pure JS (tanpa pdfkit)
// Cloudflare Workers tidak support Node.js Buffer/stream
// ─────────────────────────────────────────────
function generateSuratPindahPDF(data: {
  letterNumber: string;
  letterDate: string;
  nama: string;
  alamatAsal?: string;
  alamatBaru?: string;
  lingkunganTujuan?: string;
  stasiTujuan?: string;
  paroki?: string;
  penandatangan?: string;
  perihalSurat?: string;
}): Uint8Array {
  const {
    letterNumber, letterDate, nama,
    alamatAsal = '-', alamatBaru = '-',
    lingkunganTujuan = '-', stasiTujuan = '-',
    paroki = '-', penandatangan = 'Pastor Paroki',
    perihalSurat = '',
  } = data;

  const formattedDate = new Date(letterDate).toLocaleDateString('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  // PDF structure using PDFLib-compatible approach
  // Kita buat PDF minimal yang valid
  const lines: string[] = [
    'GEREJA KATOLIK ST. AGATHA',
    'Paroki Pluit Penjaringan',
    '================================================',
    'SURAT KETERANGAN PINDAH',
    `Nomor: ${letterNumber}`,
    '',
    `Tanggal: ${formattedDate}`,
    perihalSurat ? `Perihal: ${perihalSurat}` : '',
    '',
    'Yang bertanda tangan di bawah ini, Pastor Paroki St. Agatha,',
    'dengan ini menerangkan bahwa:',
    '',
    `Nama              : ${nama}`,
    `Alamat Asal       : ${alamatAsal}`,
    `Alamat Baru       : ${alamatBaru}`,
    `Lingkungan Tujuan : ${lingkunganTujuan}`,
    `Stasi Tujuan      : ${stasiTujuan}`,
    `Paroki            : ${paroki}`,
    '',
    'Demikian surat keterangan ini dibuat dengan sebenarnya',
    'untuk dapat dipergunakan sebagaimana mestinya.',
    '',
    '',
    `Pluit, ${formattedDate}`,
    'Pastor Paroki',
    '',
    '',
    penandatangan,
    'St. Agatha',
  ].filter(l => l !== undefined);

  // Build minimal valid PDF
  const textContent = lines.join('\n');
  const escapedText = textContent.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj

2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj

3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]
/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj

4 0 obj
<< /Length ${escapedText.length + 200} >>
stream
BT
/F1 11 Tf
50 780 Td
12 TL
(${escapedText.split('\n').map(l => l.replace(/[()\\]/g, '\\$&')).join(') Tj T* (')}) Tj
ET
endstream
endobj

5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>
endobj

xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000${(500 + escapedText.length).toString().padStart(6, '0')} 00000 n 

trailer
<< /Size 6 /Root 1 0 R >>
startxref
${600 + escapedText.length}
%%EOF`;

  return new TextEncoder().encode(pdfContent);
}

// ─────────────────────────────────────────────
// Generate Letter Number
// ─────────────────────────────────────────────
async function generateLetterNumber(
  kategoriSurat: string,
  tanggalPermohonan: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
) {
  const date = tanggalPermohonan ? new Date(tanggalPermohonan) : new Date();
  const year = date.getFullYear();
  const monthRoman = ROMAN_MONTHS[date.getMonth()];

  const kodeMap: Record<string, string> = {
    PINDAH: 'PINDAH', pindah: 'PINDAH',
    KETERANGAN: 'KETERANGAN', keterangan: 'KETERANGAN',
  };
  const kodeJenis = kodeMap[kategoriSurat] || kategoriSurat.toUpperCase();

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
// CORS helper
// ─────────────────────────────────────────────
function getAllowedOrigins(env: Env): string[] {
  const origins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://arsip-surat-app.vercel.app',
    'https://portalagatha.com',
    'https://www.portalagatha.com',
  ];
  if (env.CORS_ORIGINS) {
    env.CORS_ORIGINS.split(',').forEach(o => {
      const t = o.trim();
      if (t && !origins.includes(t)) origins.push(t);
    });
  }
  if (env.FRONTEND_URL && !origins.includes(env.FRONTEND_URL.trim())) {
    origins.push(env.FRONTEND_URL.trim());
  }
  if (env.APP_ORIGIN && !origins.includes(env.APP_ORIGIN.trim())) {
    origins.push(env.APP_ORIGIN.trim());
  }
  return origins;
}

// ═════════════════════════════════════════════
// HONO APP
// ═════════════════════════════════════════════
const app = new Hono<{ Bindings: Env }>();

// ─────────────────────────────────────────────
// CORS Middleware
// ─────────────────────────────────────────────
app.use('*', async (c, next) => {
  const allowedOrigins = getAllowedOrigins(c.env);
  const origin = c.req.header('origin') || '';

  const isAllowed =
    !origin ||
    allowedOrigins.includes(origin) ||
    origin.endsWith('.vercel.app');

  const corsOrigin = isAllowed ? (origin || '*') : 'null';

  // Handle preflight
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Expose-Headers': 'X-Letter-Number, X-Archive-Id, Content-Disposition',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  await next();

  c.res.headers.set('Access-Control-Allow-Origin', corsOrigin);
  c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  c.res.headers.set('Access-Control-Expose-Headers', 'X-Letter-Number, X-Archive-Id, Content-Disposition');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
});

// ─────────────────────────────────────────────
// Auth Middleware factory
// ─────────────────────────────────────────────
async function requireAuth(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return c.json({ message: 'Token diperlukan' }, 401);
  }
  const token = authHeader.slice(7);
  try {
    const decoded = await verifyJWT(token, c.env.JWT_SECRET);
    c.set('user', decoded);
  } catch {
    return c.json({ message: 'Token tidak valid atau sudah kadaluarsa' }, 401);
  }
  await next();
}

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
app.get('/api/health', async (c) => {
  const env = c.env;
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      supabase: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      google: !!(env.GOOGLE_PRIVATE_KEY && env.GOOGLE_DRIVE_ROOT_FOLDER_ID),
      jwt: !!env.JWT_SECRET,
    },
  });
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────
app.post('/api/auth/login', async (c) => {
  const env = c.env;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: 'Body JSON tidak valid' }, 400);
  }

  const { username, password } = body;
  if (!username || !password) {
    return c.json({ message: 'Username dan password diperlukan' }, 400);
  }
  if (username !== 'admin' || password !== env.ADMIN_PASSWORD) {
    return c.json({ message: 'Username atau password salah' }, 401);
  }

  const token = await signJWT(
    { username, exp: Math.floor(Date.now() / 1000) + 8 * 3600 },
    env.JWT_SECRET
  );

  return c.json({ token, username });
});

// ─────────────────────────────────────────────
// GET /api/templates
// ─────────────────────────────────────────────
app.get('/api/templates', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return c.json({ message: `Gagal mengambil template: ${error.message}` }, 500);
  return c.json(data);
});

// ─────────────────────────────────────────────
// POST /api/templates (upload file hingga 50MB)
// ─────────────────────────────────────────────
app.post('/api/templates', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Parse multipart form data (Web Standard)
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ message: 'Gagal membaca form data' }, 400);
  }

  const name = (formData.get('name') || formData.get('templateName')) as string;
  const category = formData.get('category') as string;
  const file = formData.get('template') as File | null;

  if (!name || !category) {
    return c.json({ message: 'Field name/templateName dan category diperlukan' }, 400);
  }

  // Validasi ukuran file 50MB
  if (file && file.size > 50 * 1024 * 1024) {
    return c.json({ message: 'Ukuran file melebihi batas 50MB' }, 413);
  }

  let driveFileId: string | null = null;
  let driveWebViewLink: string | null = null;

  if (file && file.size > 0 && env.GOOGLE_DRIVE_ROOT_FOLDER_ID) {
    const creds = resolveGoogleCredentials(env);
    if (creds) {
      try {
        const folderId = extractDriveFolderId(env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
        const fileName = `${Date.now()}_${file.name}`;
        const fileBuffer = await file.arrayBuffer();
        const result = await uploadToDrive(
          fileBuffer,
          fileName,
          file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          folderId,
          creds
        );
        if (result) {
          driveFileId = result.drive_file_id;
          driveWebViewLink = result.drive_web_view_link;
        }
      } catch (driveErr: any) {
        console.error('[Drive] Upload template gagal:', driveErr.message);
      }
    }
  }

  const { data, error } = await supabase
    .from('templates')
    .insert([{ name, category, drive_file_id: driveFileId, drive_web_view_link: driveWebViewLink }])
    .select()
    .single();

  if (error) return c.json({ message: `Gagal menyimpan template: ${error.message}` }, 500);
  return c.json(data, 201);
});

// ─────────────────────────────────────────────
// DELETE /api/templates/:id
// ─────────────────────────────────────────────
app.delete('/api/templates/:id', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const id = c.req.param('id');
  const { data: existing, error: fetchErr } = await supabase
    .from('templates').select('id').eq('id', id).single();

  if (fetchErr || !existing) return c.json({ message: 'Template tidak ditemukan' }, 404);

  const { error } = await supabase.from('templates').delete().eq('id', id);
  if (error) return c.json({ message: `Gagal menghapus template: ${error.message}` }, 500);

  return c.json({ message: 'Template berhasil dihapus' });
});

// ─────────────────────────────────────────────
// GET /api/archives/dashboard
// ─────────────────────────────────────────────
app.get('/api/archives/dashboard', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const month = c.req.query('month');
  const year = c.req.query('year');

  let letterQuery = supabase
    .from('archives').select('id', { count: 'exact', head: true }).not('letter_number', 'is', null);
  let uploadQuery = supabase
    .from('archives').select('id', { count: 'exact', head: true }).not('drive_file_id', 'is', null);

  if (month) {
    letterQuery = letterQuery.eq('archive_month', parseInt(month, 10));
    uploadQuery = uploadQuery.eq('archive_month', parseInt(month, 10));
  }
  if (year) {
    letterQuery = letterQuery.eq('archive_year', parseInt(year, 10));
    uploadQuery = uploadQuery.eq('archive_year', parseInt(year, 10));
  }

  const [{ count: letterCount, error: letterErr }, { count: uploadCount, error: uploadErr }] =
    await Promise.all([letterQuery, uploadQuery]);

  if (letterErr) return c.json({ message: `Gagal menghitung surat: ${letterErr.message}` }, 500);
  if (uploadErr) return c.json({ message: `Gagal menghitung upload: ${uploadErr.message}` }, 500);

  return c.json({ letters: letterCount || 0, uploads: uploadCount || 0 });
});

// ─────────────────────────────────────────────
// GET /api/archives
// ─────────────────────────────────────────────
app.get('/api/archives', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { month, year, jenisArsip, namaArsip } = c.req.query() as Record<string, string>;

  let query = supabase.from('archives').select('*').order('created_at', { ascending: false });

  if (month) query = query.eq('archive_month', parseInt(month, 10));
  if (year) query = query.eq('archive_year', parseInt(year, 10));
  if (jenisArsip) query = query.eq('jenis_arsip', jenisArsip);
  if (namaArsip) query = query.ilike('nama_arsip', `%${namaArsip}%`);

  const { data, error } = await query;
  if (error) return c.json({ message: `Gagal mengambil arsip: ${error.message}` }, 500);

  return c.json(data);
});

// ─────────────────────────────────────────────
// POST /api/archives/take-number
// ─────────────────────────────────────────────
app.post('/api/archives/take-number', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message: 'Body JSON tidak valid' }, 400); }

  const { kategoriSurat, tanggalPermohonan, perihalSurat } = body;
  if (!kategoriSurat) return c.json({ message: 'Field kategoriSurat diperlukan' }, 400);

  const { letterNumber, letterDate, kodeJenis } = await generateLetterNumber(
    kategoriSurat, tanggalPermohonan, supabase
  );

  const date = new Date(letterDate);
  const archiveMonth = date.getMonth() + 1;
  const archiveYear = date.getFullYear();

  const { data, error } = await supabase
    .from('archives')
    .insert([{
      nama_arsip: perihalSurat || `Surat ${kodeJenis} - ${letterNumber}`,
      jenis_arsip: kodeJenis,
      letter_number: letterNumber,
      letter_type: kodeJenis,
      letter_subject: perihalSurat || null,
      request_date: letterDate,
      archive_month: archiveMonth,
      archive_year: archiveYear,
      sync_status: 'local',
    }])
    .select().single();

  if (error) return c.json({ message: `Gagal menyimpan nomor surat: ${error.message}` }, 500);
  return c.json({ letterNumber, letterDate }, 201);
});

// ─────────────────────────────────────────────
// POST /api/archives/manual-upload (file hingga 50MB)
// ─────────────────────────────────────────────
app.post('/api/archives/manual-upload', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ message: 'Gagal membaca form data' }, 400);
  }

  const jenisArsip = formData.get('jenisArsip') as string | null;
  const namaArsip = formData.get('namaArsip') as string | null;
  const archiveMonth = formData.get('archiveMonth') as string | null;
  const archiveYear = formData.get('archiveYear') as string | null;
  const file = formData.get('file') as File | null;

  if (!namaArsip) return c.json({ message: 'Field namaArsip diperlukan' }, 400);

  // Validasi ukuran file 50MB
  if (file && file.size > 50 * 1024 * 1024) {
    return c.json({ message: 'Ukuran file melebihi batas 50MB' }, 413);
  }

  let driveFileId: string | null = null;
  let driveWebViewLink: string | null = null;
  let syncStatus = 'local';

  if (file && file.size > 0 && env.GOOGLE_DRIVE_ROOT_FOLDER_ID) {
    const creds = resolveGoogleCredentials(env);
    if (creds) {
      try {
        const folderId = extractDriveFolderId(env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
        const fileName = `${Date.now()}_${file.name}`;
        const fileBuffer = await file.arrayBuffer();
        const result = await uploadToDrive(
          fileBuffer, fileName,
          file.type || 'application/octet-stream',
          folderId, creds
        );
        if (result) {
          driveFileId = result.drive_file_id;
          driveWebViewLink = result.drive_web_view_link;
          syncStatus = 'synced';
        }
      } catch (driveErr: any) {
        console.error('[Drive] Upload arsip gagal:', driveErr.message);
      }
    }
  }

  const { data, error } = await supabase
    .from('archives')
    .insert([{
      nama_arsip: namaArsip,
      jenis_arsip: jenisArsip || null,
      archive_month: archiveMonth ? parseInt(archiveMonth, 10) : null,
      archive_year: archiveYear ? parseInt(archiveYear, 10) : null,
      sync_status: syncStatus,
      drive_file_id: driveFileId,
      drive_web_view_link: driveWebViewLink,
    }])
    .select().single();

  if (error) return c.json({ message: `Gagal menyimpan arsip: ${error.message}` }, 500);
  return c.json(data, 201);
});

// ─────────────────────────────────────────────
// POST /api/archives/generate-pdf
// ─────────────────────────────────────────────
app.post('/api/archives/generate-pdf', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message: 'Body JSON tidak valid' }, 400); }

  const {
    kategoriSurat, nama, tanggalPermohonan,
    alamatAsal, alamatBaru, lingkunganTujuan,
    stasiTujuan, paroki, penandatangan, perihalSurat,
  } = body;

  if (!kategoriSurat) return c.json({ message: 'Field kategoriSurat diperlukan' }, 400);
  if (!nama) return c.json({ message: 'Field nama diperlukan' }, 400);

  const { letterNumber, letterDate, kodeJenis } = await generateLetterNumber(
    kategoriSurat, tanggalPermohonan, supabase
  );

  const date = new Date(letterDate);
  const archiveMonth = date.getMonth() + 1;
  const archiveYear = date.getFullYear();

  // Simpan ke DB
  const { data: archiveData, error: dbError } = await supabase
    .from('archives')
    .insert([{
      nama_arsip: nama,
      jenis_arsip: kodeJenis,
      letter_number: letterNumber,
      letter_type: kodeJenis,
      letter_subject: perihalSurat || null,
      request_date: letterDate,
      archive_month: archiveMonth,
      archive_year: archiveYear,
      sync_status: 'local',
    }])
    .select().single();

  if (dbError) return c.json({ message: `Gagal menyimpan arsip: ${dbError.message}` }, 500);

  // Generate PDF
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = generateSuratPindahPDF({
      letterNumber, letterDate, nama,
      alamatAsal, alamatBaru, lingkunganTujuan,
      stasiTujuan, paroki, penandatangan, perihalSurat,
    });
  } catch (pdfErr: any) {
    return c.json({ message: `Gagal membuat PDF: ${pdfErr.message}` }, 500);
  }

  // Upload PDF ke Drive
  if (env.GOOGLE_DRIVE_ROOT_FOLDER_ID) {
    const creds = resolveGoogleCredentials(env);
    if (creds) {
      try {
        const folderId = extractDriveFolderId(env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
        const fileName = `${letterNumber.replace(/\//g, '-')}.pdf`;
        const pdfAB: ArrayBuffer = pdfBytes!.buffer.slice(pdfBytes!.byteOffset, pdfBytes!.byteOffset + pdfBytes!.byteLength) as ArrayBuffer;
        const result = await uploadToDrive(pdfAB, fileName, 'application/pdf', folderId, creds);
        if (result) {
          await supabase.from('archives').update({
            drive_file_id: result.drive_file_id,
            drive_web_view_link: result.drive_web_view_link,
            sync_status: 'synced',
          }).eq('id', archiveData.id);
        }
      } catch (driveErr: any) {
        console.error('[Drive] Upload PDF gagal:', driveErr.message);
      }
    }
  }

  const safeLetterNumber = letterNumber.replace(/\//g, '-');
  return new Response(pdfBytes! as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'X-Letter-Number': letterNumber,
      'X-Archive-Id': archiveData.id,
      'Content-Disposition': `attachment; filename="surat-${safeLetterNumber}.pdf"`,
    },
  });
});

// ─────────────────────────────────────────────
// PUT /api/archives/:id
// ─────────────────────────────────────────────
app.put('/api/archives/:id', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const id = c.req.param('id');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message: 'Body JSON tidak valid' }, 400); }

  const { namaArsip, jenisArsip, perihalSurat, tanggalPermohonan } = body;

  const { data: existing, error: fetchErr } = await supabase
    .from('archives').select('id').eq('id', id).single();
  if (fetchErr || !existing) return c.json({ message: 'Arsip tidak ditemukan' }, 404);

  const updateFields: Record<string, any> = {};
  if (namaArsip !== undefined) updateFields.nama_arsip = namaArsip;
  if (jenisArsip !== undefined) updateFields.jenis_arsip = jenisArsip;
  if (perihalSurat !== undefined) updateFields.letter_subject = perihalSurat;
  if (tanggalPermohonan !== undefined) updateFields.request_date = tanggalPermohonan;

  if (Object.keys(updateFields).length === 0) {
    return c.json({ message: 'Tidak ada field yang diperbarui' }, 400);
  }

  const { data, error } = await supabase
    .from('archives').update(updateFields).eq('id', id).select().single();
  if (error) return c.json({ message: `Gagal memperbarui arsip: ${error.message}` }, 500);

  return c.json(data);
});

// ─────────────────────────────────────────────
// DELETE /api/archives/:id
// ─────────────────────────────────────────────
app.delete('/api/archives/:id', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const id = c.req.param('id');
  const { data: existing, error: fetchErr } = await supabase
    .from('archives').select('id').eq('id', id).single();
  if (fetchErr || !existing) return c.json({ message: 'Arsip tidak ditemukan' }, 404);

  const { error } = await supabase.from('archives').delete().eq('id', id);
  if (error) return c.json({ message: `Gagal menghapus arsip: ${error.message}` }, 500);

  return c.json({ message: 'Arsip berhasil dihapus' });
});

// ─────────────────────────────────────────────
// 404 handler
// ─────────────────────────────────────────────
app.notFound((c) => {
  return c.json({ message: `Route ${c.req.method} ${c.req.path} tidak ditemukan` }, 404);
});

// ─────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[Error]', err.message);
  return c.json({ message: err.message || 'Terjadi kesalahan pada server' }, 500);
});

export default app;
