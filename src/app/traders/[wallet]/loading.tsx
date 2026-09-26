import { Card } from "@/components/ui/primitives";

/** Skeleton while a trader profile renders on the server (the per-mint PnL is computed on demand). */
export default function TraderLoading() {
  return (
    <div className="page @container gap-4 app:gap-5" aria-busy="true" aria-label="Loading trader">
      <span className="mt-1 h-8 w-40 rounded-full bg-card-3/70 app:mt-0" />
      <Card className="overflow-hidden">
        <div className="h-[84px] bg-mint-100 animate-blink app:h-[108px]" />
        <div className="flex flex-col gap-4 px-4 pb-6 app:px-6 @3xl:flex-row @3xl:items-start @3xl:gap-6">
          <span className="-mt-[60px] size-[112px] shrink-0 rounded-[24px] bg-card-3 shadow-[0_0_0_4px_var(--card)] animate-blink app:-mt-[80px] app:size-[144px] app:rounded-[30px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-3 @3xl:pt-5">
            <span className="h-3 w-24 rounded bg-card-3" />
            <span className="h-8 w-60 max-w-full rounded-lg bg-card-3" />
            <span className="h-3 w-44 rounded bg-card-3" />
            <div className="mt-1 flex gap-2">
              <span className="h-[22px] w-14 rounded-full bg-card-2" />
              <span className="h-[22px] w-20 rounded-full bg-card-2" />
              <span className="h-[22px] w-20 rounded-full bg-card-2" />
            </div>
          </div>
          <div className="flex flex-col gap-2.5 @3xl:w-64 @3xl:pt-5">
            <span className="h-12 rounded-full bg-card-3" />
            <span className="h-12 rounded-full bg-card-2" />
          </div>
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3 app:gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} className="flex h-56 flex-col gap-3 p-4">
            <span className="h-3 w-20 rounded bg-card-3" />
            <span className="h-7 w-32 rounded-lg bg-card-3 animate-blink" />
            <span className="mt-auto h-20 rounded-card-sm bg-card-2" />
          </Card>
        ))}
      </div>
      <Card className="h-64" />
    </div>
  );
}
