import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { prisma } from "./prisma";

const app = express();
app.use(cors());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

const rooms = new Map<string, Set<string>>();

io.on("connection", (socket) => {
  console.log("✅ user connected:", socket.id);

  // --- JOIN ROOM (With History + Reactions) ---
  socket.on("join-room", async (roomId: string) => {
  socket.join(roomId);

  try {
    const history = await prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: "asc" },
      include: { reactions: true },
    });

    const formattedHistory = history.map((msg) => {
      const reactionsGrouped: Record<string, string[]> = {};
      msg.reactions.forEach((r) => {
        if (!reactionsGrouped[r.emoji]) reactionsGrouped[r.emoji] = [];
        reactionsGrouped[r.emoji].push(r.userId);
      });

      return {
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
          replyToId: msg.replyToId,
          reactions: reactionsGrouped,
          pinned: msg.pinned, // FIXED: Changed from isPinned to pinned
        },
      };
    });

    socket.emit("chat-history", formattedHistory);
  } catch (err) {
    console.error("❌ History fetch error:", err);
  }
});
  socket.on("send-message", async ({ roomId, message }) => {
    // 1️⃣ Emit immediately (NO UI delay)
    io.to(roomId).emit("receive-message", {
      socketId: socket.id,
      message,
    });

    // 2️⃣ Persist in DB (async, safe)
    try {
      await prisma.message.create({
        data: {
          id: message.id,
          roomId,
          text: message.text,
          senderId: message.sender.id,
          senderName: message.sender.name,
          senderAvatar: message.sender.avatarUrl,
          replyToId: message.replyTo?.id,
          createdAt: new Date(message.createdAt),
        },
      });
    } catch (err) {
      console.error("❌ Failed to save message:", err);
    }
  });

  socket.on("message-read", ({ roomId, messageId }) => {
    socket.to(roomId).emit("message-read", {
      messageId,
      socketId: socket.id,
    });
  });

  socket.on("typing-start", ({ roomId, name }) => {
    socket.to(roomId).emit("typing-start", {
      socketId: socket.id,
      name,
    });
  });

  socket.on("typing-stop", ({ roomId }) => {
    socket.to(roomId).emit("typing-stop", {
      socketId: socket.id,
    });
  });

  // --- PIN MESSAGE: Update DB ---
  socket.on("pin-message", async ({ roomId, messageId, pinned }) => {
  // 1. Validation to prevent Prisma crash
  if (!messageId) {
    console.error("❌ Received pin-message event without messageId");
    return;
  }

  try {
    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: { pinned: !!pinned }, // Ensure it's a boolean
    });

    console.log(`📌 Message ${messageId} pin status: ${updatedMessage.pinned}`);

    // 2. Broadcast to everyone in the room
    io.to(roomId).emit("pin-message-update", { 
      messageId: updatedMessage.id, 
      pinned: updatedMessage.pinned 
    });
  } catch (err) {
    console.error("❌ Pin update error:", err);
  }
});

  // --- MESSAGE REACT: Robust Toggle ---
  socket.on("message-react", async ({ roomId, messageId, emoji, userId }) => {
    try {
      const existing = await prisma.reaction.findFirst({
        where: { messageId, userId },
      });

      if (existing) {
        // If same emoji, remove it (Toggle off)
        if (existing.emoji === emoji) {
          await prisma.reaction.delete({ where: { id: existing.id } });
          io.to(roomId).emit("message-react-update", {
            messageId,
            userId,
            emoji,
            action: "removed",
          });
        } else {
          // If different emoji, update it
          await prisma.reaction.update({
            where: { id: existing.id },
            data: { emoji },
          });
          io.to(roomId).emit("message-react-update", {
            messageId,
            userId,
            emoji,
            action: "updated",
          });
        }
      } else {
        // New reaction
        await prisma.reaction.create({
          data: { messageId, userId, emoji },
        });
        io.to(roomId).emit("message-react-update", {
          messageId,
          userId,
          emoji,
          action: "added",
        });
      }
    } catch (err) {
      // This catches the P2002 Unique constraint error if two clicks happen at once
      console.log("⚠️ Reaction race condition handled safely.");
    }
  });

  socket.on("leave-room", (roomId) => {
    rooms.get(roomId)?.delete(socket.id);
    socket.leave(roomId);
  });

  socket.on("disconnect", () => {
    for (const [roomId, members] of rooms.entries()) {
      if (members.has(socket.id)) {
        members.delete(socket.id);
        socket.to(roomId).emit("typing-stop", {
          socketId: socket.id,
        });
      }
    }
  });
});

const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Socket.IO server running on port ${PORT}`);
});
