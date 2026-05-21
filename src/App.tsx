import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { FileList } from "./components/FileList";
import { SentenceTable } from "./components/SentenceTable";
import { EditorPanel } from "./components/EditorPanel";
import { FindReplaceModal } from "./components/FindReplaceModal";
import { BatchReplaceModal } from "./components/BatchReplaceModal";
import { TmPanel } from "./components/TmPanel";
import { GlossaryModal } from "./components/GlossaryModal";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { Resizer } from "./components/Resizer";
import { HomeV2 as HomeScreen } from "./ui-v2/HomeV2";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { Dp1Editor } from "./games/dp1/Dp1Editor";
import { Dp1TexturesEditor } from "./games/dp1/Dp1TexturesEditor";
import { Dp1FontsEditor } from "./games/dp1/Dp1FontsEditor";
import { Dp2FontsEditor } from "./games/dp2/Dp2FontsEditor";
import { Dp2TexturesEditor } from "./games/dp2/Dp2TexturesEditor";
import { Dp2TextPrepWizard } from "./games/dp2/Dp2TextPrepWizard";
import { HbrEditor } from "./games/hbr/HbrEditor";
import { MissingEditor } from "./games/missing/MissingEditor";
import { MissingFontsEditor } from "./games/missing/MissingFontsEditor";
import { MissingTexturesEditor } from "./games/missing/MissingTexturesEditor";
import { HbrFontsEditor } from "./games/hbr/HbrFontsEditor";
import { HbrTexturesEditor } from "./games/hbr/HbrTexturesEditor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { dp2TextRequiredEntries } from "./games/dp2/required-text-files";
import { TglEditor } from "./games/tgl/TglEditor";
import { TglFontsEditor } from "./games/tgl/fonts/TglFontsEditor";
import { SettingsModal } from "./components/SettingsModal";
import { readGlossary, type GlossaryEntry } from "./lib/glossary";
import { useLocalStorage } from "./lib/useLocalStorage";
import { useStore } from "./lib/store";
import { useAutosave } from "./lib/useAutosave";
import type { SetupStatus } from "./lib/ipc";
import { DialogHost } from "./lib/dialogs";
import { UpdateBanner } from "./components/UpdateBanner";
import { ToastProvider } from "./components/ToastProvider";

type Stage = "loading" | "onboarding" | "home" | "prep-dp2" | "editor-dp2" | "editor-dp1" | "textures-dp1" | "fonts-dp1" | "editor-tgl" | "fonts-dp2" | "textures-dp2" | "fonts-tgl" | "editor-hbr" | "fonts-hbr" | "textures-hbr" | "editor-missing" | "fonts-missing" | "textures-missing";
type ActiveGame = "dp1" | "dp2" | "tgl" | "hbr" | "missing" | null;

export default function App() {
  const [findOpen, setFindOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [tmVisible, setTmVisible] = useLocalStorage<boolean>("dp2.ui.tmVisible", true);
  const [focusMode, setFocusMode] = useLocalStorage<boolean>("dp2.ui.focusMode", false);
  const [fileListW, setFileListW] = useLocalStorage<number>("dp2.ui.fileListW", 280);
  const [editorW, setEditorW] = useLocalStorage<number>("dp2.ui.editorW", 520);
  const [tmW, setTmW] = useLocalStorage<number>("dp2.ui.tmW", 300);
  const [activeGame, setActiveGame] = useLocalStorage<ActiveGame>("dp2.ui.activeGame", null);
  // Підрежим для DP2 (text|fonts|textures) і TGL (text|fonts) — щоб після
  // перезапуску відкритися саме там, де користувач був, а не завжди в Text.
  const [dp2Mode, setDp2Mode] = useLocalStorage<"text" | "fonts" | "textures">("dp2.ui.dp2Mode", "text");
  const [tglMode, setTglMode] = useLocalStorage<"text" | "fonts">("dp2.ui.tglMode", "text");
  const [fontsSettingsOpen, setFontsSettingsOpen] = useState(false);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);

  const [stage, setStage] = useState<Stage>("loading");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [dp2PrepOpen, setDp2PrepOpen] = useState(false);

  const init = useStore((s) => s.init);
  const folder = useStore((s) => s.folder);
  const dp2Dirty = useStore((s) => s.dirty);
  const dp2Autosave = useStore((s) => s.autosave);
  useAutosave(stage === "editor-dp2" && dp2Dirty, dp2Autosave);

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
      // Усі DP2-режими потребують assetsPath. Якщо ще не задано (перший
      // запуск) — кидаємо у prep-wizard який сам попросить теку гри і
      // витягне тексти у TEXT/ORIGINAL + TEXT/DONE.
      const ap: string | undefined = s.settings?.assetsPath;
      if (!ap) { setStage("prep-dp2"); return s; }
      if (dp2Mode === "fonts") setStage("fonts-dp2");
      else if (dp2Mode === "textures") setStage("textures-dp2");
      else {
        // Text mode: ще перевіряємо чи готовий TEXT/DONE.
        const required = dp2TextRequiredEntries();
        try {
          const w = window.dp2 as unknown as { textPrepStatus: (p: { assetsPath: string; requiredFiles: unknown[] }) => Promise<{ doneMissing?: string[]; doneDir?: string }> };
          const st = await w.textPrepStatus({ assetsPath: ap, requiredFiles: required });
          const missing = st.doneMissing?.length ?? 0;
          if (missing > 0) {
            setStage("prep-dp2");
          } else {
            // Авто-виставляємо TEXT/DONE як lastFolder, якщо ще не задано
            // (інакше editor покаже порожній FileList і знову проситиме папку).
            const currentLast = s.settings?.lastFolder as string | undefined;
            if (st.doneDir && !currentLast) {
              try { await window.dp2.saveSettings({ lastFolder: st.doneDir }); } catch {}
              const fresh = await window.dp2.setupStatus();
              setSetupStatus(fresh);
            }
            setStage("editor-dp2");
          }
        } catch {
          setStage("prep-dp2");
        }
      }
    } else if (activeGame === "dp1") {
      setStage("editor-dp1");
    } else if (activeGame === "tgl") {
      setStage(tglMode === "fonts" ? "fonts-tgl" : "editor-tgl");
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

  // При вході в editor-dp2 перевіряємо, чи готовий TEXT/DONE. Якщо файлів
  // нема або не задано assetsPath — показуємо модалку prep ПОВЕРХ editor.
  useEffect(() => {
    if (stage !== "editor-dp2") { setDp2PrepOpen(false); return; }
    let cancelled = false;
    (async () => {
      const s = await window.dp2.setupStatus();
      const ap = (s.settings as { assetsPath?: string })?.assetsPath;
      if (!ap) { if (!cancelled) setDp2PrepOpen(true); return; }
      const required = dp2TextRequiredEntries();
      try {
        const w = window.dp2 as unknown as { textPrepStatus: (p: { assetsPath: string; requiredFiles: unknown[] }) => Promise<{ doneMissing?: string[]; doneDir?: string }> };
        const st = await w.textPrepStatus({ assetsPath: ap, requiredFiles: required });
        const missing = st.doneMissing?.length ?? 0;
        if (missing > 0) { if (!cancelled) setDp2PrepOpen(true); return; }
        // Все готово — авто-виставляємо lastFolder, якщо ще не задано.
        const currentLast = (s.settings as { lastFolder?: string })?.lastFolder;
        if (st.doneDir && !currentLast) {
          await window.dp2.saveSettings({ lastFolder: st.doneDir });
          const fresh = await window.dp2.setupStatus();
          if (!cancelled) setSetupStatus(fresh);
        }
        if (!cancelled) setDp2PrepOpen(false);
      } catch {
        if (!cancelled) setDp2PrepOpen(true);
      }
    })();
    return () => { cancelled = true; };
  }, [stage]);

  // У prep-dp2 stage для fonts/textures режимів з готовим assetsPath
  // одразу пропускаємо wizard і йдемо у відповідний редактор.
  useEffect(() => {
    if (stage !== "prep-dp2") return;
    if (dp2Mode === "text") return;
    const ap = setupStatus?.settings?.assetsPath;
    if (!ap) return;
    if (dp2Mode === "fonts") setStage("fonts-dp2");
    else if (dp2Mode === "textures") setStage("textures-dp2");
  }, [stage, dp2Mode, setupStatus]);

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
        <DialogHost /><ToastProvider /><UpdateBanner />
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
          />
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "home") {
    const homeProps = {
      onPickGame: (id: "dp1" | "dp2" | "tgl" | "hbr" | "missing", mode?: "text" | "fonts" | "textures") => {
        setActiveGame(id);
        if (id === "missing") {
          if (mode === "fonts") setStage("fonts-missing");
          else if (mode === "textures") setStage("textures-missing");
          else setStage("editor-missing");
          return;
        }
        if (id === "hbr") {
          setStage(
            mode === "textures" ? "textures-hbr"
            : mode === "fonts" ? "fonts-hbr"
            : "editor-hbr"
          );
          return;
        }
        if (id === "dp1") {
          setStage(
            mode === "textures" ? "textures-dp1"
            : mode === "fonts" ? "fonts-dp1"
            : "editor-dp1"
          );
        } else if (id === "tgl") {
          const m: "text" | "fonts" = mode === "fonts" ? "fonts" : "text";
          setTglMode(m);
          setStage(m === "fonts" ? "fonts-tgl" : "editor-tgl");
        } else {
          const m: "text" | "fonts" | "textures" = mode === "fonts" ? "fonts" : mode === "textures" ? "textures" : "text";
          setDp2Mode(m);
          // Йдемо одразу в потрібний DP2-стейдж. Якщо це text-mode і TEXT/DONE
          // неповний — поверх editor-dp2 покажемо модалку prep, яка зробить
          // extract і відкриє редактор по кнопці.
          setStage(m === "fonts" ? "fonts-dp2" : m === "textures" ? "textures-dp2" : "editor-dp2");
        }
      },
      onOpenSetup: async () => {
        await window.dp2.setupReset();
        await refreshStatusAndRoute();
      },
      onOpenFolder: async (p: string) => {
        await window.dp2.saveSettings({ lastFolder: p });
        setActiveGame("dp2");
        setStage("editor-dp2");
      },
      onOpenRecent: async (game: "dp1" | "dp2" | "tgl" | "hbr" | "missing", path: string) => {
        if (game === "hbr" || game === "missing") return;
        if (game === "dp1") {
          await window.dp2.saveSettings({ dp1EngPath: path });
          setActiveGame("dp1");
          setStage("editor-dp1");
        } else if (game === "tgl") {
          await window.dp2.saveSettings({ tglBinPath: path });
          setActiveGame("tgl");
          setTglMode("text");
          setStage("editor-tgl");
        } else {
          await window.dp2.saveSettings({ lastFolder: path });
          setActiveGame("dp2");
          setDp2Mode("text");
          setStage("editor-dp2");
        }
      },
    };
    return (
      <>
        <div className="h-screen flex flex-col">
          <HomeScreen {...homeProps} />
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
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
          />
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "textures-dp1") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="Deadly Premonition — textures">
            <Dp1TexturesEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "fonts-dp1") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="Deadly Premonition — fonts">
            <Dp1FontsEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "editor-missing") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="THE MISSING — text">
            <MissingEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "fonts-missing") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="THE MISSING — fonts">
            <MissingFontsEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "textures-missing") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="THE MISSING — textures">
            <MissingTexturesEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "editor-hbr") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="Hotel Barcelona — text">
            <HbrEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "fonts-hbr") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="Hotel Barcelona — fonts">
            <HbrFontsEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "textures-hbr") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <ErrorBoundary label="Hotel Barcelona — textures">
            <HbrTexturesEditor
              onHome={() => {
                setActiveGame(null);
                setStage("home");
                window.dp2.setupStatus().then(setSetupStatus);
              }}
            />
          </ErrorBoundary>
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "fonts-tgl") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <TglFontsEditor
            onHome={() => {
              setActiveGame(null);
              setStage("home");
              window.dp2.setupStatus().then(setSetupStatus);
            }}
          />
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "editor-tgl") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <TglEditor
            onHome={() => {
              setActiveGame(null);
              setStage("home");
              window.dp2.setupStatus().then(setSetupStatus);
            }}
          />
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "textures-dp2") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <Dp2TexturesEditor
            onHome={() => {
              setActiveGame(null);
              setStage("home");
              window.dp2.setupStatus().then(setSetupStatus);
            }}
          />
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  if (stage === "fonts-dp2") {
    return (
      <>
        <div className="h-screen flex flex-col">
          <Dp2FontsEditor
            onHome={() => {
              setActiveGame(null);
              setStage("home");
              window.dp2.setupStatus().then(setSetupStatus);
            }}
            onOpenSettings={() => setFontsSettingsOpen(true)}
          />
          <SettingsModal open={fontsSettingsOpen} onClose={() => setFontsSettingsOpen(false)} />
        </div>
        <DialogHost /><ToastProvider /><UpdateBanner />
      </>
    );
  }

  const showTm = tmVisible && !!folder && !focusMode;
  const showSidePanels = !focusMode;

  return (
    <div className="h-screen flex flex-col">
      <Header
        onFindReplace={() => setFindOpen(true)}
        onBatchReplace={() => setBatchOpen(true)}
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
      <BatchReplaceModal open={batchOpen} onClose={() => setBatchOpen(false)} />
      <GlobalSearchModal open={globalSearchOpen} onClose={() => setGlobalSearchOpen(false)} />
      <GlossaryModal
        open={glossaryOpen}
        folder={folder}
        onClose={(saved) => {
          setGlossaryOpen(false);
          if (saved) setGlossary(saved);
        }}
      />
      <DialogHost /><ToastProvider /><UpdateBanner />
      {dp2PrepOpen && (
        <Dp2TextPrepWizard
          assetsPath={(setupStatus?.settings as { assetsPath?: string })?.assetsPath ?? null}
          onAssetsPathPicked={async (newPath) => {
            await window.dp2.saveSettings({ assetsPath: newPath });
            const fresh = await window.dp2.setupStatus();
            setSetupStatus(fresh);
          }}
          onDone={async (doneDir) => {
            try { await window.dp2.saveSettings({ lastFolder: doneDir }); } catch {}
            const fresh = await window.dp2.setupStatus();
            setSetupStatus(fresh);
            setDp2PrepOpen(false);
            init();
          }}
          onCancel={() => {
            setDp2PrepOpen(false);
            setActiveGame(null);
            setStage("home");
            window.dp2.setupStatus().then(setSetupStatus);
          }}
        />
      )}
    </div>
  );
}

