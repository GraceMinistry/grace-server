import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { prisma } from "./prisma";
import { createAudioRouter, audioRouter } from "./mediasoup/router";
import { getOrCreateRoom, createWebRtcTransport, removePeerFromRoom } from "./mediasoup/rooms";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

(async () => {
  try {
    await createAudioRouter();
  } catch (err) {
    console.error("🛑 Mediasoup Bootstrap Failed:", err);
  }
})();

io.on("connection", (socket) => {
  console.log("✅ user connected:", socket.id);

  /* =====================================================
      🚀 THE UNIFIED JOIN (Fixes Chat + Media)
  ===================================================== */
  
  socket.on("join-room", async (roomId: string) => {
    // 1. Join Socket.io room immediately for CHAT
    socket.join(roomId);
    console.log(`💬 User ${socket.id} joined Chat Room: ${roomId}`);

    // 2. Fetch Chat History (Protected from DB crash)
    try {
      const history = await prisma.message.findMany({
        where: { roomId },
        orderBy: { createdAt: "asc" },
        include: { reactions: true },
      });

      const formattedHistory = history.map((msg: any) => {
        const reactionsGrouped: Record<string, string[]> = {};
        msg.reactions.forEach((r: any) => {
          if (!reactionsGrouped[r.emoji]) reactionsGrouped[r.emoji] = [];
          reactionsGrouped[r.emoji].push(r.userId);
        });

        return {
          socketId: "system",
          message: {
            id: msg.id,
            text: msg.text,
            createdAt: msg.createdAt.getTime(),
            sender: { id: msg.senderId, name: msg.senderName, avatarUrl: msg.senderAvatar },
            replyToId: msg.replyToId,
            reactions: reactionsGrouped,
            pinned: msg.pinned,
          },
        };
      });
      socket.emit("chat-history", formattedHistory);
    } catch (err) {
      console.error("❌ DB Down, history empty");
      socket.emit("chat-history", []);
    }
  });

  // This is the specific Mediasoup join (Keep this separate for the Device handshake)
  socket.on("join-mediasoup-room", async ({ roomId, rtpCapabilities }, callback) => {
    try {
      const room = await getOrCreateRoom(roomId, audioRouter);
      
      // Ensure they are in the Socket.io room too just in case
      socket.join(roomId); 

      room.peers.set(socket.id, {
        socketId: socket.id,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        rtpCapabilities,
      });
      
      console.log(`🎧 Mediasoup state ready for ${socket.id} in ${roomId}`);
      callback({ success: true });
    } catch (err) {
      callback({ error: "Failed to join mediasoup room" });
    }
  });

  /* =====================================================
      💬 CHAT SENDING LOGIC (Fixed to use io.to(roomId))
  ===================================================== */

  socket.on("send-message", async ({ roomId, message }) => {
    // This sends the message to everyone who called socket.join(roomId)
    io.to(roomId).emit("receive-message", { socketId: socket.id, message });

    try {
      await prisma.message.create({
        data: {
          id: message.id,
          roomId,
          text: message.text,
          senderId: message.sender.id,
          senderName: message.sender.name,
          senderAvatar: message.sender.avatarUrl,
          createdAt: new Date(message.createdAt),
        },
      });
    } catch (err) {
      console.error("❌ Message not saved to DB");
    }
  });

  /* =====================================================
      🚀 MEDIASOUP TRANSPORTS (Keep these)
  ===================================================== */

  socket.on("get-rtp-capabilities", async ({ roomId }, callback) => {
    try {
      const room = await getOrCreateRoom(roomId, audioRouter);
      callback({ rtpCapabilities: room.router.rtpCapabilities });
    } catch (err) {
      callback({ error: "Failed" });
    }
  });

  socket.on("create-webrtc-transport", async ({ roomId }, callback) => {
    try {
      const room = await getOrCreateRoom(roomId, audioRouter);
      const transport = await createWebRtcTransport(room.router);
      const peer = room.peers.get(socket.id);
      if (peer) peer.transports.set(transport.id, transport);

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (err: any) {
      callback({ error: err.message });
    }
  });

  socket.on("connect-transport", async ({ roomId, transportId, dtlsParameters }, callback) => {
    try {
      const room = await getOrCreateRoom(roomId, audioRouter);
      const peer = room.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (transport) {
        await transport.connect({ dtlsParameters });
        callback({ success: true });
      }
    } catch (err: any) {
      callback({ error: err.message });
    }
  });

  /* =====================================================
      🧹 CLEANUP
  ===================================================== */

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        removePeerFromRoom(roomId, socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));