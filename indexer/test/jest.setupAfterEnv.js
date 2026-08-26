// Registered via jest.config.js's setupFilesAfterEnv, so this runs once per
// test file, after the test framework globals (describe/afterAll/expect) are
// installed but before the file's own top-level code runs. Jest runs
// same-level afterAll hooks in reverse declaration order, so this global
// afterAll fires after each test file's own afterAll/teardown has already
// run — right before Jest tears the file's module environment down.
//
// createApi() kicks off ensureAuditPartitions() fire-and-forget (see
// src/api.js and src/audit/auditLogger.js) so server startup doesn't block
// on it. If that promise is still pending when a test file finishes, its
// console.log can fire after Jest freezes the file's console, which prints
// "Cannot log after tests are done" and — more importantly — silently sets
// process.exitCode = 1 for the *entire* test run, even though every test
// passed. Waiting for it here (a no-op for files that never touched the
// audit logger) closes that race.
afterAll(async () => {
  const { getPendingAuditPartitionWork } = await import("../src/audit/auditLogger.js");
  await getPendingAuditPartitionWork();
});
