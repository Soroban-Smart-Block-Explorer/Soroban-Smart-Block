import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

// Generic coin placeholder — shown until the asset resolves, or when its
// issuer has no stellar.toml / no image field (#546 acceptance criteria).
const PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="7" fill="#30363d" stroke="#8b949e" stroke-width="1"/>
      <text x="8" y="11" font-size="8" text-anchor="middle" fill="#8b949e" font-family="sans-serif">?</text>
    </svg>`,
  );

interface Props {
  code: string;
  issuer: string | null | undefined;
}

/** 16×16 classic asset logo, resolved via GET /api/assets/:issuer/:code, with a generic placeholder fallback. */
export default function AssetLogo({ code, issuer }: Props) {
  const { data } = useQuery({
    queryKey: ["asset", issuer, code],
    queryFn: () => api.asset(issuer as string, code),
    enabled: !!issuer && code !== "XLM",
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const src = data?.logo_url || PLACEHOLDER;

  return (
    <img
      src={src}
      onError={(e) => {
        (e.target as HTMLImageElement).src = PLACEHOLDER;
      }}
      width={16}
      height={16}
      style={{ borderRadius: "50%", verticalAlign: "middle", marginRight: 4 }}
      alt={code}
      title={data?.name ? `${code} — ${data.name}` : code}
    />
  );
}
