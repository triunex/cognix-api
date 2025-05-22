import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SerpAPI } from "langchain/tools/serpapi";
import { initializeAgentExecutorWithOptions } from "langchain/agents";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = gemini.getGenerativeModel({ model: "gemini-pro" });

app.post("/api/search", async (req, res) => {
  const userQuery = req.body.query?.trim();
  if (!userQuery) return res.status(400).json({ error: "Missing query" });

  try {
    const searchTool = new SerpAPI(process.env.SERPAPI_API_KEY);
    const executor = await initializeAgentExecutorWithOptions(
      [searchTool],
      {
        call: async (inputs) => {
          const result = await model.generateContent(inputs.input);
          return { content: result.response.text() };
        },
      },
      {
        agentType: "openai-functions",
        verbose: true,
      }
    );

    const answer = await executor.run(userQuery);
    res.json({ answer });
  } catch (err) {
    console.error("Execution error:", err);
    res
      .status(500)
      .json({ error: "Failed to generate answer", details: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running...");
});
