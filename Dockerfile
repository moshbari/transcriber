FROM node:20-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
```

Click **"Commit changes"** → **"Commit changes"**

---

Go back to repo main page → **"Add file"** → **"Create new file"**

---

**File 4 of 4: `.gitignore`**

Filename: `.gitignore`

Paste this:
```
node_modules
.env
*.mp3
*.mp4
```

Click **"Commit changes"** → **"Commit changes"**

---

### **Part C: Deploy to Railway**

1. Go to **railway.app**
2. Click **"New Project"**
3. Click **"Deploy from GitHub repo"**
4. Find and select **"fb-transcriber"**
5. Railway will start building (you'll see logs)

**Wait!** Before it works, we need to add your OpenAI key:

6. In Railway, click on your project → **"Variables"** tab
7. Click **"+ New Variable"**
8. Add:
   - **Name:** `OPENAI_API_KEY`
   - **Value:** (paste your OpenAI API key)
9. Click **"Add"**

Railway will rebuild automatically.

---

### **Part D: Get Your Backend URL**

1. In Railway, click **"Settings"** tab
2. Scroll to **"Networking"** → **"Generate Domain"**
3. Click it — you'll get something like: `fb-transcriber-production-xxxx.up.railway.app`

**Copy this URL and save it!** We'll need it for Step 3.

---

## **Checkpoint**

Test your backend is working:

Open your browser and go to:
```
https://your-railway-url.up.railway.app/
