import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { Home, FileText, Settings, Calendar, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { MONTHS } from "@/lib/months";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

export function MobileBottomNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const isMonth = path.startsWith("/month/");
  const isHome = path === "/";
  const isReports = path === "/reports";
  const isSettings = path === "/settings";

  const Item = ({
    active, label, icon: Icon, onClick, to,
  }: { active: boolean; label: string; icon: any; onClick?: () => void; to?: string }) => {
    const cls = cn(
      "flex-1 flex flex-col items-center justify-center gap-0.5 h-full text-[11px] active:scale-95 transition-transform",
      active ? "text-accent" : "text-muted-foreground"
    );
    const inner = (
      <>
        <Icon className="w-5 h-5" />
        <span>{label}</span>
      </>
    );
    if (to) {
      return (
        <Link to={to} className={cls}>
          {inner}
        </Link>
      );
    }
    return (
      <button type="button" onClick={onClick} className={cls}>
        {inner}
      </button>
    );
  };

  return (
    <>
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-card border-t h-16 flex items-stretch"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <Item to="/" label="Главная" icon={Home} active={isHome} />
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex-1 flex flex-col items-center justify-center gap-0.5 h-full text-[11px] active:scale-95 transition-transform",
                isMonth ? "text-accent" : "text-muted-foreground"
              )}
            >
              <Calendar className="w-5 h-5" />
              <span>Учёт</span>
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-auto max-h-[80vh]">
            <SheetHeader>
              <SheetTitle>Выберите месяц</SheetTitle>
            </SheetHeader>
            <div className="grid grid-cols-3 gap-3 pt-4 pb-2">
              {MONTHS.map((m, i) => {
                const active = path === `/month/${i + 1}`;
                return (
                  <button
                    key={i}
                    onClick={() => {
                      setOpen(false);
                      navigate({ to: "/month/$month", params: { month: String(i + 1) } });
                    }}
                    className={cn(
                      "h-16 rounded-xl border text-sm font-medium active:scale-95 transition-transform",
                      active
                        ? "bg-accent text-accent-foreground border-accent"
                        : "bg-card hover:bg-muted"
                    )}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </SheetContent>
        </Sheet>
        <Item to="/reports" label="Отчёты" icon={FileText} active={isReports} />
        {isAdmin && <Item to="/settings" label="Настройки" icon={Settings} active={isSettings} />}
      </nav>
      {/* Spacer so content isn't covered by bottom nav */}
      <div className="md:hidden h-16" aria-hidden />
    </>
  );
}
