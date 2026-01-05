import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { prisma } from "./prisma";
import { createAudioRouter, audioRouter } from "./mediasoup/router";
import {
  getOrCreateRoom,
  createWebRtcTransport,
  removePeerFromRoom,
} from "./mediasoup/rooms";

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

  /* =========================
     CHAT
  ========================= */

  socket.on("join-room", async (roomId: string) => {
    socket.join(roomId);

    try {
      const history = await prisma.message.findMany({
        where: { roomId },
        orderBy: { createdAt: "asc" },
        include: { reactions: true },
      });

      socket.emit(
        "chat-history",
        history.map((msg: any) => ({
          socketId: "system",
          message: {
            id: msg.id,
            text: msg.text,
            createdAt: msg.createdAt.getTime(),
            sender: {
              id: msg.senderId,
              name: msg.senderName,
              avatarUrl: msg.senderAvatar,
            },
            pinned: msg.pinned,
            reactions: msg.reactions.reduce((acc: any, r: any) => {
              acc[r.emoji] ??= [];
              acc[r.emoji].push(r.userId);
              return acc;
            }, {}),
          },
        }))
      );
    } catch {
      socket.emit("chat-history", []);
    }
  });

  socket.on("send-message", async ({ roomId, message }) => {
    io.to(roomId).emit("receive-message", {
      socketId: socket.id,
      message,
    });

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
    } catch {}
  });

  /* =========================
     MEDIASOUP
  ========================= */

  socket.on("get-rtp-capabilities", async ({ roomId }, cb) => {
    const room = await getOrCreateRoom(roomId, audioRouter);
    cb({ rtpCapabilities: room.router.rtpCapabilities });
  });

  socket.on("join-mediasoup-room", async ({ roomId, rtpCapabilities }, cb) => {
    const room = await getOrCreateRoom(roomId, audioRouter);
    socket.join(roomId);

    room.peers.set(socket.id, {
      socketId: socket.id,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      rtpCapabilities,
    });

    const existingProducers: string[] = [];
    for (const [peerId, peer] of room.peers) {
      if (peerId !== socket.id) {
        peer.producers.forEach((p) => existingProducers.push(p.id));
      }
    }

    console.log(`🎧 Mediasoup ready for ${socket.id} in ${roomId}`);
    cb({ success: true, existingProducers });
  });

  socket.on("create-webrtc-transport", async ({ roomId, direction }, cb) => {
    const room = await getOrCreateRoom(roomId, audioRouter);
    const transport = await createWebRtcTransport(room.router);

    transport.appData.direction = direction;

    room.peers.get(socket.id)?.transports.set(transport.id, transport);

    cb({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });
  });

  socket.on(
    "connect-transport",
    async ({ roomId, transportId, dtlsParameters }, cb) => {
      const room = await getOrCreateRoom(roomId, audioRouter);
      const transport = room.peers.get(socket.id)?.transports.get(transportId);

      if (!transport) return cb({ error: "Transport not found" });

      await transport.connect({ dtlsParameters });
      cb({ success: true });
    }
  );

  /* =========================
     PRODUCE
  ========================= */

  socket.on(
    "produce",
    async ({ roomId, transportId, kind, rtpParameters }, cb) => {
      const room = await getOrCreateRoom(roomId, audioRouter);
      const peer = room.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);

      if (kind !== "audio") {
        return cb({ error: "Only audio is allowed" });
      }

      if (!transport) return cb({ error: "No transport" });

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { media: "audio" },
      });

      peer!.producers.set(producer.id, producer);

      socket.to(roomId).emit("new-producer", { producerId: producer.id });
      console.log(`🎤 Audio producer ${producer.id} from ${socket.id}`);


      cb({ id: producer.id });
    }
  );

  /* =========================
     CONSUME (FIXED)
  ========================= */

/* =========================
    CONSUME (FIXED)
========================= */
socket.on("consume", async ({ roomId, producerId, rtpCapabilities }, cb) => {
  try {
    const room = await getOrCreateRoom(roomId, audioRouter);
    const peer = room.peers.get(socket.id);
    if (!peer) throw new Error("Peer not found");

    // ✅ FIX: Specifically find the transport meant for receiving
    const transport = Array.from(peer.transports.values()).find(
      (t) => t.appData.direction === "recv"
    );

    if (!transport) throw new Error("No receive transport found");

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      return cb({ error: "Cannot consume" });
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    peer.consumers.set(consumer.id, consumer);

    cb({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  } catch (err: any) {
    cb({ error: err.message });
  }
});

  socket.on("resume-consumer", async ({ roomId, consumerId }) => {
    const room = await getOrCreateRoom(roomId, audioRouter);
    const consumer = room.peers.get(socket.id)?.consumers.get(consumerId);
    await consumer?.resume();
  });

  /* =========================
     CLEANUP
  ========================= */

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      removePeerFromRoom(roomId, socket.id);
    }
  });
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
