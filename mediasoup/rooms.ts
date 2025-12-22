import { Router, WebRtcTransport } from "mediasoup/node/lib/types";

export type Peer = {
  socketId: string;
  transports: Map<string, WebRtcTransport>; // Specific type instead of any
  producers: Map<string, any>;
  consumers: Map<string, any>;
  rtpCapabilities?: any;
};

export type Room = {
  router: Router;
  peers: Map<string, Peer>;
};
 
const rooms = new Map<string, Room>();

export const getOrCreateRoom = async (
  roomId: string,
  router: Router
): Promise<Room> => {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      router,
      peers: new Map(),
    });
  }
  return rooms.get(roomId)!;
};

export const getRoom = (roomId: string) => rooms.get(roomId);

/**
 * PHASE 4: WebRTC Transport Creation
 * Creates the server-side transport for a peer to send or receive audio.
 */
export const createWebRtcTransport = async (router: Router) => {
  const transport = await router.createWebRtcTransport({
    listenIps: [
      {
        ip: "0.0.0.0", // Binds to all interfaces
        // On Railway, announcedIp is your public domain/IP
        announcedIp: process.env.RAILWAY_PUBLIC_DOMAIN || "127.0.0.1",
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  return transport;
};

/**
 * PHASE 7 Cleanup Helper
 * Closes transports and removes peer from the room state.
 */
export const removePeerFromRoom = (roomId: string, socketId: string) => {
  const room = rooms.get(roomId);
  if (!room) return;

  const peer = room.peers.get(socketId);
  if (peer) {
    // Close all active transports for this user
    peer.transports.forEach((transport) => transport.close());
    room.peers.delete(socketId);
    console.log(`🗑️ Mediasoup state cleaned for peer ${socketId}`);
  }

  // If room is empty, delete it
  if (room.peers.size === 0) {
    rooms.delete(roomId);
    console.log(`🏠 Room ${roomId} fully closed`);
  }
};