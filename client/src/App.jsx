import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import QRCode from "qrcode";
import { useWebRTC } from "./hooks/useWebRTC";
import { generateRoomCode, formatBytes, formatSpeed } from "./utils/helpers";
import "./App.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export default function App() {
  const socketRef = useRef(null);
  const [socket, setSocket] = useState(null);
  const [serverConnected, setServerConnected] = useState(false);

  const [screen, setScreen] = useState("home"); // home | host | join | transfer
  const [roomCode, setRoomCode] = useState("");
  const [joinInput, setJoinInput] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [peerReady, setPeerReady] = useState(false);
  const [error, setError] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const { connectionState, transferState, sendFile, cleanup } = useWebRTC({
    socket,
    roomCode,
    isHost,
  });

  // Init socket once
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = s;
    setSocket(s);
    s.on("connect", () => setServerConnected(true));
    s.on("disconnect", () => setServerConnected(false));
    return () => s.disconnect();
  }, []);

  // Socket room events
  useEffect(() => {
    if (!socket) return;

    socket.on("room-created", ({ roomCode: rc }) => {
      setRoomCode(rc);
      setScreen("host");
      generateQR(rc);
    });

    socket.on("room-joined", () => {
      setScreen("transfer");
    });

    socket.on("peer-joined", () => {
      setPeerReady(true);
      setScreen("transfer");
    });

    socket.on("error", ({ message }) => {
      setError(message);
    });

    socket.on("peer-disconnected", () => {
      setPeerReady(false);
      setError("Peer disconnected.");
    });

    return () => {
      socket.off("room-created");
      socket.off("room-joined");
      socket.off("peer-joined");
      socket.off("error");
      socket.off("peer-disconnected");
    };
  }, [socket]);

  // Reflect connection state
  useEffect(() => {
    if (connectionState === "connected") setPeerReady(true);
    if (connectionState === "disconnected" || connectionState === "error") setPeerReady(false);
  }, [connectionState]);

  async function generateQR(code) {
    try {
      const url = await QRCode.toDataURL(code, { width: 180, margin: 1 });
      setQrDataUrl(url);
    } catch {}
  }

  function handleCreateRoom() {
    if (!serverConnected) return;
    const code = generateRoomCode();
    setIsHost(true);
    setError("");
    socket.emit("create-room", { roomCode: code });
  }

  function handleJoinRoom() {
    const code = joinInput.trim();
    if (code.length !== 6 || !/^\d+$/.test(code)) {
      setError("Enter a valid 6-digit code.");
      return;
    }
    setIsHost(false);
    setError("");
    setRoomCode(code);
    socket.emit("join-room", { roomCode: code });
  }

  function handleReset() {
    cleanup();
    setScreen("home");
    setRoomCode("");
    setJoinInput("");
    setIsHost(false);
    setPeerReady(false);
    setError("");
    setQrDataUrl("");
  }

  const handleFileDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      if (!peerReady) return;
      const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
      if (file) sendFile(file);
    },
    [peerReady, sendFile]
  );

  const handleFileSelect = useCallback(
    (e) => {
      const file = e.target.files?.[0];
      if (file && peerReady) sendFile(file);
    },
    [peerReady, sendFile]
  );

  const statusDot = serverConnected ? "dot-on" : "dot-off";

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <path d="M11 2L4 7v8l7 5 7-5V7L11 2z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <path d="M7 11h8M11 7v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <span>DropLink</span>
        </div>
        <div className="server-status">
          <span className={`status-dot ${statusDot}`} />
          <span>{serverConnected ? "Connected" : "Connecting..."}</span>
        </div>
      </header>

      <main className="app-main">
        {screen === "home" && (
          <div className="screen-home">
            <div className="hero">
              <h1>Send files directly,<br />no middleman.</h1>
              <p className="hero-sub">
                Peer-to-peer transfers over WebRTC. Nothing stored, nothing logged.
              </p>
            </div>

            <div className="action-cards">
              <button className="action-card action-send" onClick={handleCreateRoom} disabled={!serverConnected}>
                <div className="card-icon">
                  <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                    <path d="M14 4v14M8 10l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M4 22h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                <span className="card-label">Send a file</span>
                <span className="card-desc">Create a room & share the code</span>
              </button>

              <div className="action-card action-receive">
                <div className="card-icon">
                  <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                    <path d="M14 24V10M8 18l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M4 6h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                <span className="card-label">Receive a file</span>
                <input
                  className="code-input"
                  type="text"
                  placeholder="Enter 6-digit code"
                  maxLength={6}
                  value={joinInput}
                  onChange={(e) => { setJoinInput(e.target.value.replace(/\D/g, "")); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleJoinRoom()}
                  disabled={!serverConnected}
                />
                <button className="join-btn" onClick={handleJoinRoom} disabled={!serverConnected || joinInput.length !== 6}>
                  Join
                </button>
              </div>
            </div>

            {error && <p className="error-msg">{error}</p>}

            <div className="features">
              {["End-to-end encrypted", "No file size limits*", "Zero storage", "Instant P2P"].map((f) => (
                <span key={f} className="feature-tag">{f}</span>
              ))}
            </div>
            <p className="footnote">* Limited by your browser's memory</p>
          </div>
        )}

        {screen === "host" && (
          <div className="screen-wait">
            <div className="wait-card">
              <h2>Waiting for peer…</h2>
              <p className="wait-sub">Share this code or QR with the other device</p>

              <div className="code-display">
                {roomCode.split("").map((d, i) => (
                  <span key={i} className="code-digit">{d}</span>
                ))}
              </div>

              {qrDataUrl && (
                <div className="qr-wrap">
                  <img src={qrDataUrl} alt="QR code" className="qr-img" />
                </div>
              )}

              <div className="pulse-ring">
                <div className="pulse-dot" />
              </div>

              <button className="btn-ghost" onClick={handleReset}>Cancel</button>
            </div>
          </div>
        )}

        {screen === "transfer" && (
          <div className="screen-transfer">
            <div className="transfer-card">
              <div className="peer-status">
                <span className={`status-dot ${peerReady ? "dot-on" : "dot-connecting"}`} />
                <span>{peerReady ? "Peer connected" : connectionState === "connecting" ? "Establishing P2P…" : "Waiting…"}</span>
              </div>

              {!transferState && peerReady && (
                <div
                  className={`drop-zone ${dragOver ? "drag-active" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleFileDrop}
                  onClick={() => document.getElementById("file-input").click()}
                >
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                    <rect x="8" y="12" width="24" height="20" rx="3" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M20 8v16M14 14l6-6 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <p className="drop-label">Drop a file here</p>
                  <p className="drop-sub">or click to browse</p>
                  <input id="file-input" type="file" hidden onChange={handleFileSelect} />
                </div>
              )}

              {!transferState && !peerReady && (
                <div className="waiting-peer">
                  <div className="spinner" />
                  <p>{connectionState === "connecting" ? "Setting up secure channel…" : "Waiting for peer…"}</p>
                </div>
              )}

              {transferState && (
                <div className="transfer-progress">
                  <div className="file-info">
                    <FileIcon type={transferState.fileName?.split(".").pop()} />
                    <div>
                      <p className="file-name">{transferState.fileName}</p>
                      <p className="file-size">{formatBytes(transferState.fileSize)}</p>
                    </div>
                    <StatusBadge status={transferState.status} />
                  </div>

                  <div className="progress-bar-wrap">
                    <div
                      className={`progress-bar-fill ${transferState.status === "done" ? "fill-done" : ""}`}
                      style={{ width: `${transferState.progress}%` }}
                    />
                  </div>

                  <div className="transfer-stats">
                    <span>{transferState.progress}%</span>
                    {transferState.speed > 0 && transferState.status !== "done" && (
                      <span>{formatSpeed(transferState.speed)}</span>
                    )}
                    {transferState.status === "done" && (
                      <span className="done-label">
                        {transferState.fileName?.split(".").pop() !== undefined ? "✓ Complete" : "✓ Done"}
                      </span>
                    )}
                  </div>

                  {transferState.status === "done" && peerReady && (
                    <button className="btn-ghost mt-8" onClick={() => { document.getElementById("file-input").click(); }}>
                      Send another file
                      <input id="file-input" type="file" hidden onChange={handleFileSelect} />
                    </button>
                  )}
                </div>
              )}

              <div className="transfer-footer">
                <span className="room-code-sm">Room: {roomCode}</span>
                <button className="btn-ghost-sm" onClick={handleReset}>Disconnect</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function FileIcon({ type }) {
  const colors = {
    pdf: "#e24b4a", jpg: "#1d9e75", jpeg: "#1d9e75", png: "#1d9e75",
    gif: "#7f77dd", mp4: "#ba7517", mp3: "#ba7517", zip: "#888780",
    txt: "#378add", doc: "#185fa5", docx: "#185fa5",
  };
  const color = colors[type?.toLowerCase()] || "#888780";
  return (
    <div className="file-icon" style={{ background: color + "22", color }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.02em" }}>
        {(type || "?").toUpperCase().slice(0, 4)}
      </span>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    sending: ["Sending", "badge-blue"],
    receiving: ["Receiving", "badge-amber"],
    done: ["Done", "badge-green"],
    error: ["Error", "badge-red"],
  };
  const [label, cls] = map[status] || ["—", "badge-gray"];
  return <span className={`badge ${cls}`}>{label}</span>;
}
