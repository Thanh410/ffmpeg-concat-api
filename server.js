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
const API_KEY = process.env.API_KEY || 'your-secret-key';

// ─── Auth Middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized', status: 'failed' });
  }
  next();
});

// ─── Health Check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  try {
    const version = execSync('ffmpeg -version').toString().split('\n')[0];
    res.json({ status: 'ok', ffmpeg: version });
  } catch (e) {
    res.status(500).json({ status: 'error', ffmpeg: 'not found' });
  }
});

// ─── Download helper ──────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    
    const request = protocol.get(url, (response) => {
      // Follow redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${response.statusCode} for ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });

    request.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error(`Download timeout: ${url}`));
    });
  });
}

// ─── Cleanup helper ───────────────────────────────────────────────
function cleanup(...files) {
  files.forEach(f => {
    if (f && fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  });
}

// ─── POST /v1/video/concatenate ───────────────────────────────────
// Body: { "video_urls": [{"video_url": "..."}, {"video_url": "..."}] }
// hoặc: { "video_urls": ["url1", "url2"] }
app.post('/v1/video/concatenate', async (req, res) => {
  const { video_urls } = req.body;

  if (!video_urls || !Array.isArray(video_urls) || video_urls.length < 2) {
    return res.status(400).json({ error: 'video_urls must be array with at least 2 items' });
  }

  // Normalize: support cả [{video_url: "..."}, ...] và ["url1", ...]
  const urls = video_urls.map(item =>
    typeof item === 'string' ? item : item.video_url
  ).filter(Boolean);

  const jobId = randomUUID().split('-')[0];
  const tmpFiles = [];
  const listPath = path.join(TMP, `list_${jobId}.txt`);
  const outputPath = path.join(TMP, `output_${jobId}.mp4`);

  console.log(`[${jobId}] Starting concatenation of ${urls.length} videos`);

  try {
    // Step 1: Download all videos in parallel
    console.log(`[${jobId}] Downloading ${urls.length} videos...`);
    const downloadPromises = urls.map((url, i) => {
      const filePath = path.join(TMP, `input_${jobId}_${i}.mp4`);
      tmpFiles.push(filePath);
      return downloadFile(url, filePath).then(() => {
        console.log(`[${jobId}] ✓ Downloaded video ${i + 1}/${urls.length}`);
      });
    });
    await Promise.all(downloadPromises);

    // Step 2: Write FFmpeg concat list
    const listContent = tmpFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listPath, listContent);
    console.log(`[${jobId}] Concat list:\n${listContent}`);

    // Step 3: Run FFmpeg
    const ffmpegCmd = `ffmpeg -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}" -y`;
    console.log(`[${jobId}] Running: ${ffmpegCmd}`);
    
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[${jobId}] FFmpeg error:`, stderr);
          reject(new Error(`FFmpeg failed: ${stderr.slice(-500)}`));
        } else {
          resolve();
        }
      });
    });

    // Step 4: Read output and return as base64
    const outputBuffer = fs.readFileSync(outputPath);
    const base64Video = outputBuffer.toString('base64');
    const fileSizeMB = (outputBuffer.length / 1024 / 1024).toFixed(2);
    
    console.log(`[${jobId}] ✓ Done! Output: ${fileSizeMB} MB`);

    return res.json({
      status: 'success',
      job_id: jobId,
      file_size_mb: parseFloat(fileSizeMB),
      video_count: urls.length,
      output_base64: base64Video,
      content_type: 'video/mp4'
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    return res.status(500).json({
      status: 'failed',
      job_id: jobId,
      error: error.message
    });
  } finally {
    cleanup(...tmpFiles, listPath, outputPath);
  }
});

// ─── Start Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Concat API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Concat: POST http://localhost:${PORT}/v1/video/concatenate`);
});
