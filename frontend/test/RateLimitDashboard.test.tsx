/**
 * Task 17.8 — Unit tests for rate limit analytics dashboard components.
 *
 * Test suite 1: RateLimitDashboard renders the admin login prompt when no admin
 *               token is stored in sessionStorage (i.e. the user is unauthenticated).
 *
 * Test suite 2: TopUsersTable renders the correct number of table rows from mock data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RateLimitDashboard from "../src/pages/RateLimitDashboard";
import TopUsersTable from "../src/components/TopUsersTable";

// ---------------------------------------------------------------------------
// RateLimitDashboard tests
// ---------------------------------------------------------------------------

describe("RateLimitDashboard — login prompt when not authenticated", () => {
  beforeEach(() => {
    // Ensure no admin token is present in sessionStorage before each test.
    sessionStorage.removeItem("admin_token");
    sessionStorage.removeItem("admin_totp");

    // Stub global fetch so the component never makes real network calls.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, json: async () => ({}) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the Admin Login heading when no token is in sessionStorage", () => {
    render(
      <MemoryRouter>
        <RateLimitDashboard />
      </MemoryRouter>,
    );

    // The login panel heading must be visible.
    expect(screen.getByText("Admin Login")).toBeDefined();
  });

  it("renders the admin token password input on the login screen", () => {
    render(
      <MemoryRouter>
        <RateLimitDashboard />
      </MemoryRouter>,
    );

    // The password input for the admin token must be present.
    const tokenInput = screen.getByPlaceholderText("Admin token");
    expect(tokenInput).toBeDefined();
    expect(tokenInput.getAttribute("type")).toBe("password");
  });

  it("renders the Sign in button on the login screen", () => {
    render(
      <MemoryRouter>
        <RateLimitDashboard />
      </MemoryRouter>,
    );

    expect(screen.getByText("Sign in")).toBeDefined();
  });

  it("does NOT render the dashboard analytics heading when unauthenticated", () => {
    render(
      <MemoryRouter>
        <RateLimitDashboard />
      </MemoryRouter>,
    );

    // The main dashboard heading should NOT be present while on the login screen.
    expect(screen.queryByText("Rate Limit Analytics")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TopUsersTable tests
// ---------------------------------------------------------------------------

const MOCK_TOP_USERS = [
  {
    api_key_id: "aaaaaaaa-0000-0000-0000-000000000001",
    key_name: "Alpha Service",
    total_requests: 50000,
  },
  {
    api_key_id: "bbbbbbbb-0000-0000-0000-000000000002",
    key_name: "Beta Service",
    total_requests: 30000,
  },
  {
    api_key_id: "cccccccc-0000-0000-0000-000000000003",
    key_name: "Gamma Service",
    total_requests: 20000,
  },
  {
    api_key_id: "dddddddd-0000-0000-0000-000000000004",
    key_name: "Delta Service",
    total_requests: 10000,
  },
  {
    api_key_id: "eeeeeeee-0000-0000-0000-000000000005",
    key_name: "Epsilon Service",
    total_requests: 5000,
  },
];

describe("TopUsersTable — row count matches mock data", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders one table row per entry in the data array", () => {
    const onWindowChange = vi.fn();

    render(
      <TopUsersTable data={MOCK_TOP_USERS} window="24h" onWindowChange={onWindowChange} />,
    );

    // Each row has a rank number in the first column; filter by tbody rows only.
    const rows = screen
      .getAllByRole("row")
      .filter((r) => r.closest("tbody") !== null);

    expect(rows).toHaveLength(MOCK_TOP_USERS.length);
  });

  it("renders all key names from the data array", () => {
    const onWindowChange = vi.fn();

    render(
      <TopUsersTable data={MOCK_TOP_USERS} window="24h" onWindowChange={onWindowChange} />,
    );

    for (const user of MOCK_TOP_USERS) {
      expect(screen.getByText(user.key_name)).toBeDefined();
    }
  });

  it("renders request counts formatted with locale separators", () => {
    const onWindowChange = vi.fn();

    render(
      <TopUsersTable data={MOCK_TOP_USERS} window="24h" onWindowChange={onWindowChange} />,
    );

    // 50,000 should appear as a formatted number.
    expect(screen.getByText("50,000")).toBeDefined();
    expect(screen.getByText("30,000")).toBeDefined();
  });

  it("shows an empty-state message when data array is empty", () => {
    const onWindowChange = vi.fn();

    render(<TopUsersTable data={[]} window="1h" onWindowChange={onWindowChange} />);

    expect(screen.getByText("No data for this window.")).toBeDefined();
  });

  it("highlights the active window button with aria-pressed=true", () => {
    const onWindowChange = vi.fn();

    render(
      <TopUsersTable data={MOCK_TOP_USERS} window="7d" onWindowChange={onWindowChange} />,
    );

    const btn7d = screen.getByText("7d");
    expect(btn7d.getAttribute("aria-pressed")).toBe("true");

    const btn1h = screen.getByText("1h");
    expect(btn1h.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders correct rank numbers in the first column (1-indexed)", () => {
    const onWindowChange = vi.fn();

    render(
      <TopUsersTable data={MOCK_TOP_USERS} window="24h" onWindowChange={onWindowChange} />,
    );

    // Rank cells contain plain integers 1 through N.
    for (let i = 1; i <= MOCK_TOP_USERS.length; i++) {
      expect(screen.getByText(String(i))).toBeDefined();
    }
  });
});
