const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

const TMP = '/tmp';
const OUTPUT_DIR = '/tmp/outputs';
const API_KEY = process.env.API_KEY || 'your-secret-key';
const BASE_URL = process.env.BASE_URL || '';

// Create output dir
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Auth Middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/v1/video/file/')) return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  try {
    const v = execSync('ffmpeg -version').toString().split('\n')[0];
    res.json({ status: 'ok', ffmpeg: v });
  } catch (e) {
    res.status(500).json({ status: 'error', ffmpeg: 'not found' });
  }
});

// ─── Serve .mp4 ───────────────────────────────────────────────────
// GET /v1/video/file/output_abc123.mp4
app.get('/v1/video/file/:filename', (req, res) => {
  const { filename } = req.params;
  if (!filename.endsWith('.mp4') || filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.sendFile(filePath);
});

// ─── Download helper ──────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const req = protocol.get(url, (response) => {
      if ([301, 302].includes(response.statusCode)) {
        file.close();
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function cleanup(...files) {
  files.forEach(f => { if (f && fs.existsSync(f)) { try { fs.unlinkSync(f); } catch (_) {} } });
}

function scheduleDelete(filePath, minutes = 30) {
  setTimeout(() => {
    cleanup(filePath);
    console.log(`[Cleanup] Deleted: ${path.basename(filePath)}`);
  }, minutes * 60 * 1000);
}

// ─── POST /v1/video/concatenate ───────────────────────────────────
app.post('/v1/video/concatenate', async (req, res) => {
  const { video_urls } = req.body;
  if (!video_urls || !Array.isArray(video_urls) || video_urls.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 video_urls' });
  }

  const urls = video_urls.map(i => typeof i === 'string' ? i : i.video_url).filter(Boolean);
  const jobId = randomUUID().split('-')[0];
  const tmpFiles = [];
  const listPath = path.join(TMP, `list_${jobId}.txt`);
  const filename = `output_${jobId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  console.log(`[${jobId}] Concat ${urls.length} videos`);

  try {
    // Download all in parallel
    await Promise.all(urls.map((url, i) => {
      const p = path.join(TMP, `input_${jobId}_${i}.mp4`);
      tmpFiles.push(p);
      return downloadFile(url, p).then(() => console.log(`[${jobId}] Downloaded ${i+1}/${urls.length}`));
    }));

    // FFmpeg concat
    fs.writeFileSync(listPath, tmpFiles.map(f => `file '${f}'`).join('\n'));
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}" -y`,
        { timeout: 300000 },
        (err, _, stderr) => err ? reject(new Error(stderr.slice(-500))) : resolve()
      );
    });

    const mb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);

    // Auto-delete after 30 min
    scheduleDelete(outputPath, 30);

    // Build URL
    const host = BASE_URL || `${req.protocol}://${req.get('host')}`;
    const output_url = `${host}/v1/video/file/${filename}`;

    console.log(`[${jobId}] ✓ ${mb}MB → ${output_url}`);

    return res.json({
      status: 'success',
      job_id: jobId,
      output_url,        // ⭐ URL trực tiếp có đuôi .mp4
      filename,
      file_size_mb: parseFloat(mb),
      expires_in: '30 minutes'
    });

  } catch (e) {
    console.error(`[${jobId}]`, e.message);
    return res.status(500).json({ status: 'failed', job_id: jobId, error: e.message });
  } finally {
    cleanup(...tmpFiles, listPath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎬 FFmpeg API :${PORT}`);
  console.log(`   POST /v1/video/concatenate → output_url.mp4`);
  console.log(`   GET  /v1/video/file/:name  → serve mp4`);
});