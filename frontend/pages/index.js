import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [messages, setMessages] = useState([]);

  // Auto-scroll to bottom when messages update
  const transcriptRef = useRef(null);
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages]);

  const pcRef = useRef(null);
  const micRef = useRef(null);
  const audioElRef = useRef(null);
  const dataChannelRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);

  // Track one active assistant item
  const currentAssistantItem = useRef(null);

  function addMessage(role, text) {
    if (!text || !text.trim()) return;
    setMessages((prev) => [...prev, { role, text }]);
  }

  function appendAssistantDelta(itemId, deltaText) {
    if (!deltaText) return;

    // If we’re starting a new assistant message
    if (currentAssistantItem.current === null) {
      currentAssistantItem.current = itemId;
      setMessages((prev) => [...prev, { role: "assistant", text: deltaText }]);
      return;
    }

    // Append delta to the current assistant message
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") return next;
      next[next.length - 1] = { ...last, text: last.text + deltaText };
      return next;
    });
  }

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
    try {
      analyserRef.current?.disconnect();
    } catch {}
    analyserRef.current = null;
  }

  async function startSession() {
    if (connecting || connected) return;
    setConnecting(true);

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

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioElRef.current = audioEl;
    pc.ontrack = (ev) => (audioEl.srcObject = ev.streams[0]);

    pc.oniceconnectionstatechange = () =>
      console.log("iceConnectionState:", pc.iceConnectionState);
    pc.onconnectionstatechange = () =>
      console.log("connectionState:", pc.connectionState);

    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    micRef.current = mic;
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    startMeter(mic);

    function handleEvent(event) {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        const raw = String(event.data || "").trim();
        if (raw) addMessage("assistant", raw);
        return;
      }

      if (msg?.type === "response.audio_transcript.delta") {
        appendAssistantDelta(msg.item_id, msg.delta);
        return;
      }

      if (msg?.type === "response.audio_transcript.done") {
        currentAssistantItem.current = null;
        return;
      }

      const t1 = msg?.delta?.content?.[0]?.text;
      const t2 = msg?.content?.[0]?.text;
      const t3 = msg?.output_text?.delta;
      const t4 = msg?.text;
      const text = t1 || t2 || t3 || t4;

      if (typeof text === "string" && text.trim()) {
        appendAssistantDelta("generic", text);
      }
    }

    const dc = pc.createDataChannel("oai-events");
    dataChannelRef.current = dc;
    dc.onopen = () => {
      console.log("client datachannel open");
      try {
        dc.send(
          JSON.stringify({
            type: "response.create",
            response: {
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

    pc.ondatachannel = (evt) => {
      console.log("ondatachannel from server:", evt.channel?.label);
      evt.channel.onmessage = handleEvent;
    };

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
    currentAssistantItem.current = null;
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

      <div
      ref={transcriptRef}
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

        {messages.filter((m) => (m.text || "").trim()).length === 0 ? (
          <div style={{ color: "#777" }}>No transcript yet…</div>
        ) : (
          messages
            .filter((m) => (m.text || "").trim())
            .map((m, i) => (
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
