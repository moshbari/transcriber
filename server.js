const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const isTikTok = (url) => /tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url);
const isYouTube = (url) => /youtube\.com|youtu\.be/i.test(url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, opts = {}) =>
  new Promise((resolve, reject) => {
    exec(cmd, { timeout: 300000, ...opts }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });

// Extra yt-dlp args. Login-walled sites (Instagram/Facebook) and YouTube's
// bot checks usually need a logged-in cookie jar — set YTDLP_COOKIES_B64 (a
// base64 of a Netscape cookies.txt exported from a logged-in browser).
let cookiesReady = false;
function ytdlpArgs() {
  const args = ['--no-playlist', '--no-warnings', '--force-ipv4'];
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      if (!cookiesReady) {
        fs.writeFileSync('/tmp/yt-cookies.txt', Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf8'));
        cookiesReady = true;
      }
      args.push('--cookies', '/tmp/yt-cookies.txt');
    } catch (e) {
      console.error('cookie write failed:', e.message);
    }
  }
  return args.join(' ');
}

// Download via yt-dlp (FB/IG/Twitter/YouTube). Kept fresh by a boot-time
// `yt-dlp -U` (see package.json) since stale extractors are the #1 cause of
// "Failed to download video" on these sites.
async function downloadWithYtdlp(url, audioPath) {
  // -f bestaudio/best + the web_safari player client avoids YouTube's recent
  // "Requested format is not available" (the default clients return
  // SABR/PO-gated streams that can't be downloaded server-side, even with
  // valid cookies). The extractor-arg is namespaced to youtube, so it's a
  // no-op for IG/FB/Twitter, which keep the generic best-audio selection.
  const fmt = `-f "bestaudio/best" --extractor-args "youtube:player_client=default,web_safari,mweb,tv;formats=missing_pot"`;
  try {
    await run(`yt-dlp ${ytdlpArgs()} ${fmt} -x --audio-format mp3 --audio-quality 0 -o "${audioPath}" "${url}"`);
  } catch (err) {
    console.error('yt-dlp error:', err.message);
    throw new Error('Failed to download video');
  }
}

// YouTube no longer lets servers DOWNLOAD audio (SABR/PO-token gated), but its
// CAPTIONS come from a different endpoint that isn't gated — and with cookies
// the player response (which holds the caption track) is reachable. For a
// transcription service that's ideal: we get the existing transcript directly,
// no audio, no Whisper. Returns { text, segments, language } or null if the
// video has no captions (then we fall back to the audio path).
const SUB_LANGS = process.env.SUB_LANGS || 'en.*,en,bn.*,bn,hi.*,hi';
async function fetchYouTubeCaptions(url, jobId) {
  const base = `/tmp/${jobId}`;
  await run(
    `yt-dlp ${ytdlpArgs()} --skip-download --write-subs --write-auto-subs ` +
    `--sub-langs "${SUB_LANGS}" --sub-format json3 -o "${base}.%(ext)s" "${url}"`
  );
  const files = fs.readdirSync('/tmp').filter((f) => f.startsWith(jobId) && f.endsWith('.json3'));
  if (!files.length) return null;
  const path0 = `/tmp/${files[0]}`;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path0, 'utf8'));
  } finally {
    files.forEach((f) => { try { fs.unlinkSync(`/tmp/${f}`); } catch {} });
  }
  const segments = (data.events || [])
    .filter((e) => e.segs)
    .map((e) => ({
      start: (e.tStartMs || 0) / 1000,
      end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
      text: (e.segs || []).map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
    }))
    .filter((s) => s.text);
  if (!segments.length) return null;
  const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  const lang = (files[0].match(/\.([A-Za-z-]+)\.json3$/) || [])[1] || 'unknown';
  return { text, segments, language: lang };
}

// Resolve a TikTok link to a directly-downloadable no-watermark MP4 via tikwm,
// then pull it from TikTok's CDN (which serves cloud IPs fine) and extract audio.
async function downloadTikTok(url, audioPath, jobId) {
  const videoPath = `/tmp/${jobId}.mp4`;
  let playUrl = null;

  // tikwm free tier is rate-limited to 1 req/sec — retry a few times on limit
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0',
      },
      body: `url=${encodeURIComponent(url)}&hd=1`,
    });
    const data = await resp.json().catch(() => ({}));
    if (data.code === 0 && data.data && (data.data.play || data.data.hdplay)) {
      playUrl = data.data.hdplay || data.data.play;
      break;
    }
    if (data.msg && /limit/i.test(data.msg)) {
      await sleep(1200);
      continue;
    }
    throw new Error(`TikTok resolve failed: ${data.msg || 'unknown error'}`);
  }
  if (!playUrl) throw new Error('TikTok resolve failed: rate limited');

  // Download the MP4 from the CDN
  const vresp = await fetch(playUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!vresp.ok) throw new Error(`TikTok CDN download failed: HTTP ${vresp.status}`);
  const buf = Buffer.from(await vresp.arrayBuffer());
  fs.writeFileSync(videoPath, buf);

  // Extract mono 16k mp3 for Whisper, then drop the video
  try {
    await run(`ffmpeg -y -loglevel error -i "${videoPath}" -vn -ar 16000 -ac 1 -b:a 64k "${audioPath}"`);
  } finally {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'FB Transcriber is running!' });
});

// Main transcription endpoint
app.post('/transcribe', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  const jobId = uuidv4();
  const audioPath = `/tmp/${jobId}.mp3`;

  try {
    console.log('Downloading video from:', url);

    // YouTube: grab the existing captions (no download, no Whisper). Falls
    // through to the audio path only if the video has no captions.
    if (isYouTube(url)) {
      try {
        const cap = await fetchYouTubeCaptions(url, jobId);
        if (cap && cap.text) {
          console.log(`YouTube captions used (${cap.language}, ${cap.segments.length} lines)`);
          return res.json({ success: true, ...cap, source: 'youtube-captions' });
        }
        console.log('No YouTube captions found, falling back to audio download');
      } catch (capErr) {
        console.error('Caption fetch failed, trying audio:', capErr.message);
      }
    }

    // TikTok blocks yt-dlp from datacenter IPs, so resolve it via tikwm + CDN.
    // Other platforms (FB/IG/Twitter/YouTube) stay on yt-dlp.
    if (isTikTok(url)) {
      try {
        await downloadTikTok(url, audioPath, jobId);
      } catch (ttErr) {
        console.error('TikTok resolver failed, trying yt-dlp:', ttErr.message);
        await downloadWithYtdlp(url, audioPath);
      }
    } else {
      await downloadWithYtdlp(url, audioPath);
    }

    console.log('Audio downloaded, starting transcription...');

    // Check file size (Whisper limit is 25MB)
    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

    if (fileSizeMB > 25) {
      fs.unlinkSync(audioPath);
      return res.status(400).json({ error: 'Video too long. Max ~25 minutes supported.' });
    }

    // Transcribe with OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json'
    });

    // Clean up temp file
    fs.unlinkSync(audioPath);

    console.log('Transcription complete!');

    res.json({
      success: true,
      text: transcription.text,
      segments: transcription.segments,
      language: transcription.language,
      duration: transcription.duration
    });

  } catch (error) {
    console.error('Error:', error.message);
    
    // Clean up on error
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
    
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
