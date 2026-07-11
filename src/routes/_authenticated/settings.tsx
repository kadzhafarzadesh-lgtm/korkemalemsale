import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Loader2, Store as StoreIcon } from "lucide-react";
import { toast } from "sonner";
import { createUser, deleteUser, setUserActive } from "@/lib/admin-users.functions";
import { PRODUCT_COLOR_PALETTE, normalizeProductColor } from "@/lib/product-colors";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { isAdmin, profile, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => { if (!loading && !isAdmin) navigate({ to: "/" }); }, [loading, isAdmin, navigate]);
  if (loading || !profile) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (!isAdmin) return null;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Настройки</h1>
        <p className="text-sm text-muted-foreground">Управление пользователями, магазинами и типами продукции</p>
      </div>
      <Tabs defaultValue="users">
        <TabsList className="w-full overflow-x-auto flex justify-start">
          <TabsTrigger value="users">Пользователи</TabsTrigger>
          <TabsTrigger value="counterparties">Контрагенты</TabsTrigger>
          <TabsTrigger value="stores">Магазины</TabsTrigger>
          <TabsTrigger value="ptypes">Типы продукции</TabsTrigger>
        </TabsList>
        <TabsContent value="users"><UsersTab /></TabsContent>
        <TabsContent value="counterparties"><CounterpartiesTab /></TabsContent>
        <TabsContent value="stores"><StoresTab /></TabsContent>
        <TabsContent value="ptypes"><PTypesTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const create = useServerFn(createUser);
  const del = useServerFn(deleteUser);
  const setActive = useServerFn(setUserActive);
  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: async () => (await supabase.from("profiles").select("*").order("created_at", { ascending: false })).data ?? [],
  });
  const [open, setOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "operator" as "admin" | "operator" | "viewer" });
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await create({ data: form }); toast.success("Пользователь создан"); setOpen(false); setForm({ name: "", email: "", password: "", role: "operator" }); qc.invalidateQueries({ queryKey: ["users"] }); }
    catch (err: any) { toast.error("Ошибка", { description: err.message }); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-4 space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="font-medium">Пользователи системы</h3>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              className="md:static md:h-9 md:w-auto md:rounded-md md:shadow-none fixed bottom-24 right-4 z-30 h-14 w-14 rounded-full shadow-lg p-0 md:p-3"
            >
              <Plus className="w-6 h-6 md:w-4 md:h-4 md:mr-1" />
              <span className="hidden md:inline">Добавить</span>
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Новый пользователь</DialogTitle></DialogHeader>
            <form onSubmit={submit} className="space-y-3">
              <div><Label>Имя</Label><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>Email</Label><Input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
              <div><Label>Пароль (мин. 8 символов)</Label><Input type="password" minLength={8} required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></div>
              <div><Label>Роль</Label>
                <Select value={form.role} onValueChange={(v: any) => setForm({ ...form, role: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="operator">Оператор</SelectItem><SelectItem value="viewer">Руководитель</SelectItem><SelectItem value="admin">Администратор</SelectItem></SelectContent>
                </Select></div>
              <DialogFooter><Button type="submit" disabled={busy}>{busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Создать</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left"><tr><th className="py-2">Имя</th><th>Email</th><th>Роль</th><th>Активен</th><th></th></tr></thead>
          <tbody>{users.map(u => (
            <tr key={u.id} className="border-t">
              <td className="py-2">{u.name}</td><td>{u.email}</td>
              <td>{u.role === "admin" ? "Администратор" : u.role === "viewer" ? "Руководитель" : "Оператор"}</td>
              <td><Switch checked={u.is_active} onCheckedChange={async (v) => { try { await setActive({ data: { userId: u.id, isActive: v } }); qc.invalidateQueries({ queryKey: ["users"] }); } catch (e: any) { toast.error(e.message); } }} /></td>
              <td className="text-right">
                <Button variant="ghost" size="sm" onClick={() => setAssignFor({ id: u.id, name: u.name })} title="Магазины">
                  <StoreIcon className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={async () => { if (!confirm("Удалить пользователя?")) return; try { await del({ data: { userId: u.id } }); toast.success("Удалено"); qc.invalidateQueries({ queryKey: ["users"] }); } catch (e: any) { toast.error(e.message); } }}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </td>
            </tr>))}</tbody>
        </table>
      )}
      {assignFor && <ManagerStoresDialog userId={assignFor.id} userName={assignFor.name} onClose={() => setAssignFor(null)} />}
    </Card>
  );
}

function StoresTab() {
  const qc = useQueryClient();
  const { data: stores = [] } = useQuery({ queryKey: ["all-stores"], queryFn: async () => (await supabase.from("stores").select("*, counterparties(id,name)").order("sort_order")).data ?? [] });
  const { data: counterparties = [] } = useQuery({ queryKey: ["all-counterparties"], queryFn: async () => (await supabase.from("counterparties").select("*").eq("is_active", true).order("sort_order")).data ?? [] });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<{ name: string; address: string; is_active: boolean; counterparty_id: string | null }>({ name: "", address: "", is_active: true, counterparty_id: null });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) {
      const { error } = await supabase.from("stores").update(form).eq("id", editing.id);
      if (error) return toast.error(error.message);
    } else {
      const maxOrder = Math.max(0, ...stores.map(s => s.sort_order));
      const { error } = await supabase.from("stores").insert({ ...form, sort_order: maxOrder + 1 });
      if (error) return toast.error(error.message);
    }
    toast.success("Сохранено"); setOpen(false); setEditing(null); setForm({ name: "", address: "", is_active: true, counterparty_id: null });
    qc.invalidateQueries({ queryKey: ["all-stores"] }); qc.invalidateQueries({ queryKey: ["stores"] });
  };

  const remove = async (id: string) => {
    if (!confirm("Удалить магазин? Все связанные данные будут удалены.")) return;
    const { error } = await supabase.from("stores").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Удалено"); qc.invalidateQueries({ queryKey: ["all-stores"] });
  };

  return (
    <Card className="p-4 space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="font-medium">Магазины</h3>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditing(null); setForm({ name: "", address: "", is_active: true, counterparty_id: null }); } }}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              onClick={() => { setEditing(null); setForm({ name: "", address: "", is_active: true, counterparty_id: null }); }}
              className="md:static md:h-9 md:w-auto md:rounded-md md:shadow-none fixed bottom-24 right-4 z-30 h-14 w-14 rounded-full shadow-lg p-0 md:p-3"
            >
              <Plus className="w-6 h-6 md:w-4 md:h-4 md:mr-1" />
              <span className="hidden md:inline">Добавить</span>
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? "Изменить магазин" : "Новый магазин"}</DialogTitle></DialogHeader>
            <form onSubmit={save} className="space-y-3">
              <div><Label>Название</Label><Input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
              <div><Label>Адрес</Label><Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></div>
              <div>
                <Label>Контрагент</Label>
                <Select value={form.counterparty_id ?? "none"} onValueChange={(v) => setForm({ ...form, counterparty_id: v === "none" ? null : v })}>
                  <SelectTrigger><SelectValue placeholder="Без контрагента" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Без контрагента</SelectItem>
                    {counterparties.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2"><Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} /><Label>Активен</Label></div>
              <DialogFooter><Button type="submit">Сохранить</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left"><tr><th className="py-2 w-10">#</th><th>Название</th><th>Контрагент</th><th>Адрес</th><th>Статус</th><th></th></tr></thead>
        <tbody>{stores.map((s: any, i) => (
          <tr key={s.id} className="border-t">
            <td className="py-2 text-muted-foreground">{i + 1}</td><td>{s.name}</td>
            <td className="text-muted-foreground">{s.counterparties?.name ?? "—"}</td>
            <td className="text-muted-foreground">{s.address || "—"}</td>
            <td>{s.is_active ? "Активен" : "Неактивен"}</td>
            <td className="text-right">
              <Button variant="ghost" size="sm" onClick={() => { setEditing(s); setForm({ name: s.name, address: s.address ?? "", is_active: s.is_active, counterparty_id: s.counterparty_id ?? null }); setOpen(true); }}>Изменить</Button>
              <Button variant="ghost" size="sm" onClick={() => remove(s.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
            </td>
          </tr>))}</tbody>
      </table>
    </Card>
  );
}

function CounterpartiesTab() {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({ queryKey: ["all-counterparties"], queryFn: async () => (await supabase.from("counterparties").select("*").order("sort_order")).data ?? [] });
  const [name, setName] = useState("");

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!name.trim()) return;
    const maxOrder = Math.max(0, ...items.map((p: any) => p.sort_order));
    const { error } = await supabase.from("counterparties").insert({ name: name.trim(), sort_order: maxOrder + 1 });
    if (error) return toast.error(error.message);
    setName(""); toast.success("Добавлено"); qc.invalidateQueries({ queryKey: ["all-counterparties"] });
  };
  const toggle = async (id: string, v: boolean) => {
    const { error } = await supabase.from("counterparties").update({ is_active: v }).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["all-counterparties"] });
  };
  const remove = async (id: string) => {
    if (!confirm("Удалить контрагента? У магазинов поле будет очищено.")) return;
    const { error } = await supabase.from("counterparties").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Удалено"); qc.invalidateQueries({ queryKey: ["all-counterparties"] });
    qc.invalidateQueries({ queryKey: ["all-stores"] });
  };

  return (
    <Card className="p-4 space-y-3">
      <h3 className="font-medium">Контрагенты</h3>
      <form onSubmit={add} className="flex gap-2"><Input placeholder="Например: ИП Иванов" value={name} onChange={e => setName(e.target.value)} /><Button type="submit"><Plus className="w-4 h-4 mr-1" />Добавить</Button></form>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left"><tr><th className="py-2">Название</th><th>Активен</th><th></th></tr></thead>
        <tbody>{items.map((p: any) => (
          <tr key={p.id} className="border-t"><td className="py-2">{p.name}</td>
            <td><Switch checked={p.is_active} onCheckedChange={(v) => toggle(p.id, v)} /></td>
            <td className="text-right"><Button variant="ghost" size="sm" onClick={() => remove(p.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button></td>
          </tr>))}</tbody>
      </table>
    </Card>
  );
}

function PTypesTab() {
  const qc = useQueryClient();
  const { data: ptypes = [] } = useQuery({ queryKey: ["all-ptypes"], queryFn: async () => (await supabase.from("product_types").select("*").order("sort_order").order("name")).data ?? [] });
  const [name, setName] = useState("");
  const [shelf, setShelf] = useState("");
  const [price, setPrice] = useState("");

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!name.trim()) return;
    const maxOrder = Math.max(0, ...ptypes.map((p: any) => p.sort_order));
    const priceVal = price.trim() === "" ? null : Number(price.replace(",", "."));
    const { error } = await supabase.from("product_types").insert({
      name: name.trim(),
      sort_order: maxOrder + 1,
      shelf_life_days: Math.max(0, Math.min(3650, parseInt(shelf) || 0)),
      price: priceVal != null && Number.isFinite(priceVal) ? priceVal : null,
    } as any);
    if (error) return toast.error(error.message);
    setName(""); setShelf(""); setPrice("");
    toast.success("Добавлено");
    qc.invalidateQueries({ queryKey: ["all-ptypes"] }); qc.invalidateQueries({ queryKey: ["ptypes"] });
  };
  const updateShelf = async (id: string, days: number) => {
    const v = Math.max(0, Math.min(3650, Math.floor(days) || 0));
    const { error } = await supabase.from("product_types").update({ shelf_life_days: v }).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["all-ptypes"] });
    qc.invalidateQueries({ queryKey: ["expiry-report"] });
  };
  const updatePrice = async (id: string, raw: string) => {
    const trimmed = raw.trim();
    const val = trimmed === "" ? null : Number(trimmed.replace(",", "."));
    if (val != null && !Number.isFinite(val)) return;
    const { error } = await supabase.from("product_types").update({ price: val } as any).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["all-ptypes"] });
    qc.invalidateQueries({ queryKey: ["expiry-report"] });
  };
  const updateColor = async (id: string, hex: string | null) => {
    const { error } = await supabase.from("product_types").update({ color: hex } as any).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["all-ptypes"] });
    qc.invalidateQueries({ queryKey: ["ptypes"] });
  };
  const remove = async (id: string) => {
    if (!confirm("Удалить тип? Связанные данные тоже удалятся.")) return;
    const { error } = await supabase.from("product_types").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Удалено"); qc.invalidateQueries({ queryKey: ["all-ptypes"] });
  };

  return (
    <Card className="p-4 space-y-3">
      <h3 className="font-medium">Типы продукции</h3>
      <p className="text-xs text-muted-foreground">Срок годности (в днях) — для мониторинга партий, 0 = не отслеживать. Цена (₸) — для расчёта потерь по просрочке. Цвет — визуальная метка во всех разделах.</p>
      <form onSubmit={add} className="flex gap-2 flex-wrap">
        <Input placeholder="Например: сер." value={name} onChange={e => setName(e.target.value)} className="flex-1 min-w-40" />
        <Input type="number" min={0} max={3650} placeholder="Срок, дней" value={shelf} onChange={e => setShelf(e.target.value)} className="w-32" />
        <Input type="text" inputMode="decimal" placeholder="Цена, ₸" value={price} onChange={e => setPrice(e.target.value)} className="w-32" />
        <Button type="submit"><Plus className="w-4 h-4 mr-1" />Добавить</Button>
      </form>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left"><tr><th className="py-2">Название</th><th className="w-32">Срок (дней)</th><th className="w-32">Цена, ₸</th><th className="min-w-[220px]">Цвет</th><th></th></tr></thead>
        <tbody>{ptypes.map((p: any) => (
          <tr key={p.id} className="border-t">
            <td className="py-2">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: normalizeProductColor(p.color) }}
                  aria-hidden
                />
                {p.name}
              </div>
            </td>
            <td>
              <Input
                type="number"
                min={0}
                max={3650}
                defaultValue={p.shelf_life_days ?? 0}
                onBlur={(e) => {
                  const v = parseInt(e.target.value) || 0;
                  if (v !== (p.shelf_life_days ?? 0)) updateShelf(p.id, v);
                }}
                className="h-8 w-24"
              />
            </td>
            <td>
              <Input
                type="text"
                inputMode="decimal"
                defaultValue={p.price ?? ""}
                onBlur={(e) => {
                  const cur = p.price == null ? "" : String(p.price);
                  if (e.target.value.trim() !== cur) updatePrice(p.id, e.target.value);
                }}
                className="h-8 w-28 tabular-nums"
              />
            </td>
            <td>
              <div className="flex flex-wrap gap-1.5 py-1">
                {PRODUCT_COLOR_PALETTE.map((c) => {
                  const active = (p.color ?? "").toLowerCase() === c.hex;
                  return (
                    <button
                      key={c.hex}
                      type="button"
                      title={c.label}
                      onClick={() => updateColor(p.id, active ? null : c.hex)}
                      className={cn(
                        "w-6 h-6 rounded-full border transition-transform active:scale-90",
                        active ? "ring-2 ring-offset-1 ring-foreground scale-110" : "border-border hover:scale-110",
                      )}
                      style={{ backgroundColor: c.hex }}
                      aria-label={c.label}
                    />
                  );
                })}
                {p.color && (
                  <button
                    type="button"
                    onClick={() => updateColor(p.id, null)}
                    className="text-[11px] text-muted-foreground underline ml-1 self-center"
                  >
                    сбросить
                  </button>
                )}
              </div>
            </td>
            <td className="text-right"><Button variant="ghost" size="sm" onClick={() => remove(p.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button></td>
          </tr>))}</tbody>
      </table>
      </div>
    </Card>
  );
}

function ManagerStoresDialog({ userId, userName, onClose }: { userId: string; userName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: stores = [] } = useQuery({
    queryKey: ["all-stores-for-assign"],
    queryFn: async () => (await supabase.from("stores").select("id,name").eq("is_active", true).order("sort_order").order("name")).data ?? [],
  });
  const { data: assigned = [] } = useQuery({
    queryKey: ["manager-stores", userId],
    queryFn: async () => (await supabase.from("manager_stores").select("store_id").eq("user_id", userId)).data ?? [],
  });
  const assignedSet = new Set(assigned.map((a: any) => a.store_id));
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (storeId: string, checked: boolean) => {
    setBusy(storeId);
    try {
      if (checked) {
        const { error } = await supabase.from("manager_stores").insert({ user_id: userId, store_id: storeId } as any);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("manager_stores").delete().eq("user_id", userId).eq("store_id", storeId);
        if (error) throw error;
      }
      qc.invalidateQueries({ queryKey: ["manager-stores", userId] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Магазины пользователя · {userName}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          Если ничего не выбрано — пользователь видит все магазины. Отметьте магазины, чтобы ограничить доступ.
        </p>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {stores.map((s: any) => (
            <label key={s.id} className="flex items-center justify-between border rounded-md p-2">
              <span className="text-sm">{s.name}</span>
              <Switch
                checked={assignedSet.has(s.id)}
                disabled={busy === s.id}
                onCheckedChange={(v) => toggle(s.id, v)}
              />
            </label>
          ))}
          {stores.length === 0 && <div className="text-sm text-muted-foreground py-4 text-center">Нет активных магазинов</div>}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Закрыть</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
