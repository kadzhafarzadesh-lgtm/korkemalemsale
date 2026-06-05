import { useEffect, useState } from "react";
import { X, Download } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";

const KEY = "pwa-install-dismissed-v1";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallBanner() {
  const isMobile = useIsMobile();
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(KEY) === "1") return;
    // Already installed
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!isMobile || !show || !evt) return null;

  const install = async () => {
    try {
      await evt.prompt();
      await evt.userChoice;
    } finally {
      localStorage.setItem(KEY, "1");
      setShow(false);
    }
  };
  const dismiss = () => {
    localStorage.setItem(KEY, "1");
    setShow(false);
  };

  return (
    <div
      className="md:hidden fixed left-3 right-3 z-50 rounded-xl bg-card border shadow-lg p-3 flex items-center gap-3"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 76px)" }}
    >
      <div className="text-xl">📱</div>
      <div className="flex-1 text-sm">
        <div className="font-medium">Установить приложение</div>
        <div className="text-muted-foreground text-xs">Откройте быстрее с экрана телефона</div>
      </div>
      <button
        onClick={install}
        className="h-9 px-3 rounded-md bg-accent text-accent-foreground text-sm font-medium flex items-center gap-1 active:scale-95"
      >
        <Download className="w-4 h-4" /> Установить
      </button>
      <button onClick={dismiss} className="p-1 text-muted-foreground active:scale-95" aria-label="Закрыть">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
