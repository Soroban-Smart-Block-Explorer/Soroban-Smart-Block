export default {
  testEnvironment: "node",
  transform: {},
  testTimeout: 30000,
  setupFiles: ["<rootDir>/test/jest.setup.js"],
  setupFilesAfterEnv: ["<rootDir>/test/jest.setupAfterEnv.js"],
};
