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
const isMeta = (url) => /instagram\.com|instagr\.am|facebook\.com|fb\.watch|fb\.com/i.test(url);

// --- Residential proxy (IPRoyal) ---
// Data-center IPs get bot-checked / 429'd by YouTube, IG and FB. PROXY_URL is
// the base proxy, e.g. http://user:pass_country-us@geo.iproyal.com:12321.
// IPRoyal picks the exit IP from the password: we add a session id so one job's
// requests share an IP (media URLs are tied to the IP that asked for them).
//  - YouTube: a fresh IP per job (and per retry) — spreads the rate limit.
//  - Instagram/Facebook: one IP per hour, so the login cookies don't appear
//    from a new house on every request (that trips their security checks).
// If the proxy fails (dropped IP, balance used up), downloads retry without it.
// TikTok stays off the proxy: tikwm + TikTok's CDN already work for free.
const { ProxyAgent, fetch: proxyFetch } = require('undici');
function proxyUrl(session, lifetime) {
  const base = process.env.PROXY_URL;
  if (!base) return null;
  if (!/iproyal/i.test(base)) return base;
  const u = new URL(base);
  u.password = `${decodeURIComponent(u.password)}_session-${session}_lifetime-${lifetime}`;
  return u.toString();
}
const randomSession = () => Math.random().toString(36).slice(2, 10);
function proxyForUrl(url) {
  if (isYouTube(url)) return proxyUrl(randomSession(), '10m');
  if (isMeta(url)) return proxyUrl(`meta${new Date().toISOString().slice(0, 13).replace(/\D/g, '')}`, '1h');
  return null;
}

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
function ytdlpArgs(url, useProxy) {
  const args = ['--no-playlist', '--no-warnings', '--force-ipv4'];
  const proxy = useProxy && proxyForUrl(url);
  if (proxy) args.push('--proxy', `"${proxy}"`);
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
async function downloadWithYtdlp(url, audioPath, useProxy) {
  // -f bestaudio/best + the web_safari player client avoids YouTube's recent
  // "Requested format is not available" (the default clients return
  // SABR/PO-gated streams that can't be downloaded server-side, even with
  // valid cookies). The extractor-arg is namespaced to youtube, so it's a
  // no-op for IG/FB/Twitter, which keep the generic best-audio selection.
  const fmt = `-f "bestaudio/best" --extractor-args "youtube:player_client=default,web_safari,mweb,tv;formats=missing_pot"`;
  const attempt = (proxy) =>
    run(`yt-dlp ${ytdlpArgs(url, proxy)} ${fmt} -x --audio-format mp3 --audio-quality 0 -o "${audioPath}" "${url}"`);
  try {
    await attempt(useProxy);
  } catch (err) {
    console.error('yt-dlp error:', err.message);
    if (!useProxy) throw new Error('Failed to download video');
    try {
      console.log('Proxy download failed, retrying without the proxy');
      await attempt(false);
    } catch (err2) {
      console.error('yt-dlp error (no proxy):', err2.message);
      throw new Error('Failed to download video');
    }
  }
}

// YouTube no longer lets servers DOWNLOAD audio (SABR/PO-token gated), but its
// CAPTIONS come from a different endpoint that isn't gated — and with cookies
// the player response (which holds the caption track) is reachable. For a
// transcription service that's ideal: we get the existing transcript directly,
// no audio, no Whisper. Returns { text, segments, language } or null if the
// video has no captions (then we fall back to the audio path).
const SUB_LANGS = process.env.SUB_LANGS || 'en.*,en,bn.*,bn,hi.*,hi';
async function fetchYouTubeCaptions(url, jobId, useProxy) {
  const base = `/tmp/${jobId}`;
  await run(
    `yt-dlp ${ytdlpArgs(url, useProxy)} --skip-download --write-subs --write-auto-subs ` +
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

// Build a Cookie header for youtube.com from the Netscape cookie jar so we can
// fetch the watch page as a logged-in user (bypasses the consent/bot gate).
function youtubeCookieHeader() {
  const b64 = process.env.YTDLP_COOKIES_B64;
  if (!b64) return '';
  let txt;
  try { txt = Buffer.from(b64, 'base64').toString('utf8'); } catch { return ''; }
  const pairs = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    const p = line.replace(/^#HttpOnly_/, '').split('\t');
    if (p.length < 7) continue;
    if (!/youtube\.com|google\.com/i.test(p[0])) continue;
    pairs.push(`${p[5]}=${p[6]}`);
  }
  return pairs.join('; ');
}

function ytId(url) {
  const m = (url || '').match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Captions through the residential proxy, via YouTube's ANDROID player API.
// The watch-page caption links now come back empty without a PO token, but
// the Android client's links still serve the full track (~150-200KB of proxy
// data a video). A 429 means that exit IP is rate-limited: retry on a new one.
// No cookies here on purpose — a clean home IP passes on its own, and it keeps
// the logged-in account out of it. Returns { text, segments, language } or null.
async function fetchYouTubeCaptionsProxy(url) {
  const id = ytId(url);
  if (!id || !process.env.PROXY_URL) return null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dispatcher = new ProxyAgent(proxyUrl(randomSession(), '10m'));
    try {
      const pr = await proxyFetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        dispatcher,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
        body: JSON.stringify({
          context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' } },
          videoId: id,
        }),
      });
      const player = await pr.json().catch(() => ({}));
      const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      console.log(`[capproxy ${id} #${attempt}] player=${pr.status} ${player?.playabilityStatus?.status} tracks=${tracks.length}`);
      if (pr.status === 429) continue;
      if (!tracks.length) return null;
      const lang = (re) => tracks.find((t) => re.test(t.languageCode || ''));
      const track = lang(/^en/i) || lang(/^bn/i) || lang(/^hi/i) || tracks[0];
      const cr = await proxyFetch(track.baseUrl.replace(/&fmt=\w+/, '') + '&fmt=json3', { dispatcher });
      if (cr.status === 429) { console.log(`[capproxy ${id} #${attempt}] captions 429`); continue; }
      const data = await cr.json().catch(() => null);
      const segments = (data?.events || [])
        .filter((e) => e.segs)
        .map((e) => ({
          start: (e.tStartMs || 0) / 1000,
          end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
          text: (e.segs || []).map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
        }))
        .filter((s) => s.text);
      if (!segments.length) continue;
      return { text: segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments, language: track.languageCode || 'unknown' };
    } catch (e) {
      console.error(`[capproxy ${id} #${attempt}] ${e.message}`);
    } finally {
      dispatcher.close().catch(() => {});
    }
  }
  return null;
}

// Fetch the caption track straight from the watch-page HTML (the
// youtube-transcript-api method). This path isn't SABR/PO-gated like the
// innertube player API, so with cookies it works server-side where yt-dlp's
// own caption fetch is blocked. Returns { text, segments, language } or null.
async function fetchYouTubeCaptionsWeb(url) {
  const id = ytId(url);
  if (!id) return null;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const cookie = youtubeCookieHeader();
  if (cookie) headers.Cookie = cookie;

  const html = await (await fetch(`https://www.youtube.com/watch?v=${id}&hl=en&bpctr=9999999999&has_verified=1`, { headers })).text();
  const m = html.match(/"captionTracks":(\[.*?\])/);
  console.log(`[capweb ${id}] html=${html.length}b cookie=${cookie ? 'yes' : 'no'} captionTracks=${!!m} consent=${/consent\.youtube|CONSENT/.test(html)} signin=${/Sign in to confirm|LOGIN_REQUIRED/.test(html)} playerResp=${html.includes('ytInitialPlayerResponse')}`);
  if (!m) return null;
  let tracks;
  try { tracks = JSON.parse(m[1]); } catch { return null; }
  if (!tracks.length) return null;
  // English first, then Bangla, then Hindi. One regex for all three took the
  // first match in YouTube's list, which is alphabetical by language name, so
  // "Bangla" beat "English" and English videos came back in Bangla.
  const lang = (re) => tracks.find((t) => re.test(t.languageCode || ''));
  const track = lang(/^en/i) || lang(/^bn/i) || lang(/^hi/i) || tracks[0];
  if (!track.baseUrl) return null;
  const subUrl = track.baseUrl.replace(/&fmt=\w+/, '') + '&fmt=json3';

  let data;
  try { data = JSON.parse(await (await fetch(subUrl, { headers })).text()); } catch { return null; }
  if (!data || !data.events) return null;
  const segments = data.events
    .filter((e) => e.segs)
    .map((e) => ({
      start: (e.tStartMs || 0) / 1000,
      end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
      text: (e.segs || []).map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
    }))
    .filter((s) => s.text);
  if (!segments.length) return null;
  return { text: segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments, language: track.languageCode || 'unknown' };
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


// --- Whisper on audio of any length ---
// Whisper takes 25MB per request. Re-encode to mono 16kHz 32kbps (~14MB an
// hour — speech loses nothing) and, when it is still too big, cut it into
// 20-minute pieces and stitch the text back together, shifting each piece's
// timestamps so the segments stay on the whole recording's clock.
const CHUNK_SECONDS = 20 * 60;
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;

async function mediaDuration(file) {
  const out = await run(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${file}"`);
  return parseFloat(out) || 0;
}

async function transcribeLongAudio(inputPath, jobId) {
  const speech = `/tmp/${jobId}-speech.mp3`;
  const parts = [];
  try {
    await run(`ffmpeg -y -loglevel error -i "${inputPath}" -vn -ar 16000 -ac 1 -b:a 32k "${speech}"`, { timeout: 900000 });
    if (!fs.existsSync(speech) || fs.statSync(speech).size < 1000) {
      throw new Error('No sound found in that file.');
    }

    if (fs.statSync(speech).size <= WHISPER_MAX_BYTES) {
      parts.push({ file: speech, offset: 0 });
    } else {
      const total = await mediaDuration(speech);
      for (let start = 0, i = 0; start < total; start += CHUNK_SECONDS, i++) {
        const part = `/tmp/${jobId}-part${i}.mp3`;
        await run(`ffmpeg -y -loglevel error -ss ${start} -t ${CHUNK_SECONDS} -i "${speech}" -c copy "${part}"`);
        parts.push({ file: part, offset: start });
      }
    }

    const texts = [];
    const segments = [];
    let language = '';
    let duration = 0;
    for (const { file, offset } of parts) {
      const t = await openai.audio.transcriptions.create({
        file: fs.createReadStream(file),
        model: 'whisper-1',
        response_format: 'verbose_json',
      });
      texts.push((t.text || '').trim());
      language = language || t.language || '';
      duration = offset + (t.duration || 0);
      for (const seg of t.segments || []) {
        segments.push({ ...seg, start: seg.start + offset, end: seg.end + offset });
      }
    }
    return { text: texts.filter(Boolean).join(' '), segments, language, duration };
  } finally {
    for (const f of [speech, ...parts.map((p) => p.file)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
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
  // The proxy is the first try for every app on this server. If it fails
  // (balance used up, blocked IP…) YouTube falls back to the browser
  // extension on the app side — see `code` in the error below.
  const useProxy = !!process.env.PROXY_URL;

  try {
    console.log('Downloading video from:', url, useProxy ? '(proxy)' : '');

    // YouTube: grab the existing captions (no download, no Whisper). Falls
    // through to the audio path only if the video has no captions.
    if (isYouTube(url)) {
      try {
        const cap = (useProxy && await fetchYouTubeCaptionsProxy(url)) || (await fetchYouTubeCaptionsWeb(url)) || (await fetchYouTubeCaptions(url, jobId, useProxy));
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
        await downloadWithYtdlp(url, audioPath, useProxy);
      }
    } else {
      await downloadWithYtdlp(url, audioPath, useProxy);
    }

    console.log('Audio downloaded, starting transcription...');

    // Any length now: long audio is cut into pieces instead of refused.
    const transcription = await transcribeLongAudio(audioPath, jobId);
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
    
    // Tells the apps to fall back to the YouTube Transcript extension (or ask
    // the user to install it) instead of showing a bare error.
    res.status(500).json({ error: error.message, ...(isYouTube(url) && { code: 'youtube_needs_extension' }) });
  }
});

// --- Direct audio-file transcription (mic dictation, voice memos, etc.) ---
// Accepts an uploaded audio blob (multipart field "audio") and runs Whisper.
// Used by UAE Prices shopping-list dictation and any other voice-to-text caller.
const multer = require('multer');
const audioUpload = multer({ dest: '/tmp', limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/transcribe-audio', audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded (field "audio").' });
  // Give the temp file a real extension so Whisper detects the container.
  const ext = path.extname(req.file.originalname || '') || '.webm';
  const audioPath = req.file.path + ext;
  try {
    fs.renameSync(req.file.path, audioPath);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
    });
    fs.unlinkSync(audioPath);
    res.json({ success: true, text: (transcription.text || '').trim() });
  } catch (error) {
    console.error('transcribe-audio error:', error.message);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    else if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// --- Any audio or video file, any length (the phone's "Get Transcript" button) ---
// Screen recordings, voice notes, podcast downloads. Video is fine: ffmpeg keeps
// only the sound. Big limit on purpose — a 20-minute screen recording is ~300MB.
const mediaUpload = multer({ dest: '/tmp', limits: { fileSize: 1024 * 1024 * 1024 } });

app.post('/transcribe-media', mediaUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "file").' });
  const jobId = uuidv4();
  try {
    const result = await transcribeLongAudio(req.file.path, jobId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('transcribe-media error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
