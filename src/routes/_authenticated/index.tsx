import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MONTHS, MONTHS_SHORT, fmt } from "@/lib/months";
import { TrendingUp, RotateCcw, ShoppingBag, Percent, Loader2 } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend,
} from "recharts";

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
  opening_balance: number;
};

type Entry = {
  store_id: string;
  product_type_id: string;
  year: number;
  month: number;
  posted: number;
  returned: number;
  realized: number;
};

function Dashboard() {
  const year = new Date().getFullYear();
  const [monthFilter, setMonthFilter] = useState<string>("all");

  const { data: rawEntries = [], isLoading } = useQuery({
    queryKey: ["dash-entries", year],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,year,month,day,posted,returned,opening_balance")
        .eq("year", year)
        .limit(50000);
      if (error) throw error;
      return (data ?? []) as RawEntry[];
    },
  });

  // Aggregate to per (store, ptype, month) computing realized client-side.
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
      const opening = list.find((d) => d.day === 1)?.opening_balance ?? 0;
      let prevActual = opening;
      let posted = 0, returned = 0, realized = 0;
      for (const d of list) {
        const base = d.day === 1 ? opening : prevActual;
        const actual = base + (+d.posted) - (+d.returned);
        realized += Math.max(0, base - actual);
        posted += +d.posted;
        returned += +d.returned;
        prevActual = actual;
      }
      out.push({ store_id, product_type_id, year, month: Number(monthStr), posted, returned, realized });
    }
    return out;
  }, [rawEntries, year]);

  const { data: stores = [] } = useQuery({
    queryKey: ["stores"],
    queryFn: async () => (await supabase.from("stores").select("id,name").eq("is_active", true).order("sort_order")).data ?? [],
  });
  const { data: ptypes = [] } = useQuery({
    queryKey: ["ptypes"],
    queryFn: async () => (await supabase.from("product_types").select("id,name").order("sort_order")).data ?? [],
  });

  const filtered = useMemo(() => {
    if (monthFilter === "all") return entries;
    const m = Number(monthFilter);
    return entries.filter(e => e.month === m);
  }, [entries, monthFilter]);

  const kpis = useMemo(() => {
    let posted = 0, returned = 0, realized = 0;
    for (const e of filtered) { posted += +e.posted; returned += +e.returned; realized += +e.realized; }
    return { posted, returned, realized, retPct: posted > 0 ? (returned / posted) * 100 : 0 };
  }, [filtered]);

  const monthly = useMemo(() => {
    const arr = MONTHS.map((_, i) => ({ name: MONTHS_SHORT[i], Поступления: 0, Возвраты: 0, Реализация: 0 }));
    for (const e of entries) {
      arr[e.month - 1].Поступления += +e.posted;
      arr[e.month - 1].Возвраты += +e.returned;
      arr[e.month - 1].Реализация += +e.realized;
    }
    return arr;
  }, [entries]);

  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) m.set(e.product_type_id, (m.get(e.product_type_id) ?? 0) + +e.realized);
    return ptypes.map(p => ({ name: p.name, value: m.get(p.id) ?? 0 }));
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

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Главная</h1>
          <p className="text-sm text-muted-foreground">Аналитика продаж за {year} год</p>
        </div>
        <div className="w-full md:w-48">
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все месяцы</SelectItem>
              {MONTHS.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
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

          <div className="grid lg:grid-cols-3 gap-4">
            <Card className="p-4 lg:col-span-2">
              <h3 className="font-medium mb-3">Динамика по месяцам</h3>
              <div className="h-72">
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
            </Card>
            <Card className="p-4">
              <h3 className="font-medium mb-3">Реализация по типу</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={byType} dataKey="value" nameKey="name" outerRadius={90} label={(d: any) => d.name}>
                      {byType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
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
                      <td className="py-2 px-2">{s.name}</td>
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
