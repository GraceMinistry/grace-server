import { Router, WebRtcTransport } from "mediasoup/node/lib/types";
import { createMediasoupWorker } from "./worker";

export type Peer = {
  socketId: string;
  userId?: string; // Add userId field
  name?: string;
  imageUrl?: string | null;
  isHost?: boolean;
  isCoHost?: boolean; // Co-host status
  transports: Map<string, WebRtcTransport>; // Specific type instead of any
  producers: Map<string, any>;
  consumers: Map<string, any>;
  rtpCapabilities?: any;
};

export type Room = {
  router: Router;
  peers: Map<string, Peer>;
  screenShareEnabled: boolean; // Global screen share permission
};

const rooms = new Map<string, Room>();

export const getOrCreateRoom = async (
  roomId: string,
  router?: Router
): Promise<Room> => {
  const existingRoom = rooms.get(roomId);

  // Check if room exists and router is still open
  if (existingRoom && !existingRoom.router.closed) {
    return existingRoom;
  }

  // If room doesn't exist or router is closed, create new room with new router
  if (!router || router.closed) {
    console.log(`🏗️ Creating new router for room ${roomId}`);
    const worker = await createMediasoupWorker();
    router = await worker.createRouter({
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {
            "x-google-start-bitrate": 1000,
          },
        },
        {
          kind: "video",
          mimeType: "video/VP9",
          clockRate: 90000,
          parameters: {
            "profile-id": 2,
            "x-google-start-bitrate": 1000,
          },
        },
        {
          kind: "video",
          mimeType: "video/h264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "4d0032",
            "level-asymmetry-allowed": 1,
            "x-google-start-bitrate": 1000,
          },
        },
        {
          kind: "video",
          mimeType: "video/h264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1,
            "x-google-start-bitrate": 1000,
          },
        },
      ],
    });
  }

  const room = {
    router,
    peers: new Map(),
    screenShareEnabled: true, // Default: screen sharing allowed
  };

  rooms.set(roomId, room);
  return room;
};

export const getRoom = (roomId: string) => rooms.get(roomId);

/**
 * PHASE 4: WebRTC Transport Creation
 * Creates the server-side transport for a peer to send or receive audio.
 */
export const createWebRtcTransport = async (router: Router) => {
  // Use PUBLIC_IP for VPS deployments (DigitalOcean, Vultr, AWS EC2)
  // Set this environment variable to your server's public IP address
  const announcedIp = process.env.PUBLIC_IP || process.env.ANNOUNCED_IP || "127.0.0.1";
  console.log(`🌐 Creating transport with announcedIp: ${announcedIp}`);

  const transport = await router.createWebRtcTransport({
    listenIps: [
      {
        ip: "0.0.0.0", // Binds to all interfaces
        announcedIp,
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  console.log(`📡 Transport ICE candidates:`, JSON.stringify(transport.iceCandidates, null, 2));
  return transport;
};

/**
 * PHASE 7 Cleanup Helper
 * Closes transports, producers, consumers and removes peer from the room state.
 */
export const removePeerFromRoom = (roomId: string, socketId: string) => {
  try {
    const room = rooms.get(roomId);
    if (!room) return;

    const peer = room.peers.get(socketId);
    if (peer) {
      // Close all consumers safely
      peer.consumers.forEach((consumer) => {
        try {
          if (!consumer.closed) consumer.close();
        } catch (err) {
          console.error("Error closing consumer:", err);
        }
      });

      // Close all producers safely
      peer.producers.forEach((producer) => {
        try {
          if (!producer.closed) producer.close();
        } catch (err) {
          console.error("Error closing producer:", err);
        }
      });

      // Close all transports safely
      peer.transports.forEach((transport) => {
        try {
          if (!transport.closed) transport.close();
        } catch (err) {
          console.error("Error closing transport:", err);
        }
      });

      room.peers.delete(socketId);
      console.log(`🗑️ Mediasoup state cleaned for peer ${socketId}`);
    }

    // If room is empty, close router and delete room
    if (room.peers.size === 0) {
      try {
        if (!room.router.closed) {
          room.router.close();
        }
      } catch (err) {
        console.error("Error closing router:", err);
      }
      rooms.delete(roomId);
      console.log(`🏠 Room ${roomId} fully closed`);
    }
  } catch (err) {
    console.error("Error in removePeerFromRoom:", err);
  }
};
