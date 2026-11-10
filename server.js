import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://api.dicebear.com", "https://api.qrserver.com"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "20kb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many AI requests. Please try again later." }
});
app.use("/api/", apiLimiter);

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validNumber(value, min = 0, max = 100000) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(client) });
});

app.post("/api/coach", async (req, res) => {
  if (!client) {
    return res.status(503).json({ error: "AI coach is not configured on the server." });
  }

  const body = req.body || {};
  const rawMessages = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
  const messages = rawMessages
    .filter((item) => item && ["user", "assistant"].includes(item.role))
    .map((item) => ({
      role: item.role,
      content: cleanText(item.content, 1500)
    }))
    .filter((item) => item.content);

  if (!messages.length || !messages.some((item) => item.role === "user")) {
    return res.status(400).json({ error: "A user message is required." });
  }

  const raw = body.profile && typeof body.profile === "object" ? body.profile : {};
  const profile = {
    name: cleanText(raw.name, 60),
    steps: validNumber(raw.steps, 0, 1000000),
    points: validNumber(raw.points, 0, 10000000),
    streak: validNumber(raw.streak, 0, 10000),
    workouts: validNumber(raw.workouts, 0, 100000),
    height: validNumber(raw.height, 0, 300),
    weight: validNumber(raw.weight, 0, 500),
    goal: ["gain", "lose", "maintain"].includes(raw.goal) ? raw.goal : "maintain",
    health: raw.health && typeof raw.health === "object"
      ? {
          bmi: validNumber(raw.health.bmi, 0, 100),
          maintenance: validNumber(raw.health.maintenance, 0, 20000),
          protein: validNumber(raw.health.protein, 0, 1000)
        }
      : null
  };

  const system = [
    "You are Trainer, the friendly, encouraging AI Personal Coach inside the FitCampus fitness app.",
    "Give concise, practical, upbeat replies (2-5 sentences, occasionally a short list).",
    `Use this user profile only when relevant: ${JSON.stringify(profile)}.`,
    "You can discuss general workouts, nutrition basics, motivation, activity habits, streaks, points, tasks and challenges.",
    "Do not give medical diagnoses or extreme diet/exercise advice. Suggest consulting a qualified professional for injuries or medical concerns."
  ].join(" ");

  try {
    const result = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system,
      messages
    });
    const reply = (result.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();

    if (!reply) return res.status(502).json({ error: "The AI service returned an empty response." });
    return res.json({ reply });
  } catch (error) {
    console.error("Coach API error:", error?.status || error?.name || "unknown");
    return res.status(502).json({ error: "The AI coach is temporarily unavailable." });
  }
});

app.post("/api/task-suggestion", async (req, res) => {
  if (!client) {
    return res.status(503).json({ error: "AI task suggestions are not configured on the server." });
  }

  const body = req.body || {};
  const goal = ["gain", "lose", "maintain"].includes(body.goal) ? body.goal : "maintain";
  const activity = ["Sedentary", "Light", "Moderate", "Active", "Very Active"].includes(body.activity)
    ? body.activity
    : "Light";
  const bmi = validNumber(body.bmi, 0, 100);

  const system = [
    "Suggest one short, specific, safe, actionable daily fitness or wellbeing task (under 12 words).",
    `The user's goal is ${goal}; activity level is ${activity}.`,
    bmi === null ? "BMI was not provided." : `BMI value supplied by the app: ${bmi}.`,
    "Reply with only the task text, without quotes or extra explanation.",
    "Avoid extreme exercise, restrictive eating, or weight-loss pressure."
  ].join(" ");

  try {
    const result = await client.messages.create({
      model: MODEL,
      max_tokens: 60,
      system,
      messages: [{ role: "user", content: "Suggest one suitable daily task." }]
    });
    const suggestion = (result.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()
      .replace(/^["']|["']$/g, "");

    if (!suggestion) return res.status(502).json({ error: "The AI service returned an empty suggestion." });
    return res.json({ text: suggestion.slice(0, 120) });
  } catch (error) {
    console.error("Task suggestion API error:", error?.status || error?.name || "unknown");
    return res.status(502).json({ error: "AI task suggestions are temporarily unavailable." });
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

app.listen(PORT, () => {
  console.log(`FitCampus running at http://localhost:${PORT}`);
  if (!client) console.warn("ANTHROPIC_API_KEY is missing. AI features will use frontend fallbacks.");
});
