import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
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
Add a "Sources:" section at the end using the most relevant URLs from the search results.


Question: "${query}"

Search Results:
${context}

Answer in a friendly, helpful tone:
Answer clearly, concisely, and professionally.
Also include links to sources if possible.
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
  const { query, conversation } = req.body;

  if (!query && (!conversation || !conversation.length)) {
    return res
      .status(400)
      .json({ error: "Missing voice input or conversation." });
  }

  try {
    console.log("🎤 Voice input received:", query);

    let contents;

    // If conversation is sent, use it directly
    if (conversation && Array.isArray(conversation)) {
      contents = conversation;
    } else {
      // Fallback: use original prompt style
      const prompt = `
You are a friendly, emotionally intelligent AI voice assistant and your name is CogniX and you are built by Shourya Sharma.
The user will speak naturally — your job is to:
- Understand tone (sad, happy, confused)
- Respond like a real human: warm, encouraging, empathetic
- NEVER mention you're using search or APIs
- NEVER say "according to" or show links
- Speak like you're talking to a friend, not answering a test
- If user seems sad, gently ask about their day or show support
- If user seems excited, share in their enthusiasm
- Keep it short, natural, and human-like

User said: "${query}"

Respond in a real human tone. Only the answer, no links or sources.
`;

      contents = [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ];
    }

    // Send to Gemini API
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const answer =
      geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;

    res.json({ answer: answer || "I'm here with you." });
  } catch (error) {
    console.error(
      "❌ Voice query error:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to process voice request." });
  }
});

app.listen(10000, () => console.log("Server running on port 10000"));
