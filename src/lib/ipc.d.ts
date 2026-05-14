// Типи для window.dp2 API, експонованого з preload.

export interface TreeNode {
  type: "folder" | "file";
  name: string;
  path: string;
  children?: TreeNode[];
  // file-only meta
  totalEntries?: number;
  translatedCount?: number;
}

declare global {
  interface Window {
    dp2: {
      pickFolder: () => Promise<string | null>;
      pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      pickSaveFile: (opts?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      listFiles: (folder: string) => Promise<string[]>;
      listTree: (root: string) => Promise<TreeNode | null>;
      readFile: (fullPath: string) => Promise<string>;
      writeFile: (fullPath: string, content: string) => Promise<boolean>;
      readBackup: (fullPath: string) => Promise<string | null>;
      writeAutosave: (fullPath: string, content: string) => Promise<string>;
      readAutosave: (fullPath: string) => Promise<{ content: string; autosaveMtime: number; originalMtime: number } | null>;
      deleteAutosave: (fullPath: string) => Promise<boolean>;
      readAll: (folder: string) => Promise<Array<{ path: string; content: string; bakContent: string | null }>>;
      buildTmWorker: (payload: { dp2Folder: string | null; dp1EngPath: string | null }) => Promise<Array<{
        source: "dp1" | "dp2"; src: string; tgt: string; jp: string;
        filePath: string; fileName: string; charaName?: string;
      }>>;
      searchAllWorker: (payload: { folder: string; opts: { query: string; field: string; caseSensitive: boolean; regex: boolean } }) => Promise<{
        hits: Array<{
          filePath: string; fileName: string; entryIndex: number;
          matchedField: string; matchedText: string;
          entry: { kind: string; id: string; charaName?: string };
        }>;
        truncated: boolean;
      }>;
      corpusStatsWorker: (payload: { folder: string }) => Promise<CorpusStats>;
      glossaryConsistencyWorker: (payload: { folder: string; glossary: Array<{ src: string; tgt: string }> }) => Promise<GlossaryConsistencyResult>;
      batchReplaceWorker: (payload: { folder: string; opts: BatchReplaceOptions }) => Promise<BatchReplaceResult>;
      nameConsistencyWorker: (payload: { folder: string }) => Promise<NameConsistencyResult>;
      fileCountsWorker: (payload: { folder: string }) => Promise<Array<{ path: string; total: number; translated: number }>>;
      smartBreakAllWorker: (payload: { folder: string; opts: { maxLine?: number; dryRun?: boolean } }) => Promise<{
        files: Array<{ path: string; fileName: string; changed: number }>;
        totalEntries: number;
        totalChanges: number;
      }>;
      renameCharaWorker: (payload: { folder: string; oldName: string; newName: string }) => Promise<{
        files: Array<{ path: string; fileName: string; changed: number }>;
        totalEntries: number;
      }>;
      getSettings: () => Promise<DpSettings>;
      saveSettings: (partial: Record<string, unknown>) => Promise<DpSettings>;
      launchUabea: () => Promise<{ success: boolean; error?: string }>;
      buildAssets: () => Promise<{ success: boolean; outputPath?: string; error?: string; log?: string; logPath?: string }>;
      fontsExport: () => Promise<{
        success: boolean;
        outDir?: string;
        exported?: Array<{ name: string; pathId: number; file: string; size: number }>;
        error?: string;
        log?: string;
      }>;
      fontsReplace: (payload: { pathId: number; newFontPath: string }) => Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
        log?: string;
      }>;
      fontsList: () => Promise<{ dir: string | null; files: Array<{ name: string; path: string }> }>;
      fontsReadBase64: (filePath: string) => Promise<string | null>;
      onFontsExportProgress: (cb: (line: string) => void) => () => void;
      onFontsReplaceProgress: (cb: (line: string) => void) => () => void;
      openFolder: (folder: string) => Promise<void>;

      // Setup / onboarding
      setupStatus: () => Promise<SetupStatus>;
      setupRun: (payload: SetupRunPayload) => Promise<SetupRunResult>;
      setupReset: () => Promise<{ ok: boolean }>;
      onSetupProgress: (cb: (p: SetupProgress) => void) => () => void;

      // DP1 pack
      dp1Pack: (payload: { donePath: string }) => Promise<{
        ok?: boolean;
        error?: string;
        outputPath?: string;
        intermediatePath?: string;
      }>;
    };
  }
}

export interface CorpusStats {
  files: number;
  totalEntries: number;
  translatedEntries: number;
  percent: number;
  uaWords: number;
  enWords: number;
  uaChars: number;
  enChars: number;
  topFiles: Array<{
    fileName: string;
    filePath: string;
    total: number;
    translated: number;
    percent: number;
  }>;
}

export interface BatchReplaceOptions {
  find: string;
  replace: string;
  field: "en" | "charaName";
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  dryRun: boolean;
}

export interface BatchReplaceHit {
  entryIndex: number;
  entryId: string;
  field: string;
  before: string;
  after: string;
}

export interface BatchReplaceFileResult {
  path: string;
  fileName: string;
  entriesChanged: number;
  replacements: number;
  hits: BatchReplaceHit[];
}

export interface BatchReplaceResult {
  files: BatchReplaceFileResult[];
  totalEntries: number;
  totalReplacements: number;
  truncated: boolean;
}

export interface NameVariantSample {
  filePath: string;
  fileName: string;
  entryIndex: number;
  entryId: string;
  en: string;
}

export interface NameVariant {
  name: string;
  count: number;
  samples: NameVariantSample[];
}

export interface NameGroup {
  canonical: string;
  variants: NameVariant[];
}

export interface NameConsistencyResult {
  groups: NameGroup[];
  totalNames: number;
  totalEntries: number;
}

export interface GlossaryViolation {
  filePath: string;
  fileName: string;
  entryIndex: number;
  entryId: string;
  kind: "sentence" | "item";
  charaName?: string;
  originalEn: string;
  en: string;
  sheetIndex: number;
  listIndex: number;
  scenarioIndex?: number;
}

export interface GlossaryTermResult {
  src: string;
  tgt: string;
  okCount: number;
  violationCount: number;
  violations: GlossaryViolation[];
}

export interface GlossaryConsistencyResult {
  termResults: GlossaryTermResult[];
  totals: {
    terms: number;
    violations: number;
    entriesScanned: number;
    entriesTranslated: number;
  };
}

export interface DpSettings {
  uabeaPath?: string;
  lastFolder?: string;
  assetsPath?: string;
  pwshPath?: string;
  toolsDir?: string;
  setupCompleted?: boolean;
  recentFolders?: string[];
}

export interface SetupStatus {
  completed: boolean;
  settings: {
    uabeaPath: string;
    pwshPath: string;
    assetsPath: string;
    lastFolder: string;
    toolsDir: string;
    recentFolders: string[];
  };
  defaults: {
    toolsDir: string;
    suggestedAssets: string[];
  };
  validity: {
    uabeaPath: boolean;
    pwshPath: boolean;
    assetsPath: boolean;
    lastFolder: boolean;
  };
}

export interface SetupRunPayload {
  toolsDir: string;
  assetsPath?: string;
  lastFolder?: string;
  uabeaPath?: string;
  pwshPath?: string;
  downloadUabea: boolean;
  downloadPwsh: boolean;
}

export interface SetupRunResult {
  ok?: boolean;
  error?: string;
  settings?: {
    uabeaPath: string;
    pwshPath: string;
    assetsPath: string;
    lastFolder: string;
    toolsDir: string;
  };
}

export type SetupPhase =
  | "check" | "fetch" | "download" | "extract" | "persist" | "done" | "error";

export interface SetupProgress {
  phase: SetupPhase;
  tool?: "uabea" | "pwsh";
  message: string;
  total?: number;
  downloaded?: number;
  percent?: number | null;
}

export {};
