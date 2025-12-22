import { createMediasoupWorker } from "./worker";

export let audioRouter: any; 

export async function createAudioRouter() {
  if (audioRouter) return audioRouter;

  const worker = await createMediasoupWorker();

  audioRouter = await worker.createRouter({
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
  return audioRouter;
}