import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import XdrInspector from "../src/pages/XdrInspector";

describe("XdrInspector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows prompt message for empty input", () => {
    render(<XdrInspector />);
    expect(screen.getByText("Paste a Base64 XDR string above.")).toBeDefined();
  });

  it("shows error for non-Base64 input", () => {
    render(<XdrInspector />);
    const textarea = screen.getByPlaceholderText("Paste Base64 XDR here…");
    fireEvent.change(textarea, { target: { value: "hello world" } });
    expect(
      screen.getByText("Could not decode XDR. Ensure it is a valid Base64-encoded Soroban XDR string.")
    ).toBeDefined();
  });

  it("shows error for valid Base64 that is not valid XDR", () => {
    render(<XdrInspector />);
    const textarea = screen.getByPlaceholderText("Paste Base64 XDR here…");
    fireEvent.change(textarea, { target: { value: "AAAAAA==" } });
    expect(
      screen.getByText("Could not decode XDR. Ensure it is a valid Base64-encoded Soroban XDR string.")
    ).toBeDefined();
  });
});
