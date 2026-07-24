/**
 * Configuration Validation Tests
 *
 * Tests the Zod schema validation for environment variables.
 * Ensures proper handling of invalid, missing, and malformed values.
 */

describe("Configuration Validation", () => {
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    // Clear the module cache to allow re-importing with new env vars
    jest.resetModules();
  });

  describe("Database URL Validation", () => {
    it("should reject missing DATABASE_URL", async () => {
      delete process.env.DATABASE_URL;
      
      // Capture console.error to suppress test output noise
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should reject invalid DATABASE_URL format", async () => {
      process.env.DATABASE_URL = "not-a-postgres-url";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should accept valid DATABASE_URL", async () => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
      
      const config = await import("../src/config.js");
      expect(config.default.DATABASE_URL).toBe("postgres://user:pass@localhost:5432/db");
    });
  });

  describe("Numeric Value Validation", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    });

    it("should reject NaN for POLL_MS", async () => {
      process.env.POLL_MS = "not-a-number";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should reject negative POLL_MS", async () => {
      process.env.POLL_MS = "-1000";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should reject POLL_MS below minimum threshold", async () => {
      process.env.POLL_MS = "50"; // Below 100ms minimum
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should accept valid POLL_MS", async () => {
      process.env.POLL_MS = "5000";
      
      const config = await import("../src/config.js");
      expect(config.default.POLL_MS).toBe(5000);
    });

    it("should use default for missing POLL_MS", async () => {
      delete process.env.POLL_MS;
      
      const config = await import("../src/config.js");
      expect(config.default.POLL_MS).toBe(5000);
    });

    it("should reject zero for positive int fields", async () => {
      process.env.PORT = "0";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should accept zero for START_LEDGER (non-negative)", async () => {
      process.env.START_LEDGER = "0";
      
      const config = await import("../src/config.js");
      expect(config.default.START_LEDGER).toBe(0);
    });

    it("should reject empty string for numeric fields", async () => {
      process.env.PORT = "";
      
      const config = await import("../src/config.js");
      // Empty string should use default
      expect(config.default.PORT).toBe(3001);
    });
  });

  describe("Port Validation", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    });

    it("should reject PORT above 65535", async () => {
      process.env.PORT = "99999";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should accept valid port", async () => {
      process.env.PORT = "8080";
      
      const config = await import("../src/config.js");
      expect(config.default.PORT).toBe(8080);
    });
  });

  describe("URL Validation", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    });

    it("should reject invalid SOROBAN_RPC_URL", async () => {
      process.env.SOROBAN_RPC_URL = "not-a-url";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should accept valid SOROBAN_RPC_URL", async () => {
      process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
      
      const config = await import("../src/config.js");
      expect(config.default.SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    });

    it("should use default for missing SOROBAN_RPC_URL", async () => {
      delete process.env.SOROBAN_RPC_URL;
      
      const config = await import("../src/config.js");
      expect(config.default.SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    });

    it("should allow optional REDIS_URL to be missing", async () => {
      delete process.env.REDIS_URL;
      
      const config = await import("../src/config.js");
      expect(config.default.REDIS_URL).toBeUndefined();
    });

    it("should reject invalid optional URL", async () => {
      process.env.REDIS_URL = "invalid-url";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });
  });

  describe("Cron Expression Validation", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    });

    it("should accept valid 5-field cron expression", async () => {
      process.env.PRUNE_CRON = "0 2 * * *";
      
      const config = await import("../src/config.js");
      expect(config.default.PRUNE_CRON).toBe("0 2 * * *");
    });

    it("should accept valid 6-field cron expression", async () => {
      process.env.ABI_SYNC_CRON = "0 */10 * * * *";
      
      const config = await import("../src/config.js");
      expect(config.default.ABI_SYNC_CRON).toBe("0 */10 * * * *");
    });

    it("should reject invalid cron expression", async () => {
      process.env.PRUNE_CRON = "invalid cron";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });
  });

  describe("Comma-separated List Validation", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    });

    it("should parse comma-separated list", async () => {
      process.env.GEO_BLOCK_LIST = "CN,RU,KP";
      
      const config = await import("../src/config.js");
      expect(config.default.GEO_BLOCK_LIST).toEqual(["CN", "RU", "KP"]);
    });

    it("should handle empty comma-separated list", async () => {
      process.env.GEO_BLOCK_LIST = "";
      
      const config = await import("../src/config.js");
      expect(config.default.GEO_BLOCK_LIST).toEqual([]);
    });

    it("should trim whitespace from list items", async () => {
      process.env.GEO_BLOCK_LIST = " CN , RU , KP ";
      
      const config = await import("../src/config.js");
      expect(config.default.GEO_BLOCK_LIST).toEqual(["CN", "RU", "KP"]);
    });
  });

  describe("Boolean Validation", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    });

    it("should parse 'true' as true", async () => {
      process.env.VERIFY_ON_UPLOAD = "true";
      
      const config = await import("../src/config.js");
      expect(config.default.VERIFY_ON_UPLOAD).toBe(true);
    });

    it("should parse '1' as true", async () => {
      process.env.VERIFY_ON_UPLOAD = "1";
      
      const config = await import("../src/config.js");
      expect(config.default.VERIFY_ON_UPLOAD).toBe(true);
    });

    it("should parse 'false' as false", async () => {
      process.env.VERIFY_ON_UPLOAD = "false";
      
      const config = await import("../src/config.js");
      expect(config.default.VERIFY_ON_UPLOAD).toBe(false);
    });

    it("should use default for missing boolean", async () => {
      delete process.env.VERIFY_ON_UPLOAD;
      
      const config = await import("../src/config.js");
      expect(config.default.VERIFY_ON_UPLOAD).toBe(true);
    });
  });

  describe("Float Validation", () => {
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    });

    it("should accept valid float", async () => {
      process.env.CACHE_XFETCH_BETA = "1.5";
      
      const config = await import("../src/config.js");
      expect(config.default.CACHE_XFETCH_BETA).toBe(1.5);
    });

    it("should reject negative float for positive number", async () => {
      process.env.ALERT_MIN_THROUGHPUT = "-0.5";
      
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const processExitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(async () => {
        await import("../src/config.js");
      }).rejects.toThrow("process.exit(1)");

      expect(processExitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });
  });
});
