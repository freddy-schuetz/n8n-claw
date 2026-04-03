const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3200;
const FILES_DIR = process.env.FILES_DIR || '/data/files';
const META_DIR = process.env.META_DIR || '/data/meta';
const TTL_HOURS = parseInt(process.env.UPLOAD_TTL_HOURS || '24', 10);
const MAX_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10) * 1024 * 1024;

// Ensure directories exist
[FILES_DIR, META_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const upload = multer({
  dest: FILES_DIR,
  limits: { fileSize: MAX_SIZE }
});

function generateId() {
  return 'file-' + crypto.randomBytes(8).toString('hex');
}

function metaPath(id) {
  return path.join(META_DIR, id + '.json');
}

function filePath(id) {
  return path.join(FILES_DIR, id);
}

function saveMeta(id, meta) {
  fs.writeFileSync(metaPath(id), JSON.stringify(meta));
}

function loadMeta(id) {
  const p = metaPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function deleteFile(id) {
  const fp = filePath(id);
  const mp = metaPath(id);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  if (fs.existsSync(mp)) fs.unlinkSync(mp);
}

// ── POST /upload — multipart file upload ──────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided. Send as multipart with field name "file".' });
  }

  const id = generateId();
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();

  // Move multer's temp file to our named path
  fs.renameSync(req.file.path, filePath(id));

  const meta = {
    id,
    file_name: req.file.originalname || 'upload',
    mime_type: req.file.mimetype || 'application/octet-stream',
    size_bytes: req.file.size,
    created_at: new Date().toISOString(),
    expires_at: expiresAt
  };
  saveMeta(id, meta);

  res.json(meta);
});

// ── POST /upload/base64 — JSON with base64 content ────────────
app.post('/upload/base64', (req, res) => {
  const { content_base64, file_name, mime_type } = req.body;
  if (!content_base64) {
    return res.status(400).json({ error: 'content_base64 is required.' });
  }

  const buffer = Buffer.from(content_base64, 'base64');
  if (buffer.length > MAX_SIZE) {
    return res.status(413).json({ error: `File too large. Max ${MAX_SIZE / 1024 / 1024} MB.` });
  }

  const id = generateId();
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();

  fs.writeFileSync(filePath(id), buffer);

  const meta = {
    id,
    file_name: file_name || 'upload',
    mime_type: mime_type || 'application/octet-stream',
    size_bytes: buffer.length,
    created_at: new Date().toISOString(),
    expires_at: expiresAt
  };
  saveMeta(id, meta);

  res.json(meta);
});

// ── GET /files/:id — binary download ──────────────────────────
app.get('/files/:id', (req, res) => {
  const meta = loadMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  // Check expiry
  if (new Date(meta.expires_at) < new Date()) {
    deleteFile(req.params.id);
    return res.status(410).json({ error: 'File expired.' });
  }

  const fp = filePath(req.params.id);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File data missing.' });

  res.set('Content-Type', meta.mime_type);
  res.set('Content-Disposition', `attachment; filename="${meta.file_name}"`);
  res.set('Content-Length', meta.size_bytes);
  fs.createReadStream(fp).pipe(res);
});

// ── GET /files/:id/meta — metadata only ───────────────────────
app.get('/files/:id/meta', (req, res) => {
  const meta = loadMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  if (new Date(meta.expires_at) < new Date()) {
    deleteFile(req.params.id);
    return res.status(410).json({ error: 'File expired.' });
  }

  res.json(meta);
});

// ── DELETE /files/:id — explicit delete ───────────────────────
app.delete('/files/:id', (req, res) => {
  const meta = loadMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  deleteFile(req.params.id);
  res.json({ success: true, deleted: req.params.id });
});

// ── DELETE /cleanup — remove all expired files ────────────────
app.delete('/cleanup', (req, res) => {
  const now = new Date();
  let cleaned = 0;

  const metaFiles = fs.readdirSync(META_DIR).filter(f => f.endsWith('.json'));
  for (const f of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8'));
      if (new Date(meta.expires_at) < now) {
        deleteFile(meta.id);
        cleaned++;
      }
    } catch (e) {
      // Corrupted meta file — remove it
      const id = f.replace('.json', '');
      deleteFile(id);
      cleaned++;
    }
  }

  res.json({ success: true, cleaned });
});

// ── POST /files/:id/forward — forward file to external service ─
app.post('/files/:id/forward', async (req, res) => {
  const meta = loadMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  if (new Date(meta.expires_at) < new Date()) {
    deleteFile(req.params.id);
    return res.status(410).json({ error: 'File expired.' });
  }

  const fp = filePath(req.params.id);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File data missing.' });

  const { url, headers, form_fields, filename, file_field, method, raw_body } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required.' });

  const fileBuffer = fs.readFileSync(fp);
  const uploadName = filename || meta.file_name;
  const httpMethod = (method || 'POST').toUpperCase();

  let body;
  let reqHeaders;

  if (raw_body) {
    // Raw mode: send file bytes as-is (for WebDAV PUT, resumable uploads)
    body = fileBuffer;
    reqHeaders = {
      'Content-Type': meta.mime_type,
      'Content-Length': fileBuffer.length,
      ...(headers || {})
    };
  } else {
    // Multipart/form-data mode (default, for Seafile etc.)
    const boundary = '----FileBridge' + crypto.randomBytes(8).toString('hex');
    const fieldName = file_field || 'file';

    const parts = [];
    if (form_fields && typeof form_fields === 'object') {
      for (const [key, val] of Object.entries(form_fields)) {
        parts.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
        );
      }
    }
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${uploadName}"\r\nContent-Type: ${meta.mime_type}\r\n\r\n`
    );

    const header = Buffer.from(parts.join(''), 'latin1');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
    body = Buffer.concat([header, fileBuffer, footer]);
    reqHeaders = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      ...(headers || {})
    };
  }

  try {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const parsed = new URL(url);

    const result = await new Promise((resolve, reject) => {
      const fwdReq = mod.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: httpMethod,
        headers: reqHeaders
      }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: resp.statusCode, body: responseBody });
        });
      });
      fwdReq.on('error', reject);
      fwdReq.write(body);
      fwdReq.end();
    });

    let parsed_body;
    try { parsed_body = JSON.parse(result.body); } catch (e) { parsed_body = result.body; }

    if (result.statusCode >= 400) {
      return res.status(502).json({
        error: 'Remote server returned ' + result.statusCode,
        remote_status: result.statusCode,
        remote_body: parsed_body
      });
    }

    res.json({
      success: true,
      file_id: req.params.id,
      file_name: uploadName,
      size_bytes: fileBuffer.length,
      remote_status: result.statusCode,
      remote_response: parsed_body
    });
  } catch (err) {
    res.status(502).json({ error: 'Forward failed: ' + err.message });
  }
});

// ── GET /health — health check ────────────────────────────────
app.get('/health', (req, res) => {
  const metaFiles = fs.readdirSync(META_DIR).filter(f => f.endsWith('.json'));
  res.json({
    status: 'ok',
    files_stored: metaFiles.length,
    ttl_hours: TTL_HOURS,
    max_size_mb: MAX_SIZE / 1024 / 1024
  });
});

// ── Internal cleanup every 5 minutes ──────────────────────────
setInterval(() => {
  const now = new Date();
  try {
    const metaFiles = fs.readdirSync(META_DIR).filter(f => f.endsWith('.json'));
    for (const f of metaFiles) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8'));
        if (new Date(meta.expires_at) < now) {
          deleteFile(meta.id);
        }
      } catch (e) {
        const id = f.replace('.json', '');
        deleteFile(id);
      }
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`File Bridge running on port ${PORT} (TTL: ${TTL_HOURS}h, max: ${MAX_SIZE / 1024 / 1024}MB)`);
});
