import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MONTHS, daysInMonth, fmt } from "@/lib/months";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/month/$month")({
  component: MonthPage,
});

type Entry = {
  id?: string;
  store_id: string;
  product_type_id: string;
  year: number;
  month: number;
  day: number;
  posted: number;
  returned: number;
  actual_balance: number | null;
  realized: number;
  opening_balance: number;
};

type Store = { id: string; name: string; counterparty_id: string | null };
type Counterparty = { id: string; name: string };
type PType = { id: string; name: string };

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function MonthPage() {
  const { month } = Route.useParams();
  const m = Number(month);
  const year = new Date().getFullYear();
  const qc = useQueryClient();
  const isMobile = useIsMobile();

  const { data: stores = [] } = useQuery<Store[]>({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("id,name,sort_order")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as Store[];
    },
  });

  const { data: ptypes = [] } = useQuery<PType[]>({
    queryKey: ["ptypes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_types")
        .select("id,name,sort_order")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as PType[];
    },
  });

  const { data: entries = [], isLoading } = useQuery<Entry[]>({
    queryKey: ["entries", year, m],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_entries")
        .select("*")
        .eq("year", year)
        .eq("month", m)
        .limit(50000);
      if (error) throw error;
      return (data ?? []) as Entry[];
    },
  });

  const days = daysInMonth(year, m);

  // Mobile day selector — default to today's day if month is current, else 1
  const today = new Date();
  const defaultDay =
    today.getFullYear() === year && today.getMonth() + 1 === m ? today.getDate() : 1;
  const [selectedDay, setSelectedDay] = useState(defaultDay);

  const byKey = useMemo(() => {
    const x = new Map<string, Entry>();
    for (const e of entries) x.set(`${e.store_id}|${e.product_type_id}|${e.day}`, e);
    return x;
  }, [entries]);

  const rows = useMemo(() => {
    const r: { store: Store; ptype: PType }[] = [];
    for (const s of stores) for (const p of ptypes) r.push({ store: s, ptype: p });
    return r;
  }, [stores, ptypes]);

  const getDay = (storeId: string, ptypeId: string, d: number) =>
    byKey.get(`${storeId}|${ptypeId}|${d}`);

  type Computed = {
    posted: number;
    returned: number;
    manual: number | null;
    effective: number | null;
    base: number | null;
    realized: number | null;
    isAuto: boolean;
  };
  const computed = useMemo(() => {
    const map = new Map<string, Computed>();
    for (const { store, ptype } of rows) {
      const openingRaw = getDay(store.id, ptype.id, 1)?.opening_balance;
      const hasOpening = openingRaw != null && !Number.isNaN(+openingRaw);
      const opening: number | null = hasOpening ? +openingRaw! : null;
      let prevEffective: number | null = opening;
      for (let d = 1; d <= days; d++) {
        const e = getDay(store.id, ptype.id, d);
        const posted = +(e?.posted ?? 0);
        const returned = +(e?.returned ?? 0);
        const manualRaw = e?.actual_balance;
        const hasManual = manualRaw != null && !Number.isNaN(+manualRaw);
        const manual: number | null = hasManual ? +manualRaw! : null;

        const base: number | null = d === 1 ? opening : prevEffective;
        const effective: number | null = manual != null ? manual : base;
        const isAuto = manual == null && effective != null;

        const realized: number | null =
          base != null && effective != null ? base + posted - returned - effective : null;

        map.set(`${store.id}|${ptype.id}|${d}`, {
          posted, returned, manual, effective, base, realized, isAuto,
        });
        prevEffective = effective;
      }
    }
    return map;
  }, [rows, byKey, days]);

  const getComp = (s: string, p: string, d: number) => computed.get(`${s}|${p}|${d}`);

  const saveCell = async (
    storeId: string,
    ptypeId: string,
    day: number,
    field: "posted" | "returned" | "opening_balance" | "actual_balance",
    value: number | null,
  ) => {
    const existing = getDay(storeId, ptypeId, day);
    const payload: any = {
      ...(existing ?? {
        store_id: storeId,
        product_type_id: ptypeId,
        year,
        month: m,
        day,
        posted: 0,
        returned: 0,
        actual_balance: null,
        realized: 0,
        opening_balance: 0,
      }),
      [field]: value,
    };

    const { error } = await supabase
      .from("daily_entries")
      .upsert(payload, { onConflict: "store_id,product_type_id,year,month,day" });
    if (error) {
      toast.error("Ошибка сохранения", { description: error.message });
      return;
    }
    qc.invalidateQueries({ queryKey: ["entries", year, m] });
    qc.invalidateQueries({ queryKey: ["dash-entries", year] });
    qc.invalidateQueries({ queryKey: ["report-entries", year, m] });
  };

  const dayTotals = useMemo(() => {
    const t = new Array(days + 1).fill(0).map(() => ({ posted: 0, returned: 0, realized: 0 }));
    for (const { store, ptype } of rows) {
      for (let d = 1; d <= days; d++) {
        const c = getComp(store.id, ptype.id, d);
        if (!c) continue;
        t[d].posted += c.posted;
        t[d].returned += c.returned;
        if (c.realized != null) t[d].realized += c.realized;
      }
    }
    return t;
  }, [rows, computed, days]);

  const totals = useMemo(() => {
    const t = { posted: 0, returned: 0, realized: 0 };
    for (let d = 1; d <= days; d++) {
      t.posted += dayTotals[d].posted;
      t.returned += dayTotals[d].returned;
      t.realized += dayTotals[d].realized;
    }
    return t;
  }, [dayTotals, days]);

  return (
    <div className="p-3 md:p-6 space-y-4">
      <div>
        <h1 className="text-xl md:text-2xl font-semibold">{MONTHS[m - 1]} {year}</h1>
        <p className="text-xs md:text-sm text-muted-foreground">
          {isMobile
            ? "Выберите день и введите данные. Серым — автоподстановка Факт."
            : "Введите Пост., Возвр. и Факт.ост. Серым показан автоподставленный Факт. (последний введённый)."}
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="border rounded-lg p-8 text-center text-muted-foreground bg-card">
          Нет активных магазинов или типов продукции. Добавьте их в Настройках.
        </div>
      ) : isMobile ? (
        <MobileTable
          rows={rows}
          days={days}
          selectedDay={selectedDay}
          setSelectedDay={setSelectedDay}
          getDay={getDay}
          getComp={getComp}
          saveCell={saveCell}
          dayTotals={dayTotals}
        />
      ) : (
        <DesktopTable
          rows={rows}
          days={days}
          getDay={getDay}
          getComp={getComp}
          saveCell={saveCell}
          dayTotals={dayTotals}
          isCurrentMonth={today.getFullYear() === year && today.getMonth() + 1 === m}
          isPastMonth={year < today.getFullYear() || (year === today.getFullYear() && m < today.getMonth() + 1)}
          currentDay={today.getDate()}
        />
      )}


      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-md">
        <Stat label="Поступило" value={fmt(totals.posted)} />
        <Stat label="Возвращено" value={fmt(totals.returned)} />
        <Stat label="Реализовано" value={fmt(totals.realized)} />
      </div>
    </div>
  );
}

type TableProps = {
  rows: { store: Store; ptype: PType }[];
  days: number;
  getDay: (s: string, p: string, d: number) => Entry | undefined;
  getComp: (s: string, p: string, d: number) => any;
  saveCell: (s: string, p: string, d: number, f: any, v: number | null) => void;
  dayTotals: { posted: number; returned: number; realized: number }[];
};

function DesktopTable({
  rows, days, getDay, getComp, saveCell, dayTotals,
  isCurrentMonth, isPastMonth, currentDay,
}: TableProps & { isCurrentMonth: boolean; isPastMonth: boolean; currentDay: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const syncing = useRef(false);
  const [innerWidth, setInnerWidth] = useState(0);

  // Track table width for the top scrollbar sizer.
  useEffect(() => {
    const update = () => { if (tableRef.current) setInnerWidth(tableRef.current.scrollWidth); };
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro && tableRef.current) ro.observe(tableRef.current);
    window.addEventListener("resize", update);
    return () => { ro?.disconnect(); window.removeEventListener("resize", update); };
  }, [days, rows.length]);

  const STICKY_OFFSET = 320; // ширина 3 закреплённых колонок (~310px)

  // Авто-прокрутка к нужному дню при открытии месяца.
  useEffect(() => {
    if (!scrollerRef.current || innerWidth === 0) return;
    let targetDay: number | null = null;
    if (isCurrentMonth) {
      targetDay = currentDay;
    } else if (isPastMonth) {
      // Последний день с любым значением actual_balance / posted / returned.
      let last = 1;
      for (const r of rows) {
        for (let d = 1; d <= days; d++) {
          const e = getDay(r.store.id, r.ptype.id, d);
          if (!e) continue;
          if (e.actual_balance != null || +e.posted !== 0 || +e.returned !== 0) {
            if (d > last) last = d;
          }
        }
      }
      targetDay = last;
    }
    if (!targetDay) return;
    const el = scrollerRef.current.querySelector(`[data-day="${targetDay}"]`) as HTMLElement | null;
    if (!el) return;
    const left = Math.max(0, el.offsetLeft - STICKY_OFFSET);
    scrollerRef.current.scrollLeft = left;
    if (topRef.current) topRef.current.scrollLeft = left;
    // run only after layout settles
  }, [innerWidth]);

  const scrollToToday = () => {
    if (!scrollerRef.current) return;
    const el = scrollerRef.current.querySelector(`[data-day="${currentDay}"]`) as HTMLElement | null;
    if (!el) return;
    scrollerRef.current.scrollTo({ left: Math.max(0, el.offsetLeft - STICKY_OFFSET), behavior: "smooth" });
  };

  const onTopScroll = () => {
    if (syncing.current) return;
    syncing.current = true;
    if (scrollerRef.current && topRef.current) scrollerRef.current.scrollLeft = topRef.current.scrollLeft;
    requestAnimationFrame(() => { syncing.current = false; });
  };
  const onBottomScroll = () => {
    if (syncing.current) return;
    syncing.current = true;
    if (scrollerRef.current && topRef.current) topRef.current.scrollLeft = scrollerRef.current.scrollLeft;
    requestAnimationFrame(() => { syncing.current = false; });
  };

  return (
    <div className="space-y-2">
      {isCurrentMonth && (
        <div className="flex justify-end">
          <button
            onClick={scrollToToday}
            className="text-xs px-3 py-1 rounded-full border border-sidebar text-sidebar bg-card hover:bg-sidebar/5 transition-colors"
          >
            📅 Сегодня
          </button>
        </div>
      )}

      {/* Верхний синхронизированный скроллбар (sticky) */}
      <div
        ref={topRef}
        onScroll={onTopScroll}
        className="overflow-x-auto sticky top-0 z-20 bg-muted/60 border rounded-t-md"
        style={{ height: 14 }}
      >
        <div style={{ width: innerWidth, height: 1 }} />
      </div>

      <div
        ref={scrollerRef}
        onScroll={onBottomScroll}
        className="border border-t-0 rounded-b-md bg-card overflow-x-auto"
      >
        <table ref={tableRef} className="text-xs num min-w-max">
          <thead className="bg-muted/60 sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 bg-muted/80 px-2 py-2 border-r w-10 text-left shadow-[2px_0_0_rgba(0,0,0,0.04)]">№</th>
              <th className="sticky left-10 bg-muted/80 px-2 py-2 border-r min-w-[260px] text-left">Магазин</th>
              <th className="sticky left-[300px] bg-muted/80 px-2 py-2 border-r w-16 text-left shadow-[2px_0_4px_rgba(0,0,0,0.08)]">Прод.</th>
              <th className="px-2 py-2 border-r text-right">Нач. ост.</th>
              {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                const isToday = isCurrentMonth && d === currentDay;
                return (
                  <th
                    key={d}
                    data-day={d}
                    colSpan={4}
                    className={cn(
                      "px-2 py-2 border-r text-center",
                      isToday ? "bg-sidebar text-sidebar-foreground" : "bg-primary/5"
                    )}
                  >
                    День {d}
                  </th>
                );
              })}
            </tr>
            <tr className="text-muted-foreground">
              <th className="sticky left-0 bg-muted/80 border-r" />
              <th className="sticky left-10 bg-muted/80 border-r" />
              <th className="sticky left-[300px] bg-muted/80 border-r shadow-[2px_0_4px_rgba(0,0,0,0.08)]" />
              <th className="border-r" />
              {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                const isToday = isCurrentMonth && d === currentDay;
                const bg = isToday ? "bg-[#f0f4ff]" : "";
                return (
                  <Fragment key={d}>
                    <th className={cn("px-1 py-1 font-normal", bg)}>Пост.</th>
                    <th className={cn("px-1 py-1 font-normal", bg)}>Возвр.</th>
                    <th className={cn("px-1 py-1 font-normal", bg)}>Факт.</th>
                    <th className={cn("px-1 py-1 font-normal border-r", bg)}>Реал.</th>
                  </Fragment>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const opening = +(getDay(row.store.id, row.ptype.id, 1)?.opening_balance ?? 0);
              return (
                <tr key={`${row.store.id}|${row.ptype.id}`} className="border-t hover:bg-muted/30">
                  <td className="sticky left-0 bg-card px-2 py-1 border-r text-muted-foreground">{idx + 1}</td>
                  <td className="sticky left-10 bg-card px-2 py-1 border-r whitespace-nowrap">{row.store.name}</td>
                  <td className="sticky left-[300px] bg-card px-2 py-1 border-r shadow-[2px_0_4px_rgba(0,0,0,0.08)]">{row.ptype.name}</td>
                  <td className="border-r p-0">
                    <Cell value={opening} onSave={(v) => saveCell(row.store.id, row.ptype.id, 1, "opening_balance", v ?? 0)} />
                  </td>
                  {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                    const c = getComp(row.store.id, row.ptype.id, d);
                    const isNeg = c?.realized != null && c.realized < 0;
                    const isToday = isCurrentMonth && d === currentDay;
                    const tdBg = isToday ? "bg-[#f0f4ff]" : "";
                    return (
                      <Fragment key={d}>
                        <td className={cn("p-0", tdBg)}>
                          <Cell value={c?.posted ?? 0} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "posted", v ?? 0)} />
                        </td>
                        <td className={cn("p-0", tdBg)}>
                          <Cell value={c?.returned ?? 0} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "returned", v ?? 0)} />
                        </td>
                        <td className={cn("p-0", tdBg)}>
                          <Cell
                            value={c?.manual ?? null}
                            autoValue={c?.isAuto ? (c.effective as number) : null}
                            nullable
                            onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "actual_balance", v)}
                          />
                        </td>
                        <td className={cn(
                          "px-2 py-1 text-right border-r font-medium",
                          isToday ? "bg-[#f0f4ff]" : "bg-accent/5",
                          isNeg ? "text-destructive" : "text-foreground"
                        )}>
                          {c?.realized != null ? fmt(c.realized) : "—"}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-t bg-primary/10 font-semibold">
              <td className="sticky left-0 bg-primary/10 px-2 py-2 border-r" colSpan={3}>ИТОГО</td>
              <td className="border-r" />
              {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                const isToday = isCurrentMonth && d === currentDay;
                const tdBg = isToday ? "bg-[#dbe5ff]" : "";
                const isNeg = dayTotals[d].realized < 0;
                return (
                  <Fragment key={d}>
                    <td className={cn("px-1 text-right", tdBg)}>{fmt(dayTotals[d].posted)}</td>
                    <td className={cn("px-1 text-right", tdBg)}>{fmt(dayTotals[d].returned)}</td>
                    <td className={cn("px-1 text-right", tdBg)}>—</td>
                    <td className={cn("px-1 text-right border-r", tdBg, isNeg && "text-destructive")}>{fmt(dayTotals[d].realized)}</td>
                  </Fragment>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}


function MobileTable({
  rows, days, selectedDay, setSelectedDay, getDay, getComp, saveCell, dayTotals,
}: TableProps & { selectedDay: number; setSelectedDay: (d: number) => void }) {
  const d = selectedDay;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto -mx-3 px-3 pb-1">
        <div className="flex gap-2 min-w-max">
          {Array.from({ length: days }, (_, i) => i + 1).map((dd) => {
            const active = dd === d;
            return (
              <button
                key={dd}
                onClick={() => setSelectedDay(dd)}
                className={cn(
                  "shrink-0 h-10 min-w-[64px] px-3 rounded-full text-sm font-medium border active:scale-95 transition-transform",
                  active
                    ? "bg-accent text-accent-foreground border-accent"
                    : "bg-card text-foreground border-border"
                )}
              >
                День {dd}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border rounded-xl bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm num">
            <thead className="bg-muted/60 text-xs">
              <tr>
                <th className="px-2 py-2 text-left w-8">№</th>
                <th className="px-2 py-2 text-left min-w-[140px]">Магазин</th>
                <th className="px-2 py-2 text-left w-12">Тип</th>
                <th className="px-2 py-2 text-right">Нач.</th>
                <th className="px-2 py-2 text-right">Пост.</th>
                <th className="px-2 py-2 text-right">Возвр.</th>
                <th className="px-2 py-2 text-right">Факт.</th>
                <th className="px-2 py-2 text-right pr-2">Реал.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const opening = +(getDay(row.store.id, row.ptype.id, 1)?.opening_balance ?? 0);
                const c = getComp(row.store.id, row.ptype.id, d);
                const isNeg = c?.realized != null && c.realized < 0;
                return (
                  <tr key={`${row.store.id}|${row.ptype.id}`} className="border-t">
                    <td className="px-2 py-1 text-muted-foreground text-xs">{idx + 1}</td>
                    <td className="px-2 py-1 text-xs leading-tight">{truncate(row.store.name, 22)}</td>
                    <td className="px-2 py-1 text-xs">{row.ptype.name}</td>
                    <td className="p-0">
                      <Cell
                        value={d === 1 ? opening : (c?.base ?? null)}
                        readOnly={d !== 1}
                        onSave={(v) => saveCell(row.store.id, row.ptype.id, 1, "opening_balance", v ?? 0)}
                      />
                    </td>
                    <td className="p-0">
                      <Cell value={c?.posted ?? 0} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "posted", v ?? 0)} />
                    </td>
                    <td className="p-0">
                      <Cell value={c?.returned ?? 0} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "returned", v ?? 0)} />
                    </td>
                    <td className="p-0">
                      <Cell
                        value={c?.manual ?? null}
                        autoValue={c?.isAuto ? (c.effective as number) : null}
                        nullable
                        onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "actual_balance", v)}
                      />
                    </td>
                    <td className={cn(
                      "px-2 py-1 text-right font-semibold text-sm pr-2",
                      isNeg ? "text-destructive" : "text-foreground"
                    )}>
                      {c?.realized != null ? fmt(c.realized) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="sticky bottom-0">
              <tr className="bg-primary/10 font-semibold border-t">
                <td className="px-2 py-2 text-xs" colSpan={4}>ИТОГО за день {d}</td>
                <td className="px-2 py-2 text-right text-xs">{fmt(dayTotals[d].posted)}</td>
                <td className="px-2 py-2 text-right text-xs">{fmt(dayTotals[d].returned)}</td>
                <td className="px-2 py-2 text-right text-xs">—</td>
                <td className="px-2 py-2 text-right pr-2 text-xs">{fmt(dayTotals[d].realized)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded-xl px-3 py-2 bg-card shadow-sm">
      <div className="text-[10px] uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className="font-bold text-lg md:text-xl num mt-0.5">{value}</div>
    </div>
  );
}

function Cell({
  value,
  onSave,
  autoValue,
  nullable,
  readOnly,
}: {
  value: number | null;
  onSave: (v: number | null) => void | Promise<void>;
  autoValue?: number | null;
  nullable?: boolean;
  readOnly?: boolean;
}) {
  const displayAuto = value == null && autoValue != null;
  const [v, setV] = useState(value != null ? String(value) : "");
  const [focused, setFocused] = useState(false);
  const original = useRef<number | null>(value);
  useEffect(() => {
    setV(value != null ? String(value) : "");
    original.current = value;
  }, [value]);

  const shown = focused
    ? v
    : value != null
    ? String(value)
    : displayAuto
    ? String(autoValue)
    : "";

  if (readOnly) {
    return (
      <div className="w-full px-2 py-2 text-right text-sm num text-muted-foreground">
        {shown || "—"}
      </div>
    );
  }

  return (
    <input
      value={shown}
      onFocus={() => setFocused(true)}
      onChange={(e) => setV(e.target.value.replace(/[^\d.,-]/g, ""))}
      onBlur={() => {
        setFocused(false);
        const trimmed = v.trim();
        if (trimmed === "") {
          if (nullable) {
            if (original.current != null) onSave(null);
          } else {
            if (original.current !== 0) onSave(0);
          }
          return;
        }
        const n = parseFloat(trimmed.replace(",", ".")) || 0;
        if (n !== original.current) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={cn(
        "w-full min-w-[56px] px-2 py-2 text-right text-sm md:text-xs bg-transparent focus:bg-background focus:outline-none focus:ring-1 focus:ring-ring rounded num",
        !focused && displayAuto ? "text-[#9ca3af]" : ""
      )}
      inputMode="decimal"
    />
  );
}
