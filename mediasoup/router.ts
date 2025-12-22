import { createMediasoupWorker } from "./worker";

let router: any;

export async function createAudioRouter() {
  if (router) return router;

  const worker = await createMediasoupWorker();

  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
    ],
  });

  console.log("🔊 Audio router created");
  return router;
}

