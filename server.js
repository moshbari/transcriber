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
    
    // Download and extract audio using yt-dlp
    await new Promise((resolve, reject) => {
      exec(
        `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${audioPath}" "${url}"`,
        { timeout: 300000 },
        (error, stdout, stderr) => {
          if (error) {
            console.error('yt-dlp error:', stderr);
            reject(new Error('Failed to download video'));
          } else {
            resolve();
          }
        }
      );
    });

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
