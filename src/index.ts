/**
 * Backend Arsip Surat St. Agatha
 * Cloudflare Workers — Hono Framework
 */

import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
interface Env {
  JWT_SECRET: string;
  ADMIN_PASSWORD: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_CLIENT_EMAIL?: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID?: string;
  FRONTEND_URL?: string;
  APP_ORIGIN?: string;
  CORS_ORIGINS?: string;
}

const ROMAN_MONTHS = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];

// ─────────────────────────────────────────────
// Supabase Storage
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
    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      body: fileBuffer,
    });
    if (!uploadRes.ok) {
      const errData = await uploadRes.json() as any;
      console.error('[Storage] Upload gagal:', JSON.stringify(errData));
      return null;
    }
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
    return { file_path: path, public_url: publicUrl };
  } catch (err: any) {
    console.error('[Storage] error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// PDF Generator — proper layout surat resmi
// Menggunakan PDF 1.4 spec dengan font Helvetica (Type1 built-in, no embed needed)
// ─────────────────────────────────────────────

interface PdfPage {
  objects: string[];
  contentStream: string;
}

function buildPdf(lines: Array<{ text: string; fontSize?: number; bold?: boolean; center?: boolean; indent?: number }>): Uint8Array {
  // A4: 595 x 842 pt, margins: left=72, right=72, top=72, bottom=72
  const pageW = 595;
  const pageH = 842;
  const marginL = 72;
  const marginR = 72;
  const marginT = 72;
  const usableW = pageW - marginL - marginR;

  // Helvetica characters are approximately 0.6 * fontSize wide on average
  // For wrapping: use conservative 0.55
  function charWidth(ch: string, fs: number): number {
    // Very rough but good enough for Helvetica
    return fs * 0.55;
  }
  function textWidth(text: string, fs: number): number {
    return text.split('').reduce((s, c) => s + charWidth(c, fs), 0);
  }

  // Word-wrap a line to fit usableW
  function wrapLine(text: string, fontSize: number, maxW: number): string[] {
    if (textWidth(text, fontSize) <= maxW) return [text];
    const words = text.split(' ');
    const wrapped: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (textWidth(candidate, fontSize) <= maxW) {
        current = candidate;
      } else {
        if (current) wrapped.push(current);
        current = word;
      }
    }
    if (current) wrapped.push(current);
    return wrapped.length ? wrapped : [text];
  }

  // Escape PDF string special chars
  function esc(s: string): string {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      // Replace non-latin1 chars with '?'
      .replace(/[^\x00-\xFF]/g, '?');
  }

  // Build content stream
  let stream = '';
  let yPos = pageH - marginT;

  for (const line of lines) {
    const fs = line.fontSize ?? 11;
    const lineH = fs * 1.4;
    const fontName = line.bold ? 'F2' : 'F1';
    const indent = line.indent ?? 0;
    const maxW = usableW - indent;

    const subLines = wrapLine(line.text, fs, maxW);
    for (const sub of subLines) {
      if (yPos < 72) break; // safety: stop at bottom margin
      let xPos = marginL + indent;
      if (line.center) xPos = (pageW - textWidth(sub, fs)) / 2;

      stream += `BT\n/${fontName} ${fs} Tf\n${xPos.toFixed(2)} ${yPos.toFixed(2)} Td\n(${esc(sub)}) Tj\nET\n`;
      yPos -= lineH;
    }
  }

  // Draw horizontal line helper
  // Thin line after header
  stream += `0.5 w\n${marginL} ${yPos + 4} m\n${pageW - marginR} ${yPos + 4} l\nS\n`;

  // PDF object assembly
  const objects: string[] = [];
  const offsets: number[] = [];

  function addObj(content: string): number {
    const idx = objects.length + 1;
    objects.push(content);
    return idx;
  }

  // We'll track byte offsets manually
  // obj 1: Catalog
  // obj 2: Pages
  // obj 3: Page
  // obj 4: Content stream
  // obj 5: Font Helvetica normal
  // obj 6: Font Helvetica bold

  const streamBytes = new TextEncoder().encode(stream);
  const streamLen = streamBytes.length;

  const obj1 = `<< /Type /Catalog /Pages 2 0 R >>`;
  const obj2 = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const obj3 = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`;
  const obj4 = `<< /Length ${streamLen} >>\nstream\n${stream}\nendstream`;
  const obj5 = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  const obj6 = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;

  const allObjs = [obj1, obj2, obj3, obj4, obj5, obj6];

  let pdfStr = `%PDF-1.4\n`;
  const objOffsets: number[] = [];

  for (let i = 0; i < allObjs.length; i++) {
    objOffsets.push(new TextEncoder().encode(pdfStr).length);
    pdfStr += `${i + 1} 0 obj\n${allObjs[i]}\nendobj\n\n`;
  }

  const xrefOffset = new TextEncoder().encode(pdfStr).length;
  pdfStr += `xref\n0 ${allObjs.length + 1}\n0000000000 65535 f \n`;
  for (const off of objOffsets) {
    pdfStr += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdfStr += `trailer\n<< /Size ${allObjs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(pdfStr);
}

/**
 * Generate Surat Pindah PDF
 * Layout: kop surat, garis, nomor, tanggal, isi surat, tanda tangan
 */
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
    paroki = '-', penandatangan = 'Ketua Lingkungan',
    perihalSurat = 'Surat Pindah',
  } = data;

  const formattedDate = (() => {
    try {
      return new Date(letterDate).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch {
      return letterDate;
    }
  })();

  const lines: Array<{ text: string; fontSize?: number; bold?: boolean; center?: boolean; indent?: number }> = [
    // KOP SURAT
    { text: 'GEREJA KATOLIK', fontSize: 13, bold: true, center: true },
    { text: 'PAROKI SANTO AGATHA', fontSize: 14, bold: true, center: true },
    { text: 'Padang Bulan, Medan', fontSize: 10, center: true },
    { text: ' ', fontSize: 6 },

    // Garis akan digambar oleh PDF builder setelah loop — titik pisah dikirim via text kosong
    { text: ' ', fontSize: 4 },

    // Judul
    { text: 'SURAT KETERANGAN PINDAH', fontSize: 13, bold: true, center: true },
    { text: ' ', fontSize: 6 },

    // Nomor & Perihal
    { text: `Nomor     : ${letterNumber}`, fontSize: 11 },
    { text: `Perihal   : ${perihalSurat}`, fontSize: 11 },
    { text: `Tanggal   : ${formattedDate}`, fontSize: 11 },
    { text: ' ', fontSize: 8 },

    // Isi
    { text: 'Yang bertanda tangan di bawah ini, Ketua Lingkungan / Paroki Santo Agatha,', fontSize: 11 },
    { text: 'dengan ini menerangkan bahwa umat tersebut di bawah ini:', fontSize: 11 },
    { text: ' ', fontSize: 8 },

    // Data umat
    { text: `Nama              : ${nama}`, fontSize: 11, indent: 10 },
    { text: `Alamat Asal       : ${alamatAsal}`, fontSize: 11, indent: 10 },
    { text: `Alamat Baru       : ${alamatBaru}`, fontSize: 11, indent: 10 },
    { text: `Lingkungan Tujuan : ${lingkunganTujuan}`, fontSize: 11, indent: 10 },
    { text: `Stasi Tujuan      : ${stasiTujuan}`, fontSize: 11, indent: 10 },
    { text: `Paroki Tujuan     : ${paroki}`, fontSize: 11, indent: 10 },
    { text: ' ', fontSize: 8 },

    // Penutup
    { text: 'telah pindah dari wilayah Paroki Santo Agatha ke lingkungan/paroki tersebut di atas.', fontSize: 11 },
    { text: ' ', fontSize: 5 },
    { text: 'Demikian surat keterangan pindah ini dibuat dengan sebenarnya untuk', fontSize: 11 },
    { text: 'dapat dipergunakan sebagaimana mestinya.', fontSize: 11 },
    { text: ' ', fontSize: 18 },

    // Tanda tangan
    { text: `Medan, ${formattedDate}`, fontSize: 11 },
    { text: penandatangan, fontSize: 11, bold: true },
    { text: ' ', fontSize: 36 },
    { text: '( ___________________________ )', fontSize: 11 },
    { text: penandatangan, fontSize: 11 },
  ];

  return buildPdf(lines);
}

// ─────────────────────────────────────────────
// DOCX Template: replace placeholders
// Menangani kasus placeholder yang terpecah oleh XML run tags
// ─────────────────────────────────────────────
async function processDocxTemplate(
  docxBuffer: ArrayBuffer,
  placeholders: Record<string, string>
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(docxBuffer);

  // Temukan End of Central Directory
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
      eocdOffset = i; break;
    }
  }
  if (eocdOffset < 0) throw new Error('File bukan format ZIP/DOCX yang valid');

  const view = new DataView(docxBuffer);
  const cdOffset   = view.getUint32(eocdOffset + 16, true);
  const numEntries = view.getUint16(eocdOffset + 10, true);

  interface ZipEntry {
    name: string; compressMethod: number;
    compressedSize: number; uncompressedSize: number; localHeaderOffset: number;
  }
  const entries: ZipEntry[] = [];
  let cdPos = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014B50) break;
    const compressMethod    = view.getUint16(cdPos + 10, true);
    const compressedSize    = view.getUint32(cdPos + 20, true);
    const uncompressedSize  = view.getUint32(cdPos + 24, true);
    const nameLen           = view.getUint16(cdPos + 28, true);
    const extraLen          = view.getUint16(cdPos + 30, true);
    const commentLen        = view.getUint16(cdPos + 32, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cdPos + 46, cdPos + 46 + nameLen));
    entries.push({ name, compressMethod, compressedSize, uncompressedSize, localHeaderOffset });
    cdPos += 46 + nameLen + extraLen + commentLen;
  }

  function getLocalFileData(entry: ZipEntry): Uint8Array {
    const lhOffset = entry.localHeaderOffset;
    const nameLen  = view.getUint16(lhOffset + 26, true);
    const extraLen = view.getUint16(lhOffset + 28, true);
    const dataStart = lhOffset + 30 + nameLen + extraLen;
    return bytes.slice(dataStart, dataStart + entry.compressedSize);
  }

  async function decompress(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter(); const r = ds.readable.getReader();
    w.write(data as unknown as ArrayBuffer); w.close();
    const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value!); }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  async function compress(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter(); const r = cs.readable.getReader();
    w.write(data as unknown as ArrayBuffer); w.close();
    const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value!); }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  /**
   * Fix utama: placeholder di DOCX XML sering terpecah menjadi beberapa <w:r> run.
   * Contoh: {alamatBaru} bisa jadi:
   *   <w:r><w:t>{alamat</w:t></w:r><w:r><w:t>Baru}</w:t></w:r>
   *
   * Strategi:
   * 1. Gabungkan teks dalam setiap <w:p> paragraph menjadi 1 string bersih
   * 2. Replace placeholder di string bersih
   * 3. Tulis kembali ke dalam XML dengan 1 run per placeholder
   *
   * Tapi approach ini butuh XML parser. Pendekatan lebih sederhana dan reliable:
   * Normalisasi XML dulu: gabungkan semua <w:t> yang bersebelahan dalam 1 paragraph,
   * lalu replace.
   */
  function normalizeAndReplacePlaceholders(xml: string, ph: Record<string, string>): string {
    // Step 1: Escape values
    const escapedPh: Record<string, string> = {};
    for (const [k, v] of Object.entries(ph)) {
      escapedPh[k] = v
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Step 2: Untuk setiap <w:p>...</w:p>, ekstrak semua teks dari <w:t>,
    // gabungkan, replace placeholder, lalu rebuild paragraph.
    // Kita gunakan regex sederhana yang cukup untuk dokumen Word standard.
    
    // Pertama: coba replace langsung (untuk template yang placeholder-nya tidak terpecah)
    let result = xml;
    for (const [k, v] of Object.entries(escapedPh)) {
      // Semua variasi penulisan: {key}, { key }, {Key}, dll.
      result = result.split(`{${k}}`).join(v);
      result = result.split(`{ ${k} }`).join(v);
      // Case insensitive: {ALAMATBARU}, {alamatbaru}
      const lk = k.toLowerCase();
      const uk = k.toUpperCase();
      if (lk !== k) result = result.split(`{${lk}}`).join(v);
      if (uk !== k) result = result.split(`{${uk}}`).join(v);
    }

    // Step 3: Handle terpecah — cari pola {... yang belum tertutup dalam 1 run
    // Regex: cari semua text content dalam paragraph, gabungkan, replace, masukkan kembali
    result = result.replace(/<w:p[ >][^]*?<\/w:p>/g, (paragraph) => {
      // Ekstrak semua teks di dalam <w:t>...</w:t>
      const textMatches = [...paragraph.matchAll(/<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g)];
      if (textMatches.length === 0) return paragraph;

      // Gabungkan semua teks dari runs dalam paragraf ini
      const combined = textMatches.map(m => m[1]).join('');

      // Cek apakah ada placeholder yang masih belum tereplace
      let hasUnreplaced = false;
      for (const k of Object.keys(escapedPh)) {
        if (combined.includes(`{${k}`) || combined.includes(`{${k.toLowerCase()}`) || combined.includes(`{${k.toUpperCase()}`)) {
          hasUnreplaced = true; break;
        }
      }
      // Juga cek pola { atau } yang masih ada (tanda placeholder terpecah)
      if (!hasUnreplaced && !/{[a-zA-Z]/.test(combined)) return paragraph;

      // Replace di combined text
      let fixedCombined = combined;
      for (const [k, v] of Object.entries(escapedPh)) {
        fixedCombined = fixedCombined.split(`{${k}}`).join(v);
        fixedCombined = fixedCombined.split(`{${k.toLowerCase()}}`).join(v);
        fixedCombined = fixedCombined.split(`{${k.toUpperCase()}}`).join(v);
        fixedCombined = fixedCombined.split(`{ ${k} }`).join(v);
      }

      if (fixedCombined === combined) return paragraph; // tidak ada perubahan

      // Tulis kembali: ambil run pertama, hapus semua <w:t> lama, ganti dengan 1 <w:t>
      // Pertahankan formatting (<w:rPr>) dari run pertama
      const firstRunMatch = paragraph.match(/<w:r[ >][^]*?<\/w:r>/);
      if (!firstRunMatch) return paragraph;

      const firstRun = firstRunMatch[0];
      // Ekstrak w:rPr jika ada
      const rPrMatch = firstRun.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
      const rPr = rPrMatch ? rPrMatch[0] : '';

      // Rebuild paragraph: ambil semua yang bukan w:r, tambahkan 1 w:r baru
      // Hapus semua w:r dari paragraph, tambah run baru dengan teks yg sudah direplace
      const paraWithoutRuns = paragraph.replace(/<w:r[ >][^]*?<\/w:r>/g, '');
      // Sisipkan run baru sebelum </w:p>
      const newRun = `<w:r>${rPr}<w:t xml:space="preserve">${fixedCombined}</w:t></w:r>`;
      return paraWithoutRuns.replace(/<\/w:p>/, newRun + '</w:p>');
    });

    return result;
  }

  interface ProcessedEntry {
    name: string; compressMethod: number;
    data: Uint8Array; compressed: Uint8Array;
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
      processed.push({ name: entry.name, compressMethod: entry.compressMethod, data: rawData, compressed: rawData });
      continue;
    }

    // Modifikasi semua XML files yang mungkin berisi konten teks
    const isXmlContent = entry.name === 'word/document.xml' ||
                         entry.name === 'word/header1.xml' ||
                         entry.name === 'word/header2.xml' ||
                         entry.name === 'word/footer1.xml' ||
                         entry.name === 'word/footer2.xml';

    if (isXmlContent) {
      let xmlText = new TextDecoder('utf-8').decode(uncompressed);
      xmlText = normalizeAndReplacePlaceholders(xmlText, placeholders);
      const modifiedBytes = new TextEncoder().encode(xmlText);
      const recompressed = await compress(modifiedBytes);
      processed.push({ name: entry.name, compressMethod: 8, data: modifiedBytes, compressed: recompressed });
    } else {
      if (entry.compressMethod === 8) {
        processed.push({ name: entry.name, compressMethod: 8, data: uncompressed, compressed: rawData });
      } else {
        processed.push({ name: entry.name, compressMethod: 0, data: uncompressed, compressed: uncompressed });
      }
    }
  }

  // Rebuild ZIP
  const enc = new TextEncoder();
  function uint16LE(n: number) { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]); }
  function uint32LE(n: number) { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]); }
  function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

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
    const compSize = entry.compressed.length;
    const uncompSize = entry.data.length;
    const method = entry.compressMethod;
    localOffsets.push(currentOffset);

    const lh = concat(
      new Uint8Array([0x50, 0x4B, 0x03, 0x04]),
      uint16LE(20), uint16LE(0), uint16LE(method),
      uint16LE(0), uint16LE(0),
      uint32LE(crc), uint32LE(compSize), uint32LE(uncompSize),
      uint16LE(nameBytes.length), uint16LE(0),
      nameBytes, entry.compressed
    );
    localHeaders.push(lh);
    currentOffset += lh.length;

    const cd = concat(
      new Uint8Array([0x50, 0x4B, 0x01, 0x02]),
      uint16LE(20), uint16LE(20), uint16LE(0), uint16LE(method),
      uint16LE(0), uint16LE(0),
      uint32LE(crc), uint32LE(compSize), uint32LE(uncompSize),
      uint16LE(nameBytes.length), uint16LE(0), uint16LE(0),
      uint16LE(0), uint16LE(0), uint32LE(0),
      uint32LE(localOffsets[localOffsets.length - 1]),
      nameBytes
    );
    centralDirs.push(cd);
  }

  const cdStartOffset = currentOffset;
  const cdTotal = centralDirs.reduce((s, c) => s + c.length, 0);
  const eocdBytes = concat(
    new Uint8Array([0x50, 0x4B, 0x05, 0x06]),
    uint16LE(0), uint16LE(0),
    uint16LE(processed.length), uint16LE(processed.length),
    uint32LE(cdTotal), uint32LE(cdStartOffset), uint16LE(0)
  );

  const all = concat(...localHeaders, ...centralDirs, eocdBytes);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

// ─────────────────────────────────────────────
// JWT Helpers
// ─────────────────────────────────────────────
async function signJWT(payload: object, secret: string): Promise<string> {
  const encode = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const h = encode({ alg:'HS256', typ:'JWT' });
  const p = encode(payload);
  const si = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(si));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return `${si}.${s}`;
}

async function verifyJWT(token: string, secret: string): Promise<any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const si = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(si));
  if (!valid) throw new Error('Invalid signature');
  const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

// ─────────────────────────────────────────────
// Generate Letter Number
// ─────────────────────────────────────────────
async function generateLetterNumber(kategoriSurat: string, tanggalPermohonan: string | undefined, supabase: any) {
  const date = tanggalPermohonan ? new Date(tanggalPermohonan) : new Date();
  const year = date.getFullYear();
  const monthRoman = ROMAN_MONTHS[date.getMonth()];
  const kodeMap: Record<string, string> = {
    PINDAH:'PINDAH', pindah:'PINDAH', KETERANGAN:'KETERANGAN', keterangan:'KETERANGAN',
  };
  const kodeJenis = kodeMap[kategoriSurat] || kategoriSurat.toUpperCase();
  const { count, error } = await supabase
    .from('archives').select('id', { count:'exact', head:true })
    .eq('letter_type', kodeJenis)
    .gte('created_at', `${year}-01-01T00:00:00.000Z`)
    .lt('created_at', `${year+1}-01-01T00:00:00.000Z`);
  if (error) throw new Error(`Gagal menghitung nomor urut: ${error.message}`);
  const nomorUrut = String((count || 0) + 1).padStart(3, '0');
  return { letterNumber:`${nomorUrut}/${kodeJenis}/SA-PB/${monthRoman}/${year}`, letterDate:date.toISOString(), kodeJenis };
}

// ─────────────────────────────────────────────
// CORS helper
// ─────────────────────────────────────────────
function getAllowedOrigins(env: Env): string[] {
  const origins = [
    'http://localhost:3000','http://localhost:5173',
    'https://arsip-surat-app.vercel.app',
    'https://portalagatha.com','https://www.portalagatha.com',
  ];
  if (env.CORS_ORIGINS) env.CORS_ORIGINS.split(',').forEach(o => { const t=o.trim(); if(t && !origins.includes(t)) origins.push(t); });
  if (env.FRONTEND_URL && !origins.includes(env.FRONTEND_URL.trim())) origins.push(env.FRONTEND_URL.trim());
  if (env.APP_ORIGIN && !origins.includes(env.APP_ORIGIN.trim())) origins.push(env.APP_ORIGIN.trim());
  return origins;
}

// ═════════════════════════════════════════════
// HONO APP
// ═════════════════════════════════════════════
const app = new Hono<{ Bindings: Env }>();

// CORS Middleware
app.use('*', async (c, next) => {
  const allowedOrigins = getAllowedOrigins(c.env);
  const origin = c.req.header('origin') || '';
  const isAllowed = !origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app');
  const corsOrigin = isAllowed ? (origin || '*') : 'null';

  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'X-Letter-Number, X-Archive-Id, Content-Disposition',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    }});
  }
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', corsOrigin);
  c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  c.res.headers.set('Access-Control-Expose-Headers', 'X-Letter-Number, X-Archive-Id, Content-Disposition');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
});

// Auth Middleware
async function requireAuth(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return c.json({ message: 'Token diperlukan' }, 401);
  try {
    const decoded = await verifyJWT(authHeader.slice(7), c.env.JWT_SECRET);
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
  return c.json({ status:'ok', timestamp:new Date().toISOString(), env:{
    supabase:!!(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY),
    storage:!!(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY),
    jwt:!!c.env.JWT_SECRET,
  }});
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────
app.post('/api/auth/login', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }
  const { username, password } = body;
  if (!username || !password) return c.json({ message:'Username dan password diperlukan' }, 400);
  if (username !== 'admin' || password !== c.env.ADMIN_PASSWORD) return c.json({ message:'Username atau password salah' }, 401);
  const token = await signJWT({ username, exp: Math.floor(Date.now()/1000) + 8*3600 }, c.env.JWT_SECRET);
  return c.json({ token, username });
});

// ─────────────────────────────────────────────
// GET /api/templates
// ─────────────────────────────────────────────
app.get('/api/templates', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const { data, error } = await supabase.from('templates').select('*').order('created_at', { ascending:false });
  if (error) return c.json({ message:`Gagal mengambil template: ${error.message}` }, 500);
  return c.json(data);
});

// ─────────────────────────────────────────────
// GET /api/templates/category/:kategori
// ─────────────────────────────────────────────
app.get('/api/templates/category/:kategori', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const kategori = c.req.param('kategori').toUpperCase();
  const { data, error } = await supabase.from('templates').select('*').eq('category', kategori)
    .order('created_at', { ascending:false }).limit(1).maybeSingle();
  if (error) return c.json({ message:`Gagal mengambil template: ${error.message}` }, 500);
  if (!data) return c.json({ exists:false, template:null });
  return c.json({ exists:true, template:data });
});

// ─────────────────────────────────────────────
// POST /api/templates
// ─────────────────────────────────────────────
app.post('/api/templates', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

  let formData: FormData;
  try { formData = await c.req.formData(); } catch { return c.json({ message:'Gagal membaca form data' }, 400); }

  const name = (formData.get('name') || formData.get('templateName')) as string;
  const category = formData.get('category') as string;
  const file = formData.get('template') as File | null;

  if (!name || !category) return c.json({ message:'Field name dan category diperlukan' }, 400);
  if (file && file.size > 50*1024*1024) return c.json({ message:'Ukuran file melebihi batas 50MB' }, 413);

  let storageFilePath: string | null = null;
  let storagePublicUrl: string | null = null;
  if (file && file.size > 0) {
    const result = await uploadToSupabaseStorage(
      await file.arrayBuffer(), `${Date.now()}_${file.name}`,
      file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
    );
    if (result) { storageFilePath = result.file_path; storagePublicUrl = result.public_url; }
  }

  const { data, error } = await supabase.from('templates')
    .insert([{ name, category, drive_file_id:storageFilePath, drive_web_view_link:storagePublicUrl }])
    .select().single();
  if (error) return c.json({ message:`Gagal menyimpan template: ${error.message}` }, 500);
  return c.json(data, 201);
});

// ─────────────────────────────────────────────
// PUT /api/templates/category/:kategori
// ─────────────────────────────────────────────
app.put('/api/templates/category/:kategori', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const kategori = c.req.param('kategori').toUpperCase();

  let formData: FormData;
  try { formData = await c.req.formData(); } catch { return c.json({ message:'Gagal membaca form data' }, 400); }

  const name = (formData.get('name') || formData.get('templateName') || `Template ${kategori} Updated`) as string;
  const file = formData.get('template') as File | null;
  if (!file || file.size === 0) return c.json({ message:'File template diperlukan' }, 400);
  if (file.size > 50*1024*1024) return c.json({ message:'Ukuran file melebihi batas 50MB' }, 413);

  const result = await uploadToSupabaseStorage(
    await file.arrayBuffer(), `${Date.now()}_${file.name}`,
    file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (!result) return c.json({ message:'Gagal mengupload file ke storage' }, 500);

  await supabase.from('templates').delete().eq('category', kategori);
  const { data, error } = await supabase.from('templates')
    .insert([{ name, category:kategori, drive_file_id:result.file_path, drive_web_view_link:result.public_url }])
    .select().single();
  if (error) return c.json({ message:`Gagal menyimpan template: ${error.message}` }, 500);
  return c.json(data, 200);
});

// ─────────────────────────────────────────────
// DELETE /api/templates/:id
// ─────────────────────────────────────────────
app.delete('/api/templates/:id', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const id = c.req.param('id');
  const { data:existing, error:fetchErr } = await supabase.from('templates').select('id').eq('id',id).single();
  if (fetchErr || !existing) return c.json({ message:'Template tidak ditemukan' }, 404);
  const { error } = await supabase.from('templates').delete().eq('id',id);
  if (error) return c.json({ message:`Gagal menghapus template: ${error.message}` }, 500);
  return c.json({ message:'Template berhasil dihapus' });
});

// ─────────────────────────────────────────────
// GET /api/archives/dashboard
// ─────────────────────────────────────────────
app.get('/api/archives/dashboard', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const month = c.req.query('month');
  const year  = c.req.query('year');

  let lq = supabase.from('archives').select('id', { count:'exact', head:true }).not('letter_number','is',null);
  let uq = supabase.from('archives').select('id', { count:'exact', head:true }).not('drive_file_id','is',null);
  if (month) { lq = lq.eq('archive_month', parseInt(month,10)); uq = uq.eq('archive_month', parseInt(month,10)); }
  if (year)  { lq = lq.eq('archive_year',  parseInt(year,10));  uq = uq.eq('archive_year',  parseInt(year,10)); }

  const [{ count:lc, error:le }, { count:uc, error:ue }] = await Promise.all([lq, uq]);
  if (le) return c.json({ message:`Gagal: ${le.message}` }, 500);
  if (ue) return c.json({ message:`Gagal: ${ue.message}` }, 500);
  return c.json({ letters: lc||0, uploads: uc||0 });
});

// ─────────────────────────────────────────────
// GET /api/archives
// ─────────────────────────────────────────────
app.get('/api/archives', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const { month, year, jenisArsip, namaArsip } = c.req.query() as Record<string,string>;
  let q = supabase.from('archives').select('*').order('created_at', { ascending:false });
  if (month) q = q.eq('archive_month', parseInt(month,10));
  if (year)  q = q.eq('archive_year',  parseInt(year,10));
  if (jenisArsip) q = q.eq('jenis_arsip', jenisArsip);
  if (namaArsip)  q = q.ilike('nama_arsip', `%${namaArsip}%`);
  const { data, error } = await q;
  if (error) return c.json({ message:`Gagal mengambil arsip: ${error.message}` }, 500);
  return c.json(data);
});

// ─────────────────────────────────────────────
// POST /api/archives/take-number
// ─────────────────────────────────────────────
app.post('/api/archives/take-number', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }
  const { kategoriSurat, tanggalPermohonan, perihalSurat } = body;
  if (!kategoriSurat) return c.json({ message:'Field kategoriSurat diperlukan' }, 400);
  const { letterNumber, letterDate, kodeJenis } = await generateLetterNumber(kategoriSurat, tanggalPermohonan, supabase);
  const date = new Date(letterDate);
  const { data, error } = await supabase.from('archives').insert([{
    nama_arsip: perihalSurat || `Surat ${kodeJenis} - ${letterNumber}`,
    jenis_arsip: kodeJenis, letter_number: letterNumber, letter_type: kodeJenis,
    letter_subject: perihalSurat||null, request_date: letterDate,
    archive_month: date.getMonth()+1, archive_year: date.getFullYear(), sync_status:'local',
  }]).select().single();
  if (error) return c.json({ message:`Gagal menyimpan: ${error.message}` }, 500);
  return c.json({ letterNumber, letterDate, id:data.id }, 200);
});

// ─────────────────────────────────────────────
// POST /api/archives/manual-upload
// ─────────────────────────────────────────────
app.post('/api/archives/manual-upload', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  let formData: FormData;
  try { formData = await c.req.formData(); } catch { return c.json({ message:'Gagal membaca form data' }, 400); }

  const jenisArsip   = formData.get('jenisArsip') as string|null;
  const namaArsip    = formData.get('namaArsip')  as string|null;
  const archiveMonth = formData.get('archiveMonth') as string|null;
  const archiveYear  = formData.get('archiveYear')  as string|null;
  const file         = formData.get('file') as File|null;

  if (!namaArsip) return c.json({ message:'Field namaArsip diperlukan' }, 400);
  if (file && file.size > 50*1024*1024) return c.json({ message:'Ukuran file melebihi batas 50MB' }, 413);

  let driveFileId: string|null = null, driveWebViewLink: string|null = null, syncStatus = 'local';
  if (file && file.size > 0) {
    const result = await uploadToSupabaseStorage(
      await file.arrayBuffer(), `${Date.now()}_${file.name}`,
      file.type || 'application/octet-stream',
      c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
    );
    if (result) { driveFileId = result.file_path; driveWebViewLink = result.public_url; syncStatus = 'synced'; }
  }

  const { data, error } = await supabase.from('archives').insert([{
    nama_arsip: namaArsip, jenis_arsip: jenisArsip||null,
    archive_month: archiveMonth ? parseInt(archiveMonth,10) : null,
    archive_year:  archiveYear  ? parseInt(archiveYear,10)  : null,
    sync_status: syncStatus, drive_file_id: driveFileId, drive_web_view_link: driveWebViewLink,
  }]).select().single();
  if (error) return c.json({ message:`Gagal menyimpan arsip: ${error.message}` }, 500);
  return c.json(data, 201);
});

// ─────────────────────────────────────────────
// POST /api/archives/generate-pdf
// Generate surat pindah sebagai PDF
// ─────────────────────────────────────────────
app.post('/api/archives/generate-pdf', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }

  const {
    kategoriSurat, nama, tanggalPermohonan,
    alamatAsal, alamatBaru, lingkunganTujuan,
    stasiTujuan, paroki, penandatangan, perihalSurat,
  } = body;

  if (!kategoriSurat) return c.json({ message:'Field kategoriSurat diperlukan' }, 400);
  if (!nama) return c.json({ message:'Field nama diperlukan' }, 400);

  const kodeMap: Record<string,string> = { PINDAH:'PINDAH', pindah:'PINDAH', KETERANGAN:'KETERANGAN', keterangan:'KETERANGAN' };
  const kodeJenis = kodeMap[kategoriSurat] || kategoriSurat.toUpperCase();

  // ── Validasi template ──
  const { data:templateData, error:templateErr } = await supabase
    .from('templates').select('*').eq('category', kodeJenis)
    .order('created_at', { ascending:false }).limit(1).maybeSingle();
  if (templateErr) return c.json({ message:`Gagal memeriksa template: ${templateErr.message}` }, 500);
  if (!templateData || !templateData.drive_file_id) {
    return c.json({
      message:`Template ${kodeJenis} belum diupload. Silakan upload template DOCX terlebih dahulu di menu Template DOCX.`,
      code:'TEMPLATE_NOT_FOUND',
    }, 400);
  }

  // ── Generate letter number ──
  const { letterNumber, letterDate } = await generateLetterNumber(kategoriSurat, tanggalPermohonan, supabase);
  const date = new Date(letterDate);

  // ── Simpan ke DB ──
  const { data:archiveData, error:dbError } = await supabase.from('archives').insert([{
    nama_arsip: nama, jenis_arsip: kodeJenis,
    letter_number: letterNumber, letter_type: kodeJenis,
    letter_subject: perihalSurat||null, request_date: letterDate,
    archive_month: date.getMonth()+1, archive_year: date.getFullYear(), sync_status:'local',
  }]).select().single();
  if (dbError) return c.json({ message:`Gagal menyimpan arsip: ${dbError.message}` }, 500);

  // ── Generate PDF langsung dari data field ──
  // PDF dihasilkan dari scratch dengan layout surat resmi
  // Semua data field langsung masuk tanpa bergantung pada placeholder di template
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = generateSuratPindahPDF({
      letterNumber, letterDate,
      nama:             nama             || '',
      alamatAsal:       alamatAsal       || '-',
      alamatBaru:       alamatBaru       || '-',
      lingkunganTujuan: lingkunganTujuan || '-',
      stasiTujuan:      stasiTujuan      || '-',
      paroki:           paroki           || '-',
      penandatangan:    penandatangan    || 'Ketua Lingkungan',
      perihalSurat:     perihalSurat     || 'Surat Pindah',
    });
  } catch (pdfErr: any) {
    return c.json({ message:`Gagal membuat PDF: ${pdfErr.message}` }, 500);
  }

  // ── Upload PDF ke Supabase Storage ──
  const safeLetterNumber = letterNumber.replace(/\//g, '-');
  const outputFileName = `surat-${safeLetterNumber}.pdf`;

  const pdfAB = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
  const uploadResult = await uploadToSupabaseStorage(
    pdfAB, outputFileName, 'application/pdf',
    c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (uploadResult) {
    await supabase.from('archives').update({
      drive_file_id: uploadResult.file_path,
      drive_web_view_link: uploadResult.public_url,
      sync_status: 'synced',
    }).eq('id', archiveData.id);
  }

  // ── Return PDF ──
  return new Response(pdfAB as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'X-Letter-Number': letterNumber,
      'X-Archive-Id': archiveData.id,
      'Content-Disposition': `inline; filename="${outputFileName}"`,
    },
  });
});

// ─────────────────────────────────────────────
// PUT /api/archives/:id
// ─────────────────────────────────────────────
app.put('/api/archives/:id', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const id = c.req.param('id');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }
  const { namaArsip, jenisArsip, perihalSurat, tanggalPermohonan } = body;
  const { data:existing, error:fetchErr } = await supabase.from('archives').select('id').eq('id',id).single();
  if (fetchErr || !existing) return c.json({ message:'Arsip tidak ditemukan' }, 404);
  const upd: Record<string,any> = {};
  if (namaArsip !== undefined)         upd.nama_arsip    = namaArsip;
  if (jenisArsip !== undefined)        upd.jenis_arsip   = jenisArsip;
  if (perihalSurat !== undefined)      upd.letter_subject = perihalSurat;
  if (tanggalPermohonan !== undefined) upd.request_date  = tanggalPermohonan;
  if (Object.keys(upd).length === 0) return c.json({ message:'Tidak ada field yang diperbarui' }, 400);
  const { data, error } = await supabase.from('archives').update(upd).eq('id',id).select().single();
  if (error) return c.json({ message:`Gagal memperbarui arsip: ${error.message}` }, 500);
  return c.json(data);
});

// ─────────────────────────────────────────────
// DELETE /api/archives/:id
// ─────────────────────────────────────────────
app.delete('/api/archives/:id', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const id = c.req.param('id');
  const { data:existing, error:fetchErr } = await supabase.from('archives').select('id').eq('id',id).single();
  if (fetchErr || !existing) return c.json({ message:'Arsip tidak ditemukan' }, 404);
  const { error } = await supabase.from('archives').delete().eq('id',id);
  if (error) return c.json({ message:`Gagal menghapus arsip: ${error.message}` }, 500);
  return c.json({ message:'Arsip berhasil dihapus' });
});

app.notFound((c) => c.json({ message:`Route ${c.req.method} ${c.req.path} tidak ditemukan` }, 404));
app.onError((err, c) => { console.error('[Error]', err.message); return c.json({ message:err.message||'Terjadi kesalahan' }, 500); });

export default app;
