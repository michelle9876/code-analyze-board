import { loadEnvConfig } from "@next/env";
import { processNextJob, recoverStaleJobs } from "@/lib/jobs";
import { sleep } from "@/lib/utils";

loadEnvConfig(process.cwd());

const pollMs = Number(process.env.WORKER_POLL_MS || 2500);
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 3));

async function runWorkerLane() {
  while (true) {
    const processed = await processNextJob();
    if (!processed) {
      await sleep(pollMs);
    }
  }
}

async function main() {
  const recoveredJobs = await recoverStaleJobs();
  console.log(`[worker] polling every ${pollMs}ms with concurrency ${concurrency}`);

  if (recoveredJobs > 0) {
    console.log(`[worker] re-queued ${recoveredJobs} stale running job(s)`);
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorkerLane()));
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
