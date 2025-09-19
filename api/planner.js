// Simple planner for Agentic v3: multi-intent decomposition + vertical hints
// Module type: ESM (package.json has "type": "module")

import crypto from "crypto";

function uid() {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  ).toString();
}

function norm(s = "") {
  try {
    return String(s).normalize("NFKC").trim();
  } catch {
    return String(s).trim();
  }
}

function splitMultiIntent(original = "") {
  const parts = original
    .split(/\n+|(?:^|\s)(?:\d+\.|\d+\)|-)\s+/g)
    .map((x) => norm(x))
    .filter(Boolean);
  if (parts.length <= 1) return [norm(original)];
  return parts;
}

function classifyIntent(q) {
  const s = String(q || "").toLowerCase();
  if (s.includes("news") || /\b20\d{2}\b/.test(s)) return "news";
  if (s.includes("transcript") || s.includes("speech") || s.includes("launch"))
    return "transcript";
  if (s.includes("paper") || s.includes("theorem") || s.includes("research"))
    return "science";
  if (s.includes("image") || s.includes("chart") || s.includes("graph"))
    return "visual";
  return "general";
}

function verticalHints(intent) {
  switch (intent) {
    case "news":
      return ["web", "news", "twitter"];
    case "transcript":
      return ["web", "youtube"];
    case "science":
      return ["web", "wiki", "pdf"];
    case "visual":
      return ["web", "images"];
    default:
      return ["web", "wiki", "reddit"];
  }
}

export function planSubtasks(query, { mode = "deep", max = 6 } = {}) {
  const items = splitMultiIntent(query).slice(0, max);
  return items.map((q) => {
    const intent = classifyIntent(q);
    return {
      id: uid(),
      kind: intent,
      query: q,
      verticals: verticalHints(intent),
      mode,
    };
  });
}
