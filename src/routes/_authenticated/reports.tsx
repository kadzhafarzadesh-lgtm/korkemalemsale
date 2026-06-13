import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MONTHS, fmt } from "@/lib/months";
import { CalendarIcon, Download } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_authenticated/reports")({
  component: ReportsPage,
});

function ReportsPage() {
  const today = new Date();
  const year = today.getFullYear();
  const [periodMode, setPeriodMode] = useState<"month" | "day" | "range">("month");
  const [month, setMonth] = useState<string>(String(today.getMonth() + 1));
  const [selectedDay, setSelectedDay] = useState<Date>(today);
  const [rangeStart, setRangeStart] = useState<Date>(new Date(year, today.getMonth(), 1));
  const [rangeEnd, setRangeEnd] = useState<Date>(today);
  const [ptype, setPtype] = useState<string>("all");
  const [store, setStore] = useState<string>("all");

  const { startDate, endDate, periodLabel } = useMemo(() => {
    if (periodMode === "day") {
      return {
        startDate: selectedDay,
        endDate: selectedDay,
        periodLabel: format(selectedDay, "dd.MM.yyyy"),
      };
    }
    if (periodMode === "range") {
      const from = rangeStart <= rangeEnd ? rangeStart : rangeEnd;
      const to = rangeStart <= rangeEnd ? rangeEnd : rangeStart;
      return {
        startDate: from,
        endDate: to,
        periodLabel: `${format(from, "dd.MM.yyyy")}–${format(to, "dd.MM.yyyy")}`,
      };
    }
    const selectedMonth = Number(month);
    return {
      startDate: new Date(year, selectedMonth - 1, 1),
      endDate: new Date(year, selectedMonth, 0),
      periodLabel: `${MONTHS[selectedMonth - 1]} ${year}`,
    };
  }, [periodMode, selectedDay, rangeStart, rangeEnd, month, year]);

  const { data: stores = [] } = useQuery({
    queryKey: ["stores"],
    queryFn: async () => (await supabase.from("stores").select("*").order("sort_order")).data ?? [],
  });
  const { data: ptypes = [] } = useQuery({
    queryKey: ["ptypes"],
    queryFn: async () => (await supabase.from("product_types").select("*").order("sort_order")).data ?? [],
  });

  const { data: entries = [] } = useQuery({
    queryKey: ["report-entries", startDate.getFullYear(), endDate.getFullYear()],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,year,month,day,posted,returned,opening_balance,actual_balance")
        .gte("year", startDate.getFullYear())
        .lte("year", endDate.getFullYear())
        .limit(50000);
      if (error) throw error;
      return data ?? [];
    },
  });

  type Row = { store_id: string; product_type_id: string; posted: number; returned: number; realized: number; opening: number; closing: number };

  // Обрабатываем каждый календарный день с начала первого выбранного месяца.
  // Это сохраняет корректную базу на середину месяца и переносит остаток между месяцами.
  const filteredSales: Row[] = useMemo(() => {
    type Day = { posted: number; returned: number; actual_balance: number | null; opening_balance: number };
    const byDate = new Map<string, Day>();
    for (const e of entries) {
      const k = `${e.store_id}|${e.product_type_id}|${e.year}-${e.month}-${e.day}`;
      byDate.set(k, {
        posted: +e.posted,
        returned: +e.returned,
        actual_balance: e.actual_balance == null ? null : +e.actual_balance,
        opening_balance: +e.opening_balance,
      });
    }
    const fStores = store === "all" ? stores : stores.filter((s: any) => s.id === store);
    const fTypes = ptype === "all" ? ptypes : ptypes.filter((p: any) => p.id === ptype);
    const result: Row[] = [];
    for (const s of fStores) {
      for (const p of fTypes) {
        let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
        let prevEffective = 0;
        let posted = 0, returned = 0, realized = 0, opening = 0, closing = 0;
        let firstSelectedDay = true;
        while (cursor <= endDate) {
          const y = cursor.getFullYear();
          const mo = cursor.getMonth() + 1;
          const day = cursor.getDate();
          const d = byDate.get(`${s.id}|${p.id}|${y}-${mo}-${day}`);
          if (day === 1) {
            const enteredOpening = +(d?.opening_balance ?? 0);
            if (enteredOpening !== 0 || cursor.getTime() === new Date(startDate.getFullYear(), startDate.getMonth(), 1).getTime()) {
              prevEffective = enteredOpening;
            }
          }
          const base = prevEffective;
          const dayPosted = d?.posted ?? 0;
          const dayReturned = d?.returned ?? 0;
          const effective = d?.actual_balance != null
            ? d.actual_balance
            : base + dayPosted - dayReturned;
          if (cursor >= startDate) {
            if (firstSelectedDay) {
              opening = base;
              firstSelectedDay = false;
            }
            posted += dayPosted;
            returned += dayReturned;
            realized += d?.actual_balance != null ? base + dayPosted - dayReturned - effective : 0;
            closing = effective;
          }
          prevEffective = effective;
          cursor = new Date(y, mo - 1, day + 1);
        }
        result.push({ store_id: s.id, product_type_id: p.id, posted, returned, realized, opening, closing });
      }
    }
    return result;
  }, [entries, stores, ptypes, store, ptype, startDate, endDate]);


  const storeName = (id: string) => stores.find(s => s.id === id)?.name ?? "—";
  const ptName = (id: string) => ptypes.find(p => p.id === id)?.name ?? "—";

  const totals = useMemo(() => filteredSales.reduce((a, r) => ({
    posted: a.posted + r.posted, returned: a.returned + r.returned, realized: a.realized + r.realized,
  }), { posted: 0, returned: 0, realized: 0 }), [filteredSales]);

  const typeSummary = useMemo(() => {
    const m2 = new Map<string, { posted: number; returned: number; realized: number }>();
    for (const r of filteredSales) {
      const cur = m2.get(r.product_type_id) ?? { posted: 0, returned: 0, realized: 0 };
      cur.posted += r.posted; cur.returned += r.returned; cur.realized += r.realized;
      m2.set(r.product_type_id, cur);
    }
    return Array.from(m2.entries()).map(([id, v]) => ({
      name: ptName(id), ...v, retPct: v.posted > 0 ? (v.returned / v.posted) * 100 : 0,
    }));
  }, [filteredSales]);

  const ranking = useMemo(() => {
    const m2 = new Map<string, { posted: number; returned: number; realized: number }>();
    for (const r of filteredSales) {
      const cur = m2.get(r.store_id) ?? { posted: 0, returned: 0, realized: 0 };
      cur.posted += r.posted; cur.returned += r.returned; cur.realized += r.realized;
      m2.set(r.store_id, cur);
    }
    const total = filteredSales.reduce((s, r) => s + r.realized, 0) || 1;
    return Array.from(m2.entries())
      .map(([id, v]) => ({ id, name: storeName(id), ...v, retPct: v.posted > 0 ? (v.returned / v.posted) * 100 : 0, share: (v.realized / total) * 100 }))
      .sort((a, b) => b.realized - a.realized);
  }, [filteredSales]);

  const exportSales = () => {
    const rows = filteredSales.map(r => ({
      Магазин: storeName(r.store_id), Продукция: ptName(r.product_type_id),
      "Пост.": r.posted, "Возвр.": r.returned, "Реал.": r.realized, "Нач. ост.": r.opening, "Кон. ост.": r.closing,
    }));
    rows.push({ Магазин: "ИТОГО", Продукция: "", "Пост.": totals.posted, "Возвр.": totals.returned, "Реал.": totals.realized, "Нач. ост.": 0, "Кон. ост.": 0 });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Продажи");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(typeSummary.map(t => ({ Тип: t.name, "Пост.": t.posted, "Возвр.": t.returned, "Реал.": t.realized, "% возвр.": t.retPct.toFixed(1) }))), "По типам");
    XLSX.writeFile(wb, `Отчёт_продажи_${MONTHS[m - 1]}_${year}.xlsx`);
  };

  const exportRanking = () => {
    const rows = ranking.map((r, i) => ({ Место: i + 1, Магазин: r.name, "Реал.": r.realized, "% возвр.": r.retPct.toFixed(1), "Доля %": r.share.toFixed(1) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Рейтинг");
    XLSX.writeFile(wb, `Рейтинг_${MONTHS[m - 1]}_${year}.xlsx`);
  };

  const exportDetailed = () => {
    const rows = filteredSales.map(r => ({
      Магазин: storeName(r.store_id), Продукция: ptName(r.product_type_id), Месяц: MONTHS[m - 1],
      "Пост.": r.posted, "Возвр.": r.returned, "Реал.": r.realized, "Нач. ост.": r.opening, "Кон. ост.": r.closing,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Детально");
    XLSX.writeFile(wb, `Детально_${MONTHS[m - 1]}_${year}.xlsx`);
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Отчёты</h1>
        <p className="text-sm text-muted-foreground">Сводные отчёты с возможностью выгрузки в Excel</p>
      </div>

      <Card className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Месяц</label>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
            <SelectContent>{MONTHS.map((mn, i) => <SelectItem key={i} value={String(i + 1)}>{mn}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Тип продукции</label>
          <Select value={ptype} onValueChange={setPtype}>
            <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              {ptypes.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Магазин</label>
          <Select value={store} onValueChange={setStore}>
            <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Tabs defaultValue="sales">
        <TabsList className="w-full overflow-x-auto flex justify-start">
          <TabsTrigger value="sales">По продажам</TabsTrigger>
          <TabsTrigger value="ranking">Рейтинг</TabsTrigger>
          <TabsTrigger value="detail">Детально</TabsTrigger>
        </TabsList>

        <TabsContent value="sales" className="space-y-3">
          <div className="flex md:justify-end"><Button onClick={exportSales} className="w-full md:w-auto h-11 md:h-9"><Download className="w-4 h-4 mr-2" />Скачать Excel</Button></div>
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/60"><tr>
                <th className="px-3 py-2 text-left">Магазин</th><th className="text-left">Прод.</th>
                <th className="text-right">Пост.</th><th className="text-right">Возвр.</th><th className="text-right">Реал.</th>
                <th className="text-right">Нач. ост.</th><th className="text-right pr-3">Кон. ост.</th>
              </tr></thead>
              <tbody>
                {filteredSales.map((r, i) => (
                  <tr key={i} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-1.5">{storeName(r.store_id)}</td><td>{ptName(r.product_type_id)}</td>
                    <td className="text-right num">{fmt(r.posted)}</td><td className="text-right num">{fmt(r.returned)}</td>
                    <td className={"text-right num font-medium " + (r.realized < 0 ? "text-destructive" : "")}>{fmt(r.realized)}</td>
                    <td className="text-right num">{fmt(r.opening)}</td><td className="text-right num pr-3">{fmt(r.closing)}</td>
                  </tr>
                ))}

                <tr className="border-t bg-primary/10 font-semibold">
                  <td className="px-3 py-2" colSpan={2}>ИТОГО</td>
                  <td className="text-right num">{fmt(totals.posted)}</td>
                  <td className="text-right num">{fmt(totals.returned)}</td>
                  <td className="text-right num">{fmt(totals.realized)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tbody>
            </table>
          </Card>
          <Card className="p-4">
            <h3 className="font-medium mb-2">Сводка по типам продукции</h3>
            <table className="w-full text-sm">
              <thead className="text-muted-foreground"><tr className="text-left">
                <th className="py-1">Тип</th><th className="text-right">Пост.</th><th className="text-right">Возвр.</th><th className="text-right">Реал.</th><th className="text-right">% возвр.</th>
              </tr></thead>
              <tbody>{typeSummary.map(t => (
                <tr key={t.name} className="border-t"><td className="py-1.5">{t.name}</td>
                  <td className="text-right num">{fmt(t.posted)}</td><td className="text-right num">{fmt(t.returned)}</td>
                  <td className="text-right num">{fmt(t.realized)}</td><td className="text-right num">{t.retPct.toFixed(1)}%</td>
                </tr>))}</tbody>
            </table>
          </Card>
        </TabsContent>

        <TabsContent value="ranking" className="space-y-3">
          <div className="flex md:justify-end"><Button onClick={exportRanking} className="w-full md:w-auto h-11 md:h-9"><Download className="w-4 h-4 mr-2" />Скачать Excel</Button></div>
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/60"><tr>
                <th className="w-12 px-3 py-2 text-left">Место</th><th className="text-left">Магазин</th>
                <th className="text-right">Реал.</th><th className="text-right">% возвр.</th><th className="text-right pr-3">Доля</th>
              </tr></thead>
              <tbody>{ranking.map((r, i) => (
                <tr key={r.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-1.5 font-medium">{i + 1}</td><td>{r.name}</td>
                  <td className="text-right num">{fmt(r.realized)}</td>
                  <td className="text-right num">{r.retPct.toFixed(1)}%</td>
                  <td className="text-right num pr-3">{r.share.toFixed(1)}%</td>
                </tr>))}</tbody>
            </table>
          </Card>
        </TabsContent>

        <TabsContent value="detail" className="space-y-3">
          <div className="flex md:justify-end"><Button onClick={exportDetailed} className="w-full md:w-auto h-11 md:h-9"><Download className="w-4 h-4 mr-2" />Скачать Excel</Button></div>
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/60"><tr>
                <th className="px-3 py-2 text-left">Магазин</th><th className="text-left">Прод.</th><th className="text-left">Месяц</th>
                <th className="text-right">Пост.</th><th className="text-right">Возвр.</th><th className="text-right">Реал.</th>
                <th className="text-right">Нач. ост.</th><th className="text-right pr-3">Кон. ост.</th>
              </tr></thead>
              <tbody>{filteredSales.map((r, i) => (
                <tr key={i} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-1.5">{storeName(r.store_id)}</td><td>{ptName(r.product_type_id)}</td><td>{MONTHS[m - 1]}</td>
                  <td className="text-right num">{fmt(r.posted)}</td><td className="text-right num">{fmt(r.returned)}</td>
                  <td className={"text-right num font-medium " + (r.realized < 0 ? "text-destructive" : "")}>{fmt(r.realized)}</td>
                  <td className="text-right num">{fmt(r.opening)}</td><td className="text-right num pr-3">{fmt(r.closing)}</td>
                </tr>))}</tbody>

            </table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
