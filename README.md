# 🎬 FFmpeg Concat API

Video concatenation API dùng Node.js + FFmpeg, deploy miễn phí trên Render.com.

## Deploy lên Render (5 bước)

1. **Push lên GitHub**
```bash
git init
git add .
git commit -m "ffmpeg concat api"
git remote add origin https://github.com/YOUR_USERNAME/ffmpeg-concat-api.git
git push -u origin main
```

2. **Vào render.com** → New → Web Service → Connect GitHub repo

3. **Chọn settings:**
   - Environment: **Docker**
   - Region: **Singapore** (gần nhất)
   - Plan: **Free**

4. **Thêm Environment Variable:**
   - Key: `API_KEY`
   - Value: `your-secret-key-here`

5. **Deploy** → Đợi ~3 phút → Lấy URL dạng:
   `https://ffmpeg-concat-api.onrender.com`

---

## API Usage

### Health Check
```
GET https://your-service.onrender.com/health
```

### Concatenate Videos
```
POST https://your-service.onrender.com/v1/video/concatenate
Headers:
  x-api-key: your-secret-key
  Content-Type: application/json

Body (format 1 - từ Kling AI):
{
  "video_urls": [
    {"video_url": "https://...mp4"},
    {"video_url": "https://...mp4"},
    {"video_url": "https://...mp4"}
  ]
}

Body (format 2 - array đơn giản):
{
  "video_urls": ["https://...mp4", "https://...mp4"]
}
```

### Response
```json
{
  "status": "success",
  "job_id": "a1b2c3",
  "file_size_mb": 12.5,
  "video_count": 3,
  "output_base64": "AAAAIGZ0eXBpc29...",
  "content_type": "video/mp4"
}
```

---

## Dùng trong n8n

### Node: Concatenate Video (HTTP Request)
- Method: POST
- URL: `https://your-service.onrender.com/v1/video/concatenate`
- Authentication: Header Auth
  - Name: `x-api-key`
  - Value: `your-secret-key`
- Body (JSON):
```
{{ $json.final_json_string }}
```

### Node sau: Convert Base64 → File (Code node)
```javascript
const base64 = $input.first().json.output_base64;
const buffer = Buffer.from(base64, 'base64');
return [{ binary: { data: { data: buffer.toString('base64'), mimeType: 'video/mp4', fileName: 'output.mp4' } }, json: {} }];
```

---

## ⚠️ Lưu ý Free Tier Render

- Service **spin down sau 15 phút** không có request
- Lần đầu gọi sau khi idle: **cold start ~30s**
- RAM: 512MB — đủ cho video ~50MB
- Không có persistent storage (file xóa sau mỗi request — đã handle trong code)
