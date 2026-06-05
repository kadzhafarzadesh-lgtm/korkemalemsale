import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MONTHS, fmt } from "@/lib/months";
import { Download } from "lucide-react";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_authenticated/reports")({
  component: ReportsPage,
});

function ReportsPage() {
  const year = new Date().getFullYear();
  const [month, setMonth] = useState<string>(String(new Date().getMonth() + 1));
  const [ptype, setPtype] = useState<string>("all");
  const [store, setStore] = useState<string>("all");

  const { data: stores = [] } = useQuery({
    queryKey: ["stores"],
    queryFn: async () => (await supabase.from("stores").select("*").order("sort_order")).data ?? [],
  });
  const { data: ptypes = [] } = useQuery({
    queryKey: ["ptypes"],
    queryFn: async () => (await supabase.from("product_types").select("*").order("sort_order")).data ?? [],
  });

  const m = Number(month);
  const { data: entries = [] } = useQuery({
    queryKey: ["report-entries", year, m],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_entries")
        .select("store_id,product_type_id,day,posted,returned,realized,opening_balance,actual_balance")
        .eq("year", year).eq("month", m).limit(50000);
      return data ?? [];
    },
  });

  type Row = { store_id: string; product_type_id: string; posted: number; returned: number; realized: number; opening: number; closing: number };

  const aggregated: Row[] = useMemo(() => {
    const m2 = new Map<string, Row>();
    // group by store+ptype, opening = day1 opening, closing = max day actual
    const lastByKey = new Map<string, { day: number; actual: number }>();
    for (const e of entries) {
      const k = `${e.store_id}|${e.product_type_id}`;
      let r = m2.get(k);
      if (!r) { r = { store_id: e.store_id, product_type_id: e.product_type_id, posted: 0, returned: 0, realized: 0, opening: 0, closing: 0 }; m2.set(k, r); }
      r.posted += +e.posted; r.returned += +e.returned; r.realized += +e.realized;
      if (e.day === 1) r.opening = +e.opening_balance;
      const last = lastByKey.get(k);
      if (!last || e.day > last.day) lastByKey.set(k, { day: e.day, actual: +e.actual_balance });
    }
    for (const [k, last] of lastByKey) { const r = m2.get(k); if (r) r.closing = last.actual; }
    return Array.from(m2.values());
  }, [entries]);

  const filteredSales = useMemo(() => {
    return aggregated.filter(r =>
      (ptype === "all" || r.product_type_id === ptype) &&
      (store === "all" || r.store_id === store)
    );
  }, [aggregated, ptype, store]);

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

      <Card className="p-4 grid sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Месяц</label>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{MONTHS.map((mn, i) => <SelectItem key={i} value={String(i + 1)}>{mn}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Тип продукции</label>
          <Select value={ptype} onValueChange={setPtype}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              {ptypes.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Магазин</label>
          <Select value={store} onValueChange={setStore}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">По продажам</TabsTrigger>
          <TabsTrigger value="ranking">Рейтинг</TabsTrigger>
          <TabsTrigger value="detail">Детально</TabsTrigger>
        </TabsList>

        <TabsContent value="sales" className="space-y-3">
          <div className="flex justify-end"><Button onClick={exportSales}><Download className="w-4 h-4 mr-2" />Скачать Excel</Button></div>
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
                    <td className="text-right num font-medium">{fmt(r.realized)}</td>
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
          <div className="flex justify-end"><Button onClick={exportRanking}><Download className="w-4 h-4 mr-2" />Скачать Excel</Button></div>
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
          <div className="flex justify-end"><Button onClick={exportDetailed}><Download className="w-4 h-4 mr-2" />Скачать Excel</Button></div>
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
                  <td className="text-right num font-medium">{fmt(r.realized)}</td>
                  <td className="text-right num">{fmt(r.opening)}</td><td className="text-right num pr-3">{fmt(r.closing)}</td>
                </tr>))}</tbody>
            </table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
