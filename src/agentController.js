import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import unfluff from "unfluff";

const AGENT_RUNS = new Map(); // runId -> run object
const SSE_CLIENTS = new Map(); // runId -> [res, ...]

export default function registerAgentRoutes(app) {
  // Planner
  app.post("/api/agent/plan", async (req, res) => {
    const { query, tools = ["search", "browse", "synthesize", "codegen"] } =
      req.body || {};
    if (!query) return res.status(400).json({ error: "Missing query" });

    // Default (fallback) plan
    let planId = uuidv4();
    let steps = [
      { id: "s1", tool: "search", desc: `Search web for "${query}"` },
      {
        id: "s2",
        tool: "browse",
        desc: "Open top result and extract key points",
      },
      { id: "s3", tool: "synthesize", desc: "Create summary of findings" },
      { id: "s4", tool: "codegen", desc: "Generate starter project scaffold" },
    ];
    let planText = `Create a project for: ${query}`;

    // Try to ask LLM for a better plan (Gemini) if key present
    if (process.env.GEMINI_API_KEY) {
      try {
        const prompt = `You are an agent planner. User asked: "${query}".
Return only JSON with these fields:
- planText (string)
- estimatedCost (number)
- estimatedTimeSec (number)
- steps: array of { id, tool, desc }
- requiresConfirmation (boolean)
`;
        const resp = await axios.post(
          `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          { contents: [{ role: "user", parts: [{ text: prompt }] }] },
          { headers: { "Content-Type": "application/json" } }
        );
        const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        // try to parse JSON from LLM output
        const jsonStart = raw.indexOf("{");
        if (jsonStart !== -1) {
          const parsed = JSON.parse(raw.slice(jsonStart));
          planText = parsed.planText || planText;
          steps = parsed.steps || steps;
        }
      } catch (e) {
        console.warn(
          "Planner LLM failed, falling back to default plan.",
          e.message
        );
      }
    }

    const plan = {
      planId,
      planText,
      estimatedCost: 0.02,
      estimatedTimeSec: 10,
      steps,
      requiresConfirmation: true,
    };
    AGENT_RUNS.set(planId, {
      plan,
      status: "planned",
      createdAt: new Date().toISOString(),
    });
    return res.json(plan);
  });

  // Start run (user must confirm)
  app.post("/api/agent/run", (req, res) => {
    const { planId, confirm = false } = req.body || {};
    if (!planId) return res.status(400).json({ error: "Missing planId" });
    if (!confirm)
      return res.status(400).json({ error: "Confirmation required" });

    const stored = AGENT_RUNS.get(planId);
    if (!stored) return res.status(404).json({ error: "Plan not found" });

    const runId = uuidv4();
    const run = {
      runId,
      plan: stored.plan,
      status: "running",
      logs: [],
      createdAt: new Date().toISOString(),
    };
    AGENT_RUNS.set(runId, run);

    // run async executor
    setImmediate(() => executePlan(runId).catch((e) => console.error(e)));

    return res.json({ runId });
  });

  // SSE stream for run updates
  app.get("/api/agent/stream", (req, res) => {
    const runId = req.query.runId;
    if (!runId) return res.status(400).end("Missing runId");

    res.set({
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.flushHeaders?.();
    res.write(`retry: 10000\n\n`);

    const arr = SSE_CLIENTS.get(runId) || [];
    arr.push(res);
    SSE_CLIENTS.set(runId, arr);

    req.on("close", () => {
      const list = SSE_CLIENTS.get(runId) || [];
      const idx = list.indexOf(res);
      if (idx !== -1) list.splice(idx, 1);
    });
  });

  // internal helper to send SSE events to clients of a runId
  async function sendEvent(runId, event, payload) {
    const list = SSE_CLIENTS.get(runId) || [];
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const r of list) {
      try {
        r.write(msg);
      } catch (e) {
        // ignore
      }
    }
  }

  // executor implementation (MVP)
  async function executePlan(runId) {
    const run = AGENT_RUNS.get(runId);
    if (!run) return;
    const steps = run.plan.steps || [];

    for (const step of steps) {
      await sendEvent(runId, "step_started", { stepId: step.id, step });
      try {
        if (step.tool === "search") {
          const query = run.plan.planText;
          let results = [];
          if (process.env.SERPAPI_API_KEY) {
            const resp = await axios.get("https://serpapi.com/search", {
              params: {
                engine: "google",
                q: query,
                api_key: process.env.SERPAPI_API_KEY,
              },
            });
            results =
              resp.data?.organic_results?.slice(0, 5).map((r) => ({
                title: r.title,
                link: r.link,
                snippet: r.snippet,
              })) || [];
          } else {
            results = [
              {
                title: "Example result (simulated)",
                link: "https://example.com",
                snippet: "Simulated because SERPAPI_API_KEY is not set.",
              },
            ];
          }
          run.logs.push({ stepId: step.id, results });
          await sendEvent(runId, "step_success", { stepId: step.id, results });
        } else if (step.tool === "browse") {
          // pick top link from previous search
          const lastSearch = run.logs.find((l) => l.stepId === "s1");
          const top = lastSearch?.results?.[0]?.link;
          if (top) {
            try {
              const resp = await axios.get(top, {
                timeout: 10000,
                headers: { "User-Agent": "Mozilla/5.0" },
              });
              const parsed = unfluff(resp.data || "");
              const excerpt = (parsed.text || "").slice(0, 1400);
              run.logs.push({
                stepId: step.id,
                url: top,
                title: parsed.title || top,
                excerpt,
              });
              await sendEvent(runId, "step_success", {
                stepId: step.id,
                url: top,
                title: parsed.title,
                excerpt,
              });
            } catch (e) {
              run.logs.push({ stepId: step.id, error: e.message });
              await sendEvent(runId, "step_failed", {
                stepId: step.id,
                error: e.message,
              });
            }
          } else {
            run.logs.push({ stepId: step.id, error: "No top link" });
            await sendEvent(runId, "step_failed", {
              stepId: step.id,
              error: "No top link to browse",
            });
          }
        } else if (step.tool === "synthesize") {
          // simple synthesis from available logs (fallback)
          const snippets = run.logs.flatMap((l) => {
            if (l.results) return l.results.map((r) => r.snippet || "");
            if (l.excerpt) return [l.excerpt];
            return [];
          });
          const context = snippets.join("\n\n").slice(0, 2000);
          let summary =
            "No LLM key: returning short summary generated locally.";
          if (process.env.GEMINI_API_KEY) {
            try {
              const prompt = `Summarize the following content into a concise helpful summary:\n\n${context}`;
              const resp = await axios.post(
                `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                { contents: [{ role: "user", parts: [{ text: prompt }] }] },
                { headers: { "Content-Type": "application/json" } }
              );
              summary =
                resp.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                summary;
            } catch (e) {
              summary = "LLM error: " + e.message;
            }
          }
          run.logs.push({ stepId: step.id, summary });
          await sendEvent(runId, "step_success", { stepId: step.id, summary });
        } else if (step.tool === "codegen") {
          // produce scaffold files - if LLM available, try to ask it, otherwise return simple defaults
          let files = [];
          if (process.env.GEMINI_API_KEY) {
            try {
              const prompt = `Generate a minimal React + Node scaffold for: ${run.plan.planText}.
Return a single JSON array of objects like:
[
 { "filename": "package.json", "content": "..." },
 { "filename": "src/App.jsx", "content": "..." }
]
`;
              const resp = await axios.post(
                `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                { contents: [{ role: "user", parts: [{ text: prompt }] }] },
                {
                  headers: { "Content-Type": "application/json" },
                  timeout: 20000,
                }
              );
              const raw =
                resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
              const idx = raw.indexOf("[");
              if (idx !== -1) files = JSON.parse(raw.slice(idx));
            } catch (e) {
              // fallback
              files = [];
            }
          }
          if (!files || files.length === 0) {
            files = [
              {
                filename: "package.json",
                content: JSON.stringify(
                  { name: "generated-app", version: "0.0.1" },
                  null,
                  2
                ),
              },
              {
                filename: "src/App.jsx",
                content: `export default function App() { return (<div style={{padding:40,fontFamily:'Inter'}}><h1>Hello from DevAgent</h1><p>Generated scaffold for: ${run.plan.planText}</p></div>) }`,
              },
              {
                filename: "README.md",
                content: `# Generated App\n\nThis project was generated by DevAgent for: ${run.plan.planText}`,
              },
            ];
          }

          // stream file creation + incremental updates
          for (const f of files) {
            await sendEvent(runId, "file_created", { filename: f.filename });
            // break file into increments (simulate typing)
            const len = f.content.length;
            let lastLen = 0;
            for (let i = 1; i <= len; i += 120) {
              const upto = Math.min(i, len);
              lastLen = upto;
              await sendEvent(runId, "file_update", {
                filename: f.filename,
                content: f.content.slice(0, upto),
              });
            }
            // ensure final full content is sent
            if (lastLen < len) {
              await sendEvent(runId, "file_update", {
                filename: f.filename,
                content: f.content,
              });
            }
            await sendEvent(runId, "file_saved", { filename: f.filename });
          }

          run.logs.push({ stepId: step.id, files });
          await sendEvent(runId, "step_success", { stepId: step.id, files });
        } else {
          run.logs.push({ stepId: step.id, info: `Unknown tool ${step.tool}` });
          await sendEvent(runId, "step_success", {
            stepId: step.id,
            info: `Unknown tool ${step.tool}`,
          });
        }
      } catch (e) {
        run.logs.push({ stepId: step.id, error: e.message || String(e) });
        await sendEvent(runId, "step_failed", {
          stepId: step.id,
          error: e.message || String(e),
        });
      }
    } // for

    run.status = "done";
    AGENT_RUNS.set(runId, run);
    await sendEvent(runId, "done", {
      final: { formatted_answer: "Agent run complete", sources: [] },
    });
  } // executePlan
}
