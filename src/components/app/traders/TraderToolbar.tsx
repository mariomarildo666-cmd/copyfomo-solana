// The toolbar above a trader list (Explore and /traders): filter chips, ranking window, sort and a search slot.
// No hooks (the parent owns the state); render it from a client component.
//
//   wide container (≥ 60rem)  one row: chips … window · sort · search (300 px)
//   narrower                  chips … window / sort · search (full width)
//   phones                    chips (scrolling, edge to edge) / window · sort / search

import type { ReactNode } from "react";
import type { LeaderboardWindow } from "@/lib/types";
import { ChipGroup, Segmented } from "@/components/ui/ChipGroup";
import { cn } from "@/components/ui/cn";
import { SortMenu } from "@/components/ui/SortMenu";
import { FILTERS, WINDOWS, sortOptions, type TraderFilter, type TraderSort } from "./explore";

export function TraderToolbar({
  filter,
  onFilter,
  win,
  onWindow,
  sort,
  onSort,
  search,
  className,
}: {
  filter: TraderFilter;
  onFilter: (v: TraderFilter) => void;
  win: LeaderboardWindow;
  onWindow: (v: LeaderboardWindow) => void;
  sort: TraderSort;
  onSort: (v: TraderSort) => void;
  /** The search / filter field (full width on its own row when space runs out). */
  search: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("@container/tb", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3 max-app:gap-x-2 max-app:gap-y-2.5">
        <ChipGroup
          label="Filter traders"
          options={FILTERS}
          value={filter}
          onChange={onFilter}
          className="app:flex-[1_0_auto] max-app:w-[calc(100%+32px)] max-app:flex-none"
        />
        <Segmented
          label="Ranking window"
          options={WINDOWS}
          value={win}
          onChange={onWindow}
        />
        {/* tablets: its own row; wide: joins the row; phones: dissolves (sort beside the window, search below) */}
        <div className="flex min-w-0 basis-full items-center gap-3 max-app:contents @min-[60rem]/tb:flex-[0_1_auto] @min-[60rem]/tb:basis-auto">
          <SortMenu label="Sort" options={sortOptions(win)} value={sort} onChange={onSort} />
          <div className="min-w-0 flex-1 max-app:basis-full @min-[60rem]/tb:w-[300px] @min-[60rem]/tb:flex-none">{search}</div>
        </div>
      </div>
    </div>
  );
}
