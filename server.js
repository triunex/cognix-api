import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import unfluff from "unfluff";
import bodyParser from "body-parser";

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "10mb" })); // handle base64 images

app.use(cors({ origin: "*", methods: ["POST", "OPTIONS"] }));
app.use(express.json());

app.post("/api/search", async (req, res) => {
  const query = req.body.query;

  if (!query) return res.status(400).json({ error: "Missing query" });

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

    // 4. Respond to frontend
    res.json({
      answer: geminiResponse.data.candidates[0].content.parts[0].text,
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
Be behave like you are a Gen Z and talk like Gen z
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
  const userMessage = req.body.query;
  const history = req.body.history || [];

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

    // Build AI prompt
    const finalPrompt = triggerRealTime
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

Answer like you're smart, helpful and human. Don’t mention these are search results.
Be conversational and up-to-date.
Give answer in the friendly way and talk like a smart , helpful and chill Gen Z friend.
`
      : userMessage;

    const formattedHistory = history.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.content }],
    }));

    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          ...formattedHistory,
          { role: "user", parts: [{ text: finalPrompt }] },
        ],
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const reply = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text;
    res.json({ reply });
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

    const articles =
      newsRes.data.news_results?.map((item) => ({
        title: item.title,
        link: item.link,
        source: item.source,
        date: item.date,
        thumbnail: item.thumbnail,
        snippet: item.snippet,
      })) || [];

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

app.post("/api/chart-explainer", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) return res.status(400).json({ error: "Missing chart prompt." });

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

    const explanation =
      geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text;
    res.json({ explanation: explanation || "No explanation available." });
  } catch (err) {
    console.error(
      "❌ Chart explainer error:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Failed to generate chart explanation." });
  }
});


app.listen(10000, () => console.log("Server running on port 10000"));
