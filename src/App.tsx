import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { FileList } from "./components/FileList";
import { SentenceTable } from "./components/SentenceTable";
import { EditorPanel } from "./components/EditorPanel";
import { FindReplaceModal } from "./components/FindReplaceModal";
import { TmPanel } from "./components/TmPanel";
import { GlossaryModal } from "./components/GlossaryModal";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { Resizer } from "./components/Resizer";
import { HomeScreen } from "./components/HomeScreen";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { Dp1Editor } from "./games/dp1/Dp1Editor";
import { Dp1SettingsModal } from "./games/dp1/Dp1SettingsModal";
import { readGlossary, type GlossaryEntry } from "./lib/glossary";
import { useLocalStorage } from "./lib/useLocalStorage";
import { useStore } from "./lib/store";
import type { SetupStatus } from "./lib/ipc";
import { DialogHost } from "./lib/dialogs";

type Stage = "loading" | "onboarding" | "home" | "editor-dp2" | "editor-dp1";
type ActiveGame = "dp1" | "dp2" | null;

export default function App() {
  const [findOpen, setFindOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [tmVisible, setTmVisible] = useLocalStorage<boolean>("dp2.ui.tmVisible", true);
  const [focusMode, setFocusMode] = useLocalStorage<boolean>("dp2.ui.focusMode", false);
  const [fileListW, setFileListW] = useLocalStorage<number>("dp2.ui.fileListW", 280);
  const [editorW, setEditorW] = useLocalStorage<number>("dp2.ui.editorW", 520);
  const [tmW, setTmW] = useLocalStorage<number>("dp2.ui.tmW", 300);
  const [activeGame, setActiveGame] = useLocalStorage<ActiveGame>("dp2.ui.activeGame", null);
  const [dp1SettingsOpen, setDp1SettingsOpen] = useState(false);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);

  const [stage, setStage] = useState<Stage>("loading");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);

  const init = useStore((s) => s.init);
  const folder = useStore((s) => s.folder);

  // ── Bootstrap: вирішуємо що показувати ─────────────────────────
  // 1) onboarding — якщо ще не пройдено
  // 2) home       — якщо немає обраної гри
  // 3) editor     — якщо обрано DP2
  async function refreshStatusAndRoute(): Promise<SetupStatus> {
    const s = await window.dp2.setupStatus();
    setSetupStatus(s);
    if (!s.completed) {
      setStage("onboarding");
    } else if (activeGame === "dp2") {
      setStage("editor-dp2");
    } else if (activeGame === "dp1") {
      setStage("editor-dp1");
    } else {
      setStage("home");
    }
    return s;
  }

  useEffect(() => {
    refreshStatusAndRoute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ініціалізація store (loadTree з lastFolder) — лише коли заходимо в DP2 editor.
  useEffect(() => {
    if (stage === "editor-dp2") init();
  }, [stage, init]);

  useEffect(() => {
    if (!folder) {
      setGlossary([]);
      return;
    }
    readGlossary(folder).then(setGlossary);
  }, [folder]);

  // Глобальні шорткати DP2 — реєструємо лише в DP2 editor.
  useEffect(() => {
    if (stage !== "editor-dp2") return;
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "h") {
        const target = e.target as HTMLElement;
        const inMonaco = target.closest(".monaco-editor") !== null;
        if (inMonaco) return;
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGlossaryOpen(true);
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setTmVisible((v) => !v);
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setGlobalSearchOpen(true);
        return;
      }
      if (ctrl && !e.shiftKey && (e.key === "\\" || e.code === "Backslash")) {
        e.preventDefault();
        setFocusMode((v) => !v);
        return;
      }
      if (e.key === "Escape" && focusMode && !findOpen && !glossaryOpen && !globalSearchOpen) {
        setFocusMode(false);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, focusMode, findOpen, glossaryOpen, globalSearchOpen, setFocusMode, setTmVisible]);

  // ── Render ─────────────────────────────────────────────────────
  if (stage === "loading") {
    return (
      <>
        <div className="h-screen flex items-center justify-center bg-[var(--bg)] text-[var(--text-muted)] text-[13px]">
          Завантаження…
        </div>
        <DialogHost />
      </>
    );
  }

  if (stage === "onboarding" && setupStatus) {
    return (
      <>
        <div className="h-screen flex flex-col">
          <OnboardingScreen
            status={setupStatus}
            onComplete={() => refreshStatusAndRoute()}
            onSkip={async () => {
              await window.dp2.saveSettings({ setupCompleted: true });
              await refreshStatusAndRoute();
            }}
          />
        </div>
        <DialogHost />
      </>
    );
  }

  if (stage === "home") {
    const recents = setupStatus?.settings.recentFolders ?? [];
    return (
      <>
        <div className="h-screen flex flex-col">
          <HomeScreen
            recentFolders={recents}
            onPickGame={(id) => {
              setActiveGame(id);
              setStage(id === "dp1" ? "editor-dp1" : "editor-dp2");
            }}
            onOpenSetup={async () => {
              await window.dp2.setupReset();
              await refreshStatusAndRoute();
            }}
            onOpenFolder={async (p) => {
              await window.dp2.saveSettings({ lastFolder: p });
              setActiveGame("dp2");
              setStage("editor-dp2");
            }}
          />
        </div>
        <DialogHost />
      </>
    );
  }

  if (stage === "editor-dp1") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <Dp1Editor
            onHome={() => {
              setActiveGame(null);
              setStage("home");
              // Оновлюємо setupStatus БЕЗ роутингу — інакше refreshStatusAndRoute
              // прочитає stale activeGame з closure і поверне нас назад у editor.
              window.dp2.setupStatus().then(setSetupStatus);
            }}
            onOpenSettings={() => setDp1SettingsOpen(true)}
          />
          <Dp1SettingsModal open={dp1SettingsOpen} onClose={() => setDp1SettingsOpen(false)} />
        </div>
        <DialogHost />
      </>
    );
  }

  const showTm = tmVisible && !!folder && !focusMode;
  const showSidePanels = !focusMode;

  return (
    <div className="h-screen flex flex-col">
      <Header
        onFindReplace={() => setFindOpen(true)}
        onGlobalSearch={() => setGlobalSearchOpen(true)}
        onOpenGlossary={() => setGlossaryOpen(true)}
        onToggleTm={() => setTmVisible((v) => !v)}
        tmVisible={tmVisible}
        focusMode={focusMode}
        onToggleFocus={() => setFocusMode((v) => !v)}
        onHome={() => {
          setActiveGame(null);
          setStage("home");
          window.dp2.setupStatus().then(setSetupStatus);
        }}
      />
      <div className="flex-1 flex min-h-0">
        {showSidePanels && (
          <>
            <div style={{ width: fileListW }} className="h-full">
              <FileList />
            </div>
            <Resizer value={fileListW} onChange={setFileListW} min={180} max={520} />
            <div className="flex-1 min-w-0 h-full">
              <SentenceTable />
            </div>
            <Resizer value={editorW} onChange={setEditorW} invert min={360} max={900} />
          </>
        )}
        <div
          style={focusMode ? { flex: 1 } : { width: editorW }}
          className="h-full min-w-0"
        >
          <EditorPanel />
        </div>
        {showTm && (
          <>
            <Resizer value={tmW} onChange={setTmW} invert min={220} max={520} />
            <div style={{ width: tmW }} className="h-full">
              <TmPanel glossary={glossary} onOpenGlossary={() => setGlossaryOpen(true)} />
            </div>
          </>
        )}
      </div>
      <FindReplaceModal open={findOpen} onClose={() => setFindOpen(false)} />
      <GlobalSearchModal open={globalSearchOpen} onClose={() => setGlobalSearchOpen(false)} />
      <GlossaryModal
        open={glossaryOpen}
        folder={folder}
        onClose={(saved) => {
          setGlossaryOpen(false);
          if (saved) setGlossary(saved);
        }}
      />
      <DialogHost />
    </div>
  );
}

