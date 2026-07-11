import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MONTHS, MONTHS_SHORT, fmt } from "@/lib/months";
import { TrendingUp, RotateCcw, ShoppingBag, Percent, Loader2, Sparkles, CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend,
} from "recharts";
import { getDailyInsights } from "@/lib/ai-insights.functions";

export const Route = createFileRoute("/_authenticated/")({
  component: Dashboard,
});

type RawEntry = {
  store_id: string;
  product_type_id: string;
  year: number;
  month: number;
  day: number;
  posted: number;
  returned: number;
  written_off: number;
  opening_balance: number;
  actual_balance: number | null;
};

type Entry = {
  store_id: string;
  product_type_id: string;
  year: number;
  month: number;
  day: number;
  posted: number;
  returned: number;
  written_off: number;
  realized: number;
};

function DashboardDatePicker({ value, onChange }: { value: Date; onChange: (date: Date) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-start font-normal">
          <CalendarIcon className="text-muted-foreground" />
          {format(value, "dd MMMM yyyy", { locale: ru })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="single"
          selected={value}
          onSelect={(date) => date && onChange(date)}
          locale={ru}
          className="p-3 pointer-events-auto"
        />
      </PopoverContent>
    </Popover>
  );
}

function Dashboard() {
  const today = new Date();
  const year = today.getFullYear();
  const [periodMode, setPeriodMode] = useState<"all" | "month" | "day">("all");
  const [monthFilter, setMonthFilter] = useState<string>(String(today.getMonth() + 1));
  const [dayFilter, setDayFilter] = useState<Date>(today);
  const dataYear = periodMode === "day" ? dayFilter.getFullYear() : year;

  const { data: rawEntries = [], isLoading } = useQuery({
    queryKey: ["dash-entries", dataYear],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,year,month,day,posted,returned,written_off,opening_balance,actual_balance")
        .eq("year", dataYear)
        .limit(50000);
      if (error) throw error;
      return (data ?? []) as RawEntry[];
    },
  });

  // Реал. = Нач + Пост − Возвр − Списано − Факт (с автоподстановкой Факт. = предыдущий).
  const entries: Entry[] = useMemo(() => {
    const grouped = new Map<string, RawEntry[]>();
    for (const e of rawEntries) {
      const k = `${e.store_id}|${e.product_type_id}|${e.month}`;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(e);
    }
    const out: Entry[] = [];
    for (const [k, list] of grouped) {
      const [store_id, product_type_id, monthStr] = k.split("|");
      list.sort((a, b) => a.day - b.day);
      const opening = +(list.find((d) => d.day === 1)?.opening_balance ?? 0);
      let prevEffective: number = opening;
      for (const d of list) {
        const base = d.day === 1 ? opening : prevEffective;
        const posted = +d.posted;
        const returned = +d.returned;
        const writtenOff = +(d.written_off ?? 0);
        const manual = d.actual_balance == null ? null : +d.actual_balance;
        const effective = manual != null ? manual : base + posted - returned - writtenOff;
        const dayRealized = manual != null ? base + posted - returned - writtenOff - manual : 0;
        out.push({
          store_id,
          product_type_id,
          year: d.year,
          month: Number(monthStr),
          day: d.day,
          posted,
          returned,
          written_off: writtenOff,
          realized: dayRealized,
        });
        prevEffective = effective;
      }
    }
    return out;
  }, [rawEntries]);


  const { data: stores = [] } = useQuery({
    queryKey: ["stores"],
    queryFn: async () => (await supabase.from("stores").select("id,name").eq("is_active", true).order("sort_order").order("name")).data ?? [],
  });
  const { data: ptypes = [] } = useQuery({
    queryKey: ["ptypes"],
    queryFn: async () => (await supabase.from("product_types").select("id,name,color").order("sort_order").order("name")).data ?? [],
  });

  const filtered = useMemo(() => {
    if (periodMode === "day") {
      return entries.filter(e =>
        e.year === dayFilter.getFullYear() &&
        e.month === dayFilter.getMonth() + 1 &&
        e.day === dayFilter.getDate()
      );
    }
    if (periodMode === "month") return entries.filter(e => e.month === Number(monthFilter));
    return entries;
  }, [entries, periodMode, monthFilter, dayFilter]);

  const periodLabel = periodMode === "day"
    ? format(dayFilter, "dd MMMM yyyy", { locale: ru })
    : periodMode === "month"
      ? `${MONTHS[Number(monthFilter) - 1]} ${year}`
      : `${year} год`;

  const kpis = useMemo(() => {
    let posted = 0, returned = 0, realized = 0;
    for (const e of filtered) { posted += +e.posted; returned += +e.returned; realized += +e.realized; }
    return { posted, returned, realized, retPct: posted > 0 ? (returned / posted) * 100 : 0 };
  }, [filtered]);

  const monthly = useMemo(() => {
    const arr = MONTHS.map((_, i) => ({ name: MONTHS_SHORT[i], Поступления: 0, Возвраты: 0, Реализация: 0 }));
    for (const e of filtered) {
      arr[e.month - 1].Поступления += +e.posted;
      arr[e.month - 1].Возвраты += +e.returned;
      arr[e.month - 1].Реализация += +e.realized;
    }
    return arr;
  }, [filtered]);

  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) m.set(e.product_type_id, (m.get(e.product_type_id) ?? 0) + +e.realized);
    return ptypes.map((p: any) => ({ name: p.name, color: p.color as string | null, value: m.get(p.id) ?? 0 }));
  }, [filtered, ptypes]);

  const topStores = useMemo(() => {
    const m = new Map<string, { realized: number; posted: number; returned: number }>();
    for (const e of filtered) {
      const cur = m.get(e.store_id) ?? { realized: 0, posted: 0, returned: 0 };
      cur.realized += +e.realized; cur.posted += +e.posted; cur.returned += +e.returned;
      m.set(e.store_id, cur);
    }
    const totalRealized = filtered.reduce((s, e) => s + +e.realized, 0) || 1;
    return stores
      .map(s => ({ id: s.id, name: s.name, ...(m.get(s.id) ?? { realized: 0, posted: 0, returned: 0 }) }))
      .map(s => ({ ...s, retPct: s.posted > 0 ? (s.returned / s.posted) * 100 : 0, share: (s.realized / totalRealized) * 100 }))
      .sort((a, b) => b.realized - a.realized)
      .slice(0, 10);
  }, [filtered, stores]);


  const COLORS = ["hsl(200 60% 45%)", "hsl(150 50% 45%)", "hsl(250 50% 50%)", "hsl(25 70% 55%)", "hsl(280 50% 55%)"];
  const byTypeTotal = byType.reduce((s, t) => s + t.value, 0);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Главная</h1>
          <p className="text-sm text-muted-foreground">Аналитика продаж: {periodLabel}</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
          <div className="w-full sm:w-40">
            <Select value={periodMode} onValueChange={(value) => setPeriodMode(value as typeof periodMode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Весь год</SelectItem>
                <SelectItem value="month">По месяцу</SelectItem>
                <SelectItem value="day">По дню</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {periodMode === "month" && (
            <div className="w-full sm:w-44">
              <Select value={monthFilter} onValueChange={setMonthFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {periodMode === "day" && (
            <div className="w-full sm:w-56">
              <DashboardDatePicker value={dayFilter} onChange={setDayFilter} />
            </div>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            <KpiCard label="Всего поступлений" value={fmt(kpis.posted)} icon={TrendingUp} color="text-chart-1" />
            <KpiCard label="Всего возвратов" value={fmt(kpis.returned)} icon={RotateCcw} color="text-chart-5" />
            <KpiCard label="Всего реализация" value={fmt(kpis.realized)} icon={ShoppingBag} color="text-chart-3" />
            <KpiCard label="% возвратов" value={kpis.retPct.toFixed(1) + "%"} icon={Percent} color="text-chart-4" />
          </div>

          <AiInsightsCard />


          <div className="grid lg:grid-cols-3 gap-4">
            <Card className="p-4 lg:col-span-2">
              <h3 className="font-medium mb-3">Динамика по месяцам</h3>
              <div className="h-52 md:h-72">
                <div className="md:hidden h-full overflow-x-auto">
                  <div style={{ width: 600, height: "100%" }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={monthly}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                        <XAxis dataKey="name" fontSize={11} />
                        <YAxis fontSize={11} />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="Поступления" fill={COLORS[0]} radius={[4, 4, 0, 0]} />
                        <Bar dataKey="Возвраты" fill={COLORS[3]} radius={[4, 4, 0, 0]} />
                        <Bar dataKey="Реализация" fill={COLORS[1]} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="hidden md:block h-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthly}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" fontSize={12} />
                    <YAxis fontSize={12} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Поступления" fill={COLORS[0]} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Возвраты" fill={COLORS[3]} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Реализация" fill={COLORS[1]} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <h3 className="font-medium mb-3">Реализация по типу</h3>
              <div className="h-52 md:h-72">
                {byTypeTotal === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Нет данных
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={byType}
                        dataKey="value"
                        nameKey="name"
                        outerRadius={90}
                        label={({ name, percent }: any) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                      >
                        {byType.map((t, i) => (
                          <Cell key={i} fill={TYPE_COLORS[t.name] ?? COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: any) => fmt(Number(v))} />
                      <Legend
                        wrapperStyle={{ fontSize: 12 }}
                        formatter={(value: string) => {
                          const item = byType.find((b) => b.name === value);
                          const pct = item && byTypeTotal > 0 ? ((item.value / byTypeTotal) * 100).toFixed(1) : "0";
                          return `${value} — ${pct}%`;
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </div>

          <Card className="p-4">
            <h3 className="font-medium mb-3">Топ-10 магазинов по реализации</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b text-muted-foreground">
                    <th className="py-2 px-2 w-12">Место</th>
                    <th className="py-2 px-2">Магазин</th>
                    <th className="py-2 px-2 text-right num">Реал.</th>
                    <th className="py-2 px-2 text-right num">% возвр.</th>
                    <th className="py-2 px-2 text-right num">Доля</th>
                  </tr>
                </thead>
                <tbody>
                  {topStores.map((s, i) => (
                    <tr key={s.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="py-2 px-2 font-medium">{i + 1}</td>
                      <td className="py-2 px-2"><span className="md:hidden">{s.name.length > 20 ? s.name.slice(0, 19) + "…" : s.name}</span><span className="hidden md:inline">{s.name}</span></td>
                      <td className="py-2 px-2 text-right num">{fmt(s.realized)}</td>
                      <td className="py-2 px-2 text-right num">{s.retPct.toFixed(1)}%</td>
                      <td className="py-2 px-2 text-right num">{s.share.toFixed(1)}%</td>
                    </tr>
                  ))}
                  {topStores.length === 0 && (
                    <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">Нет данных за выбранный период</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: any; color: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
          <div className="text-2xl font-semibold mt-1 num">{value}</div>
        </div>
        <Icon className={`w-5 h-5 ${color}`} />
      </div>
    </Card>
  );
}

function AiInsightsCard() {
  const fetchInsights = useServerFn(getDailyInsights);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["ai-insights", new Date().toISOString().slice(0, 10)],
    queryFn: () => fetchInsights(),
    staleTime: 1000 * 60 * 60,
    retry: false,
  });

  return (
    <Card className="p-4 md:p-5 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">ИИ-инсайты</h3>
          {data?.created_at && (
            <span className="text-xs text-muted-foreground">
              · обновлено {new Date(data.created_at).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-xs text-primary hover:underline disabled:opacity-50"
        >
          {isFetching ? "..." : "Обновить"}
        </button>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> ИИ анализирует данные…
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none [&_ul]:my-2 [&_h2]:text-base [&_h3]:text-sm [&_h2]:mt-3 [&_h3]:mt-2">
          <ReactMarkdown>{data?.content ?? ""}</ReactMarkdown>
        </div>
      )}
    </Card>
  );
}
