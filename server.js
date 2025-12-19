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

// In-memory job storage (upgrade to Redis for production)
const jobs = new Map();

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'FB Transcriber is running with async job support!' });
});

// ==========================================
// NEW: POST /transcribe - Start Job
// ==========================================
app.post('/transcribe', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Video URL is required' });
  }

  // Create job
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    url,
    createdAt: new Date(),
    progress: 0
  });

  // Start processing in background (don't await)
  processTranscription(jobId, url);

  // Return immediately
  res.json({ jobId, status: 'pending' });
});

// ==========================================
// NEW: GET /status/:jobId - Check Progress
// ==========================================
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ 
      error: 'Job not found',
      jobId 
    });
  }

  // Return current status
  const response = {
    jobId: job.jobId,
    status: job.status,
  };

  if (job.progress !== undefined) {
    response.progress = job.progress;
  }

  if (job.status === 'complete') {
    response.segments = job.segments;
    response.text = job.text;
    response.language = job.language;
    response.duration = job.duration;
  }

  if (job.status === 'error') {
    response.error = job.error;
  }

  res.json(response);
});

// ==========================================
// Background Processing Function
// ==========================================
async function processTranscription(jobId, url) {
  const audioPath = path.join(__dirname, `temp_${jobId}.mp3`);

  try {
    // Update status: processing
    updateJob(jobId, { status: 'processing', progress: 10 });

    // Download video and extract audio with yt-dlp
    console.log(`[${jobId}] Downloading video...`);
    await downloadAudio(url, audioPath);
    
    updateJob(jobId, { progress: 50 });

    // Check file size (Whisper limit is 25MB)
    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 25) {
      throw new Error(`File too large (${fileSizeMB.toFixed(1)}MB). Max 25MB supported.`);
    }

    updateJob(jobId, { progress: 60 });

    // Transcribe with OpenAI Whisper
    console.log(`[${jobId}] Transcribing...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json'
    });

    updateJob(jobId, { progress: 90 });

    // Clean up temp file
    fs.unlinkSync(audioPath);

    // Update job: complete
    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      text: transcription.text,
      segments: transcription.segments,
      language: transcription.language,
      duration: transcription.duration,
      completedAt: new Date()
    });

    console.log(`[${jobId}] Complete!`);

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    
    // Clean up on error
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }

    // Update job: error
    updateJob(jobId, {
      status: 'error',
      error: error.message,
      failedAt: new Date()
    });
  }
}

// Helper: Update job data
function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
    jobs.set(jobId, job);
  }
}

// Helper: Download audio using yt-dlp
function downloadAudio(url, outputPath) {
  return new Promise((resolve, reject) => {
    const command = `yt-dlp -x --audio-format mp3 -o "${outputPath}" "${url}"`;
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Download failed: ${stderr || error.message}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

// ==========================================
// Optional: Cleanup old jobs (every hour)
// ==========================================
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  for (const [jobId, job] of jobs.entries()) {
    const jobTime = new Date(job.completedAt || job.failedAt || job.createdAt).getTime();
    if (jobTime < oneHourAgo) {
      jobs.delete(jobId);
      console.log(`Cleaned up old job: ${jobId}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
