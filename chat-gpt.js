import express from "express";
import axios from "axios";
const router = express.Router();

router.post("/", async (req, res) => {
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: "Missing message" });

  try {
    const openaiRes = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: message }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const reply = openaiRes.data.choices[0].message.content;
    res.status(200).json({ reply });
  } catch (err) {
    console.error("GPT error:", err.response?.data || err.message);
    res.status(500).json({ error: "Something went wrong with GPT." });
  }
});

export default router;
