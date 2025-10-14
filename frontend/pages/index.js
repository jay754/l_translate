import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [messages, setMessages] = useState([]); // [{role, text}]

  const pcRef = useRef(null);
  const micRef = useRef(null);
  const audioElRef = useRef(null);
  const dataChannelRef = useRef(null);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);

  // Track ongoing assistant items so we can append transcript deltas
  // itemId -> index in messages[]
  const itemIndexRef = useRef(new Map());
  // itemId -> current text buffer (for quick append)
  const itemTextRef = useRef(new Map());

  function addMessage(role, text) {
    if (!text) return;
    setMessages((prev) => [...prev, { role, text }]);
  }

  // Append/stream text for a given assistant item id
  function appendAssistantDelta(itemId, deltaText) {
    if (!deltaText) return;

    // If this is the first time we see this assistant item, create it
    if (!itemIndexRef.current.has(itemId)) {
      const newIndex = messages.length + (pendingAddsRef.current || 0);
      itemIndexRef.current.set(itemId, newIndex);
      itemTextRef.current.set(itemId, "");
      // Queue a new assistant message (empty for now)
      queueAddAssistantShell(itemId);
    }

    // Append to buffer
    const buf = (itemTextRef.current.get(itemId) || "") + deltaText;
    itemTextRef.current.set(itemId, buf);

    // Reflect in UI
    const idx = itemIndexRef.current.get(itemId);
    setMessages((prev) => {
      if (idx == null) return prev;
      const next = prev.slice();
      const existing = next[idx];
      if (!existing) return prev;
      next[idx] = { role: "assistant", text: buf };
      return next;
    });
  }

  // We need a way to insert a placeholder assistant message exactly once
  const pendingAddsRef = useRef(0);
  function queueAddAssistantShell(itemId) {
    pendingAddsRef.current += 1;
    setMessages((prev) => {
      pendingAddsRef.current -= 1;
      // Insert an empty assistant message; it will be filled by deltas
      return [...prev, { role: "assistant", text: "" }];
    });
  }

  // Spacebar toggles mute
  useEffect(() => {
    function onKeyDown(e) {
      if (e.code === "Space" && connected) {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        toggleMute();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connected, muted]);

  // Mic level meter
  function startMeter(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = audioCtxRef.current || new AudioCtx();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(100, Math.round(rms * 150)));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopMeter() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try { analyserRef.current?.disconnect(); } catch {}
    analyserRef.current = null;
  }

  async function startSession() {
    if (connecting || connected) return;
    setConnecting(true);

    // Get ephemeral token from backend (Express or Next API)
    let data;
    try {
      const r = await fetch("http://localhost:3001/session", { method: "POST" });
      data = await r.json();
    } catch (e) {
      console.error("Session fetch failed:", e);
    }

    const token = data?.client_secret?.value;
    if (!token) {
      alert("No realtime session token from backend.");
      setConnecting(false);
      return;
    }

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    // Remote audio
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioElRef.current = audioEl;
    pc.ontrack = (ev) => (audioEl.srcObject = ev.streams[0]);

    // Debug ICE/connection
    pc.oniceconnectionstatechange = () =>
      console.log("iceConnectionState:", pc.iceConnectionState);
    pc.onconnectionstatechange = () =>
      console.log("connectionState:", pc.connectionState);

    // Mic input
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    micRef.current = mic;
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    startMeter(mic);

    // ---- Data channels for text/events ----
    function handleEvent(event) {
      console.log("RTC DATA:", event.data);
      // Try to parse JSON; if not, show raw
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        if (event.data && String(event.data).trim()) {
          console.log("TEXT (raw):", String(event.data));
          addMessage("assistant", String(event.data));
        }
        return;
      }

      // Handle audio transcript streaming (assistant output)
      if (msg?.type === "response.audio_transcript.delta") {
        // The transcript fragment is in msg.delta
        const itemId = msg.item_id;
        const deltaText = msg.delta;
        appendAssistantDelta(itemId, deltaText);
        return;
      }

      if (msg?.type === "response.audio_transcript.done") {
        const itemId = msg.item_id;
        // No action needed; we already appended all deltas
        // But ensure final text is visible:
        const finalTranscript = msg.transcript;
        if (finalTranscript && !itemIndexRef.current.has(itemId)) {
          // Edge case: if we somehow missed deltas, add final
          addMessage("assistant", finalTranscript);
        }
        return;
      }

      // Generic fallbacks (some runtimes may send text deltas)
      const t1 = msg?.delta?.content?.[0]?.text;
      const t2 = msg?.content?.[0]?.text;
      const t3 = msg?.output_text?.delta;
      const t4 = msg?.text;
      const text = t1 || t2 || t3 || t4;

      if (typeof text === "string" && text.trim()) {
        console.log("TEXT:", text);
        addMessage("assistant", text);
      }
    }

    // Client-initiated channel
    const dc = pc.createDataChannel("oai-events");
    dataChannelRef.current = dc;
    dc.onopen = () => {
      console.log("client datachannel open");
      // Ask the model to introduce itself (responses will stream as audio + transcript deltas)
      try {
        dc.send(
          JSON.stringify({
            type: "response.create",
            response: {
              // Keep it English-only in frontend too (backend will enforce, but helps)
              instructions:
                "Only speak English. Introduce yourself briefly, then wait for the user.",
              modalities: ["audio", "text"],
            },
          })
        );
      } catch (e) {
        console.warn("dc.send failed:", e);
      }
    };
    dc.onmessage = handleEvent;

    // Server-initiated channel
    pc.ondatachannel = (evt) => {
      console.log("ondatachannel from server:", evt.channel?.label);
      evt.channel.onmessage = handleEvent;
    };

    // Offer → Answer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch(
      "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      }
    );
    const answer = { type: "answer", sdp: await sdpResp.text() };
    await pc.setRemoteDescription(answer);

    setConnected(true);
    setConnecting(false);
    addMessage("system", "Connected — speak to the assistant!");
  }

  function toggleMute() {
    const stream = micRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }

  function disconnect() {
    // cleanup
    try {
      micRef.current?.getTracks().forEach((t) => t.stop());
      pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop());
      pcRef.current?.close();
    } catch {}
    stopMeter();
    pcRef.current = null;
    micRef.current = null;
    dataChannelRef.current = null;
    audioElRef.current?.remove?.();
    audioElRef.current = null;
    itemIndexRef.current.clear();
    itemTextRef.current.clear();
    setConnected(false);
    setMuted(false);
    setConnecting(false);
    setLevel(0);
    setMessages([]);
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        marginTop: 60,
        fontFamily: "ui-sans-serif, system-ui",
      }}
    >
      <h1>🎙 AI Voice Chatbot</h1>
      <div style={{ fontSize: 14, color: "#666" }}>
        Space toggles mute — transcript below.
      </div>

      {!connected ? (
        <button
          onClick={startSession}
          disabled={connecting}
          style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #ccc" }}
        >
          {connecting ? "Connecting…" : "Start Talking"}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={toggleMute}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: "1px solid #ccc",
              background: muted ? "#fff5f5" : "#e7fff0",
            }}
          >
            {muted ? "🔇 Unmute (Space)" : "🎤 Mute (Space)"}
          </button>
          <button
            onClick={disconnect}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: "1px solid #ccc",
            }}
          >
            Disconnect
          </button>
        </div>
      )}

      {/* Mic meter */}
      <div
        style={{
          width: 280,
          height: 12,
          borderRadius: 999,
          border: "1px solid #ddd",
          background: "#f5f5f5",
          overflow: "hidden",
          marginTop: 10,
        }}
      >
        <div
          style={{
            width: `${level}%`,
            height: "100%",
            background:
              level > 70 ? "#ef4444" : level > 35 ? "#f59e0b" : "#10b981",
            transition: "width 80ms linear",
          }}
        />
      </div>

      {/* Transcript */}
      <div
        style={{
          width: 420,
          maxHeight: 360,
          overflowY: "auto",
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 8,
          marginTop: 12,
          background: "#fafafa",
        }}
      >
        {messages.length === 0 ? (
          <div style={{ color: "#777" }}>No transcript yet…</div>
        ) : (
          messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <b
                style={{
                  color:
                    m.role === "assistant"
                      ? "#2563eb"
                      : m.role === "system"
                      ? "#888"
                      : "#16a34a",
                }}
              >
                {m.role}:
              </b>{" "}
              {m.text}
            </div>
          ))
        )}
      </div>
    </main>
  );
}
