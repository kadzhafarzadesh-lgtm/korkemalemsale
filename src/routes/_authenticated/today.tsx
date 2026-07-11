import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { CalendarIcon, Eye } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { todayAqtauParts } from "@/lib/months";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { productRowStyle, productDotStyle } from "@/lib/product-colors";

export const Route = createFileRoute("/_authenticated/today")({
  component: TodayPage,
  errorComponent: ({ error }) => <div className="p-6 text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-6">Не найдено</div>,
});

type Store = { id: string; name: string; counterparty_id: string | null };
type PType = { id: string; name: string; color: string | null };
type Entry = {
  store_id: string;
  product_type_id: string;
  posted: number;
  returned: number;
  written_off: number;
  actual_balance: number | null;
  opening_balance: number;
};

function TodayPage() {
  const qc = useQueryClient();
  const { canWrite } = useAuth();
  const readOnly = !canWrite;

  const t = todayAqtauParts();
  const [date, setDate] = useState<Date>(new Date(t.year, t.month - 1, t.day));
  const y = date.getFullYear();
  const mo = date.getMonth() + 1;
  const day = date.getDate();

  const { data: stores = [] } = useQuery<Store[]>({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data } = await supabase
        .from("stores")
        .select("id,name,counterparty_id")
        .eq("is_active", true)
        .order("sort_order").order("name");
      return (data ?? []) as Store[];
    },
  });
  const { data: cps = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["counterparties"],
    queryFn: async () =>
      (await supabase.from("counterparties").select("id,name").order("sort_order").order("name")).data ?? [],
  });
  const { data: ptypes = [] } = useQuery<PType[]>({
    queryKey: ["ptypes"],
    queryFn: async () =>
      ((await supabase.from("product_types").select("id,name,color").order("sort_order").order("name")).data ?? []) as PType[],
  });

  const { data: entries = [] } = useQuery<Entry[]>({
    queryKey: ["today-entries", y, mo, day],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,posted,returned,written_off,actual_balance,opening_balance")
        .eq("year", y).eq("month", mo).eq("day", day);
      return (data ?? []) as Entry[];
    },
  });

  // History for computing running base up to (selected day - 1) within the current month,
  // plus the previous month's carry when day 1 has no explicit opening.
  type HistEntry = { store_id: string; product_type_id: string; year: number; month: number; day: number; posted: number; returned: number; written_off: number; actual_balance: number | null; opening_balance: number };
  const { data: history = [] } = useQuery<HistEntry[]>({
    queryKey: ["today-history", y, mo],
    queryFn: async () => {
      const prevY = mo === 1 ? y - 1 : y;
      const prevM = mo === 1 ? 12 : mo - 1;
      const { data } = await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,year,month,day,posted,returned,written_off,actual_balance,opening_balance")
        .in("year", [prevY, y])
        .or(`and(year.eq.${y},month.eq.${mo}),and(year.eq.${prevY},month.eq.${prevM})`)
        .limit(50000);
      return (data ?? []) as HistEntry[];
    },
  });

  // realtime
  useEffect(() => {
    const ch = supabase
      .channel(`today-${y}-${mo}-${day}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_entries", filter: `year=eq.${y}` }, () => {
        qc.invalidateQueries({ queryKey: ["today-entries", y, mo, day] });
        qc.invalidateQueries({ queryKey: ["today-history", y, mo] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc, y, mo, day]);

  const [filterCp, setFilterCp] = useState("all");
  const [filterStore, setFilterStore] = useState("all");

  const byKey = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of entries) m.set(`${e.store_id}|${e.product_type_id}`, e);
    return m;
  }, [entries]);

  // Compute base (running effective balance at end of previous day) per store×product.
  const baseByKey = useMemo(() => {
    const m = new Map<string, number>();
    // Group history by key
    const groups = new Map<string, HistEntry[]>();
    for (const h of history) {
      const k = `${h.store_id}|${h.product_type_id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(h);
    }
    const cutoff = y * 10000 + mo * 100 + day; // exclude the selected day itself
    for (const [k, list] of groups) {
      list.sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day);
      // opening_balance: prefer first day-1 entry of current month; else first day-1 of prev month
      const curMonthDay1 = list.find(e => e.year === y && e.month === mo && e.day === 1);
      const openingCurRaw = curMonthDay1?.opening_balance;
      const hasOpeningCur = openingCurRaw != null && +openingCurRaw !== 0;
      const prevY = mo === 1 ? y - 1 : y;
      const prevM = mo === 1 ? 12 : mo - 1;
      const prevMonthDay1 = list.find(e => e.year === prevY && e.month === prevM && e.day === 1);
      const openingPrev = +(prevMonthDay1?.opening_balance ?? 0);

      let eff: number = hasOpeningCur ? +openingCurRaw! : openingPrev;
      // If current month has an entered opening, we can skip prev month entirely.
      const startFromCurrent = hasOpeningCur;
      for (const e of list) {
        const key = e.year * 10000 + e.month * 100 + e.day;
        if (startFromCurrent && (e.year !== y || e.month !== mo)) continue;
        if (key >= cutoff) break;
        const posted = +e.posted;
        const returned = +e.returned;
        const wo = +(e.written_off ?? 0);
        const manual = e.actual_balance != null ? +e.actual_balance : null;
        eff = manual != null ? manual : eff + posted - returned - wo;
      }
      m.set(k, eff);
    }
    return m;
  }, [history, y, mo, day]);

  const rows = useMemo(() => {
    const list: { store: Store; ptype: PType }[] = [];
    for (const s of stores) {
      if (filterCp !== "all" && s.counterparty_id !== filterCp) continue;
      if (filterStore !== "all" && s.id !== filterStore) continue;
      for (const p of ptypes) list.push({ store: s, ptype: p });
    }
    return list;
  }, [stores, ptypes, filterCp, filterStore]);

  const filledCount = useMemo(() => {
    let c = 0;
    for (const { store, ptype } of rows) {
      const e = byKey.get(`${store.id}|${ptype.id}`);
      if (e && (e.actual_balance != null || +e.posted !== 0 || +e.returned !== 0)) c++;
    }
    return c;
  }, [rows, byKey]);

  const saveField = async (
    storeId: string,
    ptypeId: string,
    field: "posted" | "returned" | "actual_balance",
    value: number | null,
  ) => {
    if (readOnly) return;
    const payload: Record<string, unknown> = {
      store_id: storeId, product_type_id: ptypeId,
      year: y, month: mo, day,
      [field]: value,
    };
    const { error } = await supabase
      .from("daily_entries")
      .upsert(payload as any, { onConflict: "store_id,product_type_id,year,month,day" });
    if (error) toast.error("Ошибка сохранения", { description: error.message });
    else qc.invalidateQueries({ queryKey: ["today-entries", y, mo, day] });
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Ввод за день</h1>
          <p className="text-sm text-muted-foreground">
            Быстрый ввод Пост./Возвр./Факт. по магазинам × типам продукции
          </p>
        </div>
        {readOnly && (
          <Badge variant="outline" className="text-xs"><Eye className="w-3 h-3 mr-1" />Только просмотр</Badge>
        )}
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-56 justify-start text-left font-normal">
                <CalendarIcon className="w-4 h-4 mr-2" />
                {format(date, "d MMMM yyyy", { locale: ru })}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={date} onSelect={(d) => d && setDate(d)} initialFocus className={cn("p-3 pointer-events-auto")} locale={ru} />
            </PopoverContent>
          </Popover>

          <Select value={filterCp} onValueChange={setFilterCp}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Контрагент" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все контрагенты</SelectItem>
              {cps.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={filterStore} onValueChange={setFilterStore}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Магазин" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все магазины</SelectItem>
              {stores
                .filter((s) => filterCp === "all" || s.counterparty_id === filterCp)
                .map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>

          <Badge variant="secondary" className="ml-auto">
            Заполнено {filledCount} / {rows.length}
          </Badge>
        </div>

        <div className="space-y-2">
          {rows.length === 0 && (
            <div className="py-8 text-center text-muted-foreground text-sm">Нет строк для отображения</div>
          )}
          {rows.map(({ store, ptype }) => {
            const e = byKey.get(`${store.id}|${ptype.id}`);
            const posted = +(e?.posted ?? 0);
            const returned = +(e?.returned ?? 0);
            const writtenOff = +(e?.written_off ?? 0);
            const actual = e?.actual_balance != null ? +e.actual_balance : null;
            const base = baseByKey.get(`${store.id}|${ptype.id}`) ?? 0;
            const realized = actual != null ? base + posted - returned - writtenOff - actual : 0;
            const isEmpty = !(e && (actual != null || posted !== 0 || returned !== 0));
            return (
              <div
                key={`${store.id}|${ptype.id}`}
                className={cn(
                  "grid grid-cols-12 gap-2 items-center rounded-md border p-2 text-sm",
                  isEmpty && "bg-amber-50 dark:bg-amber-500/5 border-amber-200 dark:border-amber-800/40",
                )}
              >
                <div className="col-span-12 md:col-span-4 min-w-0">
                  <div className="font-medium truncate">{store.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{ptype.name}</div>
                </div>
                <NumField label="Пост." value={posted} readOnly={readOnly} onSave={(v) => saveField(store.id, ptype.id, "posted", v)} />
                <NumField label="Возвр." value={returned} readOnly={readOnly} onSave={(v) => saveField(store.id, ptype.id, "returned", v)} />
                <NumField label="Факт." value={actual} nullable readOnly={readOnly} onSave={(v) => saveField(store.id, ptype.id, "actual_balance", v)} />
                <div className="col-span-4 md:col-span-2 text-right">
                  <div className="text-xs text-muted-foreground">Реал.</div>
                  <div className={cn("font-medium tabular-nums", actual == null && "text-muted-foreground")}>
                    {actual == null ? "—" : realized}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function NumField({
  label, value, nullable, readOnly, onSave,
}: {
  label: string;
  value: number | null;
  nullable?: boolean;
  readOnly?: boolean;
  onSave: (v: number | null) => void;
}) {
  const [local, setLocal] = useState<string>(value == null ? "" : String(value));
  useEffect(() => { setLocal(value == null ? "" : String(value)); }, [value]);
  const commit = () => {
    const trimmed = local.trim();
    if (trimmed === "") {
      if (nullable) onSave(null);
      else onSave(0);
      return;
    }
    const n = Number(trimmed.replace(",", "."));
    if (!Number.isFinite(n)) return;
    onSave(n);
  };
  return (
    <div className="col-span-4 md:col-span-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Input
        type="text"
        inputMode="decimal"
        value={local}
        readOnly={readOnly}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="h-8 text-right tabular-nums"
      />
    </div>
  );
}
