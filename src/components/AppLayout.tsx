import { Link, useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { MONTHS } from "@/lib/months";
import { Home, FileText, Settings, LogOut, Menu, ChevronDown, Calendar } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AppLayout({ children }: { children: ReactNode }) {
  const { profile, isAdmin, signOut } = useAuth();
  const path = useRouterState({ select: s => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [monthsOpen, setMonthsOpen] = useState(true);

  const NavItem = ({ to, icon: Icon, label }: { to: string; icon: any; label: string }) => {
    const active = path === to;
    return (
      <Link
        to={to}
        onClick={() => setOpen(false)}
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
          active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        )}
      >
        <Icon className="w-4 h-4" /> {label}
      </Link>
    );
  };

  const sidebar = (
    <aside className="w-64 bg-sidebar text-sidebar-foreground h-screen flex flex-col border-r border-sidebar-border">
      <div className="px-5 py-5 border-b border-sidebar-border">
        <div className="text-lg font-semibold leading-tight">Полуфабрикаты</div>
        <div className="text-xs text-sidebar-foreground/60 mt-0.5">Учёт продаж</div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        <NavItem to="/" icon={Home} label="Главная" />

        <button
          onClick={() => setMonthsOpen(v => !v)}
          className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
        >
          <span className="flex items-center gap-3"><Calendar className="w-4 h-4" /> Учёт</span>
          <ChevronDown className={cn("w-4 h-4 transition-transform", monthsOpen && "rotate-180")} />
        </button>
        {monthsOpen && (
          <div className="ml-4 border-l border-sidebar-border pl-2 space-y-0.5">
            {MONTHS.map((m, i) => (
              <Link
                key={i}
                to="/month/$month"
                params={{ month: String(i + 1) }}
                onClick={() => setOpen(false)}
                className={cn(
                  "block px-3 py-1.5 rounded-md text-sm",
                  path === `/month/${i + 1}`
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/40"
                )}
              >
                {m}
              </Link>
            ))}
          </div>
        )}

        <NavItem to="/reports" icon={FileText} label="Отчёты" />
        {isAdmin && <NavItem to="/settings" icon={Settings} label="Настройки" />}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="px-2 py-2 text-xs text-sidebar-foreground/60">
          <div className="font-medium text-sidebar-foreground truncate">{profile?.name ?? "—"}</div>
          <div className="truncate">{profile?.email}</div>
          <div className="mt-1 inline-block px-2 py-0.5 rounded bg-sidebar-accent text-[10px] uppercase">
            {profile?.role === "admin" ? "Администратор" : "Оператор"}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="w-full justify-start text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground" onClick={() => signOut()}>
          <LogOut className="w-4 h-4 mr-2" /> Выйти
        </Button>
      </div>
    </aside>
  );

  return (
    <div className="min-h-screen flex bg-background">
      <div className="hidden md:block">{sidebar}</div>

      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative">{sidebar}</div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden h-12 border-b flex items-center px-3 bg-card">
          <button onClick={() => setOpen(true)} className="p-2"><Menu className="w-5 h-5" /></button>
          <span className="ml-2 font-medium">Полуфабрикаты</span>
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
