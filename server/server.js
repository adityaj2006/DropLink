const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://drop-link-p2p.vercel.app"
    ],
    methods: ["GET", "POST"],
  },
});

// roomCode -> { hostId, guestId }
const rooms = new Map();

app.get("/health", (req, res) => res.json({ status: "ok" }));

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Host creates a room
  socket.on("create-room", ({ roomCode }) => {
    if (rooms.has(roomCode)) {
      socket.emit("error", { message: "Room already exists" });
      return;
    }
    rooms.set(roomCode, { hostId: socket.id, guestId: null });
    socket.join(roomCode);
    socket.emit("room-created", { roomCode });
    console.log(`[Room] Created: ${roomCode} by ${socket.id}`);
  });

  // Guest joins a room
  socket.on("join-room", ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }
    if (room.guestId) {
      socket.emit("error", { message: "Room is full" });
      return;
    }
    room.guestId = socket.id;
    socket.join(roomCode);
    socket.emit("room-joined", { roomCode });

    // Notify host that a peer joined
    io.to(room.hostId).emit("peer-joined", { guestId: socket.id });
    console.log(`[Room] ${socket.id} joined ${roomCode}`);
  });

  // WebRTC signaling relay
  socket.on("offer", ({ roomCode, offer }) => {
    socket.to(roomCode).emit("offer", { offer, from: socket.id });
  });

  socket.on("answer", ({ roomCode, answer }) => {
    socket.to(roomCode).emit("answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ roomCode, candidate }) => {
    socket.to(roomCode).emit("ice-candidate", { candidate, from: socket.id });
  });

  // Cleanup on disconnect
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    for (const [code, room] of rooms.entries()) {
      if (room.hostId === socket.id || room.guestId === socket.id) {
        io.to(code).emit("peer-disconnected");
        rooms.delete(code);
        console.log(`[Room] Deleted: ${code}`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
