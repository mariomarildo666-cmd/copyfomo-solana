"use client";

// /feed: each row pairs an ORIGINAL trade with what a COPY agent did about it (copied, skipped or failed, with
// latency), newest first, polled every 5s. Filters: All / Copied / Skipped · Failed. The same list (and row) as the
// landing page's feed preview, with the filter chips on.

import { FeedList } from "@/components/landing/FeedList";

export type { FeedFilter } from "@/components/landing/FeedList";

export function FeedRows({ limit = 50, pollMs = 5_000 }: { limit?: number; pollMs?: number }) {
  return (
    <section aria-label="Recent original trades and copies" className="mt-5 flex flex-col max-app:mt-4">
      <FeedList limit={limit} pollMs={pollMs} withFilters />
    </section>
  );
}
