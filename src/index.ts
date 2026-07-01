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
  GOOGLE_DRIVE_ROOT_FOLDER_ID?: string;
  FRONTEND_URL?: string;
  APP_ORIGIN?: string;
  CORS_ORIGINS?: string;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const ROMAN_MONTHS = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];

// ─────────────────────────────────────────────
// Supabase Storage: upload file ke bucket 'arsip-files'
// ─────────────────────────────────────────────
async function uploadToSupabaseStorage(
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
  supabaseUrl: string,
  supabaseKey: string
): Promise<{ file_path: string; public_url: string } | null> {
  try {
    const bucket = 'arsip-files';
    const path = `uploads/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    
    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/${bucket}/${path}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': mimeType,
          'x-upsert': 'true',
        },
        body: fileBuffer,
      }
    );

    if (!uploadRes.ok) {
      const errData = await uploadRes.json() as any;
      console.error('[Storage] Upload gagal:', JSON.stringify(errData));
      return null;
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
    return { file_path: path, public_url: publicUrl };
  } catch (err: any) {
    console.error('[Storage] uploadToSupabaseStorage error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// DOCX Template: replace placeholders in .docx XML
// .docx adalah ZIP yang berisi word/document.xml
// Kita gunakan JSZip-like approach dengan DecompressionStream
// ─────────────────────────────────────────────

/**
 * Pisahkan ZIP entry berdasarkan central directory.
 * Cloudflare Workers mendukung DecompressionStream('deflate-raw').
 */
async function processDocxTemplate(
  docxBuffer: ArrayBuffer,
  placeholders: Record<string, string>
): Promise<ArrayBuffer> {
  // Parse ZIP secara manual — Workers tidak punya JSZip/node:zlib
  const bytes = new Uint8Array(docxBuffer);

  // Temukan End of Central Directory (signature 0x06054B50)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('File bukan format ZIP/DOCX yang valid');

  const view = new DataView(docxBuffer);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdSize   = view.getUint32(eocdOffset + 12, true);
  const numEntries = view.getUint16(eocdOffset + 10, true);

  // Baca seluruh entry dari central directory
  interface ZipEntry {
    name: string;
    compressMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  }
  const entries: ZipEntry[] = [];
  let cdPos = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014B50) break;
    const compressMethod   = view.getUint16(cdPos + 10, true);
    const compressedSize   = view.getUint32(cdPos + 20, true);
    const uncompressedSize = view.getUint32(cdPos + 24, true);
    const nameLen          = view.getUint16(cdPos + 28, true);
    const extraLen         = view.getUint16(cdPos + 30, true);
    const commentLen       = view.getUint16(cdPos + 32, true);
    const localHeaderOffset= view.getUint32(cdPos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cdPos + 46, cdPos + 46 + nameLen));
    entries.push({ name, compressMethod, compressedSize, uncompressedSize, localHeaderOffset });
    cdPos += 46 + nameLen + extraLen + commentLen;
  }

  // Helper: baca data dari local file header
  function getLocalFileData(entry: ZipEntry): Uint8Array {
    const lhOffset = entry.localHeaderOffset;
    if (view.getUint32(lhOffset, true) !== 0x04034B50) throw new Error('Local header tidak valid untuk: ' + entry.name);
    const nameLen  = view.getUint16(lhOffset + 26, true);
    const extraLen = view.getUint16(lhOffset + 28, true);
    const dataStart = lhOffset + 30 + nameLen + extraLen;
    return bytes.slice(dataStart, dataStart + entry.compressedSize);
  }

  // Helper: decompress deflate-raw
  async function decompress(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(data);
    writer.close();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  // Helper: compress deflate-raw
  async function compress(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    writer.write(data);
    writer.close();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  // Baca semua entry, modifikasi word/document.xml jika ditemukan
  interface ProcessedEntry {
    name: string;
    compressMethod: number;
    data: Uint8Array;       // raw (uncompressed) data
    compressed: Uint8Array; // data untuk disimpan
  }
  const processed: ProcessedEntry[] = [];

  for (const entry of entries) {
    const rawData = getLocalFileData(entry);
    let uncompressed: Uint8Array;

    if (entry.compressMethod === 0) {
      uncompressed = rawData;
    } else if (entry.compressMethod === 8) {
      uncompressed = await decompress(rawData);
    } else {
      // Method lain — simpan apa adanya
      processed.push({ name: entry.name, compressMethod: entry.compressMethod, data: rawData, compressed: rawData });
      continue;
    }

    // Modifikasi word/document.xml
    if (entry.name === 'word/document.xml') {
      let xmlText = new TextDecoder('utf-8').decode(uncompressed);
      
      // Replace placeholders — handle kasus dimana placeholder terpecah oleh XML tags
      // Pertama normalkan: gabungkan text runs yang berurutan dalam <w:p>
      // Pendekatan sederhana: replace di raw XML text
      for (const [key, value] of Object.entries(placeholders)) {
        // Escape special XML chars di value
        const safeValue = value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
        
        // Replace {key} — bisa terpecah oleh run boundaries di XML
        // Strategy: replace literal {key} terlebih dulu
        xmlText = xmlText.split(`{${key}}`).join(safeValue);
        
        // Juga handle jika ada spasi atau variasi casing
        xmlText = xmlText.split(`{ ${key} }`).join(safeValue);
      }

      const modifiedBytes = new TextEncoder().encode(xmlText);
      
      // Re-compress dengan deflate-raw
      const recompressed = await compress(modifiedBytes);
      processed.push({ name: entry.name, compressMethod: 8, data: modifiedBytes, compressed: recompressed });
    } else {
      // Entry lain — simpan dengan compress method asli
      if (entry.compressMethod === 8) {
        processed.push({ name: entry.name, compressMethod: 8, data: uncompressed, compressed: rawData });
      } else {
        processed.push({ name: entry.name, compressMethod: 0, data: uncompressed, compressed: uncompressed });
      }
    }
  }

  // Rebuild ZIP
  const enc = new TextEncoder();
  
  function uint16LE(n: number): Uint8Array {
    return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]);
  }
  function uint32LE(n: number): Uint8Array {
    return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]);
  }
  function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const arr of arrays) { result.set(arr, off); off += arr.length; }
    return result;
  }

  // CRC-32 table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const localHeaders: Uint8Array[] = [];
  const centralDirs: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let currentOffset = 0;

  for (const entry of processed) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const compSize   = entry.compressed.length;
    const uncompSize = entry.data.length;
    const method     = entry.compressMethod;

    localOffsets.push(currentOffset);

    // Local file header
    const lh = concat(
      new Uint8Array([0x50, 0x4B, 0x03, 0x04]), // signature
      uint16LE(20),           // version needed
      uint16LE(0),            // general purpose bit flag
      uint16LE(method),       // compression method
      uint16LE(0), uint16LE(0), // last mod time/date (zeroed)
      uint32LE(crc),
      uint32LE(compSize),
      uint32LE(uncompSize),
      uint16LE(nameBytes.length),
      uint16LE(0),            // extra field length
      nameBytes,
      entry.compressed
    );
    localHeaders.push(lh);
    currentOffset += lh.length;

    // Central directory entry
    const cd = concat(
      new Uint8Array([0x50, 0x4B, 0x01, 0x02]), // signature
      uint16LE(20), uint16LE(20),  // version made by / needed
      uint16LE(0),                 // general purpose bit flag
      uint16LE(method),
      uint16LE(0), uint16LE(0),    // last mod time/date
      uint32LE(crc),
      uint32LE(compSize),
      uint32LE(uncompSize),
      uint16LE(nameBytes.length),
      uint16LE(0), uint16LE(0),    // extra / comment length
      uint16LE(0), uint16LE(0),    // disk start / internal attrs
      uint32LE(0),                 // external attrs
      uint32LE(localOffsets[localOffsets.length - 1]),
      nameBytes
    );
    centralDirs.push(cd);
  }

  const cdStartOffset = currentOffset;
  const cdTotal = centralDirs.reduce((s, c) => s + c.length, 0);

  // End of central directory
  const eocd = concat(
    new Uint8Array([0x50, 0x4B, 0x05, 0x06]),
    uint16LE(0), uint16LE(0),
    uint16LE(processed.length), uint16LE(processed.length),
    uint32LE(cdTotal),
    uint32LE(cdStartOffset),
    uint16LE(0)
  );

  const all = concat(...localHeaders, ...centralDirs, eocd);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
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
      storage: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
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
// GET /api/templates/category/:kategori
// Ambil template terbaru untuk kategori tertentu (misal PINDAH)
// ─────────────────────────────────────────────
app.get('/api/templates/category/:kategori', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const kategori = c.req.param('kategori').toUpperCase();

  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('category', kategori)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ message: `Gagal mengambil template: ${error.message}` }, 500);
  if (!data) return c.json({ exists: false, template: null });

  return c.json({ exists: true, template: data });
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

  let storageFilePath: string | null = null;
  let storagePublicUrl: string | null = null;

  if (file && file.size > 0 && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const fileName = `${Date.now()}_${file.name}`;
      const fileBuffer = await file.arrayBuffer();
      const result = await uploadToSupabaseStorage(
        fileBuffer, fileName,
        file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY
      );
      if (result) {
        storageFilePath = result.file_path;
        storagePublicUrl = result.public_url;
      }
    } catch (storageErr: any) {
      console.error('[Storage] Upload template gagal:', storageErr.message);
    }
  }

  const { data, error } = await supabase
    .from('templates')
    .insert([{ name, category, drive_file_id: storageFilePath, drive_web_view_link: storagePublicUrl }])
    .select()
    .single();

  if (error) return c.json({ message: `Gagal menyimpan template: ${error.message}` }, 500);
  return c.json(data, 201);
});

// ─────────────────────────────────────────────
// PUT /api/templates/category/:kategori
// Update/replace template untuk kategori (soft replace — insert baru)
// ─────────────────────────────────────────────
app.put('/api/templates/category/:kategori', requireAuth, async (c) => {
  const env = c.env;
  if (!env.SUPABASE_URL) return c.json({ message: 'Database tidak dikonfigurasi' }, 503);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const kategori = c.req.param('kategori').toUpperCase();

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ message: 'Gagal membaca form data' }, 400);
  }

  const name = (formData.get('name') || formData.get('templateName') || `Template ${kategori} Updated`) as string;
  const file = formData.get('template') as File | null;

  if (!file || file.size === 0) {
    return c.json({ message: 'File template diperlukan' }, 400);
  }
  if (file.size > 50 * 1024 * 1024) {
    return c.json({ message: 'Ukuran file melebihi batas 50MB' }, 413);
  }

  // Upload file baru
  const fileName = `${Date.now()}_${file.name}`;
  const fileBuffer = await file.arrayBuffer();
  const result = await uploadToSupabaseStorage(
    fileBuffer, fileName,
    file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY
  );

  if (!result) {
    return c.json({ message: 'Gagal mengupload file ke storage' }, 500);
  }

  // Hapus template lama kategori ini
  await supabase.from('templates').delete().eq('category', kategori);

  // Insert template baru
  const { data, error } = await supabase
    .from('templates')
    .insert([{
      name,
      category: kategori,
      drive_file_id: result.file_path,
      drive_web_view_link: result.public_url,
    }])
    .select()
    .single();

  if (error) return c.json({ message: `Gagal menyimpan template: ${error.message}` }, 500);
  return c.json(data, 200);
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
  return c.json({ letterNumber, letterDate, id: data.id }, 200);
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

  if (file && file.size > 0 && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const fileName = `${Date.now()}_${file.name}`;
      const fileBuffer = await file.arrayBuffer();
      const result = await uploadToSupabaseStorage(
        fileBuffer, fileName,
        file.type || 'application/octet-stream',
        env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY
      );
      if (result) {
        driveFileId = result.file_path;
        driveWebViewLink = result.public_url;
        syncStatus = 'synced';
      }
    } catch (storageErr: any) {
      console.error('[Storage] Upload arsip gagal:', storageErr.message);
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
// Generate surat dari template DOCX — replace placeholders
// Return: file .docx dengan placeholder sudah diganti
// CATATAN: Cloudflare Workers tidak mendukung LibreOffice/PDF conversion
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

  // ── VALIDASI: Cek apakah template PINDAH sudah ada ──
  const kodeMap: Record<string, string> = {
    PINDAH: 'PINDAH', pindah: 'PINDAH',
    KETERANGAN: 'KETERANGAN', keterangan: 'KETERANGAN',
  };
  const kodeJenis = kodeMap[kategoriSurat] || kategoriSurat.toUpperCase();

  const { data: templateData, error: templateErr } = await supabase
    .from('templates')
    .select('*')
    .eq('category', kodeJenis)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (templateErr) {
    return c.json({ message: `Gagal memeriksa template: ${templateErr.message}` }, 500);
  }

  if (!templateData || !templateData.drive_file_id) {
    return c.json({
      message: `Template ${kodeJenis} belum diupload. Silakan upload template DOCX terlebih dahulu di menu Template DOCX.`,
      code: 'TEMPLATE_NOT_FOUND',
    }, 400);
  }

  // Generate letter number
  const { letterNumber, letterDate } = await generateLetterNumber(
    kategoriSurat, tanggalPermohonan, supabase
  );

  const date = new Date(letterDate);
  const archiveMonth = date.getMonth() + 1;
  const archiveYear = date.getFullYear();

  const formattedDate = date.toLocaleDateString('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  // ── Simpan ke DB dulu ──
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

  // ── Download template DOCX dari Supabase Storage ──
  const templateUrl = templateData.drive_web_view_link;
  let docxBuffer: ArrayBuffer;
  try {
    const templateRes = await fetch(templateUrl);
    if (!templateRes.ok) {
      throw new Error(`Gagal mengunduh template (${templateRes.status})`);
    }
    docxBuffer = await templateRes.arrayBuffer();
  } catch (fetchErr: any) {
    return c.json({ message: `Gagal mengunduh template: ${fetchErr.message}` }, 500);
  }

  // ── Replace placeholders di .docx ──
  const placeholders: Record<string, string> = {
    nama:              nama || '',
    alamatAsal:        alamatAsal || '-',
    alamatBaru:        alamatBaru || '-',
    nomorSurat:        letterNumber,
    tanggalSurat:      formattedDate,
    lingkunganTujuan:  lingkunganTujuan || '-',
    stasiTujuan:       stasiTujuan || '-',
    paroki:            paroki || '-',
    penandatangan:     penandatangan || 'Ketua Lingkungan',
    perihalSurat:      perihalSurat || 'Surat Pindah',
    // Variasi nama placeholder yang mungkin dipakai di template
    'Nama':            nama || '',
    'AlamatAsal':      alamatAsal || '-',
    'AlamatBaru':      alamatBaru || '-',
    'NomorSurat':      letterNumber,
    'TanggalSurat':    formattedDate,
    'LingkunganTujuan': lingkunganTujuan || '-',
    'StasiTujuan':     stasiTujuan || '-',
    'Paroki':          paroki || '-',
    'Penandatangan':   penandatangan || 'Ketua Lingkungan',
    'PerihalSurat':    perihalSurat || 'Surat Pindah',
    // Nomor & Tanggal (alt)
    'nomor':           letterNumber,
    'tanggal':         formattedDate,
    'Nomor':           letterNumber,
    'Tanggal':         formattedDate,
  };

  let resultBuffer: ArrayBuffer;
  try {
    resultBuffer = await processDocxTemplate(docxBuffer, placeholders);
  } catch (docxErr: any) {
    console.error('[DOCX] Processing error:', docxErr.message);
    return c.json({ message: `Gagal memproses template: ${docxErr.message}` }, 500);
  }

  // ── Upload hasil .docx ke Supabase Storage ──
  const safeLetterNumber = letterNumber.replace(/\//g, '-');
  const outputFileName = `surat-${safeLetterNumber}.docx`;

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const result = await uploadToSupabaseStorage(
        resultBuffer,
        outputFileName,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_ROLE_KEY
      );
      if (result) {
        await supabase.from('archives').update({
          drive_file_id: result.file_path,
          drive_web_view_link: result.public_url,
          sync_status: 'synced',
        }).eq('id', archiveData.id);
      }
    } catch (storageErr: any) {
      console.error('[Storage] Upload docx gagal:', storageErr.message);
    }
  }

  // ── Return file sebagai download ──
  return new Response(resultBuffer as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'X-Letter-Number': letterNumber,
      'X-Archive-Id': archiveData.id,
      'Content-Disposition': `attachment; filename="${outputFileName}"`,
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
