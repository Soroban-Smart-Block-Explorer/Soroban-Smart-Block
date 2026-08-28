// Runs before each test file's module graph is evaluated.
//
// ES module `import` statements are hoisted and evaluated before any of the
// importing file's own top-level statements, including `process.env.X = …`
// assignments written above the imports. Every test/api/*.test.js file sets
// process.env.DATABASE_URL that way, but by the time that line runs,
// api.js's transitive import of config.js has already parsed process.env
// and (with DATABASE_URL unset) called process.exit(1). CI only exports
// TEST_DATABASE_URL, never DATABASE_URL, so this previously failed every
// run. Setting it here, in a Jest setupFiles hook, happens before any test
// module is loaded.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
}
