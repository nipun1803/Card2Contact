import { useEffect, useState } from "react";

/** Reactive media-query match. Used for responsive layout branching in JS. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** True below the `md` breakpoint (768px) — i.e. mobile/small tablet. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
