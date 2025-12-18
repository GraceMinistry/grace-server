import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

const rooms = new Map<string, Set<string>>();

io.on("connection", (socket) => {
  console.log("✅ user connected:", socket.id);

  socket.on("join-room", (roomId: string) => {
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId)!.add(socket.id);
    socket.join(roomId);
  });

  socket.on("send-message", ({ roomId, message }) => {
    io.to(roomId).emit("receive-message", {
      socketId: socket.id,
      message,
    });
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

  socket.on("pin-message", ({ roomId, message }) => {
    socket.to(roomId).emit("pin-message", message);
  });

 socket.on("message-react", ({ roomId, messageId, emoji, userId }) => {
  io.to(roomId).emit("message-react", {
    messageId,
    emoji,
    userId,
  });
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

