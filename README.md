# DropLink - P2P File Transfer

A browser-based peer-to-peer file transfer app using **React**, **WebRTC**, and **Socket.IO**.

## Architecture

```
User A  ←→  Server (signaling only)  ←→  User B
   │                                         │
   └──────────── WebRTC (direct P2P) ─────────┘
```

- **Server**: Node.js + Socket.IO — handles room creation, offer/answer/ICE relay only. Never touches file data.
- **Client**: React + WebRTC (`RTCPeerConnection` + `RTCDataChannel`) — splits files into 16KB chunks, streams them directly, reassembles on receiver side.

## Project Structure

```
p2p-transfer/
├── server/
│   ├── server.js         # Signaling server
│   └── package.json
└── client/
    ├── src/
    │   ├── App.jsx           # Main UI + screen routing
    │   ├── App.css           # Styles
    │   ├── main.jsx
    │   ├── hooks/
    │   │   ├── useWebRTC.js  # RTCPeerConnection + DataChannel logic
    │   │   └── useSocket.js  # Socket.IO connection
    │   └── utils/
    │       └── helpers.js    # formatBytes, generateRoomCode, etc.
    ├── index.html
    ├── vite.config.js
    └── package.json
```

## Setup & Run

### 1. Start the signaling server

```bash
cd server
npm install
npm run dev     # or: npm start
# Runs on http://localhost:3001
```

### 2. Start the client

```bash
cd client
npm install
npm run dev
# Runs on http://localhost:5173
```

### 3. Test P2P transfer

1. Open `http://localhost:5173` in **Browser A** → click **Send a file** → copy the 6-digit code
2. Open `http://localhost:5173` in **Browser B** (or another device on the same network) → paste the code → click **Join**
3. Both browsers establish a direct WebRTC channel — drag & drop a file on Browser A to send

## Environment Variables

Create `client/.env` to point to a remote signaling server:

```
VITE_SERVER_URL=https://your-signaling-server.com
```

## How It Works

### Signaling Phase (via server)
1. Host emits `create-room` → server stores room, confirms with `room-created`
2. Guest emits `join-room` → server confirms with `room-joined`, notifies host with `peer-joined`
3. Host creates `RTCPeerConnection`, creates `RTCDataChannel`, generates SDP offer → emits `offer`
4. Guest receives offer, creates answer → emits `answer`
5. Both sides exchange ICE candidates via `ice-candidate` events
6. WebRTC connection established — server is no longer involved

### File Transfer Phase (direct P2P)
1. Sender emits `file-meta` JSON (name, size, type) over the DataChannel
2. File is sliced into 16KB `ArrayBuffer` chunks and sent sequentially
3. A backpressure check (`bufferedAmount`) prevents overwhelming the channel
4. Sender emits `file-end` JSON when all chunks are sent
5. Receiver accumulates chunks in a buffer, creates a `Blob`, triggers browser download

## Key Design Decisions

| Decision | Why |
|---|---|
| 16KB chunk size | Balances throughput and DataChannel buffer limits |
| `ordered: true` DataChannel | Guarantees correct chunk reassembly |
| Backpressure check | Avoids `bufferedAmount` overflow on large files |
| `FileReader` API | Streams file from disk without loading full file to memory |
| QR code = room code | The QR encodes only the 6-digit number, not a URL |

## Limitations

- File size is limited by the **receiver's browser memory** (Blob construction)
- Only one-to-one transfers per room
- No resume on disconnect
- STUN only (no TURN) — may fail on strict enterprise NAT; add a TURN server for production
