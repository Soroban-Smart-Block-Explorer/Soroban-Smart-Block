import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import ThemeToggle from "./ThemeToggle";
import NetworkSwitcher from "./NetworkSwitcher";

const NAV_LINKS = [
  { to: "/contracts", label: "Registry" },
  { to: "/contracts/register", label: "Register" },
  { to: "/search", label: "Search" },
  { to: "/xdr", label: "XDR Workbench" },
  { to: "/rpc-metrics", label: "RPC Metrics" },
  { to: "/graph", label: "Dep Graph" },
  { to: "/sandbox", label: "Sandbox" },
  { to: "/batch", label: "Batch" },
  { to: "/setup", label: "Setup" },
];

export default function Nav() {
  const [q, setQ] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const nav = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);

  function search(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    const params = new URLSearchParams({ q: v });
    if (v.startsWith("G") && v.length === 56) params.set("kind", "wallet");
    else if (v.startsWith("M") && v.length === 56) params.set("kind", "wallet");
    else if (v.startsWith("C") && v.length === 56) params.set("kind", "contract");
    nav(`/search?${params}`);
    setQ("");
  }

  // Handle keyboard shortcuts: / to focus search, Escape to blur
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Check if the user is currently typing in a form field
      const activeElement = document.activeElement as HTMLElement;
      const isInFormField =
        activeElement?.tagName === "INPUT" ||
        activeElement?.tagName === "TEXTAREA" ||
        activeElement?.tagName === "SELECT" ||
        activeElement?.contentEditable === "true";

      // Press "/" to focus the search bar (unless already in a form field)
      if (e.key === "/" && !isInFormField) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }

      // Press "Escape" to blur the search bar or close mobile menu
      if (e.key === "Escape") {
        if (activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
        }
        setMobileMenuOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function handleNavLinkClick() {
    setMobileMenuOpen(false);
  }

  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .nav-desktop-links {
            display: none;
          }
          .nav-search-form {
            max-width: none;
            flex: none;
            order: 3;
            width: 100%;
            margin-top: 12px;
          }
          header {
            flex-wrap: wrap;
            align-items: flex-start;
          }
        }
        @media (min-width: 769px) {
          .nav-hamburger {
            display: none;
          }
          .nav-mobile-menu {
            display: none;
          }
        }
        .nav-mobile-menu {
          position: fixed;
          top: 50px;
          left: 0;
          right: 0;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          z-index: 1000;
          max-height: calc(100vh - 50px);
          overflow-y: auto;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .nav-mobile-menu a {
          display: block;
          padding: 12px 24px;
          border-bottom: 1px solid var(--border);
          text-decoration: none;
          color: var(--text);
          font-size: 14px;
          transition: background 200ms ease;
        }
        .nav-mobile-menu a:hover {
          background: var(--border);
          text-decoration: none;
        }
      `}</style>
      <header
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Link to="/" style={{ fontWeight: 700, fontSize: 16, whiteSpace: "nowrap" }}>
          ⬡ Soroban Explorer
        </Link>

        {/* Desktop navigation links */}
        <div className="nav-desktop-links" style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {NAV_LINKS.map((link) => (
            <Link key={link.to} to={link.to} style={{ fontSize: 13, whiteSpace: "nowrap", color: "var(--muted)" }}>
              {link.label}
            </Link>
          ))}
        </div>

        {/* Mobile hamburger button */}
        <button
          className="nav-hamburger"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--accent)",
            fontSize: 20,
            cursor: "pointer",
            padding: "4px 8px",
            display: "none",
          }}
          aria-label="Toggle menu"
          title="Toggle navigation menu"
        >
          ☰
        </button>

        <form onSubmit={search} className="nav-search-form" style={{ display: "flex", gap: 8, flex: 1, maxWidth: 600 }}>
          <input
            ref={searchInputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search contracts, events, wallets… (press / to focus)"
            style={{ flex: 1 }}
          />
          <button type="submit">Search</button>
        </form>
        <NetworkSwitcher />
        <ThemeToggle />
      </header>

      {/* Mobile navigation drawer */}
      {mobileMenuOpen && (
        <div
          className="nav-mobile-menu"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setMobileMenuOpen(false);
            }
          }}
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              onClick={handleNavLinkClick}
              style={{ display: "block", padding: "12px 24px", borderBottom: "1px solid var(--border)" }}
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
