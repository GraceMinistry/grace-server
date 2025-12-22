import * as mediasoup from "mediasoup";


let worker: mediasoup.types.Worker;

export async function createMediasoupWorker() {
  if (worker) return worker;

  worker = await mediasoup.createWorker({
    logLevel: "warn",
    logTags: ["ice", "dtls", "rtp", "srtp"],
    rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT),
    rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT),
  });

  worker.on("died", () => {
    console.error("❌ Mediasoup worker died, exiting...");
    setTimeout(() => process.exit(1), 2000);
  });

  console.log("🎧 Mediasoup worker created");

  return worker;
}
