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
puppeteer.use(StealthPlugin());

dotenv.config();

const app = express();

// ✅ Proper CORS setup
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

    const formattedHistory = (history || []).map((msg) => ({
      role: msg.role,
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

app.listen(10000, () => console.log("Server running on port 10000"));

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
  const { task, frontend, backend, db, auth, deploy, style, fallback, extra } =
    req.body;

  if (!task) return res.status(400).json({ error: "Missing task" });

  const prompt = `
You're DevAgent — the most powerful AI coding assistant ever built.

Your job is to generate full stack code based on the following:
- Task: ${task}
- Frontend: ${frontend || "React"}
- Backend: ${backend || "Node.js + Express"}
- Database: ${db || "MongoDB"}
- Auth: ${auth || "JWT or Firebase Auth"}
- Style/UI: ${style || "TailwindCSS"}
- Deployment: ${deploy || "Vercel or Firebase"}
- Fallback Plan: ${fallback || "Switch tech stack if needed"}
- Extras: ${extra || "None"}

Give complete folder structure, code files, and clear explanations (as JSON):
[
  { "filename": "package.json", "content": "..." },
  { "filename": "src/index.js", "content": "..." },
  { "filename": "README.md", "content": "..." }
]

Only give JSON — no markdown, no text.
`;

  try {
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const raw = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
    const jsonStart = raw.indexOf("[");
    const jsonEnd = raw.lastIndexOf("]");
    const jsonStr = raw.substring(jsonStart, jsonEnd + 1);
    const files = JSON.parse(jsonStr);

    res.json({ files });
  } catch (err) {
    console.error("DevAgent error:", err.response?.data || err.message);
    res.status(500).json({ error: "DevAgent failed." });
  }
});

// ------------- Agentic v2 endpoint -------------
app.post("/api/agentic-v2", async (req, res) => {
  const { query, maxWeb = 8, topChunks = 10 } = req.body || {};
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    // 1) SERPAPI search -> top links
    const serpRes = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google",
        q: query,
        api_key: process.env.SERPAPI_API_KEY,
      },
    });
    const organic = serpRes.data.organic_results || [];
    const topLinks = organic.slice(0, maxWeb).map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    }));

    // 2) Fetch & parse pages in parallel (unfluff)
    const pagePromises = topLinks.map((l) => fetchPageText(l.link));
    const pages = await Promise.all(pagePromises);

    // 3) Social signals (Twitter / Reddit)
    const [tweets, reddit] = await Promise.all([
      searchTwitterRecent(query, 6),
      searchReddit(query, 6),
    ]);

    // 4) Build chunks from pages + social posts
    let chunks = [];
    for (const p of pages) {
      if (p.text && p.text.length > 200) {
        const cs = chunkText(p.text, 1200).map((c) => ({
          ...c,
          source: { type: "web", url: p.url, title: p.title },
        }));
        chunks = chunks.concat(cs);
      } else if (p.title) {
        chunks.push({
          id: crypto.randomUUID(),
          text: `${p.title}\n\n${p.text || ""}`.slice(0, 1200),
          source: { type: "web", url: p.url, title: p.title },
        });
      }
    }

    // include tweets as short chunks
    for (const t of tweets) {
      chunks.push({
        id: crypto.randomUUID(),
        text: t.text,
        source: { type: "twitter", id: t.id, created_at: t.created_at },
      });
    }
    // include reddit posts
    for (const r of reddit) {
      chunks.push({
        id: crypto.randomUUID(),
        text: `${r.title}\n\n${r.text}`,
        source: { type: "reddit", url: r.url, subreddit: r.subreddit },
      });
    }

    if (chunks.length === 0) {
      return res.json({
        answer:
          "I couldn't fetch enough content for this query. Try broader terms or check your SERPAPI/Twitter credentials.",
        sources: [],
        raw: [],
      });
    }

    // 5) Embed all chunks (OpenAI embeddings)
    const texts = chunks.map((c) => c.text.substring(0, 2000)); // limit size
    const embeddings = await getEmbeddingsGemini(texts);

    // 6) Embed the user query
    const qEmb = (await getEmbeddingsGemini([query]))[0];

    // 7) Compute similarity, pick top chunks
    const sims = embeddings.map((emb, i) => ({
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

Do NOT return JSON unless the user explicitly asks for a chart or a table; otherwise always return human-friendly Markdown. At the end, add a section titled "Sources" listing each source as: Title — URL, one per line. Use ONLY the provided context for factual details.

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
