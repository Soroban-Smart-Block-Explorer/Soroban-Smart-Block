/**
 * Sets the document title and OpenGraph/Twitter Card meta tags for the
 * current page. Restores the previous values on unmount so navigating
 * away doesn't leak a stale title/description onto other pages.
 */

import { useEffect } from "react";

export interface MetaTags {
  title: string;
  description: string;
}

function setMetaContent(selector: string, content: string) {
  const el = document.querySelector<HTMLMetaElement>(selector);
  if (el) el.setAttribute("content", content);
}

export function useMetaTags({ title, description }: MetaTags) {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;

    setMetaContent('meta[property="og:title"]', title);
    setMetaContent('meta[property="og:description"]', description);
    setMetaContent('meta[name="twitter:title"]', title);
    setMetaContent('meta[name="twitter:description"]', description);

    return () => {
      document.title = prevTitle;
    };
  }, [title, description]);
}
