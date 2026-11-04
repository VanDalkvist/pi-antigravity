import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "pi-antigravity-sticky-test-"));
process.env.PI_CODING_AGENT_DIR = tempDir;

const {
  rememberAccount,
  getThreadStickyAccount,
  recordThreadAccountAssignment,
  loadThreadAccountStore,
  hashThreadKey,
} = await import("../src/auth/accounts.ts");

const { resolveThreadKey } = await import("../src/utils/util.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const mockAccount = (email: string, refresh: string) => ({
  email,
  access: `access-${email}`,
  refresh,
  expires: Date.now() + 60 * 60_000,
  projectId: `project-${email}`,
});

async function main() {
  console.log("Starting Thread-Sticky Round-Robin tests...");

  // Setup 4 distinct accounts
  rememberAccount(mockAccount("user1@example.com", "refresh-1"));
  rememberAccount(mockAccount("user2@example.com", "refresh-2"));
  rememberAccount(mockAccount("user3@example.com", "refresh-3"));
  rememberAccount(mockAccount("user4@example.com", "refresh-4"));

  // TEST 1: Key resolution priority
  console.log("Test 1: resolveThreadKey");
  process.env.BB_THREAD_ID = "thr_abc123";
  assert(
    resolveThreadKey() === "bb:thr_abc123",
    "Should prioritize BB_THREAD_ID when present",
  );
  delete process.env.BB_THREAD_ID;

  assert(
    resolveThreadKey(undefined, "session_custom_id") === "session:session_custom_id",
    "Should use sessionId option when BB_THREAD_ID is absent",
  );

  const transcript = {
    messages: [
      { role: "user", timestamp: 1700000000000, content: "Initial prompt text" },
    ],
  };
  const convKey1 = resolveThreadKey(transcript);
  const convKey2 = resolveThreadKey(transcript);
  assert(
    convKey1.startsWith("conv:") && convKey1 === convKey2,
    "Should derive deterministic conv key across multiple turns of same transcript",
  );

  // TEST 2: Round-Robin across 4 new threads
  console.log("Test 2: Round-robin across distinct threads");
  const thread1Result = await getThreadStickyAccount("thread_1");
  const thread2Result = await getThreadStickyAccount("thread_2");
  const thread3Result = await getThreadStickyAccount("thread_3");
  const thread4Result = await getThreadStickyAccount("thread_4");

  assert(thread1Result?.source === "allocated", "Thread 1 should be newly allocated");
  assert(thread2Result?.source === "allocated", "Thread 2 should be newly allocated");
  assert(thread3Result?.source === "allocated", "Thread 3 should be newly allocated");
  assert(thread4Result?.source === "allocated", "Thread 4 should be newly allocated");

  const emails = [
    thread1Result?.email,
    thread2Result?.email,
    thread3Result?.email,
    thread4Result?.email,
  ];

  console.log("Allocated emails for threads 1..4:", emails);
  const uniqueEmails = new Set(emails);
  assert(
    uniqueEmails.size === 4,
    `Each of the 4 parallel threads must receive a distinct account! Got: ${emails.join(", ")}`,
  );

  // TEST 3: Stickiness (Cache preservation) across multiple turns
  console.log("Test 3: Stickiness across repeated turns (cache preservation)");
  for (let turn = 2; turn <= 10; turn++) {
    const turnResult = await getThreadStickyAccount("thread_1");
    assert(
      turnResult?.source === "sticky",
      `Turn ${turn} of thread_1 should be sticky, got: ${turnResult?.source}`,
    );
    assert(
      turnResult?.email === thread1Result?.email,
      `Turn ${turn} of thread_1 MUST stay on ${thread1Result?.email}, got: ${turnResult?.email}`,
    );
    assert(
      turnResult?.apiKey.projectId === `project-${thread1Result?.email}`,
      `Turn ${turn} MUST preserve the same Google project ID for prompt cache hits`,
    );
  }

  for (let turn = 2; turn <= 5; turn++) {
    const turnResult2 = await getThreadStickyAccount("thread_2");
    assert(
      turnResult2?.email === thread2Result?.email,
      `Turn ${turn} of thread_2 MUST stay on ${thread2Result?.email}`,
    );
  }

  // TEST 4: Failover update for a thread
  console.log("Test 4: Failover updates thread assignment");
  recordThreadAccountAssignment("thread_1", "user4@example.com");
  const afterFailover = await getThreadStickyAccount("thread_1");
  assert(
    afterFailover?.email === "user4@example.com",
    `After failover, thread_1 should stick to new account user4@example.com, got: ${afterFailover?.email}`,
  );
  assert(afterFailover?.source === "sticky", "After failover, it must still resolve as sticky");

  // TEST 5: Hash fallback consistency
  console.log("Test 5: Hash fallback");
  const hashVal1 = hashThreadKey("some-thread-id");
  const hashVal2 = hashThreadKey("some-thread-id");
  assert(hashVal1 === hashVal2, "hashThreadKey must be deterministic");

  console.log("All Thread-Sticky Round-Robin tests PASSED! ✅");

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
