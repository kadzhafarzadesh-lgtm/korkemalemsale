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
import { Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createUser, deleteUser, setUserActive } from "@/lib/admin-users.functions";

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
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "operator" as "admin" | "operator" });
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
                  <SelectContent><SelectItem value="operator">Оператор</SelectItem><SelectItem value="admin">Администратор</SelectItem></SelectContent>
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
              <td>{u.role === "admin" ? "Администратор" : "Оператор"}</td>
              <td><Switch checked={u.is_active} onCheckedChange={async (v) => { try { await setActive({ data: { userId: u.id, isActive: v } }); qc.invalidateQueries({ queryKey: ["users"] }); } catch (e: any) { toast.error(e.message); } }} /></td>
              <td className="text-right">
                <Button variant="ghost" size="sm" onClick={async () => { if (!confirm("Удалить пользователя?")) return; try { await del({ data: { userId: u.id } }); toast.success("Удалено"); qc.invalidateQueries({ queryKey: ["users"] }); } catch (e: any) { toast.error(e.message); } }}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </td>
            </tr>))}</tbody>
        </table>
      )}
    </Card>
  );
}

function StoresTab() {
  const qc = useQueryClient();
  const { data: stores = [] } = useQuery({ queryKey: ["all-stores"], queryFn: async () => (await supabase.from("stores").select("*").order("sort_order")).data ?? [] });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", address: "", is_active: true });

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
    toast.success("Сохранено"); setOpen(false); setEditing(null); setForm({ name: "", address: "", is_active: true });
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
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditing(null); setForm({ name: "", address: "", is_active: true }); } }}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              onClick={() => { setEditing(null); setForm({ name: "", address: "", is_active: true }); }}
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
              <div className="flex items-center gap-2"><Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} /><Label>Активен</Label></div>
              <DialogFooter><Button type="submit">Сохранить</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left"><tr><th className="py-2 w-10">#</th><th>Название</th><th>Адрес</th><th>Статус</th><th></th></tr></thead>
        <tbody>{stores.map((s, i) => (
          <tr key={s.id} className="border-t">
            <td className="py-2 text-muted-foreground">{i + 1}</td><td>{s.name}</td><td className="text-muted-foreground">{s.address || "—"}</td>
            <td>{s.is_active ? "Активен" : "Неактивен"}</td>
            <td className="text-right">
              <Button variant="ghost" size="sm" onClick={() => { setEditing(s); setForm({ name: s.name, address: s.address ?? "", is_active: s.is_active }); setOpen(true); }}>Изменить</Button>
              <Button variant="ghost" size="sm" onClick={() => remove(s.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
            </td>
          </tr>))}</tbody>
      </table>
    </Card>
  );
}

function PTypesTab() {
  const qc = useQueryClient();
  const { data: ptypes = [] } = useQuery({ queryKey: ["all-ptypes"], queryFn: async () => (await supabase.from("product_types").select("*").order("sort_order")).data ?? [] });
  const [name, setName] = useState("");

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!name.trim()) return;
    const maxOrder = Math.max(0, ...ptypes.map(p => p.sort_order));
    const { error } = await supabase.from("product_types").insert({ name: name.trim(), sort_order: maxOrder + 1 });
    if (error) return toast.error(error.message);
    setName(""); toast.success("Добавлено"); qc.invalidateQueries({ queryKey: ["all-ptypes"] }); qc.invalidateQueries({ queryKey: ["ptypes"] });
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
      <form onSubmit={add} className="flex gap-2"><Input placeholder="Например: сер." value={name} onChange={e => setName(e.target.value)} /><Button type="submit"><Plus className="w-4 h-4 mr-1" />Добавить</Button></form>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left"><tr><th className="py-2">Название</th><th></th></tr></thead>
        <tbody>{ptypes.map(p => (
          <tr key={p.id} className="border-t"><td className="py-2">{p.name}</td>
            <td className="text-right"><Button variant="ghost" size="sm" onClick={() => remove(p.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button></td>
          </tr>))}</tbody>
      </table>
    </Card>
  );
}
