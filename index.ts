import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { prisma } from "./prisma";
import { createMediaRouter, mediaRouter } from "./mediasoup/router";
import {
  getOrCreateRoom,
  createWebRtcTransport,
  removePeerFromRoom,
} from "./mediasoup/rooms";

const app = express();
app.use(cors());
app.use(express.json());

// Debug endpoint to inspect room state
app.get("/debug/room/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { getRoom } = require("./mediasoup/rooms");
    const room = getRoom(roomId);

    if (!room) {
      return res.json({ error: "Room not found", roomId });
    }

    const peers: any[] = [];
    room.peers.forEach((peer: any, peerId: string) => {
      peers.push({
        peerId,
        name: peer.name,
        isHost: peer.isHost,
        transports: Array.from(peer.transports.values()).map((t: any) => ({
          id: t.id,
          direction: t.appData.direction,
          iceState: t.iceState,
          dtlsState: t.dtlsState,
          closed: t.closed,
        })),
        producers: Array.from(peer.producers.values()).map((p: any) => ({
          id: p.id,
          kind: p.kind,
          paused: p.paused,
          closed: p.closed,
        })),
        consumers: Array.from(peer.consumers.values()).map((c: any) => ({
          id: c.id,
          kind: c.kind,
          producerId: c.producerId,
          paused: c.paused,
          closed: c.closed,
        })),
      });
    });

    res.json({
      roomId,
      routerClosed: room.router.closed,
      peerCount: room.peers.size,
      peers,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Recording state
const recordings = new Map<string, { startTime: number }>();

(async () => {
  try {
    await createMediaRouter();
  } catch (err) {
    console.error("🛑 Mediasoup Bootstrap Failed:", err);
  }
})();

io.on("connection", (socket) => {
  console.log("✅ user connected:", socket.id);

  // Store userId in socket data when provided
  socket.on("set-user-id", (userId: string) => {
    (socket as any).data = { ...((socket as any).data || {}), userId };
    console.log(`🆔 Socket ${socket.id} mapped to user ${userId}`);
  });

  /* =========================
     CHAT
  ========================= */

  socket.on(
    "join-room",
    async ({ roomId, userId, userName, userImageUrl }: any) => {
      console.log("📥 join-room received:", {
        roomId,
        userId,
        userName,
        userImageUrl,
      });

      // Validate required fields
      if (!roomId || !userId || !userName) {
        console.error("❌ Missing required fields for join-room");
        socket.emit("error", {
          message:
            "Missing required fields: roomId, userId, and userName are required",
        });
        return;
      }

      socket.join(roomId);

      try {
        // Check if room exists, if not create it
        let room = await prisma.room.findUnique({ where: { id: roomId } });

        if (!room) {
          room = await prisma.room.create({
            data: {
              id: roomId,
              creatorId: userId,
            },
          });
          console.log(`🏠 Created new room ${roomId} with creator ${userId}`);
        }

        // Check if user is already a participant
        let participant = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        // If not, create participant entry
        if (!participant) {
          const role = userId === room.creatorId ? "HOST" : "PARTICIPANT";
          participant = await prisma.roomParticipant.create({
            data: {
              roomId,
              userId,
              name: userName,
              imageUrl: userImageUrl,
              role,
            },
          });
          console.log(`✅ ${userName} joined as ${role} (NEW)`);
        } else {
          // Update existing participant info (in case name or image changed)
          participant = await prisma.roomParticipant.update({
            where: {
              roomId_userId: {
                roomId,
                userId,
              },
            },
            data: {
              name: userName,
              imageUrl: userImageUrl,
            },
          });
          console.log(`♻️ ${userName} rejoined (EXISTING)`);
        }

        // Fetch all active participants
        const participants = await prisma.roomParticipant.findMany({
          where: { roomId },
        });

        console.log(
          `📋 Room ${roomId} has ${participants.length} participants`
        );

        // Broadcast participant list to all in room
        io.to(roomId).emit(
          "participant-list-update",
          participants.map((p) => ({
            id: p.userId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: p.isAudioMuted,
            isVideoPaused: p.isVideoPaused,
            isHost: p.role === "HOST",
          }))
        );

        // Send chat history
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
      } catch (err) {
        console.error("Error in join-room:", err);
        socket.emit("chat-history", []);
      }
    }
  );

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
     ROOM CONTROLS (HOST ONLY)
  ========================= */

  socket.on(
    "toggle-remote-audio",
    async ({ roomId, userId, targetUserId, force }: any) => {
      try {
        // Check if requester has HOST role
        const requester = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        if (!requester || requester.role !== "HOST") {
          console.log(`❌ ${userId} tried to mute but is not HOST`);
          return;
        }

        // Update target user's audio state
        await prisma.roomParticipant.update({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
          data: {
            isAudioMuted: force === "mute",
          },
        });

        // Find target's socket ID and emit force-mute
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          targetSocket.emit("force-mute", {
            audio: force === "mute",
            by: requester.name,
          });
          console.log(
            `🔇 HOST ${requester.name} ${
              force === "mute" ? "muted" : "unmuted"
            } ${targetUserId}`
          );
        }

        // Broadcast updated participant list
        const participants = await prisma.roomParticipant.findMany({
          where: { roomId },
        });

        io.to(roomId).emit(
          "participant-list-update",
          participants.map((p) => ({
            id: p.userId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: p.isAudioMuted,
            isVideoPaused: p.isVideoPaused,
            isHost: p.role === "HOST",
          }))
        );
      } catch (err) {
        console.error("Error in toggle-remote-audio:", err);
      }
    }
  );

  socket.on(
    "toggle-remote-video",
    async ({ roomId, userId, targetUserId, force }: any) => {
      try {
        // Check if requester has HOST role
        const requester = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        if (!requester || requester.role !== "HOST") {
          console.log(`❌ ${userId} tried to control video but is not HOST`);
          return;
        }

        // Update target user's video state
        await prisma.roomParticipant.update({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
          data: {
            isVideoPaused: force === "pause",
          },
        });

        // Find target's socket and emit force-video-pause
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          targetSocket.emit("force-video-pause", {
            video: force === "pause",
            by: requester.name,
          });
          console.log(
            `📹 HOST ${requester.name} ${
              force === "pause" ? "paused" : "unpaused"
            } video of ${targetUserId}`
          );
        }

        // Broadcast updated participant list
        const participants = await prisma.roomParticipant.findMany({
          where: { roomId },
        });

        io.to(roomId).emit(
          "participant-list-update",
          participants.map((p) => ({
            id: p.userId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: p.isAudioMuted,
            isVideoPaused: p.isVideoPaused,
            isHost: p.role === "HOST",
          }))
        );
      } catch (err) {
        console.error("Error in toggle-remote-video:", err);
      }
    }
  );

  socket.on(
    "remove-participant",
    async ({ roomId, userId, targetUserId }: any) => {
      try {
        // Check if requester has HOST role
        const requester = await prisma.roomParticipant.findUnique({
          where: {
            roomId_userId: {
              roomId,
              userId,
            },
          },
        });

        if (!requester || requester.role !== "HOST") {
          console.log(
            `❌ ${userId} tried to remove participant but is not HOST`
          );
          return;
        }

        // Delete participant from DB
        await prisma.roomParticipant.delete({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId,
            },
          },
        });

        // Find target's socket and force disconnect
        const targetSockets = await io.in(roomId).fetchSockets();
        const targetSocket = targetSockets.find(
          (s: any) => s.data?.userId === targetUserId
        );

        if (targetSocket) {
          targetSocket.emit("kicked-from-room", {
            by: requester.name,
            reason: "Removed by host",
          });
          targetSocket.leave(roomId);
          console.log(
            `🚫 HOST ${requester.name} removed ${targetUserId} from room`
          );
        }

        // Broadcast updated participant list
        const participants = await prisma.roomParticipant.findMany({
          where: { roomId },
        });

        io.to(roomId).emit(
          "participant-list-update",
          participants.map((p) => ({
            id: p.userId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: p.isAudioMuted,
            isVideoPaused: p.isVideoPaused,
            isHost: p.role === "HOST",
          }))
        );
      } catch (err) {
        console.error("Error in remove-participant:", err);
      }
    }
  );

  /* =========================
     MEDIASOUP
  ========================= */

  socket.on("get-rtp-capabilities", async ({ roomId }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      cb({ rtpCapabilities: room.router.rtpCapabilities });
    } catch (err: any) {
      console.error("Error getting RTP capabilities:", err);
      cb({ error: err.message });
    }
  });

  socket.on(
    "join-mediasoup-room",
    async (
      { roomId, rtpCapabilities, userName, userImageUrl, isCreator, userId },
      cb
    ) => {
      try {
        console.log(
          `🔍 JOIN REQUEST - User: ${userName}, UserId: ${userId}, Image: ${userImageUrl}, Creator: ${isCreator}`
        );

        // ====== PREVENT DUPLICATE JOINS ======
        const room = await getOrCreateRoom(roomId);
        const existingPeer = room.peers.get(socket.id);

        if (existingPeer) {
          console.log(
            `⚠️ ${userName} already joined - ignoring duplicate call`
          );

          // ✅ FIXED: Still return existing producers with full details
          const existingProducers: Array<{
            producerId: string;
            peerId: string;
            kind: string;
            isScreenShare: boolean;
          }> = [];
          for (const [peerId, peer] of room.peers) {
            if (peerId !== socket.id) {
              peer.producers.forEach((producer) => {
                existingProducers.push({
                  producerId: producer.id,
                  peerId: peerId,
                  kind: producer.kind,
                  isScreenShare: producer.appData?.share === true,
                });
              });
            }
          }
          return cb({ success: true, existingProducers, alreadyJoined: true });
        }

        // ====== MAP USERID EARLY ======
        if (userId) {
          socket.data.userId = userId;
          console.log(`🆔 Socket ${socket.id} mapped to user ${userId}`);
        }

        // ====== DATABASE PARTICIPANT STORAGE ======
        if (userId && userName) {
          try {
            // Check if room exists in DB, if not create it
            let dbRoom = await prisma.room.findUnique({
              where: { id: roomId },
            });

            if (!dbRoom) {
              dbRoom = await prisma.room.create({
                data: {
                  id: roomId,
                  creatorId: userId,
                },
              });
              console.log(
                `🏠 Created DB room ${roomId} with creator ${userId}`
              );
            }

            // Check if user is already a participant in DB
            let dbParticipant = await prisma.roomParticipant.findUnique({
              where: {
                roomId_userId: {
                  roomId,
                  userId,
                },
              },
            });

            // Create or update participant in DB
            if (!dbParticipant) {
              const role = userId === dbRoom.creatorId ? "HOST" : "PARTICIPANT";
              dbParticipant = await prisma.roomParticipant.create({
                data: {
                  roomId,
                  userId,
                  name: userName,
                  imageUrl: userImageUrl,
                  role,
                },
              });
              console.log(`✅ ${userName} joined as ${role} (NEW in DB)`);
            } else {
              // Update existing participant info
              dbParticipant = await prisma.roomParticipant.update({
                where: {
                  roomId_userId: {
                    roomId,
                    userId,
                  },
                },
                data: {
                  name: userName,
                  imageUrl: userImageUrl,
                },
              });
              console.log(`♻️ ${userName} rejoined (EXISTING in DB)`);
            }
          } catch (dbError) {
            console.error("❌ Database error:", dbError);
            // Continue with mediasoup even if DB fails
          }
        }

        // ====== MEDIASOUP SETUP ======
        socket.join(roomId);

        // ✅ If room is empty, first person becomes host automatically
        const isFirstPerson = room.peers.size === 0;
        const shouldBeHost = isCreator === true || isFirstPerson;

        console.log(
          `🎯 isCreator: ${isCreator}, isFirstPerson: ${isFirstPerson}, shouldBeHost: ${shouldBeHost}`
        );

        // ✅ CRITICAL: Create peer with user info from client
        room.peers.set(socket.id, {
          socketId: socket.id,
          name: userName || "User " + socket.id.slice(0, 4),
          imageUrl: userImageUrl || null,
          isHost: shouldBeHost,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
          rtpCapabilities,
        });

        // ✅ FIXED: Include peerId and producer details for existing producers
        const existingProducers: Array<{
          producerId: string;
          peerId: string;
          kind: string;
          isScreenShare: boolean;
        }> = [];
        for (const [peerId, peer] of room.peers) {
          if (peerId !== socket.id) {
            peer.producers.forEach((producer) => {
              existingProducers.push({
                producerId: producer.id,
                peerId: peerId,
                kind: producer.kind,
                isScreenShare: producer.appData?.share === true,
              });
            });
          }
        }

        // ✅ CRITICAL: Get participant list from DATABASE if available
        let participants;
        try {
          const dbParticipants = await prisma.roomParticipant.findMany({
            where: { roomId },
          });

          if (dbParticipants.length > 0) {
            // Use DB data with accurate audio/video states
            const participantMap = new Map();

            dbParticipants.forEach((p) => {
              // Deduplicate by userId - keep only one entry per user
              if (!participantMap.has(p.userId)) {
                participantMap.set(p.userId, {
                  id: p.userId,
                  name: p.name,
                  imageUrl: p.imageUrl,
                  isAudioMuted: p.isAudioMuted,
                  isVideoPaused: p.isVideoPaused,
                  isHost: p.role === "HOST",
                });
              }
            });

            participants = Array.from(participantMap.values());
            console.log(
              `📋 Using DB participant list (${participants.length} unique participants from ${dbParticipants.length} DB entries)`
            );
          } else {
            // Fallback to in-memory peers if DB is empty
            participants = Array.from(room.peers.values()).map((p) => ({
              id: p.socketId,
              name: p.name,
              imageUrl: p.imageUrl,
              isAudioMuted: false,
              isVideoPaused: false,
              isHost: p.isHost || false,
            }));
            console.log(
              `📋 Using memory participant list (${participants.length} participants)`
            );
          }
        } catch (dbError) {
          console.error("❌ Error fetching participants from DB:", dbError);
          // Fallback to in-memory peers
          participants = Array.from(room.peers.values()).map((p) => ({
            id: p.socketId,
            name: p.name,
            imageUrl: p.imageUrl,
            isAudioMuted: false,
            isVideoPaused: false,
            isHost: p.isHost || false,
          }));
        }

        console.log(`📤 SENDING PARTICIPANT LIST:`, participants);

        // ✅ MUST use io.to() not socket.to() - includes sender
        io.to(roomId).emit("participant-list-update", participants);

        // ✅ Notify other peers that a new consumer is ready
        socket.to(roomId).emit("new-peer-joined", {
          peerId: socket.id,
          name: userName,
          imageUrl: userImageUrl,
        });

        console.log(`🎧 Mediasoup ready for ${socket.id} in ${roomId}`);
        cb({ success: true, existingProducers });
      } catch (err: any) {
        console.error("Error joining mediasoup room:", err);
        cb({ error: err.message });
      }
    }
  );

  socket.on("create-webrtc-transport", async ({ roomId, direction }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);

      if (!peer) {
        console.error(
          `❌ Peer not found for ${socket.id} - did you call join-mediasoup-room?`
        );
        return cb({ error: "Peer not found. Call join-mediasoup-room first." });
      }

      const transport = await createWebRtcTransport(room.router);
      transport.appData.direction = direction;
      transport.appData.socketId = socket.id;
      peer.transports.set(transport.id, transport);

      // Track transport state changes
      transport.on("icestatechange", (iceState) => {
        console.log(`🧊 Transport ${transport.id} ICE state: ${iceState}`);
      });

      transport.on("dtlsstatechange", (dtlsState) => {
        console.log(`🔐 Transport ${transport.id} DTLS state: ${dtlsState}`);
        if (dtlsState === "failed" || dtlsState === "closed") {
          console.error(`❌ Transport ${transport.id} connection failed!`);
        }
      });

      console.log(
        `✅ ${direction} transport created: ${transport.id} for ${socket.id}`
      );

      cb({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (err: any) {
      console.error("Error creating transport:", err);
      cb({ error: err.message });
    }
  });

  socket.on(
    "connect-transport",
    async ({ roomId, transportId, dtlsParameters }, cb) => {
      try {
        const room = await getOrCreateRoom(roomId, mediaRouter);
        const peer = room.peers.get(socket.id);
        const transport = peer?.transports.get(transportId);

        if (!transport) {
          console.error(
            `❌ Transport ${transportId} not found for ${socket.id}`
          );
          return cb({ error: "Transport not found" });
        }
        if (transport.closed) {
          console.error(`❌ Transport ${transportId} already closed`);
          return cb({ error: "Transport already closed" });
        }

        await transport.connect({ dtlsParameters });
        console.log(
          `✅ Transport ${transportId} connected (${transport.appData.direction})`
        );
        cb({ success: true });
      } catch (err: any) {
        console.error("Error connecting transport:", err);
        cb({ error: err.message });
      }
    }
  );

  /* =========================
     PRODUCE
  ========================= */

  socket.on(
    "produce",
    async ({ roomId, transportId, kind, rtpParameters, appData }, cb) => {
      try {
        const room = await getOrCreateRoom(roomId);
        const peer = room.peers.get(socket.id);
        const transport = peer?.transports.get(transportId);

        if (kind !== "audio" && kind !== "video") {
          console.error(`❌ Invalid kind: ${kind}`);
          return cb({ error: "Only audio and video are allowed" });
        }

        if (!transport) {
          console.error(`❌ No transport found for ${transportId}`);
          return cb({ error: "No transport" });
        }
        if (transport.closed) {
          console.error(`❌ Transport ${transportId} is closed`);
          return cb({ error: "Transport closed" });
        }
        if (!peer) {
          console.error(`❌ Peer ${socket.id} not found`);
          return cb({ error: "Peer not found" });
        }

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData: appData || { media: kind },
        });

        peer.producers.set(producer.id, producer);

        // ✅ Handle producer close event
        producer.on("transportclose", () => {
          console.log(`🔌 Producer ${producer.id} transport closed`);
          peer.producers.delete(producer.id);
        });

        // Track producer lifecycle
        producer.on("score", (score) => {
          if (score.length > 0 && score[0].score < 5) {
            console.warn(`⚠️ Producer ${producer.id} low quality score:`, score[0].score);
          }
        });

        // Track producer score (quality)
        producer.on("score", (score) => {
          console.log(`📊 Producer ${producer.id} score:`, score);
        });

        const isScreenShare = appData?.share === true;
        const emoji = kind === "audio" ? "🎤" : isScreenShare ? "🖥️" : "📹";

        console.log(
          `${emoji} ${kind} producer ${producer.id} created by ${socket.id}${
            isScreenShare ? " (screen share)" : ""
          }`
        );

        // ✅ CRITICAL: Include peerId and screen share info
        socket.to(roomId).emit("new-producer", {
          producerId: producer.id,
          peerId: socket.id,
          kind,
          isScreenShare,
        });

        cb({ id: producer.id });
      } catch (err: any) {
        console.error("❌ Error producing:", err);
        cb({ error: err.message });
      }
    }
  );

  /* =========================
     CONSUME (ENHANCED WITH DEBUG)
  ========================= */
  socket.on("consume", async ({ roomId, producerId, rtpCapabilities }, cb) => {
    try {
      console.log("🔍 Consume request:", {
        roomId,
        producerId,
        fromSocket: socket.id,
        hasRtpCapabilities: !!rtpCapabilities,
      });

      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);

      if (!peer) {
        console.error(`❌ Peer not found for socket ${socket.id}`);
        return cb({ error: "Peer not found" });
      }

      // ✅ Find the transport meant for receiving
      const transport = Array.from(peer.transports.values()).find(
        (t) => t.appData.direction === "recv"
      );

      if (!transport) {
        console.error(`❌ No receive transport found for ${socket.id}`);
        console.log(
          "Available transports:",
          Array.from(peer.transports.values()).map((t) => ({
            id: t.id,
            direction: t.appData.direction,
          }))
        );
        return cb({ error: "No receive transport found" });
      }

      console.log(`✅ Using recv transport: ${transport.id}`);

      // ✅ Find the producer's peer ID and producer details
      let producerPeerId = "";
      let producer = null;
      for (const [peerId, p] of room.peers) {
        if (p.producers.has(producerId)) {
          producerPeerId = peerId;
          producer = p.producers.get(producerId);
          console.log("✅ Found producer:", {
            producerId: producer.id,
            kind: producer.kind,
            peerId: producerPeerId,
          });
          break;
        }
      }

      if (!producer) {
        console.error(`❌ Producer ${producerId} not found`);
        console.log(
          "📋 Available producers:",
          Array.from(room.peers.entries()).map(([pid, p]) => ({
            peerId: pid,
            producers: Array.from(p.producers.keys()),
          }))
        );
        return cb({ error: "Producer not found" });
      }

      // Check if router can consume
      const canConsume = room.router.canConsume({
        producerId,
        rtpCapabilities,
      });

      if (!canConsume) {
        console.error(`❌ Cannot consume - RTP capabilities mismatch`);
        console.log(
          "Producer codec:",
          producer.rtpParameters?.codecs?.[0]?.mimeType
        );
        return cb({ error: "Cannot consume - incompatible codecs" });
      }

      console.log("✅ Can consume producer");

      // Create consumer
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      peer.consumers.set(consumer.id, consumer);

      // Track consumer events
      consumer.on("transportclose", () => {
        console.log(`🔌 Consumer ${consumer.id} transport closed`);
        peer.consumers.delete(consumer.id);
      });

      consumer.on("producerclose", () => {
        console.log(`❌ Consumer ${consumer.id} producer closed`);
        peer.consumers.delete(consumer.id);
      });

      consumer.on("score", (score) => {
        console.log(`📊 Consumer ${consumer.id} score:`, score);
      });

      console.log(
        `✅ Consumer created: ${consumer.id} for producer ${producerId} (${consumer.kind}) from peer ${producerPeerId}`
      );

      // ✅ CRITICAL: Include peerId so client knows whose stream this is
      const response = {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        peerId: producerPeerId,
        producerSocketId: producerPeerId,
        isScreenShare: producer.appData?.share === true,
      };

      console.log("📤 Consumer response sent");
      cb(response);
    } catch (err: any) {
      console.error("❌ Error in consume:", err);
      cb({ error: err.message });
    }
  });

  socket.on("resume-consumer", async ({ roomId, consumerId }, cb) => {
    try {
      console.log(`▶️ Resume consumer request for ${consumerId} from ${socket.id}`);
      
      const room = await getOrCreateRoom(roomId);
      const consumer = room.peers.get(socket.id)?.consumers.get(consumerId);

      if (!consumer) {
        console.error(`❌ Consumer ${consumerId} not found for ${socket.id}`);
        return cb?.({ error: "Consumer not found" });
      }
      if (consumer.closed) {
        console.error(`❌ Consumer ${consumerId} already closed`);
        return cb?.({ error: "Consumer closed" });
      }

      await consumer.resume();
      console.log(`✅ Consumer ${consumerId} resumed successfully (kind: ${consumer.kind})`);
      cb?.({ success: true });
    } catch (err: any) {
      console.error("❌ Error resuming consumer:", err);
      cb?.({ error: err.message });
    }
  });

  // ✅ NEW: Handle producer closing
  socket.on("close-producer", async ({ roomId, producerId }, cb) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);

      if (!peer) {
        console.error(`❌ Peer ${socket.id} not found`);
        return cb?.({ error: "Peer not found" });
      }

      if (!producer) {
        console.error(`❌ Producer ${producerId} not found`);
        return cb?.({ error: "Producer not found" });
      }

      producer.close();
      peer.producers.delete(producerId);

      // Notify other peers that this producer is closed
      socket.to(roomId).emit("producer-closed", {
        producerId,
        peerId: socket.id,
      });

      console.log(`🔴 Producer ${producerId} closed by ${socket.id}`);
      cb?.({ success: true });
    } catch (err: any) {
      console.error("❌ Error closing producer:", err);
      cb?.({ error: err.message });
    }
  });

  /* =========================
     RECORDING
  ========================= */

  socket.on("start-recording", async ({ roomId }, callback) => {
    try {
      recordings.set(roomId, { startTime: Date.now() });
      io.to(roomId).emit("recording-started", { roomId });
      console.log(`🔴 Recording started: ${roomId}`);
      callback?.({ success: true });
    } catch (err: any) {
      console.error("Error starting recording:", err);
      callback?.({ error: err.message });
    }
  });

  socket.on("stop-recording", async ({ roomId }, callback) => {
    try {
      const recording = recordings.get(roomId);
      if (!recording) return callback?.({ error: "No recording found" });

      const duration = Date.now() - recording.startTime;
      recordings.delete(roomId);
      io.to(roomId).emit("recording-stopped", { roomId, duration });
      console.log(`⏹️ Recording stopped: ${roomId}`);
      callback?.({ success: true, duration });
    } catch (err: any) {
      console.error("Error stopping recording:", err);
      callback?.({ error: err.message });
    }
  });

  /* =========================
     HOST MANAGEMENT
  ========================= */

  socket.on("make-host", async ({ roomId, participantId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(participantId);

      if (!peer) return;

      peer.isHost = true;
      console.log(`👑 Made ${peer.name} a host`);

      // Update participant list
      const participants = Array.from(room.peers.values()).map((p) => ({
        id: p.socketId,
        name: p.name,
        imageUrl: p.imageUrl,
        isAudioMuted: false,
        isVideoPaused: false,
        isHost: p.isHost || false,
      }));
      io.to(roomId).emit("participant-list-update", participants);
    } catch (err) {
      console.error("Error making host:", err);
    }
  });

  socket.on("remove-host", async ({ roomId, participantId }) => {
    try {
      const room = await getOrCreateRoom(roomId);
      const peer = room.peers.get(participantId);

      if (!peer) return;

      peer.isHost = false;
      console.log(`👤 Removed host status from ${peer.name}`);

      // Update participant list
      const participants = Array.from(room.peers.values()).map((p) => ({
        id: p.socketId,
        name: p.name,
        imageUrl: p.imageUrl,
        isAudioMuted: false,
        isVideoPaused: false,
        isHost: p.isHost || false,
      }));
      io.to(roomId).emit("participant-list-update", participants);
    } catch (err) {
      console.error("Error removing host:", err);
    }
  });

  /* =========================
     CLEANUP
  ========================= */

  socket.on("disconnecting", async () => {
    try {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;

        // Remove peer first
        removePeerFromRoom(roomId, socket.id);

        // Get room if it still exists (might be deleted if last peer)
        const room = await getOrCreateRoom(roomId).catch(() => null);
        if (!room) continue;

        // ✅ Update participant list with ALL user info
        const participants = Array.from(room.peers.values()).map((p) => ({
          id: p.socketId,
          name: p.name,
          imageUrl: p.imageUrl,
          isAudioMuted: false,
          isVideoPaused: false,
          isHost: p.isHost || false,
        }));

        if (participants.length > 0) {
          io.to(roomId).emit("participant-list-update", participants);
          io.to(roomId).emit("participant-left", { peerId: socket.id });
        }
      }
      console.log(`👋 User ${socket.id} disconnected`);
    } catch (err) {
      console.error("Error during disconnect:", err);
    }
  });
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
