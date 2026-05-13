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
      readAll: (folder: string) => Promise<Array<{ path: string; content: string; bakContent: string | null }>>;
      scanAll: (folder: string) => Promise<{
        totalEntries: number;
        totalTranslated: number;
        issues: Array<{ kind: string; filePath: string; entryIndex: number; id: string; detail: string }>;
      }>;
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
      getSettings: () => Promise<DpSettings>;
      saveSettings: (partial: Record<string, unknown>) => Promise<DpSettings>;
      launchUabea: () => Promise<{ success: boolean; error?: string }>;
      buildAssets: () => Promise<{ success: boolean; outputPath?: string; error?: string; log?: string; logPath?: string }>;
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
