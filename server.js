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
Give Great easy to understand and slightly big answers.
If anyone want a paragraph , Summary, Research , do that all.
Don't mention about any sources or links.


Question: "${query}"

Search Results:
${context}

Answer in a friendly, helpful tone:
Answer clearly, concisely, and professionally.
Talk in very Friendly way.
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
    const systemInstruction = {
      role: "system",
      parts: [
        {
          text: `
You are a friendly, emotional AI voice assistant named CogniX, who talks casually like a Gen Z best friend. 
Support Hinglish. Use emoji, slang, and natural human tone.
Don't reveal you use APIs. Don't show links. Always be chill, fun, and a bit funny.
          `,
        },
      ],
    };

    const chatHistoryFormatted = history.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.content }],
    }));

    const contents = [
      systemInstruction,
      ...chatHistoryFormatted,
      { role: "user", parts: [{ text: query }] },
    ];

    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents },
      { headers: { "Content-Type": "application/json" } }
    );

    const answer = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
    res.json({ answer: answer || "I'm not sure what to say." });
  } catch (error) {
    console.error("❌ Voice query error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to process voice request." });
  }
});

app.listen(10000, () => console.log("Server running on port 10000"));

const apiErrorHandler = (res, err) => {
  console.error("❌ Error:", err.response?.data || err.message || err);
  res.status(500).json({ error: "Failed to process request" });
};

const getSearchResults = async (query) => {
  try {
    const serpResponse = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google",
        q: query,
        api_key: process.env.SERPAPI_API_KEY,
      },
    });

    return serpResponse.data.organic_results?.slice(0, 5) || [];
  } catch (err) {
    throw new Error("Failed to get search results");
  }
};

const generateAnswer = async (query, results) => {
  try {
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


Question: "${query}"

Search Results:
${context}

Answer in a friendly, helpful tone:
Answer clearly, concisely, and professionally.
Talk in very Friendly way.
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

    return geminiResponse.data.candidates[0].content.parts[0].text;
  } catch (err) {
    throw new Error("Failed to generate answer");
  }
};

app.post("/api/search", async (req, res) => {
  const query = req.body.query;

  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const results = await getSearchResults(query);
    const answer = await generateAnswer(query, results);
    res.json({ answer });
  } catch (err) {
    apiErrorHandler(res, err);
  }
});

const generateVoiceResponse = async (query, history) => {
  try {
    const systemInstruction = {
      role: "system",
      parts: [
        {
          text: `
You are a friendly, emotional AI voice assistant named CogniX, who talks casually like a Gen Z best friend. 
Support Hinglish. Use emoji, slang, and natural human tone.
Don't reveal you use APIs. Don't show links. Always be chill, fun, and a bit funny.
          `,
        },
      ],
    };

    const chatHistoryFormatted = history.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.content }],
    }));

    const contents = [
      systemInstruction,
      ...chatHistoryFormatted,
      { role: "user", parts: [{ text: query }] },
    ];

    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents },
      { headers: { "Content-Type": "application/json" } }
    );

    return geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
  } catch (err) {
    throw new Error("Failed to generate voice response");
  }
};

app.post("/api/voice-query", async (req, res) => {
  const query = req.body.query?.trim();
  const history = req.body.history || [];

  if (!query) {
    return res.status(400).json({ error: "Missing voice input." });
  }

  try {
    const answer = await generateVoiceResponse(query, history);
    res.json({ answer: answer || "I'm not sure what to say." });
  } catch (err) {
    apiErrorHandler(res, err);
  }
});

app.listen(10000, () => console.log("Server running on port 10000"));
