// backend/server.js (ESM)
import express from "express";
import "dotenv/config";

const app = express();

// --- CORS ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // tighten in prod
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// --- Health check ---
app.get("/", (_req, res) => res.json({ ok: true, service: "voicechat-backend" }));
app.get("/hello", (_req, res) => res.json({ ok: true, message: "hello 👋" }));

// --- Realtime session (voice) ---
app.post("/session", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in env." });

    const { preferredLang } = req.body ?? {};

    const body = {
      model: "gpt-4o-realtime-preview",
      voice: "verse",
      modalities: ["audio", "text"],
      instructions: [
        preferredLang
          ? `Reply in ${preferredLang} unless the user asks for a different language.`
          : "Detect the user’s language from the transcript and reply in the same language.",
        "Keep replies concise and ALWAYS include a text transcript with the audio.",
        "Preserve numbers, units, product names, URLs, and code blocks verbatim."
      ].join(" "),
      input_audio_transcription: { model: "whisper-1" }, // auto language detection
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 300,
        create_response: true,
        interrupt_response: true
      }
    };

    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1"
        // "OpenAI-Project": process.env.OPENAI_PROJECT_ID, // only if your org uses Projects
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      console.error("Realtime /sessions error", r.status, data);
      return res.status(r.status).json({ error: "Upstream OpenAI error", status: r.status, details: data });
    }

    return res.json(data);
  } catch (err) {
    console.error("Error creating session:", err);
    return res.status(500).json({ error: "Failed to create realtime session." });
  }
});

// --- Translator sanity ping (so curl GET works) ---
app.get("/translate", (_req, res) => res.json({ ok: true, route: "translate" }));

// --- Multi-language Translator (strict JSON via chat.completions) ---
app.post("/translate", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in env." });

    const {
      text,
      targets,                 // e.g. ["fr","es","de","ar","zh"]
      source_lang,             // optional; "auto" if omitted
      formality = "neutral",   // "formal" | "neutral" | "casual"
      glossary = {}            // { "OpenAI":"OpenAI", "turbo lag":"turbo lag" }
    } = req.body ?? {};

    if (!text || !Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: "Provide 'text' and non-empty array 'targets'." });
    }

    const system = [
      "You are a professional multilingual translator.",
      "Output MUST be valid JSON (no markdown, no code fences, no prose).",
      "Rules:",
      "- Be faithful and idiomatic in the TARGET language.",
      "- Preserve meaning, tone, numbers, punctuation, emoji, and line breaks.",
      "- Do NOT translate code blocks, variable names, file paths, or URLs.",
      "- If a term appears in GLOSSARY, use its mapped target form exactly.",
      "- If text is already in a target language, return it unchanged for that target.",
      `- Formality: ${formality}.`
    ].join("\n");

    const userPayload = {
      instruction: "Translate the provided TEXT into each TARGET in 'targets'.",
      source_lang: source_lang || "auto",
      targets,
      glossary,
      text
    };

    // Force strict JSON via Chat Completions JSON mode
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              "Return ONLY a JSON object of the form:\n" +
              "{ \"source_lang\": \"<iso or 'auto-detected'>\", \"translations\": { \"<tgt>\": \"...\", ... } }\n" +
              "No explanations. Here is the input JSON:\n" +
              JSON.stringify(userPayload)
          }
        ]
      })
    });

    const raw = await r.text();
    if (process.env.DEBUG) {
      console.log("[/translate] upstream status:", r.status);
      console.log("[/translate] upstream raw (first 200):", raw.slice(0, 200));
    }

    let data;
    try { data = JSON.parse(raw); }
    catch {
      return res.status(502).json({ error: "Upstream non-JSON", raw });
    }

    if (!r.ok) {
      return res.status(r.status).json({ error: "OpenAI error", details: data });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return res.status(502).json({ error: "Missing JSON content from model", details: data });
    }

    let parsed;
    try { parsed = JSON.parse(content); }
    catch {
      return res.status(502).json({ error: "Model returned non-JSON content", content });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Error in /translate:", err);
    return res.status(500).json({ error: "Translation failed." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`backend running on http://localhost:${PORT}`));
