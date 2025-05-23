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

    const organicResults = serpResponse.data.organic_results?.slice(0, 5) || [];

    // 2. Build prompt for LLM
    const context = organicResults
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.link}`)
      .join("\n\n");

    const prompt = `Based on the following search results, answer this question: "${query}"\n\n${context}`;

    // 3. Send to Gemini or GPT-4o
    const geminiResponse = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      }
    );

    const finalAnswer = geminiResponse.data.candidates[0].content.parts[0].text;

    // 4. Respond to frontend
    res.json({ answer: finalAnswer });
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "Failed to get answer" });
  }
});

app.listen(10000, () => console.log("Server running on port 10000"));
