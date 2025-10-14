import { useMemo, useState } from "react";

const ALL_LANGS = [
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "de", label: "German" },
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "hi", label: "Hindi" }
];

export default function TranslatePage() {
  const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

  const [text, setText] = useState(
    "Turbo lag is the delay before a turbo makes boost.\nIt feels like nothing, then a sudden surge."
  );
  const [formality, setFormality] = useState("neutral"); // "formal" | "neutral" | "casual"
  const [targets, setTargets] = useState(["fr", "es", "de"]);
  const [customTarget, setCustomTarget] = useState("");
  const [glossaryInput, setGlossaryInput] = useState('{"turbo lag":"turbo lag"}');
  const [sourceLang, setSourceLang] = useState(""); // blank = auto
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState(null);
  const [error, setError] = useState(null);

  const glossary = useMemo(() => {
    try { return glossaryInput ? JSON.parse(glossaryInput) : {}; }
    catch { return null; }
  }, [glossaryInput]);

  function toggleTarget(code) {
    setTargets((prev) => prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]);
  }

  async function handleTranslate() {
    setError(null); setResp(null);
    if (!text.trim()) return setError("Please enter some text.");
    if (!targets.length) return setError("Select at least one target language.");
    if (glossary === null) return setError("Glossary is not valid JSON.");

    setLoading(true);
    try {
      const r = await fetch(`${BACKEND}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text, targets, formality, glossary,
          ...(sourceLang ? { source_lang: sourceLang } : {})
        })
      });
      const data = await r.json();
      if (!r.ok) setError(data?.error || "Translation failed.");
      else setResp(data);
    } catch (e) {
      setError(e?.message || "Network error.");
    } finally {
      setLoading(false);
    }
  }

  function addCustomTarget() {
    const code = (customTarget || "").trim().toLowerCase();
    if (!code) return;
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(code)) {
      setError("Custom code must be an ISO code like 'nl' or 'zh-CN'.");
      return;
    }
    setTargets((prev) => prev.includes(code) ? prev : [...prev, code]);
    setCustomTarget("");
  }

  return (
    <main style={{ minHeight: "100vh", background: "#f6f6f6", color: "#111" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
        <header style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Multi-language Translator</h1>
            <p style={{ color: "#666", marginTop: 6 }}>
              Posts to <code>{BACKEND}/translate</code> and shows the JSON result.
            </p>
          </div>
          <a href="/" style={{ fontSize: 14, color: "#2563eb" }}>← Voice Chat</a>
        </header>

        {/* Text */}
        <section style={{ marginTop: 16 }}>
          <label style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            Text to translate
          </label>
          <textarea
            style={{ width: "100%", height: 160, padding: 12, border: "1px solid #ddd", borderRadius: 6 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </section>

        {/* Options */}
        <section style={{ display: "grid", gridTemplateColumns: "1fr", gap: 24, marginTop: 16 }}>
          {/* Targets */}
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Target languages</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              {ALL_LANGS.map((l) => (
                <label key={l.code} style={{ display: "flex", gap: 8, fontSize: 14 }}>
                  <input type="checkbox" checked={targets.includes(l.code)} onChange={() => toggleTarget(l.code)} />
                  <span>{l.label} <span style={{ color: "#777", fontSize: 12 }}>({l.code})</span></span>
                </label>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                style={{ flex: 1, border: "1px solid #ddd", borderRadius: 6, padding: 8 }}
                placeholder="Custom ISO code (e.g., nl, zh-TW)"
                value={customTarget}
                onChange={(e) => setCustomTarget(e.target.value)}
              />
              <button onClick={addCustomTarget} type="button"
                style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: 6 }}>
                Add
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
              Selected: <code>{targets.join(", ") || "(none)")}</code>
            </div>
          </div>

          {/* Formality + Source */}
          <div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Formality</label>
              <select
                style={{ width: "100%", border: "1px solid #ddd", borderRadius: 6, padding: 8 }}
                value={formality}
                onChange={(e) => setFormality(e.target.value)}
              >
                <option value="formal">formal</option>
                <option value="neutral">neutral</option>
                <option value="casual">casual</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                Source language (optional)
              </label>
              <input
                style={{ width: "100%", border: "1px solid #ddd", borderRadius: 6, padding: 8 }}
                placeholder="Leave blank for auto (e.g., en, fr, es)"
                value={sourceLang}
                onChange={(e) => setSourceLang(e.target.value)}
              />
              <p style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                If set, we’ll skip autodetect. Use ISO code like <code>en</code>.
              </p>
            </div>
          </div>

          {/* Glossary */}
          <div>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Glossary (JSON)</label>
            <textarea
              style={{
                width: "100%", height: 110, padding: 8, border: "1px solid #ddd",
                borderRadius: 6, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13
              }}
              value={glossaryInput}
              onChange={(e) => setGlossaryInput(e.target.value)}
            />
            <p style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
              Example: <code>{'{"OpenAI":"OpenAI","turbo lag":"turbo lag"}'}</code>
            </p>
          </div>
        </section>

        {/* Actions */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
          <button
            onClick={handleTranslate}
            disabled={loading}
            style={{ padding: "10px 14px", borderRadius: 6, background: "#111", color: "#fff", fontSize: 14, opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Translating..." : "Translate"}
          </button>
          {error && <span style={{ color: "#c00", fontSize: 14 }}>{error}</span>}
        </div>

        {/* Result */}
        <section style={{ marginTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Result</div>
          {!resp ? (
            <div style={{ color: "#666", fontSize: 14 }}>No result yet.</div>
          ) : (
            <div style={{ border: "1px solid #ddd", borderRadius: 8, background: "#fff" }}>
              <div style={{ padding: 12, borderBottom: "1px solid #eee", fontSize: 14 }}>
                <b>Detected source:</b> <code>{resp.source_lang}</code>
              </div>
              <div style={{ padding: 12 }}>
                <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#666" }}>
                      <th style={{ padding: "8px 8px 8px 0", width: 100 }}>Target</th>
                      <th style={{ padding: "8px 0" }}>Translation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(resp.translations).map(([tgt, out]) => (
                      <tr key={tgt} style={{ borderTop: "1px solid #eee" }}>
                        <td style={{ padding: "8px 8px 8px 0" }}><code>{tgt}</code></td>
                        <td style={{ padding: "8px 0", whiteSpace: "pre-wrap" }}>{out}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <footer style={{ marginTop: 16, fontSize: 12, color: "#666" }}>
          tip: set <code>NEXT_PUBLIC_BACKEND_URL</code> in <code>.env.local</code> to point to your server.
        </footer>
      </div>
    </main>
  );
}
