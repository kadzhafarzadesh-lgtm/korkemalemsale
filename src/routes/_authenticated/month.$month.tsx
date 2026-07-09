import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MONTHS, daysInMonth, fmt, todayAqtauParts } from "@/lib/months";
import { Loader2, Eye } from "lucide-react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/lib/auth-context";
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
  written_off: number;
  actual_balance: number | null;
  realized: number;
  opening_balance: number;
};

type Store = { id: string; name: string; counterparty_id: string | null };
type Counterparty = { id: string; name: string };
type PType = { id: string; name: string };

const MAX_VAL = 999999;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function MonthPage() {
  const { month } = Route.useParams();
  const m = Number(month);
  const year = todayAqtauParts().year;
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const { canWrite, isViewer } = useAuth();
  const readOnly = !canWrite;

  const { data: stores = [] } = useQuery<Store[]>({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("id,name,sort_order,counterparty_id")
        .eq("is_active", true)
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Store[];
    },
  });

  const { data: counterparties = [] } = useQuery<Counterparty[]>({
    queryKey: ["counterparties"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("counterparties")
        .select("id,name,sort_order")
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Counterparty[];
    },
  });

  const { data: ptypes = [] } = useQuery<PType[]>({
    queryKey: ["ptypes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_types")
        .select("id,name,sort_order")
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return (data ?? []) as PType[];
    },
  });

  // Realtime: invalidate current month on any daily_entries change for this year.
  useEffect(() => {
    const channel = supabase
      .channel(`de-${year}-${m}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_entries", filter: `year=eq.${year}` },
        () => {
          qc.invalidateQueries({ queryKey: ["entries", year, m] });
          qc.invalidateQueries({ queryKey: ["entries", m === 1 ? year - 1 : year, m === 1 ? 12 : m - 1] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc, year, m]);

  const [filterCp, setFilterCp] = useState<string>("all");
  const [filterStore, setFilterStore] = useState<string>("all");
  const [filterPtype, setFilterPtype] = useState<string>("all");

  const visibleStores = useMemo(
    () => stores.filter(s => filterCp === "all" || s.counterparty_id === filterCp),
    [stores, filterCp],
  );
  const visiblePtypes = useMemo(
    () => ptypes.filter(p => filterPtype === "all" || p.id === filterPtype),
    [ptypes, filterPtype],
  );

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

  // Previous month entries (for carrying actual_balance into next month's opening).
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? year - 1 : year;
  const { data: prevEntries = [] } = useQuery<Entry[]>({
    queryKey: ["entries", prevYear, prevMonth],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,day,actual_balance,opening_balance,posted,returned,written_off")
        .eq("year", prevYear)
        .eq("month", prevMonth)
        .limit(50000);
      if (error) throw error;
      return (data ?? []) as Entry[];
    },
    enabled: m > 1, // Only for months > January (Jan has no prior month rollover in same year)
  });

  // Map (store|ptype) -> last actual_balance from previous month
  const carryMap = useMemo(() => {
    const map = new Map<string, number>();
    if (prevEntries.length === 0) return map;
    // Sort by day, walk forward, compute effective balance per day
    const byKey = new Map<string, Entry[]>();
    for (const e of prevEntries as Entry[]) {
      const k = `${e.store_id}|${e.product_type_id}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(e);
    }
    for (const [k, list] of byKey) {
      list.sort((a, b) => a.day - b.day);
      let lastEffective: number | null = null;
      let prevEff: number | null = null;
      const opening = list.find(e => e.day === 1)?.opening_balance ?? null;
      prevEff = opening != null ? +opening : null;
      for (const e of list) {
        const base = e.day === 1 ? (opening != null ? +opening : null) : prevEff;
        const manual = e.actual_balance != null ? +e.actual_balance : null;
        const wo = +((e as any).written_off ?? 0);
        let eff: number | null;
        if (manual != null) eff = manual;
        else if (base != null) eff = base + (+e.posted) - (+e.returned) - wo;
        else eff = null;
        prevEff = eff;
        if (eff != null) lastEffective = eff;
      }
      if (lastEffective != null) map.set(k, lastEffective);
    }
    return map;
  }, [prevEntries]);

  const days = daysInMonth(year, m);

  const _t = todayAqtauParts();
  const defaultDay = _t.year === year && _t.month === m ? _t.day : 1;
  const [selectedDay, setSelectedDay] = useState(defaultDay);

  const byKey = useMemo(() => {
    const x = new Map<string, Entry>();
    for (const e of entries) x.set(`${e.store_id}|${e.product_type_id}|${e.day}`, e);
    return x;
  }, [entries]);

  const rows = useMemo(() => {
    const r: { store: Store; ptype: PType }[] = [];
    for (const s of visibleStores) {
      if (filterStore !== "all" && s.id !== filterStore) continue;
      for (const p of visiblePtypes) r.push({ store: s, ptype: p });
    }
    return r;
  }, [visibleStores, visiblePtypes, filterStore]);

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
    openingAuto: boolean; // true if opening was carried from previous month, not entered
  };
  const computed = useMemo(() => {
    const map = new Map<string, Computed>();
    for (const { store, ptype } of rows) {
      const k = `${store.id}|${ptype.id}`;
      const openingRaw = getDay(store.id, ptype.id, 1)?.opening_balance;
      const hasOpeningEntered = openingRaw != null && +openingRaw !== 0;
      const carry = carryMap.get(k) ?? null;
      // Use entered opening if non-zero; else carry from previous month if available; else 0/null.
      const opening: number | null = hasOpeningEntered
        ? +openingRaw!
        : (carry != null ? carry : (openingRaw != null ? +openingRaw : null));
      const openingAuto = !hasOpeningEntered && carry != null;

      let prevEffective: number | null = opening;
      for (let d = 1; d <= days; d++) {
        const e = getDay(store.id, ptype.id, d);
        const posted = +(e?.posted ?? 0);
        const returned = +(e?.returned ?? 0);
        const writtenOff = +((e as any)?.written_off ?? 0);
        const manualRaw = e?.actual_balance;
        const hasManual = manualRaw != null && !Number.isNaN(+manualRaw);
        const manual: number | null = hasManual ? +manualRaw! : null;

        const base: number | null = d === 1 ? opening : prevEffective;

        let effective: number | null;
        let realized: number | null;
        let isAuto: boolean;
        if (manual != null) {
          effective = manual;
          realized = base != null ? base + posted - returned - writtenOff - manual : null;
          isAuto = false;
        } else if (base != null) {
          // Auto: pretend actual = base + posted - returned - written_off, so realized = 0
          effective = base + posted - returned - writtenOff;
          realized = 0;
          isAuto = true;
        } else {
          effective = null;
          realized = null;
          isAuto = false;
        }

        map.set(`${store.id}|${ptype.id}|${d}`, {
          posted, returned, manual, effective, base, realized, isAuto,
          openingAuto: d === 1 ? openingAuto : false,
        });
        prevEffective = effective;
      }
    }
    return map;
  }, [rows, byKey, days, carryMap]);

  const getComp = (s: string, p: string, d: number) => computed.get(`${s}|${p}|${d}`);

  const saveCell = async (
    storeId: string,
    ptypeId: string,
    day: number,
    field: "posted" | "returned" | "opening_balance" | "actual_balance" | "written_off",
    value: number | null,
  ) => {
    if (readOnly) return;
    const payload: Record<string, unknown> = {
      store_id: storeId,
      product_type_id: ptypeId,
      year,
      month: m,
      day,
      [field]: value,
    };
    const { error } = await supabase
      .from("daily_entries")
      .upsert(payload as any, { onConflict: "store_id,product_type_id,year,month,day" });
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">{MONTHS[m - 1]} {year}</h1>
          <p className="text-xs md:text-sm text-muted-foreground">
            {isViewer
              ? "Просмотр данных. Серым — автозначения (Факт.ост. не вводили вручную)."
              : isMobile
              ? "Выберите день и введите данные. Серым — автозначения."
              : "Введите Пост., Возвр. и Факт.ост. Серым — автозначения (Реал. = 0 пока Факт.ост. не введён)."}
          </p>
        </div>
        {isViewer && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
            <Eye className="w-3.5 h-3.5" /> Только просмотр
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Контрагент</label>
          <select
            value={filterCp}
            onChange={(e) => { setFilterCp(e.target.value); setFilterStore("all"); }}
            className="w-full h-10 px-3 rounded-md border bg-card text-sm"
          >
            <option value="all">Все</option>
            {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Магазин</label>
          <select
            value={filterStore}
            onChange={(e) => setFilterStore(e.target.value)}
            className="w-full h-10 px-3 rounded-md border bg-card text-sm"
          >
            <option value="all">Все</option>
            {visibleStores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Продукция</label>
          <select
            value={filterPtype}
            onChange={(e) => setFilterPtype(e.target.value)}
            className="w-full h-10 px-3 rounded-md border bg-card text-sm"
          >
            <option value="all">Все</option>
            {ptypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>


      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="border rounded-lg p-8 text-center text-muted-foreground bg-card">
          {stores.length === 0 || ptypes.length === 0
            ? "Нет активных магазинов или типов продукции. Добавьте их в Настройках."
            : "По выбранным фильтрам ничего не найдено."}
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
          readOnly={readOnly}
        />
      ) : (
        <DesktopTable
          rows={rows}
          days={days}
          getDay={getDay}
          getComp={getComp}
          saveCell={saveCell}
          dayTotals={dayTotals}
          isCurrentMonth={_t.year === year && _t.month === m}
          isPastMonth={year < _t.year || (year === _t.year && m < _t.month)}
          currentDay={_t.day}
          readOnly={readOnly}
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
  readOnly: boolean;
};

// Sticky column left-offsets (in px). Widths: 40, 260, 64, 96 = 460 total.
const COL_W = { num: 40, store: 260, ptype: 64, opening: 96 };
const STICKY_OFFSET = COL_W.num + COL_W.store + COL_W.ptype + COL_W.opening; // 460
const STICKY_BG = "bg-card"; // opaque
const STICKY_HEAD_BG = "bg-muted"; // opaque, no transparency
const RIGHT_SHADOW = "shadow-[4px_0_6px_-2px_rgba(0,0,0,0.15)]";

function DesktopTable({
  rows, days, getDay, getComp, saveCell, dayTotals, readOnly,
  isCurrentMonth, isPastMonth, currentDay,
}: TableProps & { isCurrentMonth: boolean; isPastMonth: boolean; currentDay: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const syncing = useRef(false);
  const [innerWidth, setInnerWidth] = useState(0);

  useEffect(() => {
    const update = () => { if (tableRef.current) setInnerWidth(tableRef.current.scrollWidth); };
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro && tableRef.current) ro.observe(tableRef.current);
    window.addEventListener("resize", update);
    return () => { ro?.disconnect(); window.removeEventListener("resize", update); };
  }, [days, rows.length]);

  useEffect(() => {
    if (!scrollerRef.current || innerWidth === 0) return;
    let targetDay: number | null = null;
    if (isCurrentMonth) {
      targetDay = currentDay;
    } else if (isPastMonth) {
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

  // Sticky left offsets for the 4 fixed columns
  const L = {
    num: 0,
    store: COL_W.num,
    ptype: COL_W.num + COL_W.store,
    opening: COL_W.num + COL_W.store + COL_W.ptype,
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

      <div
        ref={topRef}
        onScroll={onTopScroll}
        className="overflow-x-auto sticky top-0 z-30 bg-muted border rounded-t-md"
        style={{ height: 14 }}
      >
        <div style={{ width: innerWidth, height: 1 }} />
      </div>

      <div
        ref={scrollerRef}
        onScroll={onBottomScroll}
        className="border border-t-0 rounded-b-md bg-card overflow-x-auto"
      >
        <table ref={tableRef} className="text-xs num min-w-max border-separate border-spacing-0">
          <thead>
            <tr>
              <th style={{ left: L.num, width: COL_W.num }} className={cn("sticky top-0 z-40 px-2 py-2 border-r border-b text-left", STICKY_HEAD_BG)}>№</th>
              <th style={{ left: L.store, minWidth: COL_W.store }} className={cn("sticky top-0 z-40 px-2 py-2 border-r border-b text-left", STICKY_HEAD_BG)}>Магазин</th>
              <th style={{ left: L.ptype, width: COL_W.ptype }} className={cn("sticky top-0 z-40 px-2 py-2 border-r border-b text-left", STICKY_HEAD_BG)}>Прод.</th>
              <th style={{ left: L.opening, width: COL_W.opening }} className={cn("sticky top-0 z-40 px-2 py-2 border-r border-b text-right", STICKY_HEAD_BG, RIGHT_SHADOW)}>Нач.ост.</th>
              {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                const isToday = isCurrentMonth && d === currentDay;
                return (
                  <th
                    key={d}
                    data-day={d}
                    colSpan={4}
                    className={cn(
                      "sticky top-0 z-10 px-2 py-2 border-r border-b text-center",
                      isToday ? "bg-sidebar text-sidebar-foreground" : "bg-muted"
                    )}
                  >
                    День {d}
                  </th>
                );
              })}
            </tr>
            <tr className="text-muted-foreground">
              <th style={{ left: L.num, top: 33, width: COL_W.num }} className={cn("sticky z-40 border-r border-b", STICKY_HEAD_BG)} />
              <th style={{ left: L.store, top: 33, minWidth: COL_W.store }} className={cn("sticky z-40 border-r border-b", STICKY_HEAD_BG)} />
              <th style={{ left: L.ptype, top: 33, width: COL_W.ptype }} className={cn("sticky z-40 border-r border-b", STICKY_HEAD_BG)} />
              <th style={{ left: L.opening, top: 33, width: COL_W.opening }} className={cn("sticky z-40 border-r border-b", STICKY_HEAD_BG, RIGHT_SHADOW)} />
              {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                const isToday = isCurrentMonth && d === currentDay;
                const bg = isToday ? "bg-[#f0f4ff]" : "bg-muted";
                return (
                  <Fragment key={d}>
                    <th style={{ top: 33 }} className={cn("sticky z-10 px-1 py-1 font-normal border-b", bg)}>Пост.</th>
                    <th style={{ top: 33 }} className={cn("sticky z-10 px-1 py-1 font-normal border-b", bg)}>Возвр.</th>
                    <th style={{ top: 33 }} className={cn("sticky z-10 px-1 py-1 font-normal border-b", bg)}>Факт.</th>
                    <th style={{ top: 33 }} className={cn("sticky z-10 px-1 py-1 font-normal border-r border-b", bg)}>Реал.</th>
                  </Fragment>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const c1 = getComp(row.store.id, row.ptype.id, 1);
              const openingAuto = c1?.openingAuto;
              const openingShown = c1?.base ?? 0;
              return (
                <tr key={`${row.store.id}|${row.ptype.id}`} className="hover:bg-muted/30">
                  <td style={{ left: L.num, width: COL_W.num }} className={cn("sticky z-20 px-2 py-1 border-r border-b text-muted-foreground", STICKY_BG)}>{idx + 1}</td>
                  <td style={{ left: L.store, minWidth: COL_W.store }} className={cn("sticky z-20 px-2 py-1 border-r border-b whitespace-nowrap", STICKY_BG)}>{row.store.name}</td>
                  <td style={{ left: L.ptype, width: COL_W.ptype }} className={cn("sticky z-20 px-2 py-1 border-r border-b", STICKY_BG)}>{row.ptype.name}</td>
                  <td style={{ left: L.opening, width: COL_W.opening }} className={cn("sticky z-20 border-r border-b p-0", STICKY_BG, RIGHT_SHADOW)}>
                    <Cell
                      value={openingShown}
                      autoHint={openingAuto}
                      readOnly={readOnly}
                      onSave={(v) => saveCell(row.store.id, row.ptype.id, 1, "opening_balance", v ?? 0)}
                    />
                  </td>
                  {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                    const c = getComp(row.store.id, row.ptype.id, d);
                    const isNeg = c?.realized != null && c.realized < 0;
                    const isToday = isCurrentMonth && d === currentDay;
                    const tdBg = isToday ? "bg-[#f0f4ff]" : "";
                    const realText = c?.isAuto ? "text-[#9ca3af]" : isNeg ? "text-destructive" : "text-foreground";
                    return (
                      <Fragment key={d}>
                        <td className={cn("p-0 border-b", tdBg)}>
                          <Cell value={c?.posted ?? 0} readOnly={readOnly} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "posted", v ?? 0)} />
                        </td>
                        <td className={cn("p-0 border-b", tdBg)}>
                          <Cell value={c?.returned ?? 0} readOnly={readOnly} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "returned", v ?? 0)} />
                        </td>
                        <td className={cn("p-0 border-b", tdBg)}>
                          <Cell
                            value={c?.manual ?? null}
                            autoValue={c?.isAuto ? (c.effective as number) : null}
                            nullable
                            readOnly={readOnly}
                            onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "actual_balance", v)}
                          />
                        </td>
                        <td className={cn(
                          "px-2 py-1 text-right border-r border-b font-medium",
                          isToday ? "bg-[#f0f4ff]" : "bg-accent/5",
                          realText
                        )}>
                          {c?.realized != null ? fmt(c.realized) : "—"}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="bg-primary/10 font-semibold">
              <td style={{ left: L.num }} className="sticky z-20 bg-primary/10 px-2 py-2 border-r border-b" colSpan={1}>#</td>
              <td style={{ left: L.store }} className="sticky z-20 bg-primary/10 px-2 py-2 border-r border-b" colSpan={1}>ИТОГО</td>
              <td style={{ left: L.ptype }} className="sticky z-20 bg-primary/10 px-2 py-2 border-r border-b" colSpan={1} />
              <td style={{ left: L.opening }} className={cn("sticky z-20 bg-primary/10 px-2 py-2 border-r border-b", RIGHT_SHADOW)} />
              {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                const isToday = isCurrentMonth && d === currentDay;
                const tdBg = isToday ? "bg-[#dbe5ff]" : "bg-primary/10";
                const isNeg = dayTotals[d].realized < 0;
                return (
                  <Fragment key={d}>
                    <td className={cn("px-1 text-right border-b", tdBg)}>{fmt(dayTotals[d].posted)}</td>
                    <td className={cn("px-1 text-right border-b", tdBg)}>{fmt(dayTotals[d].returned)}</td>
                    <td className={cn("px-1 text-right border-b", tdBg)}>—</td>
                    <td className={cn("px-1 text-right border-r border-b", tdBg, isNeg && "text-destructive")}>{fmt(dayTotals[d].realized)}</td>
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
  rows, days, selectedDay, setSelectedDay, getDay, getComp, saveCell, dayTotals, readOnly,
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
                const c1 = getComp(row.store.id, row.ptype.id, 1);
                const openingAuto = c1?.openingAuto;
                const c = getComp(row.store.id, row.ptype.id, d);
                const isNeg = c?.realized != null && c.realized < 0;
                const realText = c?.isAuto ? "text-[#9ca3af]" : isNeg ? "text-destructive" : "text-foreground";
                return (
                  <tr key={`${row.store.id}|${row.ptype.id}`} className="border-t">
                    <td className="px-2 py-1 text-muted-foreground text-xs">{idx + 1}</td>
                    <td className="px-2 py-1 text-xs leading-tight">{truncate(row.store.name, 22)}</td>
                    <td className="px-2 py-1 text-xs">{row.ptype.name}</td>
                    <td className="p-0">
                      <Cell
                        value={d === 1 ? (c1?.base ?? 0) : (c?.base ?? null)}
                        autoHint={d === 1 && openingAuto}
                        readOnly={d !== 1 || readOnly}
                        onSave={(v) => saveCell(row.store.id, row.ptype.id, 1, "opening_balance", v ?? 0)}
                      />
                    </td>
                    <td className="p-0">
                      <Cell value={c?.posted ?? 0} readOnly={readOnly} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "posted", v ?? 0)} />
                    </td>
                    <td className="p-0">
                      <Cell value={c?.returned ?? 0} readOnly={readOnly} onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "returned", v ?? 0)} />
                    </td>
                    <td className="p-0">
                      <Cell
                        value={c?.manual ?? null}
                        autoValue={c?.isAuto ? (c.effective as number) : null}
                        nullable
                        readOnly={readOnly}
                        onSave={(v) => saveCell(row.store.id, row.ptype.id, d, "actual_balance", v)}
                      />
                    </td>
                    <td className={cn("px-2 py-1 text-right font-semibold text-sm pr-2", realText)}>
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
  autoHint,
  nullable,
  readOnly,
}: {
  value: number | null;
  onSave: (v: number | null) => void | Promise<void>;
  autoValue?: number | null;
  autoHint?: boolean;
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
      <div className={cn(
        "w-full px-2 py-2 text-right text-sm num",
        (displayAuto || autoHint) ? "text-[#9ca3af]" : "text-foreground"
      )}>
        {shown || "—"}
      </div>
    );
  }

  const isGrey = !focused && (displayAuto || autoHint);

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
        let n = parseFloat(trimmed.replace(",", ".")) || 0;
        if (n < 0) n = 0;
        if (n > MAX_VAL) n = MAX_VAL;
        if (n !== original.current) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={cn(
        "w-full min-w-[56px] px-2 py-2 text-right text-sm md:text-xs bg-transparent focus:bg-background focus:outline-none focus:ring-1 focus:ring-ring rounded num",
        isGrey ? "text-[#9ca3af]" : ""
      )}
      inputMode="decimal"
    />
  );
}
