import { loadEnvConfig } from "@next/env";
import { processNextJob } from "@/lib/jobs";
import { sleep } from "@/lib/utils";

loadEnvConfig(process.cwd());

const pollMs = Number(process.env.WORKER_POLL_MS || 2500);

async function main() {
  console.log(`[worker] polling every ${pollMs}ms`);

  while (true) {
    const processed = await processNextJob();
    if (!processed) {
      await sleep(pollMs);
    }
  }
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
