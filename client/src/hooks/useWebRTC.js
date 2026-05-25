import { useRef, useState, useCallback, useEffect } from "react";

const CHUNK_SIZE = 16 * 1024; // 16KB
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Free TURN server - fixes same-network issue
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

// Detect File System Access API support (Chrome/Edge yes, Firefox no)
const HAS_FS_ACCESS = typeof window !== "undefined" && "showSaveFilePicker" in window;

export function useWebRTC({ socket, roomCode, isHost }) {
  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const fileBufferRef = useRef([]);   // fallback: holds chunks in memory
  const fileWritableRef = useRef(null); // FS Access API: writable stream to disk
  const fileMetaRef = useRef(null);
  const receivedBytesRef = useRef(0);
  const sendQueueRef = useRef([]);
  const isSendingRef = useRef(false);

  const [connectionState, setConnectionState] = useState("idle");
  const [transferState, setTransferState] = useState(null);
  // { fileName, fileSize, progress, speed, status: 'sending'|'receiving'|'done'|'error' }

  const resetTransfer = useCallback(() => {
    fileBufferRef.current = [];
    fileWritableRef.current = null;
    fileMetaRef.current = null;
    receivedBytesRef.current = 0;
  }, []);

  const setupDataChannel = useCallback(
    (channel) => {
      channelRef.current = channel;
      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        console.log("[DC] Open");
        setConnectionState("connected");
      };

      channel.onclose = () => {
        console.log("[DC] Closed");
        setConnectionState("disconnected");
      };

      channel.onerror = (e) => {
        console.error("[DC] Error", e);
        setConnectionState("error");
      };

      let lastReceivedBytes = 0;
      let lastTime = Date.now();

      channel.onmessage = (e) => {
        const data = e.data;

        // JSON control messages
        if (typeof data === "string") {
          const msg = JSON.parse(data);

          if (msg.type === "file-meta") {
            resetTransfer();
            fileMetaRef.current = msg;
            setTransferState({
              fileName: msg.fileName,
              fileSize: msg.fileSize,
              progress: 0,
              speed: 0,
              status: "receiving",
              usingDiskStream: HAS_FS_ACCESS,
            });

            // Try to open a writable stream directly to disk (Chrome/Edge only)
            if (HAS_FS_ACCESS) {
              window
                .showSaveFilePicker({ suggestedName: msg.fileName })
                .then((handle) => handle.createWritable())
                .then((writable) => { fileWritableRef.current = writable; })
                .catch(() => {
                  // User cancelled the picker — fall back to Blob
                  fileWritableRef.current = null;
                });
            }
            return;
          }

          if (msg.type === "file-end") {
            if (fileWritableRef.current) {
              // FS Access path: close the stream — file is already on disk
              fileWritableRef.current.close().then(() => {
                setTransferState((prev) => ({ ...prev, progress: 100, status: "done" }));
                resetTransfer();
              });
            } else {
              // Blob fallback path (Firefox, or if user cancelled the picker)
              const blob = new Blob(fileBufferRef.current, {
                type: fileMetaRef.current?.fileType || "application/octet-stream",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = fileMetaRef.current?.fileName || "received-file";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 60000);
              setTransferState((prev) => ({ ...prev, progress: 100, status: "done" }));
              resetTransfer();
            }
            return;
          }
          return;
        }

        // Binary chunk
        if (fileWritableRef.current) {
          // FS Access path: write directly to disk, no memory accumulation
          fileWritableRef.current.write(data);
        } else {
          // Blob fallback: accumulate in memory
          fileBufferRef.current.push(data);
        }
        receivedBytesRef.current += data.byteLength;

        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        let speed = 0;
        if (elapsed >= 0.5) {
          speed = (receivedBytesRef.current - lastReceivedBytes) / elapsed;
          lastReceivedBytes = receivedBytesRef.current;
          lastTime = now;
        }

        const fileSize = fileMetaRef.current?.fileSize || 1;
        const progress = Math.min(
          100,
          Math.round((receivedBytesRef.current / fileSize) * 100)
        );

        setTransferState((prev) => ({
          ...prev,
          progress,
          speed: speed > 0 ? speed : prev?.speed || 0,
          status: "receiving",
        }));
      };
    },
    [resetTransfer]
  );

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && socket) {
        socket.emit("ice-candidate", { roomCode, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("[PC] State:", pc.connectionState);
      if (pc.connectionState === "connected") setConnectionState("connected");
      if (pc.connectionState === "failed") setConnectionState("error");
      if (pc.connectionState === "disconnected") setConnectionState("disconnected");
    };

    // Guest side: receive data channel
    pc.ondatachannel = (e) => {
      setupDataChannel(e.channel);
    };

    return pc;
  }, [socket, roomCode, setupDataChannel]);

  // Host creates offer after peer joins
  const startOffer = useCallback(async () => {
    const pc = createPeerConnection();
    const channel = pc.createDataChannel("file-transfer", {
      ordered: true,
    });
    setupDataChannel(channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", { roomCode, offer });
    setConnectionState("connecting");
  }, [createPeerConnection, setupDataChannel, socket, roomCode]);

  // Socket event handlers
  useEffect(() => {
    if (!socket) return;

    const handlePeerJoined = () => {
      if (isHost) startOffer();
    };

    const handleOffer = async ({ offer }) => {
      const pc = createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { roomCode, answer });
      setConnectionState("connecting");
    };

    const handleAnswer = async ({ answer }) => {
      await pcRef.current?.setRemoteDescription(
        new RTCSessionDescription(answer)
      );
    };

    const handleIceCandidate = async ({ candidate }) => {
      try {
        await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error("[ICE] Add failed:", e);
      }
    };

    const handlePeerDisconnected = () => {
      setConnectionState("disconnected");
    };

    socket.on("peer-joined", handlePeerJoined);
    socket.on("offer", handleOffer);
    socket.on("answer", handleAnswer);
    socket.on("ice-candidate", handleIceCandidate);
    socket.on("peer-disconnected", handlePeerDisconnected);

    return () => {
      socket.off("peer-joined", handlePeerJoined);
      socket.off("offer", handleOffer);
      socket.off("answer", handleAnswer);
      socket.off("ice-candidate", handleIceCandidate);
      socket.off("peer-disconnected", handlePeerDisconnected);
    };
  }, [socket, isHost, roomCode, startOffer, createPeerConnection]);

  // Buffered chunk sender to avoid overwhelming the channel
  const drainQueue = useCallback(() => {
    if (isSendingRef.current) return;
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open") return;

    isSendingRef.current = true;

    const send = () => {
      while (sendQueueRef.current.length > 0) {
        if (channel.bufferedAmount > CHUNK_SIZE * 8) {
          setTimeout(send, 50);
          return;
        }
        const chunk = sendQueueRef.current.shift();
        channel.send(chunk);
      }
      isSendingRef.current = false;
    };

    send();
  }, []);

  const sendFile = useCallback(
    (file) => {
      const channel = channelRef.current;
      if (!channel || channel.readyState !== "open") return;

      channel.send(
        JSON.stringify({
          type: "file-meta",
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
        })
      );

      setTransferState({
        fileName: file.name,
        fileSize: file.size,
        progress: 0,
        speed: 0,
        status: "sending",
      });

      const reader = new FileReader();
      let offset = 0;
      let sentBytes = 0;
      let lastTime = Date.now();
      let lastSentBytes = 0;

      const readNextChunk = () => {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
      };

      reader.onload = (e) => {
        const chunk = e.target.result;
        sendQueueRef.current.push(chunk);
        drainQueue();

        sentBytes += chunk.byteLength;
        offset += chunk.byteLength;

        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        let speed = 0;
        if (elapsed >= 0.3) {
          speed = (sentBytes - lastSentBytes) / elapsed;
          lastSentBytes = sentBytes;
          lastTime = now;
        }

        const progress = Math.min(100, Math.round((offset / file.size) * 100));
        setTransferState((prev) => ({
          ...prev,
          progress,
          speed: speed > 0 ? speed : prev?.speed || 0,
          status: "sending",
        }));

        if (offset < file.size) {
          readNextChunk();
        } else {
          // Wait for queue to drain then signal end
          const waitForDrain = () => {
            if (sendQueueRef.current.length === 0 && !isSendingRef.current) {
              channel.send(JSON.stringify({ type: "file-end" }));
              setTransferState((prev) => ({ ...prev, progress: 100, status: "done" }));
            } else {
              setTimeout(waitForDrain, 100);
            }
          };
          waitForDrain();
        }
      };

      readNextChunk();
    },
    [drainQueue]
  );

  const cleanup = useCallback(() => {
    channelRef.current?.close();
    pcRef.current?.close();
    channelRef.current = null;
    pcRef.current = null;
    setConnectionState("idle");
    setTransferState(null);
  }, []);

  return { connectionState, transferState, sendFile, cleanup };
}
