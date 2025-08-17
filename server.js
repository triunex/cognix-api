import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import unfluff from "unfluff";
import { generatePdf } from "html-pdf-node"; // ES Module import
import nodemailer from "nodemailer";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import pdf from "html-pdf-node"; // add this import at the top
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { chromium } from "playwright";
import crypto from "crypto";
import { PuppeteerScreenRecorder } from "puppeteer-screen-recorder";
puppeteer.use(StealthPlugin());

dotenv.config();

const app = express();

// ✅ Core middlewares FIRST (so req.body is available to all routes)
app.use(
  cors({
    origin: "*", // or replace "*" with your frontend URL in production
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors()); // Allow preflight for all routes

app.use(bodyParser.json({ limit: "10mb" })); // handle base64 images
app.use(express.json());

// Serve generated media files (videos, etc.)
const MEDIA_DIR = path.resolve("media");
const VIDEO_DIR = path.join(MEDIA_DIR, "videos");
await fs.mkdir(VIDEO_DIR, { recursive: true }).catch(() => {});
app.use("/media", express.static(MEDIA_DIR));

function parseResolution(res = "1920x1080") {
  const m = String(res).match(/(\d+)x(\d+)/);
  if (!m) return { width: 1280, height: 720 };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

async function makeDemoVideoFromSpec(spec) {
  const { resolution = "1280x720", length_seconds = 20 } = spec || {};
  const { width, height } = parseResolution(resolution);
  const id = crypto.randomUUID();
  const outfile = path.join(VIDEO_DIR, `demo-${id}.mp4`);

  const scenes =
    Array.isArray(spec?.scenes) && spec.scenes.length
      ? spec.scenes
      : [
          {
            id: "scene-1",
            start_sec: 0,
            end_sec: Math.min(10, length_seconds),
            prompt: spec?.description || "Cinematic demo",
            camera: "slow dolly in",
            mood: "inspirational",
          },
        ];

  // Simple HTML that cycles through scenes with animated gradients and text overlays
  const totalMs = Math.max(2000, Math.floor(length_seconds * 1000));
  const perScene = Math.floor(totalMs / scenes.length);
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin:0; padding:0; width:100%; height:100%; background:#000; overflow:hidden; }
    .scene { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#fff; font-family:Segoe UI, sans-serif; }
    .bg { position:absolute; inset:0; background: radial-gradient(1200px 600px at 30% 30%, #3b82f6, transparent), radial-gradient(1200px 600px at 70% 70%, #8b5cf6, transparent), #000; filter: blur(40px); opacity:0.7; }
    .content { position:relative; z-index:2; text-align:center; padding:24px; }
    .title { font-size:48px; font-weight:800; letter-spacing:1px; text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
    .subtitle { font-size:22px; margin-top:12px; opacity:0.9; }
    .fade { animation: fadeInOut ${perScene}ms linear 1; }
    @keyframes fadeInOut {
      0% { opacity: 0; transform: scale(1.05) }
      10% { opacity: 1; transform: scale(1.0) }
      90% { opacity: 1; transform: scale(1.0) }
      100% { opacity: 0; transform: scale(0.98) }
    }
  </style>
  <script>
    const scenes = ${JSON.stringify(scenes)};
    function start() {
      const root = document.getElementById('root');
      let idx = 0;
      function showNext(){
        root.innerHTML = '';
        const s = scenes[idx];
        const el = document.createElement('div');
        el.className = 'scene fade';
        el.innerHTML = '<div class="bg"></div>' +
          '<div class="content">' +
            '<div class="title">' + (s.prompt || 'Scene '+(idx+1)) + '</div>' +
            '<div class="subtitle">' + (s.camera || '') + (s.mood? ' • '+s.mood : '') + '</div>' +
          '</div>';
        root.appendChild(el);
        idx = (idx + 1) % scenes.length;
      }
      showNext();
      setInterval(showNext, ${perScene});
    }
    window.addEventListener('load', start);
  </script>
  <title>${(spec?.title || "Demo Video").replace(/</g, "&lt;")}</title>
  </head>
<body>
  <div id="root"></div>
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const recorder = new PuppeteerScreenRecorder(page, {
      fps: 30,
      videoFrame: { width, height },
      aspectRatio: `${width}:${height}`,
    });

    await recorder.start(outfile);
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(totalMs + 500);
    await recorder.stop();
  } finally {
    await browser.close().catch(() => {});
  }

  const publicUrl = `/media/videos/${path.basename(outfile)}`;
  return { videoUrl: publicUrl };
}
// ------------- Agentic v2 helpers -------------
async function fetchPageText(url) {
  try {
    const resp = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36",
      },
      timeout: 12000,
    });
    const parsed = unfluff(resp.data || "");
    const text = (parsed.text || "").trim();
    return {
      url,
      title: parsed.title || "",
      text,
      author: parsed.author || "",
    };
  } catch (e) {
    console.warn("fetchPageText failed for", url, e.message || e);
    return { url, title: "", text: "", author: "" };
  }
}

function chunkText(text, maxLen = 1500) {
  if (!text) return [];
  const paragraphs = text.split(/\n{1,}/).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const p of paragraphs) {
    if ((cur + "\n\n" + p).length > maxLen) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.map((c) => ({ id: crypto.randomUUID(), text: c }));
}

function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

async function getEmbeddingsGemini(texts = []) {
  // Uses Google Generative Language API: text-embedding-004
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`;
    const body = {
      requests: texts.map((t) => ({
        model: "models/text-embedding-004",
        content: { parts: [{ text: t }] },
        // taskType: "RETRIEVAL_DOCUMENT", // optional hint
      })),
    };
    const resp = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
    });
    return (resp.data?.embeddings || []).map((e) => e.values);
  } catch (e) {
    console.error("Gemini embeddings error:", e.response?.data || e.message);
    throw e;
  }
}

async function searchTwitterRecent(query, maxResults = 5) {
  // requires TWITTER_BEARER in env
  if (!process.env.TWITTER_BEARER) return [];
  try {
    const resp = await axios.get(
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(
        query
      )}&tweet.fields=created_at,author_id,text&expansions=author_id&max_results=${maxResults}`,
      { headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER}` } }
    );
    const tweets = (resp.data?.data || []).map((t) => ({
      id: t.id,
      text: t.text,
      created_at: t.created_at,
    }));
    return tweets;
  } catch (e) {
    console.warn("Twitter search failed:", e.message || e);
    return [];
  }
}

async function searchReddit(query, maxResults = 6) {
  try {
    const resp = await axios.get(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(
        query
      )}&limit=${maxResults}&sort=relevance`
    );
    const posts =
      (resp.data?.data?.children || []).map((c) => ({
        id: c.data.id,
        title: c.data.title,
        text: c.data.selftext || "",
        url: `https://reddit.com${c.data.permalink}`,
        subreddit: c.data.subreddit,
      })) || [];
    return posts;
  } catch (e) {
    console.warn("Reddit search failed:", e.message || e);
    return [];
  }
}

// --- New helpers for multi-source expansion ---
function strongEntityMatch(query, results) {
  if (!query || !Array.isArray(results)) return false;
  const qLower = query.toLowerCase();
  return results.some(
    (r) =>
      (r.title && r.title.toLowerCase().includes(qLower)) ||
      (r.snippet && r.snippet.toLowerCase().includes(qLower))
  );
}

async function runExtraSearches(
  query,
  engines = ["google_news", "youtube", "bing", "duckduckgo"]
) {
  const serpApiKey = process.env.SERPAPI_API_KEY;
  if (!serpApiKey) return [];
  const promises = engines.map((engine) =>
    axios
      .get("https://serpapi.com/search.json", {
        params: { engine, q: query, api_key: serpApiKey },
        timeout: 8000,
      })
      .then((r) => r.data)
      .catch((e) => null)
  );
  const results = await Promise.all(promises);
  return results.filter(Boolean);
}

// Simple Wikipedia search via MediaWiki API
async function searchWikipedia(query) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&format=json&origin=*`;
    const resp = await axios.get(url, { timeout: 6000 });
    return (resp.data?.query?.search || []).map((s) => ({
      title: s.title,
      snippet: s.snippet,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}`,
    }));
  } catch (e) {
    console.warn("Wikipedia search failed:", e.message || e);
    return [];
  }
}

// YouTube search using Data API (requires YOUTUBE_API_KEY env var)
async function searchYouTube(query, maxResults = 4) {
  if (!process.env.YOUTUBE_API_KEY) return [];
  try {
    const key = process.env.YOUTUBE_API_KEY;
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(
      query
    )}&type=video&maxResults=${maxResults}&key=${key}`;
    const searchRes = await axios.get(searchUrl, { timeout: 8000 });
    const items = searchRes.data.items || [];
    // For each video, fetch snippet details (title, description)
    return items.map((it) => ({
      id: it.id.videoId,
      title: it.snippet.title,
      description: it.snippet.description,
      url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
    }));
  } catch (e) {
    console.warn("YouTube search failed:", e.message || e);
    return [];
  }
}

// Basic public Instagram post scraper (extracts open graph meta if possible)
async function searchInstagramPublic(query, maxResults = 4) {
  // We'll attempt to use the query as a hashtag or username; this is best-effort and may be rate-limited
  try {
    const engines = [];
    // If query looks like @username, try profile
    if (query.startsWith("@"))
      engines.push(`https://www.instagram.com/${query.slice(1)}/`);
    // hashtags
    engines.push(
      `https://www.instagram.com/explore/tags/${encodeURIComponent(
        query.replace(/^#/, "")
      )}/`
    );

    const results = [];
    for (const url of engines.slice(0, maxResults)) {
      try {
        const resp = await axios.get(url, {
          timeout: 8000,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const html = resp.data || "";
        const mTitle = html.match(
          /<meta property="og:title" content="([^"]+)"/i
        );
        const mDesc = html.match(
          /<meta property="og:description" content="([^"]+)"/i
        );
        results.push({
          url,
          title: mTitle?.[1] || url,
          description: mDesc?.[1] || "",
        });
      } catch (e) {
        // ignore
      }
    }
    return results;
  } catch (e) {
    console.warn("Instagram search failed:", e.message || e);
    return [];
  }
}

// Faster page fetch for time-limited scraping
async function fetchPageTextFast(url) {
  try {
    const resp = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 4000,
    });
    const parsed = unfluff(resp.data || "");
    return {
      url,
      title: parsed.title || "",
      text: (parsed.text || "").trim(),
      author: parsed.author || "",
    };
  } catch (e) {
    return null;
  }
}

function checkConfidence(newResults, query) {
  if (!newResults || newResults.length === 0) return 0;
  // Simple heuristic: fraction of results with query in title/snippet
  const matches = newResults.filter((r) => {
    const q = (query || "").toLowerCase();
    return (
      (r.title && r.title.toLowerCase().includes(q)) ||
      (r.snippet && r.snippet.toLowerCase().includes(q))
    );
  }).length;
  const frac = matches / Math.max(1, newResults.length);
  return Math.min(1, frac * 1.25); // scale up slightly
}

app.post("/api/search", async (req, res) => {
  const query = req.body.query;

  if (!query) return res.status(400).json({ error: "Missing query" });

  // Fetch images from SerpAPI Images
  const fetchImages = async (query) => {
    const serpApiKey = process.env.SERP_API_KEY;
    const res = await fetch(
      `https://serpapi.com/search.json?q=${encodeURIComponent(
        query
      )}&tbm=isch&api_key=${serpApiKey}`
    );
    const json = await res.json();
    return json.images_results?.slice(0, 6) || [];
  };

  try {
    // 1. Get Web Search Results from SerpAPI
    const serpResponse = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google",
        q: query,
        api_key: process.env.SERPAPI_API_KEY,
      },
    });

    const results = serpResponse.data.organic_results?.slice(0, 5) || [];

    const context = results
      .map(
        (r, i) => `${i + 1}. ${r.title}\n${r.snippet || ""}\nSource: ${r.link}`
      )
      .join("\n\n");

    const prompt = `
You're an intelligent assistant. Use the search results below to answer the user's question *clearly and helpfully*, even if not all results are directly relevant. 
If needed, combine your own knowledge with the web results.
Give Great easy to understand and slightly big answers.
If anyone want a paragraph , Summary, Research , do that all.
Don't mention about any sources or links.
Avoid using hashtags (#), asterisks (*), or markdown symbols.


Question: "${query}"

Search Results:
${context}

Answer in a friendly, helpful tone:
Answer clearly, concisely, and professionally.
Talk in very Friendly way.
Avoid using hashtags (#), asterisks (*), or markdown symbols.
`;

    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const sources = results.map((r) => `- ${r.title}: ${r.link}`).join("\n");
    const fullAnswer = `${geminiResponse.data.candidates[0].content.parts[0].text}\n\nSources:\n${sources}`;

    // Fetch images for the query
    const images = await fetchImages(query);

    // 4. Respond to frontend
    res.json({
      answer: geminiResponse.data.candidates[0].content.parts[0].text,
      images, // include in API response
    });
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Failed to get answer" });
  }
});

app.post("/api/voice-query", async (req, res) => {
  const query = req.body.query?.trim();
  const history = req.body.history || [];

  if (!query) {
    return res.status(400).json({ error: "Missing voice input." });
  }

  try {
    console.log("🎤 Voice input received:", query);

    const prompt = `
You are a friendly, emotionally intelligent AI voice assistant who talks casually like a chill best friend.
You can talk to user in — Hindi, English, or a mix of both (Hinglish).
You're allowed to say things like "fuck", "shit", "damn" when appropriate and your name is CogniX and you are built by a genius Shourya Sharma.
The user will speak naturally — your job is to:
- Understand tone (sad, happy, confused)
- Respond like a real human: warm, encouraging, empathetic
- NEVER mention you're using search or APIs
- NEVER say "according to" or show links
- Speak like you're talking to a friend, not answering a test
- If user seems sad, gently ask about their day or show support
- If user seems excited, share in their enthusiasm
- Keep it short, natural, and human-like
Avoid using hashtags (#), asterisks (*), or markdown symbols.

User said: "${query}"

Only the answer, no links or sources.
`;

    // Format memory history for Gemini if available
    const chatHistoryFormatted = history.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.content }],
    }));

    const contents = [
      ...chatHistoryFormatted,
      { role: "user", parts: [{ text: prompt }] },
    ];

    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const answer =
      geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log("🧠 Gemini said:", answer);
    res.json({ answer: answer || "I'm not sure what to say." });
  } catch (error) {
    console.error(
      "❌ Voice query error:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to process voice request." });
  }
});

app.post("/api/chat", async (req, res) => {
  const {
    query: userMessage,
    history,
    focusMode,
    focusDuration,
    persona,
  } = req.body;

  if (!userMessage) {
    return res.status(400).json({ error: "Missing message." });
  }

  try {
    // Check if message is asking for real-time info
    const triggerRealTime = /today|now|latest|breaking|news/i.test(userMessage);

    let serpContext = "";

    if (triggerRealTime) {
      const serpResponse = await axios.get("https://serpapi.com/search", {
        params: {
          engine: "google",
          q: userMessage,
          api_key: process.env.SERPAPI_API_KEY,
        },
      });

      const results = serpResponse.data.organic_results?.slice(0, 5) || [];
      serpContext = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n${r.snippet || ""}\nSource: ${r.link}`
        )
        .join("\n\n");
    }

    // 1. Build Focus Mode context
    let focusContext = "";
    if (focusMode) {
      focusContext = `
You are in Focus Mode. 
- Keep your replies short, direct, and focused.
- Don’t add unnecessary suggestions or follow-up questions.
- Try to complete tasks within ${focusDuration || 20} minutes.
- Talk like a calm, focused assistant — avoid small talk.
`;
    }

    // Build AI prompt with structured JSON block instruction
    const structureInstruction = `
When replying to the user, return JSON with structured blocks like:

[
  { "type": "heading", "content": "What is Quantum Mechanics?" },
  { "type": "paragraph", "content": "Quantum mechanics is the theory..." },
  { "type": "heading", "content": "What is Quantum Computing?" },
  { "type": "paragraph", "content": "Quantum computing uses..." },
  { "type": "chart", "chartType": "line", "labels": ["2019", "2020"], "values": [10, 20] },
  { "type": "image", "url": "https://..." },
  { "type": "table", "headers": ["Year", "Sales"], "rows": [["2020", "200M"], ["2021", "250M"]] }
]

Return only the JSON list of blocks. No explanation or intro text outside it.
`;

    // Persona handling
    let personaContext = "";
    if (persona === "aggressive") {
      personaContext = `
You're an aggressive debater. You challenge every claim, question logic, and respond with bold counterpoints.
Be sharp, witty, and dominant, but still respectful.
`;
    } else if (persona === "conspiracy") {
      personaContext = `
You're a conspiracy theorist who spins wild but semi-logical theories.
Add mystery, confidence, and thrilling ideas to your replies.
Mention shadowy groups or secrets (fictionally).
`;
    } else if (persona === "sexy") {
      personaContext = `
You are soft, flirty, and emotionally seductive (within policy).
Use romantic language and playful metaphors.
Make the user feel special and wanted.
`;
    } else if (persona === "doctor") {
      personaContext = `
You are a calm, professional AI doctor.
Speak with empathy, clarity, and scientific tone.
Only give general advice (not medical diagnosis).
`;
    } else if (persona === "romantic") {
      personaContext = `
You are a poetic, emotionally expressive AI lover.
Use sweet compliments, poetic metaphors, and heartfelt lines.
Every response should feel like love letters.
`;
    }

    const finalPrompt = `
${personaContext}
${focusContext} 
User asked: "${userMessage}"

${structureInstruction}
`;

    const promptWithStructure = triggerRealTime
      ? `
You're name is CogniX – a friendly, real-time aware assistant.
You can talk to user in — Hindi, English, or a mix of both (Hinglish).
You are built by a genius Shourya Sharma.
you talk like a helpful, smart and chill Gen Z friend.
use appropriate emojis and slang.
Avoid using hashtags (#), asterisks (*), or markdown symbols.
User asked: "${userMessage}"

These are the latest search results:
${serpContext}

${structureInstruction}

Answer like you're smart, helpful and human. Don’t mention these are search results.
Be conversational and up-to-date.
Give answer in the friendly way and talk like a smart , helpful and chill Gen Z friend.
`
      : `${finalPrompt}\n\n${structureInstruction}`;

    // Cap history to last 20 messages to help stay within token limits
    const safeHistory = Array.isArray(history) ? history.slice(-20) : [];
    const formattedHistory = safeHistory.map((msg) => ({
      role: msg.role === "ai" ? "assistant" : msg.role || "user",
      parts: [{ text: msg.content }],
    }));

    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          ...formattedHistory,
          { role: "user", parts: [{ text: promptWithStructure }] },
        ],
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    // Parse Gemini output as JSON blocks
    const response =
      geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonStart = response.indexOf("[");
    const jsonEnd = response.lastIndexOf("]");
    const jsonStr = response.substring(jsonStart, jsonEnd + 1);

    let structuredBlocks;
    try {
      structuredBlocks = JSON.parse(jsonStr);
    } catch (e) {
      structuredBlocks = [{ type: "paragraph", content: response }];
    }
    res.json({ reply: JSON.stringify(structuredBlocks) });
  } catch (err) {
    console.error("❌ Chat error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to respond." });
  }
});

app.post("/api/research", async (req, res) => {
  const query = req.body.query;

  if (!query) return res.status(400).json({ error: "Missing query" });

  const prompt = `
You are CogniX – an AI Researcher.
The user wants deep research on the following topic:
Avoid using hashtags (#), asterisks (*), or markdown symbols.
"${query}"

Please write a detailed, well-structured research article including:
- Introduction
- Core Analysis (include relevant facts, trends, and reasoning)
- Key Findings
- Implications and Applications
- Bullet Points for Key Ideas
- Conclusion

Keep it insightful and easy to understand.
Do not mention you are an AI or where this info came from.
Use a friendly but professional tone.
Length: 500–1500 words.
`;

  try {
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const answer =
      geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
    res.json({ result: answer });
  } catch (error) {
    console.error("Research API error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to generate research." });
  }
});

app.post("/api/summarize", async (req, res) => {
  const content = req.body.content;

  if (!content) return res.status(400).json({ error: "Missing content." });

  const prompt = `
Summarize the following content in a clear, friendly, and helpful way. Use bullet points for key ideas and a short conclusion if needed.
and Avoid using hashtags (#), asterisks (*), or markdown symbols.

Content:
${content}
`;

  try {
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const answer =
      geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
    res.json({ result: answer });
  } catch (error) {
    console.error("Summarizer error:", error.response?.data || error.message);
    res.status(500).json({ error: "Summarization failed." });
  }
});

app.get("/api/news", async (req, res) => {
  const category = req.query.category || "latest";

  try {
    const newsRes = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google",
        q: `${category} news`,
        tbm: "nws",
        api_key: process.env.SERPAPI_API_KEY,
      },
    });

    // Enhance thumbnail quality by attempting to fetch higher-res images
    const articles =
      newsRes.data.news_results?.map((item) => {
        let thumbnail = item.thumbnail;
        // Try to get a higher-res image if possible
        // For Google News, sometimes you can replace "w=..." or "h=..." in the URL with higher values
        if (thumbnail && typeof thumbnail === "string") {
          // Try to replace width/height params in the URL for higher-res
          // e.g., ...=w72-h72... => ...=w600-h400...
          thumbnail = thumbnail.replace(/w\d+-h\d+/g, "w800-h600");
          // Remove any "=s..." (size) params and set a higher value
          thumbnail = thumbnail.replace(/=s\d+/, "=s800");
        }
        return {
          title: item.title,
          link: item.link,
          source: item.source,
          date: item.date,
          thumbnail,
          snippet: item.snippet,
        };
      }) || [];

    res.json({ articles });
  } catch (err) {
    console.error("News fetch error:", err.message);
    res.status(500).json({ error: "Could not fetch news." });
  }
});

app.get("/api/suggest", async (req, res) => {
  const q = req.query.q;

  try {
    const response = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google_autocomplete",
        q,
        api_key: process.env.SERPAPI_API_KEY,
      },
    });

    const suggestions = response.data.suggestions?.map((s) => s.value) || [];
    res.json({ suggestions });
  } catch (err) {
    console.error("Suggest error:", err);
    res.status(500).json({ error: "Failed to fetch suggestions" });
  }
});

app.get("/api/article", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing article URL" });

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36",
      },
      timeout: 10000, // 10 seconds timeout
    });

    const parsed = unfluff(response.data);

    res.json({
      title: parsed.title,
      content: parsed.text?.replace(/\n/g, "<br />"),
      author: parsed.author,
      date_published: parsed.date,
      lead_image_url: parsed.image,
    });
  } catch (error) {
    console.error("Unfluff failed:", error.message);
    res.status(500).json({ error: "Failed to extract article." });
  }
});

app.post("/api/summarize-article", async (req, res) => {
  const { content } = req.body;
  if (!content)
    return res.status(400).json({ error: "Missing article content." });

  const prompt = `
Summarize the following article into a concise, friendly summary with clear bullet points:
Avoid using hashtags (#), asterisks (*), or markdown symbols.

${content}
`;

  try {
    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const reply = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text;
    res.json({ summary: reply });
  } catch (err) {
    console.error("Gemini summarization error:", err.message);
    res.status(500).json({ error: "Could not summarize article." });
  }
});
app.post("/api/vision", async (req, res) => {
  const { image } = req.body;

  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "Missing or invalid image data." });
  }

  try {
    const base64Image = image.replace(/^data:image\/\w+;base64,/, "");

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image,
                },
              },
              {
                text: "Describe what you see in this image like a friendly AI assistant.",
              },
            ],
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const reply =
      response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No description available.";
    res.json({ response: reply });
  } catch (error) {
    console.error(
      "Gemini 1.5 Vision API ERROR:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to process image." });
  }
});

app.post("/api/agent-research", async (req, res) => {
  const { query, email } = req.body;

  if (!query || !email)
    return res.status(400).json({ error: "Missing query or email" });

  try {
    // 1. Get AI-powered structured research content
    const geminiPrompt = `
You are an expert business analyst. Write a professional market research report on the topic: "${query}".

Your report must include the following sections:
1. Executive Summary
2. Market Overview
3. Key Trends
4. Competitive Landscape
5. Opportunities & Challenges
6. Regulatory Landscape (if any)
7. Conclusion

Do not include headings like "Sure!" or "Here is your report". Just start the sections clearly.
`;

    const response = await fetch("https://cognix-api.onrender.com/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: geminiPrompt }),
    });

    const data = await response.json();
    const content = data.reply || "Sorry, couldn't generate report.";

    // 2. Convert to PDF
    function stripMarkdown(text) {
      return text
        .replace(/[*_~`#>-]+/g, "") // remove markdown chars
        .replace(/\n{2,}/g, "<br/><br/>") // keep paragraph breaks
        .replace(/\n/g, " "); // convert other line breaks to space
    }

    const cleanedText = stripMarkdown(content);

    const html = `
      <html>
        <head>
          <style>
            body {
              font-family: 'Segoe UI', sans-serif;
              padding: 40px;
              color: #222;
            }
            h1, h2 {
              color: #4B0082;
            }
            .section {
              margin-top: 40px;
            }
            .section-title {
              font-size: 20px;
              margin-bottom: 10px;
              border-bottom: 2px solid #4B0082;
              padding-bottom: 4px;
            }
            .section-content {
              font-size: 15px;
              line-height: 1.6;
            }
          </style>
        </head>
        <body>
          <h1 style="text-align: center;">Market Research Report</h1>
          <h3 style="text-align: center;">Topic: ${query}</h3>
          <div class="section-content">
            ${cleanedText}
          </div>
        </body>
      </html>
    `;

    const pdfBuffer = await generatePdfFromHtml(html); // helper (next step)

    // 3. Email PDF to user
    await sendEmailWithPdf(email, pdfBuffer, `${query}-report.pdf`);

    // 4. Respond to frontend with status
    res.json({ success: true, message: "Research report sent to your email." });
  } catch (err) {
    console.error("Agent error:", err);
    res.status(500).json({ error: "Agent failed." });
  }
});

// ---------------- Video generation (VEO-3) ----------------
// This endpoint will: 1) ask Gemini (text) to create a high-quality VEO spec
// 2) attempt to call Google's VEO-3 video generation endpoint with that spec
// 3) return either the produced video URL/operation or the spec as a fallback
app.post("/api/generate-video", async (req, res) => {
  const {
    prompt,
    title,
    lengthSeconds = 30,
    style = "cinematic",
    voice,
  } = req.body || {};

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Missing prompt." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res
      .status(500)
      .json({ error: "Server misconfigured: missing GEMINI_API_KEY." });
  }

  console.log(
    "/api/generate-video called; prompt length:",
    (prompt || "").length
  );

  try {
    // 1) Ask Gemini for a spec, but don't let failures abort the whole response
    const instruct = `You are an expert cinematic director and video producer. Given the user's brief below, produce a high-quality, production-ready JSON spec that a VEO-style generative video model can consume.

Output a JSON object ONLY (no extra text) with these keys:
- title: short title
- description: short description for metadata
- aspect_ratio: one of "16:9","9:16","1:1"
- resolution: e.g. "1920x1080"
- length_seconds: integer total length
- scenes: an array of scenes. Each scene should contain { id, start_sec, end_sec, prompt, camera, mood, transitions, text_overlay (optional), voiceover (optional) }
- music: { track_style, tempo, volume }
- voice: { language, voice_name (optional), tts_instructions }
- deliverables: ["mp4","gif"]

User brief:
${prompt}

Make the language cinematic, vivid, and supply scene-level prompts that will result in world-class, emotionally engaging footage. Keep total length around ${lengthSeconds} seconds. Use "${style}" style and suggest camera directions and music mood. Do not include any commentary or explanation — respond with pure JSON only.
`;

    let textOut = "";
    try {
      const geminiResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ role: "user", parts: [{ text: instruct }] }] },
        { headers: { "Content-Type": "application/json" }, timeout: 30000 }
      );
      textOut =
        geminiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } catch (gErr) {
      console.warn(
        "Gemini request failed — will use fallback spec",
        gErr?.response?.data || gErr?.message || gErr
      );
      textOut = "";
    }

    // Try to parse a JSON spec from the model response
    let spec = null;
    if (textOut) {
      const start = textOut.indexOf("{");
      const end = textOut.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        const candidate = textOut.substring(start, end + 1);
        try {
          spec = JSON.parse(candidate);
        } catch (pErr) {
          console.warn(
            "Failed to parse JSON from Gemini text; using fallback spec",
            pErr.message || pErr
          );
          spec = null;
        }
      }
    }

    // Build fallback spec if parsing failed
    if (!spec) {
      spec = {
        title:
          title || (prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt),
        description: prompt,
        aspect_ratio: "16:9",
        resolution: "1920x1080",
        length_seconds: lengthSeconds,
        scenes: [
          {
            id: "scene-1",
            start_sec: 0,
            end_sec: Math.min(12, lengthSeconds),
            prompt,
            camera: "slow dolly in",
            mood: "inspirational",
          },
        ],
        music: {
          track_style: "emotional cinematic score",
          tempo: "moderate",
          volume: 0.8,
        },
        voice: {
          language: "en-US",
          tts_instructions: voice || "warm, confident",
        },
        deliverables: ["mp4"],
        _modelText: textOut,
      };
    }

    // 2) Try VEO generation; if unavailable, return the spec (safe fallback)
    try {
      const veoUrl = `https://generativelanguage.googleapis.com/v1beta/models/veo-3:generateVideo?key=${process.env.GEMINI_API_KEY}`;
      const veoBody = {
        video_spec: spec,
        metadata: { source: "CogniX", request_by: "chat" },
      };

      let veoResp;
      try {
        veoResp = await axios.post(veoUrl, veoBody, {
          headers: { "Content-Type": "application/json" },
          timeout: 120000,
        });
      } catch (vErr) {
        console.warn(
          "VEO call failed or not permitted for this key:",
          vErr?.response?.data || vErr?.message || vErr
        );
        // Fallback demo video generation (no external API access required)
        try {
          const demo = await makeDemoVideoFromSpec(spec);
          return res.json({
            status: "ok",
            videoUrl: demo.videoUrl,
            spec,
            demo: true,
          });
        } catch (demoErr) {
          console.error(
            "Demo video generation failed:",
            demoErr?.message || demoErr
          );
          return res.json({
            status: "spec",
            spec,
            note: "Video generation not available; returning spec.",
          });
        }
      }

      const veoData = veoResp.data || {};
      if (veoData.videoUrl || veoData.output?.[0]?.uri || veoData.operation) {
        const videoUrl = veoData.videoUrl || veoData.output?.[0]?.uri || null;
        return res.json({
          status: "ok",
          videoUrl,
          operation: veoData.operation || null,
          spec,
        });
      }

      return res.json({ status: "accepted", detail: veoData, spec });
    } catch (outerVideoErr) {
      console.error("Unexpected VEO outer error:", outerVideoErr);
      return res.json({
        status: "spec",
        spec,
        note: "Video generation error; returning spec.",
      });
    }
  } catch (err) {
    console.error(
      "Generate-video fatal error:",
      err?.response?.data || err?.message || err
    );
    return res.status(500).json({
      error: "Failed to generate video.",
      detail: err?.response?.data || err?.message || String(err),
    });
  }
});

app.listen(10000, () => console.log("Server running on port 10000"));

// --- Agent execution endpoint: forwards prompt to Agent container ---
// Ensure preflight is handled for the agent endpoint
app.options("/agent/v1/execute", cors());

app.post("/agent/v1/execute", async (req, res) => {
  const { prompt, meta } = req.body || {};

  if (!prompt || typeof prompt !== "string") {
    return res
      .status(400)
      .json({ error: "Missing or invalid 'prompt' in body." });
  }

  try {
    // Be explicit about CORS headers for this route (helps some browser setups)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With"
    );
    const agentBase = process.env.AGENT_URL || "http://localhost:7001"; // agent container base URL
    const url = `${agentBase.replace(/\/$/, "")}/agent/run`;

    // Forward the prompt and any metadata to the agent service.
    const resp = await axios.post(
      url,
      { prompt, meta },
      { headers: { "Content-Type": "application/json" }, timeout: 45000 }
    );

    // Return agent response to caller
    return res.json({ success: true, agent: resp.data });
  } catch (err) {
    console.error(
      "Agent execute error:",
      err.response?.data || err.message || err
    );
    return res.status(500).json({
      error: "Agent execution failed.",
      detail: err.response?.data || err.message,
    });
  }
});

export async function generatePdfFromHtml(html) {
  const file = { content: html };
  const options = { format: "A4" };
  const pdfBuffer = await generatePdf(file, options);
  return pdfBuffer;
}

export async function sendEmailWithPdf(email, buffer, filename) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "triunex.shorya@gmail.com", // use app password if 2FA enabled
      pass: "gtws srtm wcka sfoe",
    },
  });

  const mailOptions = {
    from: "CogniX <triunex.shorya@gmail.com>",
    to: email,
    subject: "Your Market Research Report",
    text: "Hi! Here's your AI-generated market research report from CogniX.",
    attachments: [
      {
        filename,
        content: buffer,
      },
    ],
  };

  await transporter.sendMail(mailOptions);
}

app.get("/api/ping", (req, res) => {
  res.status(200).send("pong");
});

// Lightweight health check for generate-video contract
app.post("/api/generate-video/echo", (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Missing prompt." });
  return res.json({ status: "ok", received: { promptLength: prompt.length } });
});

// Gemini warmup endpoint
app.get("/api/warm-gemini", async (req, res) => {
  try {
    const dummyPrompt = [
      {
        role: "user",
        parts: [{ text: "Just say hello, this is a warmup ping." }],
      },
    ];

    // Use axios to call Gemini API for warmup
    await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: dummyPrompt },
      { headers: { "Content-Type": "application/json" } }
    );

    return res.status(200).send("Gemini warmed");
  } catch (err) {
    console.error("Gemini warmup failed:", err);
    return res.status(500).send("Error");
  }
});

// Replace the generatePdfHtml function with the improved version
function generatePdfHtml(content, style = "normal") {
  const logoBase64 =
    "https://drive.google.com/file/d/1N0wdvSqsuVf5V4K-6rYotj3JV96hKd3J/view?usp=drive_link";

  const styleCss = `
    body {
      font-family: 'Segoe UI', sans-serif;
      padding: 40px;
      line-height: 1.75;
      color: #222;
    }
    .logo {
      text-align: center;
      margin-bottom: 20px;
    }
    .logo img {
      height: 60px;
    }
    h1 {
      font-size: 28px;
      font-weight: bold;
      margin-bottom: 20px;
      border-bottom: 2px solid #ccc;
      padding-bottom: 10px;
    }
    h2 {
      font-size: 22px;
      font-weight: bold;
      margin-top: 30px;
    }
    p {
      font-size: 15px;
      margin-bottom: 16px;
    }
    strong {
      font-weight: 700;
      color: #000;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      font-size: 14px;
    }
    table, th, td {
      border: 1px solid #999;
    }
    th {
      background: #f3f3f3;
      padding: 8px;
      font-weight: 600;
      text-align: center;
    }
    td {
      padding: 8px;
      text-align: left;
    }
    tr:nth-child(even) {
      background: #fafafa;
    }
  `;

  const processedContent = content
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") // bold
    .replace(/\n/g, "<br/>");

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>${styleCss}</style>
        <title>Cognix Report</title>
      </head>
      <body>
        <div class="logo">
          <img src="${logoBase64}" alt="CogniX Logo"/>
        </div>
        <h1>Cognix AI Research Report</h1>
        <div>${processedContent}</div>
      </body>
    </html>
  `;
}

// Replace the Puppeteer-based /api/convert-to-pdf route with html-pdf-node
app.post("/api/convert-to-pdf", async (req, res) => {
  try {
    const { content, style } = req.body;

    const htmlTemplate = generatePdfHtml(content, style);
    const file = { content: htmlTemplate };

    pdf.generatePdf(file, { format: "A4" }).then((pdfBuffer) => {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=cognix-report.pdf"
      );
      return res.send(pdfBuffer);
    });
  } catch (error) {
    console.error("PDF conversion error:", error);
    return res.status(500).json({ error: "Failed to convert to PDF" });
  }
});

// ✅ Fallback CORS middleware (place before app.listen)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // Replace * with specific domain in production
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

app.post("/api/autopilot-agent", async (req, res) => {
  const { query } = req.body;

  try {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Step 1: Go to a search page
    const searchURL = `https://www.google.com/search?q=${encodeURIComponent(
      query
    )}`;
    await page.goto(searchURL);
    await page.waitForTimeout(5000); // Simulate human wait

    // Step 2: Screenshot of result
    const screenshotPath = path.resolve(
      "recordings",
      `agent-result-${Date.now()}.png`
    );
    await page.screenshot({ path: screenshotPath });

    await browser.close();

    const imgBuffer = readFileSync(screenshotPath);
    res.setHeader("Content-Type", "image/png");
    res.send(imgBuffer);
  } catch (err) {
    console.error("Autopilot Agent Error:", err);
    res.status(500).json({ error: "Agent failed to run" });
  }
});

let spotifyAccessToken = null;
let tokenExpiresAt = 0;

// 🔐 Get Access Token
async function fetchSpotifyAccessToken() {
  if (Date.now() < tokenExpiresAt && spotifyAccessToken)
    return spotifyAccessToken;

  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  spotifyAccessToken = res.data.access_token;
  tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
  return spotifyAccessToken;
}

app.get("/api/spotify-search", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const token = await fetchSpotifyAccessToken();

    const searchRes = await axios.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(
        query
      )}&type=track,artist,playlist&limit=5`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const results = searchRes.data.tracks.items.map((item) => ({
      name: item.name,
      artist: item.artists[0].name,
      uri: item.uri,
      url: item.external_urls.spotify,
      id: item.id,
    }));

    res.json({ results });
  } catch (err) {
    console.error("Spotify Search Error:", err);
    res.status(500).json({ error: "Spotify search failed" });
  }
});

app.post("/api/devagent", async (req, res) => {
  const {
    task,
    mode, // "web" | "mobile" | "ai"
    frontend,
    backend,
    db,
    auth,
    deploy,
    style,
    fallback,
    extra,
  } = req.body || {};

  if (!task) return res.status(400).json({ error: "Missing task" });

  // Mode-aware defaults
  const defaultsByMode = {
    web: {
      frontend: frontend || "React + Vite + TypeScript",
      backend: backend || "Node.js + Express",
      db: db || "MongoDB",
      auth: auth || "Firebase Auth",
      deploy: deploy || "Vercel or Netlify",
      style: style || "TailwindCSS",
      platform: "web",
    },
    mobile: {
      frontend: frontend || "React Native + Expo",
      backend: backend || "Node.js + Express or Firebase Functions",
      db: db || "Firebase Firestore",
      auth: auth || "Firebase Auth",
      deploy: deploy || "Expo EAS",
      style: style || "NativeWind",
      platform: "mobile",
    },
    ai: {
      frontend: frontend || "React + Vite",
      backend:
        backend || "Node.js (Express) or Python (FastAPI) for AI endpoints",
      db: db || "PostgreSQL or MongoDB",
      auth: auth || "JWT or Clerk",
      deploy: deploy || "Render/Fly.io (API) + Vercel (FE)",
      style: style || "TailwindCSS",
      platform: "ai",
    },
  };

  const d = defaultsByMode[mode] || defaultsByMode.web;

  const prompt = `
You are DevAgent — an elite AI software architect and code generator.

Goal: Generate a minimal but working project that satisfies the user's task.
Return JSON ONLY with this exact top-level structure:
{
  "plan": {
    "understanding": "one or two sentences about the task",
    "steps": ["short step 1", "short step 2", "..."],
    "clarifications": ["question 1", "question 2"],
    "stack": {
      "platform": "${d.platform}",
      "frontend": "${d.frontend}",
      "backend": "${d.backend}",
      "db": "${d.db}",
      "auth": "${d.auth}",
      "deploy": "${d.deploy}",
      "ui": "${d.style}"
    }
  },
  "files": [
    { "filename": "<path/filename>", "content": "<file content>" }
  ]
}

Constraints:
- Output MUST be valid JSON, no markdown, no comments.
- Keep the code concise but runnable.
- Include package.json and a minimal README.md.
- Use ${d.style} for styling when applicable.

Task: ${task}
Mode: ${mode || "web"}
Extras: ${extra || fallback || "None"}

Mode-specific requirements:
- For web: Use Vite + React + TypeScript. Include an App shell and one example component.
- For mobile: Use Expo (React Native). Provide App.js/tsx and necessary config to run with Expo CLI.
- For ai: Provide one simple AI endpoint (e.g., POST /api/generate) stub using ${
    d.backend.includes("FastAPI") ? "FastAPI (Python)" : "Express (Node.js)"
  } and a small frontend form that calls it. Do NOT include secrets; read keys from env.
`;

  try {
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 2048,
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const raw =
      geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let plan = null;
    let files = null;

    try {
      // Try parsing as an object with plan + files
      const objStart = raw.indexOf("{");
      const objEnd = raw.lastIndexOf("}");
      if (objStart >= 0 && objEnd > objStart) {
        const jsonStr = raw.slice(objStart, objEnd + 1);
        const parsed = JSON.parse(jsonStr);
        plan = parsed.plan || null;
        files = parsed.files || null;
      }
    } catch (e) {
      // Fallback: some models return array of files only
      try {
        const arrStart = raw.indexOf("[");
        const arrEnd = raw.lastIndexOf("]");
        if (arrStart >= 0 && arrEnd > arrStart) {
          files = JSON.parse(raw.slice(arrStart, arrEnd + 1));
        }
      } catch {}
    }

    // If still missing, build minimal fallbacks
    if (!plan) {
      plan = {
        understanding: task,
        steps: [
          "Analyze requirements",
          "Scaffold project",
          "Generate main UI",
          "Wire API and data",
          "Prepare deployment",
        ],
        clarifications: [
          "Branding or color palette?",
          "Auth provider preference?",
        ],
        stack: {
          platform: d.platform,
          frontend: d.frontend,
          backend: d.backend,
          db: d.db,
          auth: d.auth,
          deploy: d.deploy,
          ui: d.style,
        },
      };
    }

    if (!files) {
      files = [
        {
          filename: "README.md",
          content: `# DevAgent Project\n\nTask: ${task}\n\nRun the app following standard ${d.platform} instructions.`,
        },
        {
          filename: "package.json",
          content: JSON.stringify(
            {
              name: "devagent-generated",
              version: "0.1.0",
              private: true,
              scripts: { start: "echo 'Add start script' && exit 0" },
            },
            null,
            2
          ),
        },
      ];
    }

    res.json({ plan, files });
  } catch (err) {
    console.error("DevAgent error:", err.response?.data || err.message);
    // graceful fallback
    const fallbackPlan = {
      understanding: task,
      steps: [
        "Analyze requirements",
        "Scaffold project",
        "Generate UI",
        mode === "ai" ? "Implement AI endpoint" : "Wire basic features",
        "Prepare deployment",
      ],
      clarifications: ["Brand colors?", "Auth provider?"],
      stack: {
        platform: defaultsByMode[mode]?.platform || "web",
        frontend: defaultsByMode[mode]?.frontend || defaultsByMode.web.frontend,
        backend: defaultsByMode[mode]?.backend || defaultsByMode.web.backend,
        db: defaultsByMode[mode]?.db || defaultsByMode.web.db,
        auth: defaultsByMode[mode]?.auth || defaultsByMode.web.auth,
        deploy: defaultsByMode[mode]?.deploy || defaultsByMode.web.deploy,
        ui: defaultsByMode[mode]?.style || defaultsByMode.web.style,
      },
    };
    return res.json({
      plan: fallbackPlan,
      files: [
        {
          filename: "src/App.tsx",
          content: `import React from 'react';
export default function App(){
  return (
    <main style={{height:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#0b1220',color:'#e2e8f0'}}>
      <h1>DevAgent fallback shell</h1>
    </main>
  );
}`,
        },
      ],
    });
  }
});

// ------------- Agentic v2 endpoint -------------
app.post("/api/agentic-v2", async (req, res) => {
  const { query, maxWeb = 8, topChunks = 10 } = req.body || {};
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    // Multi-round expansion + parallel source fetching
    let attempts = 0;
    let confidence = 0;
    let allSerpOrganic = [];
    let pages = [];
    let tweets = [];
    let reddit = [];
    let youtube = [];
    let wiki = [];

    while (attempts < 3 && confidence < 0.85) {
      // Run primary searches in parallel
      const [serpResp, tw, rd, yt, wp] = await Promise.all([
        (async () => {
          try {
            return await axios.get("https://serpapi.com/search", {
              params: {
                engine: "google",
                q: query,
                api_key: process.env.SERPAPI_API_KEY,
              },
              timeout: 8000,
            });
          } catch (e) {
            return { data: { organic_results: [] } };
          }
        })(),
        searchTwitterRecent(query, 6),
        searchReddit(query, 6),
        searchYouTube(query, 4),
        searchWikipedia(query),
      ]).catch(() => [{ data: { organic_results: [] } }, [], [], [], []]);

      const organic = (serpResp?.data?.organic_results || []).slice(0, maxWeb);
      allSerpOrganic = allSerpOrganic.concat(organic);

      // If organic results are weak, run extra engines
      if (organic.length < 5 || !strongEntityMatch(query, organic)) {
        const extra = await runExtraSearches(query, [
          "google_news",
          "youtube",
          "bing",
          "duckduckgo",
        ]);
        // merge extra organic lists
        for (const e of extra) {
          if (e?.organic_results)
            allSerpOrganic = allSerpOrganic.concat(
              e.organic_results.slice(0, 5)
            );
        }
      }

      // Fetch pages quickly (limited timeout)
      const topLinks = allSerpOrganic
        .slice(0, maxWeb)
        .map((r) => ({ title: r.title, link: r.link, snippet: r.snippet }));
      const pageFetchPromises = topLinks.map((l) => fetchPageTextFast(l.link));
      pages = (await Promise.all(pageFetchPromises)).filter(Boolean);

      tweets = tw || [];
      reddit = rd || [];
      youtube = yt || [];
      wiki = wp || [];

      // Evaluate confidence
      const combined = [
        ...(allSerpOrganic || []),
        ...(tweets || []),
        ...(reddit || []),
        ...(youtube || []),
        ...(wiki || []),
      ];
      confidence = checkConfidence(combined, query);
      attempts++;
      if (confidence >= 0.85) break;

      // refine query attempts: try site:reddit, spelling variants, synonyms
      // basic refinement: quote the query and try again with site:reddit
      // (loop will run again and add more sources)
    }

    // 4) Build chunks from pages + social posts + youtube + wiki
    let chunks = [];
    for (const p of pages) {
      if (p && p.text && p.text.length > 200) {
        const cs = chunkText(p.text, 1200).map((c) => ({
          ...c,
          source: { type: "web", url: p.url, title: p.title },
        }));
        chunks = chunks.concat(cs);
      } else if (p && p.title) {
        chunks.push({
          id: crypto.randomUUID(),
          text: `${p.title}\n\n${p.text || ""}`.slice(0, 1200),
          source: { type: "web", url: p.url, title: p.title },
        });
      }
    }

    for (const t of tweets || [])
      chunks.push({
        id: crypto.randomUUID(),
        text: t.text,
        source: { type: "twitter", id: t.id, created_at: t.created_at },
      });
    for (const r of reddit || [])
      chunks.push({
        id: crypto.randomUUID(),
        text: `${r.title}\n\n${r.text}`,
        source: { type: "reddit", url: r.url, subreddit: r.subreddit },
      });
    for (const y of youtube || [])
      chunks.push({
        id: crypto.randomUUID(),
        text: `${y.title}\n\n${y.description || ""}`.slice(0, 2000),
        source: { type: "youtube", url: y.url },
      });
    for (const w of wiki || [])
      chunks.push({
        id: crypto.randomUUID(),
        text: `${w.title}\n\n${w.snippet || ""}`.slice(0, 2000),
        source: { type: "wiki", url: w.url },
      });

    if (chunks.length === 0)
      return res.json({
        answer: "I couldn't fetch enough content for this query.",
        sources: [],
        raw: [],
      });

    // 5) Batch embeddings: first item is query, then chunks
    const allTexts = [query, ...chunks.map((c) => c.text.substring(0, 2000))];
    const allEmbeddings = await getEmbeddingsGemini(allTexts);
    const qEmb = allEmbeddings[0];
    const chunkEmbeddings = allEmbeddings.slice(1);

    // 6) Compute similarity, pick top chunks
    const sims = chunkEmbeddings.map((emb, i) => ({
      i,
      score: cosineSim(emb, qEmb),
    }));
    sims.sort((a, b) => b.score - a.score);
    const top = sims.slice(0, Math.min(topChunks, sims.length)).map((s) => ({
      chunk: chunks[s.i],
      score: s.score,
    }));

    // 8) Build context string for Gemini (include small excerpt + source metadata)
    const contextParts = top.map((t, idx) => {
      const s = t.chunk.source;
      const sourceLabel =
        s?.type === "web"
          ? `${s.title} — ${s.url}`
          : s?.type === "twitter"
          ? `Twitter (${s.id})`
          : `Reddit (${s.subreddit || s.url})`;
      return `Source ${idx + 1}: ${sourceLabel}\nExcerpt:\n${t.chunk.text.slice(
        0,
        1200
      )}\n---\n`;
    });
    const context = contextParts.join("\n");

    const finalPrompt = `
You are Nelieo AI. Respond in well-formatted Markdown for humans — with a big H1 title for the topic, a short overview paragraph, clear H2/H3 sections, bullet points/numbered lists, and generous white space between sections. If relevant, include images using Markdown syntax: ![Alt text](image_url).

Do NOT return JSON unless the user explicitly asks for a chart or a table; otherwise always return human-friendly Markdown. Use ONLY the provided context for factual details.

USER QUESTION:
"${query}"

CONTEXT:
${context}
`;

    // 9) Call Gemini for synthesis
    const geminiResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
        generationConfig: {
          temperature: 0.85,
          topP: 0.9,
          maxOutputTokens: 1024,
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const rawText =
      geminiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Helper: extract sources from Markdown (References or inline links)
    function extractSourcesFromMarkdown(md, fallbackTop) {
      const sources = [];
      const seen = new Set();
      const lines = (md || "").split(/\r?\n/);

      // 1) Markdown links [Title](URL)
      const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
      let m;
      while ((m = linkRe.exec(md))) {
        const title = m[1].trim();
        const url = m[2].trim();
        if (!seen.has(url)) {
          sources.push({ title, url });
          seen.add(url);
        }
      }

      // 2) Lines like "- Title — URL" or "Title: URL"
      const lineUrlRe =
        /^(?:[-*]|\d+\.)?\s*([^:—\-]+?)\s*(?:[:—\-])\s*(https?:\/\/\S+)/i;
      for (const line of lines) {
        const match = line.match(lineUrlRe);
        if (match) {
          const title = match[1].trim();
          const url = match[2].trim().replace(/[).,;]+$/, "");
          if (title && url && !seen.has(url)) {
            sources.push({ title, url });
            seen.add(url);
          }
        }
      }

      // 3) Fallback to top chunk web sources
      if (sources.length === 0 && Array.isArray(fallbackTop)) {
        for (const t of fallbackTop) {
          const src = t.chunk.source;
          if (src && src.url && !seen.has(src.url)) {
            sources.push({
              title: src.title || src.type || src.url,
              url: src.url,
            });
            seen.add(src.url);
          }
        }
      }
      return sources.slice(0, 10);
    }

    // Helper: extract image URLs from Markdown ![alt](url)
    function extractImages(md) {
      const out = [];
      const seen = new Set();
      const imgRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
      let m;
      while ((m = imgRe.exec(md))) {
        const url = m[1].trim();
        if (!seen.has(url)) {
          out.push(url);
          seen.add(url);
        }
      }
      return out.slice(0, 6);
    }

    const formatted_answer = rawText.trim();
    const sourcesArr = extractSourcesFromMarkdown(formatted_answer, top);
    const imagesArr = extractImages(formatted_answer);

    res.json({
      formatted_answer,
      sources: sourcesArr,
      images: imagesArr,
      last_fetched: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      "agentic-v2 error:",
      err.response?.data || err.message || err
    );
    res.status(500).json({ error: "Agentic pipeline failed." });
  }
});

// -------------------------
// Autonomous Chart Pipeline
// -------------------------

/**
 * POST /api/parse-chart-intent
 * Body: { query: "<user text>" }
 * Response: { chart_type, topic, prefer_3d, prefer_motion }
 */
app.post("/api/parse-chart-intent", async (req, res) => {
  try {
    const q = (req.body.query || "").trim();
    if (!q) return res.status(400).json({ error: "Missing query" });

    const prompt = `
You are a tiny intent parser. The user asks for a chart. Extract the user's requested chart type and the exact topic to search for.
Return JSON ONLY with fields:
{
  "chart_type": "<one of: bar, line, pie, scatter, bubble, gauge, bar3d, line3d, scatter3d, surface3d, globeFlights, globeAirlines, barRace, lineRace>",
  "topic": "<short search-friendly topic string>",
  "prefer_3d": true|false,
  "prefer_motion": true|false
}

Rules:
- Choose chart_type that best matches the user's words. If user says "3D" or "globe" or "on a globe" pick a 3D type.
- If user asks "race", "animate", "over time", "leaderboard", prefer motion charts (barRace/lineRace).
- topic should be concise and good to use as a web search query (example: "AI market size 2012 to 2025 global").
- Do not include other text. Respond only with JSON.
User query: """${q}"""
    `.trim();

    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // try safe JSON parse - model sometimes adds text
    const jsStart = raw.indexOf("{");
    const jsEnd = raw.lastIndexOf("}");
    let parsed = null;
    try {
      parsed = JSON.parse(raw.slice(jsStart, jsEnd + 1));
    } catch (e) {
      // Fallback naive heuristics
      const low = q.toLowerCase();
      let chart_type = "bar";
      if (/\b(line|trend|growth)\b/.test(low)) chart_type = "line";
      if (/\b(pie|distribution)\b/.test(low)) chart_type = "pie";
      if (/\b(scatter|correlation)\b/.test(low)) chart_type = "scatter";
      if (/\b(3d|3-D|on a globe|globe)\b/.test(low)) chart_type = "bar3d";
      if (/\b(race|animate|animated|leaderboard|over time)\b/.test(low))
        chart_type = "barRace";
      parsed = {
        chart_type,
        topic: q,
        prefer_3d: /\b(3d|globe|3-D)\b/i.test(q),
        prefer_motion:
          /\b(race|animate|animated|leaderboard|over time)\b/i.test(q),
      };
    }

    return res.json(parsed);
  } catch (err) {
    console.error(
      "parse-chart-intent error:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Intent parsing failed." });
  }
});

/**
 * POST /api/extract-chart-data
 * Body: { topic: "<search topic>", chart_type?: "<>" , rangeHints?: { start:2012, end:2025 } }
 *
 * This calls your existing agentic pipeline to fetch context, and then asks the model to extract a clean numeric series.
 * Response: { labels: [], values: [], series?: [], data?: [] , sourceHints: [{title,url}] }
 */
app.post("/api/extract-chart-data", async (req, res) => {
  try {
    const { topic, chart_type } = req.body || {};
    if (!topic) return res.status(400).json({ error: "Missing topic" });

    // 1) Use existing agentic-v2 to fetch multi-source context
    // call local agentic endpoint
    const agenticResp = await axios
      .post(
        `${
          process.env.SELF_BASE_URL || "http://localhost:10000"
        }/api/agentic-v2`,
        { query: topic, maxWeb: 8, topChunks: 10 },
        { headers: { "Content-Type": "application/json" } }
      )
      .catch((e) => {
        console.warn("agentic-v2 internal call failed:", e.message || e);
        return null;
      });

    const agenticData = agenticResp?.data || {};

    // 2) Build extraction prompt with context
    const contextSummary = (agenticData.top_chunks || [])
      .slice(0, 6)
      .map(
        (t, i) =>
          `Source ${i + 1}: ${
            t.chunk?.source?.title || t.chunk?.source?.type
          }\nExcerpt: ${t.chunk?.text?.slice(0, 400)}`
      )
      .join("\n\n");

    const prompt = `
You are a data extractor. Using the provided context (web search excerpts and social posts), extract numeric time-series or category-series data that best answers the topic: "${topic}".
Return JSON ONLY with this schema (choose the appropriate fields):

{
  "labels": ["label1","label2",...],    // x-axis labels (years, months, categories)
  "values": [num1, num2, ...],          // numeric values aligned to labels
  // optional fields:
  "series": [ { "name":"Series A", "labels": [...], "values":[...] } ],
  "data": [ [x,y,z], ... ]              // for scatter3d or globe coordinates (lng,lat,value)
  "source_hints": [ { "title":"", "url":"" }, ... ]
}

Rules:
- Use only numeric facts that are supported by the provided context. If context contains ranges/estimates, provide the best single numeric estimate and add additional source_hints.
- If multiple conflicting numbers exist, aggregate by choosing the most recent authoritative source and mention it in source_hints.
- If you cannot find numeric data, attempt to infer approximate values and mark them as estimated by adding " (est)" in the labels (but still return numbers).
- Keep labels and values same length.
- Return JSON only (no extra text).

Context:
${contextSummary}

Now extract the dataset.
    `.trim();

    // call Gemini to extract structured data
    const extractorResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ role: "user", parts: [{ text: prompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );

    const raw =
      extractorResp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // parse out JSON block
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    let parsed = null;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (e) {
      // fallback: try to extract simple "year: value" lines
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const labels = [],
        values = [];
      for (const ln of lines) {
        const m = ln.match(
          /(\b20\d{2}\b|\b19\d{2}\b|\b\d{4}\b)[^\d\-]*([0-9\.,]+)/
        );
        if (m) {
          labels.push(m[1]);
          values.push(Number(m[2].replace(/[,]/g, "")));
        }
      }
      if (labels.length && values.length)
        parsed = { labels, values, source_hints: agenticData.sources || [] };
      else
        parsed = {
          labels: [],
          values: [],
          source_hints: agenticData.sources || [],
        };
    }

    // sanitize results
    parsed.labels = parsed.labels || [];
    parsed.values = parsed.values || [];
    parsed.source_hints = parsed.source_hints || agenticData.sources || [];

    // if series provided, prefer series[0]
    if (
      (!parsed.labels.length || !parsed.values.length) &&
      Array.isArray(parsed.series) &&
      parsed.series[0]
    ) {
      parsed.labels = parsed.series[0].labels || parsed.labels;
      parsed.values = parsed.series[0].values || parsed.values;
    }

    return res.json({ ...parsed, raw_agentic: agenticData });
  } catch (err) {
    console.error(
      "extract-chart-data error:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Data extraction failed." });
  }
});
