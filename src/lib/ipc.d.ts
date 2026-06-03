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
      pickFolder: (opts?: { title?: string }) => Promise<string | null>;
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
      buildTmWorker: (payload: { dp2Folder: string | null }) => Promise<Array<{
        source: "dp2"; src: string; tgt: string; jp: string;
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
      buildAssets: () => Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
        log?: string;
        logPath?: string;
        /** Результат пакування UILabel («Інші рядки») у sharedassets1.assets.
         *  Виконується автоматично після основного збирання — якщо у Others/Done
         *  є файли. skipped=true означає «нічого не було пакувати». */
        others?: {
          ok: boolean;
          summary?: { ok: boolean; outputPath?: string; imported?: number; skipped?: number; errors?: number; note?: string } | null;
          imported?: number;
          skipped?: boolean;
          reason?: string;
          logPath?: string;
          error?: string;
        };
      }>;
      fontsExport: () => Promise<{
        success: boolean;
        outDir?: string;
        exported?: Array<{ name: string; pathId: number; file: string; size: number }>;
        error?: string;
        log?: string;
      }>;
      fontsReplace: (payload: { pathId: number; newFontPath: string; assetsFile?: string }) => Promise<{
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
      // DP2 Others — UILabel-корпус («переклад інших рядків»).
      // Original/ = еталони з sharedassets1.assets, Done/ = робочі копії.
      dp2OthersStatus: (payload: { pathIds: number[] }) => Promise<{
        ok: boolean;
        baseDir?: string;
        originalDir?: string;
        doneDir?: string;
        sharedAssets1?: string | null;
        sharedAssets1Exists?: boolean;
        files?: Array<{
          pathId: number;
          name: string;
          donePath: string;
          originalSize: number | null;
          doneSize: number | null;
          doneMtime: number | null;
        }>;
        error?: string;
      }>;
      dp2OthersExtract: (payload: { pathIds: number[] }) => Promise<{
        ok: boolean;
        summary?: {
          ok: boolean;
          outDir?: string;
          exported?: Array<{ pathId: number; file: string; size: number }>;
          failed?: Array<{ pathId: number; error: string }>;
          total?: number;
        } | null;
        copiedToDone?: number;
        log?: string;
        error?: string;
      }>;
      dp2OthersClear: () => Promise<{ ok: boolean; error?: string }>;
      onDp2OthersProgress: (cb: (line: string) => void) => () => void;
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      appVersion: () => Promise<string>;
      // Auto-detect Steam game folder. Reads HKCU\Software\Valve\Steam → SteamPath,
      // parses libraryfolders.vdf, returns first existing steamapps/common/<name>/.
      steamFindGame: (folderName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      // Full auto-update: downloads latest GitHub release asset, schedules a
      // detached batch swap, then quits.
      applyUpdate: () => Promise<{ ok: boolean; error?: string }>;
      onUpdateProgress: (cb: (p: {
        type: "locating" | "downloading" | "extracting" | "installing" | "error";
        name?: string;
        downloaded?: number;
        total?: number;
        speed?: number;
        error?: string;
      }) => void) => () => void;
      checkUpdate: (payload?: { force?: boolean }) => Promise<{
        ok: boolean;
        error?: string;
        available?: boolean;
        current?: string;
        latest?: string;
        htmlUrl?: string;
        publishedAt?: string;
        name?: string;
        body?: string;
      }>;
      dismissUpdateVersion: (version: string) => Promise<{ ok: boolean }>;
      // Last 5 GitHub releases — for the "What's new" Home section.
      fetchReleases: (payload?: { force?: boolean }) => Promise<{
        ok: boolean;
        error?: string;
        items?: Array<{
          tag: string;
          name: string;
          htmlUrl: string;
          publishedAt: string;
          prerelease: boolean;
        }>;
      }>;

      // Setup / onboarding
      setupStatus: () => Promise<SetupStatus>;
      setupRun: (payload: SetupRunPayload) => Promise<SetupRunResult>;
      setupReset: () => Promise<{ ok: boolean }>;
      onSetupProgress: (cb: (p: SetupProgress) => void) => () => void;

      // DP1 setup: download DPMsgTool (by MrIkso) into
      // Documents/SWERY-Localization-Tool/DP1/Text/Tool, copy mes_all.mes
      // from <dp1Root>/updata_eu/_us/message/output and convert to JSON.
      dp1SetupStatus: () => Promise<{
        ok: boolean;
        root: string;
        exePath: string | null;
        mesPath: string | null;
        mesCopied: boolean;
        jsonPath: string | null;
        jsonSize: number;
        textRoot?: string;
        originalJson?: string;
        doneJson?: string;
        metaFile?: string;
        originalExists?: boolean;
        doneExists?: boolean;
        metaExists?: boolean;
      }>;
      dp1DownloadTool: () => Promise<{
        ok: boolean;
        error?: string;
        root?: string;
        exePath?: string | null;
        bytes?: number;
        alreadyExisted?: boolean;
      }>;
      dp1PrepMes: (payload?: { mesPath?: string }) => Promise<{
        ok: boolean;
        error?: string;
        needsPick?: boolean;
        root?: string;
        exePath?: string;
        mesPath?: string;
        jsonPath?: string;
        jsonSize?: number;
        recordCount?: number;
        sourceMes?: string;
        stdout?: string;
        stderr?: string;
      }>;
      onDp1ToolProgress: (cb: (p: {
        phase: "download" | "extract" | "done" | "error";
        i18nKey?: string;
        i18nParams?: Record<string, string | number>;
        message?: string;
        total?: number;
        downloaded?: number;
        percent?: number;
        bytesPerSec?: number;
      }) => void) => () => void;

      // DP1 text editor — work on Original/Done/Meta JSON dump.
      dp1TextLoad: () => Promise<{
        ok: boolean;
        error?: string;
        original?: Dp1Record[];
        done?: Dp1Record[];
        meta?: Dp1Meta | null;
      }>;
      dp1TextSave: (payload: { done: Dp1Record[] }) => Promise<{
        ok: boolean;
        error?: string;
        bytesWritten?: number;
      }>;
      dp1TextCorpusStats: () => Promise<{
        ok: boolean;
        error?: string;
        files?: number;
        totalEntries?: number;
        translatedEntries?: number;
        percent?: number;
        uaWords?: number;
        enWords?: number;
        uaChars?: number;
        enChars?: number;
        topFiles?: Array<{
          fileName: string;
          filePath: string;
          total: number;
          translated: number;
          percent: number;
        }>;
      }>;
      dp1TextLintMarkers: () => Promise<{
        ok: boolean;
        error?: string;
        scannedRows?: number;
        violations?: Array<{
          index: number;
          id1: number;
          id2: number;
          missing: string[];
          extra: string[];
          original: string;
          current: string;
        }>;
      }>;
      dp1TextExportCombined: (payload?: { path?: string }) => Promise<{
        ok: boolean;
        error?: string;
        path?: string;
        bytes?: number;
      }>;
      dp1TextImportCombined: (payload: { path: string }) => Promise<{
        ok: boolean;
        error?: string;
        applied?: number;
        skipped?: number;
        fakeDiffs?: Array<{ index: number; expected: string; found: string }>;
      }>;
      dp1Pack: () => Promise<{
        ok: boolean;
        error?: string;
        outputPath?: string;
        intermediatePath?: string;
        bakPath?: string | null;
        warning?: string;
      }>;
      dp1GlyphMapRead: () => Promise<{
        ok: boolean;
        map: Record<string, string>;
        defaults: Record<string, string>;
      }>;
      dp1GlyphMapWrite: (payload: { map: Record<string, string> }) => Promise<{
        ok: boolean;
        error?: string;
      }>;

      // DP1 Textures (XPC2 archive)
      dp1TexturesList: () => Promise<{
        ok: boolean;
        error?: string;
        gameRoot?: string;
        originalDir?: string;
        doneDir?: string;
        items?: Array<{
          relPath: string;
          fullPath: string;
          size: number;
          internalName: string | null;
          ext: string | null;
          extracted: boolean;
          replaced: boolean;
        }>;
      }>;
      dp1TexturesExtractAll: () => Promise<{
        ok: boolean; error?: string; total?: number; extracted?: number; failed?: number;
      }>;
      dp1TexturesPackAll: () => Promise<{
        ok: boolean; error?: string; replaced?: number; skipped?: number; failed?: number;
      }>;
      dp1TextureReadPayload: (relPath: string) => Promise<{
        ok: boolean; error?: string;
        base64?: string; ext?: string; internalName?: string; payloadSize?: number;
      }>;
      dp1TextureReplaceOne: (payload: { relPath: string; base64: string }) => Promise<{
        ok: boolean; error?: string; size?: number;
      }>;
      onDp1TexturesProgress: (cb: (p: { done: number; total: number; phase?: string }) => void) => (() => void);
      dp1FontsPrep: () => Promise<{
        ok: boolean;
        error?: string;
        xpcPath?: string;
        ddsPath?: string;
        doneDir?: string;
        originalDir?: string;
        internalName?: string;
        payloadSize?: number;
        ext?: string;
      }>;
      dp1FontsReadRgba: () => Promise<{
        ok: boolean;
        error?: string;
        width?: number;
        height?: number;
        rgbaBase64?: string;
        source?: "done" | "original";
        srcPath?: string;
      }>;
      dp1FontsSaveRgba: (payload: { width: number; height: number; rgbaBase64: string }) => Promise<{
        ok: boolean;
        error?: string;
        outFile?: string;
        size?: number;
      }>;
      readFontFile: (fontPath: string) => Promise<{
        ok: boolean;
        error?: string;
        base64?: string;
        size?: number;
      }>;
      dp1FontsEnsureTypeface: () => Promise<{
        ok: boolean;
        error?: string;
        path?: string;
        cached?: boolean;
        size?: number;
      }>;
      onDp1FontsTypefaceProgress: (cb: (p: {
        phase: "start" | "download" | "done" | "error";
        total?: number;
        downloaded?: number;
        percent?: number;
        error?: string;
      }) => void) => (() => void);

      // DP2 Textures
      texturesExport: (payload?: {
        assetsFile?: string;
        pathIds?: number[];
      }) => Promise<{
        success: boolean;
        outDir?: string;
        exported?: Array<{
          name: string;
          pathId: number;
          width: number;
          height: number;
          format: number;
          file: string;
          size: number;
        }>;
        error?: string;
        log?: string;
      }>;
      texturesReplace: (payload: {
        pathId: number;
        newPngPath: string;
        assetsFile?: string;
      }) => Promise<{
        success: boolean;
        mode?: string;
        resS?: string;
        offset?: number;
        size?: number;
        output?: string;
        error?: string;
        log?: string;
      }>;
      texturesList: () => Promise<{ dir: string | null; files: Array<{ name: string; path: string }> }>;
      texturesReadBase64: (filePath: string) => Promise<string | null>;
      onTexturesExportProgress: (cb: (line: string) => void) => () => void;
      onTexturesReplaceProgress: (cb: (line: string) => void) => () => void;

      // HBR corpus stats — повна структура, схожа на CorpusStats (DP2),
      // щоб переюзати CorpusStatsModal через mode="hbr".
      hbrCorpusStats: () => Promise<{
        ok: boolean;
        error?: string;
        files?: number;
        totalEntries?: number;
        translatedEntries?: number;
        percent?: number;
        uaWords?: number;
        enWords?: number;
        uaChars?: number;
        enChars?: number;
        topFiles?: Array<{
          fileName: string;
          filePath: string;
          total: number;
          translated: number;
          percent: number;
        }>;
      }>;

      // HBR text — patch migration. Check returns whether new bundle hash differs
      // from meta, migrate performs backup + re-extract + merge of translations.
      hbrPatchMigrateCheck: () => Promise<{
        ok: boolean;
        error?: string;
        hasMeta?: boolean;
        needed?: boolean;
        newBundle?: string;
        oldBundle?: string;
        metaItemsCount?: number;
        doneCount?: number;
      }>;
      hbrPatchMigrate: () => Promise<{
        ok: boolean;
        error?: string;
        mergedFiles?: number;
        translated?: number;
        newCells?: number;
        keptEnglish?: number;
        backup?: string;
      }>;

      // HBR text — paths + counters (called from status-sidecar loader, etc.)
      hbrTextPrepStatus: () => Promise<{
        ok: boolean;
        error?: string;
        bundlePath?: string | null;
        bundleOk?: boolean;
        originalDir?: string;
        doneDir?: string;
        metaDir?: string;
        metaFile?: string;
        metaExists?: boolean;
        originalCount?: number;
        doneCount?: number;
      }>;

      // HBR text — remove DLC traces (Done/Original files + meta items)
      hbrTextPurgeDlc: () => Promise<{ ok: boolean; removedFiles: number; removedMeta: number }>;

      // HBR text — pre-pack placeholder lint. Scans Done vs Original for tag-set
      // mismatches per row; pack-flow asks user before running if violations > 0.
      hbrTextLintPlaceholders: () => Promise<{
        ok: boolean;
        error?: string;
        scannedFiles?: number;
        scannedRows?: number;
        violations?: Array<{
          file: string;
          textId: string;
          variantIdx: number;
          missing: string[];
          extra: string[];
          original: string;
          current: string;
        }>;
      }>;

      // HBR Font Generator (TMPUnity tool from Dropbox)
      hbrFontgenStatus: () => Promise<{ ok: boolean; installed: boolean; root: string; exePath: string | null }>;
      hbrFontgenDownload: () => Promise<{ ok: boolean; error?: string; exePath?: string | null }>;
      hbrFontgenLaunch: () => Promise<{ ok: boolean; error?: string; exePath?: string }>;
      onHbrFontgenProgress: (cb: (p: {
        phase: "download" | "extract" | "done" | "error";
        i18nKey?: string;
        i18nParams?: Record<string, string | number>;
        message?: string;
        total?: number;
        downloaded?: number;
        percent?: number;
        bytesPerSec?: number;
      }) => void) => () => void;

      // HBR Fonts (Atlas PNG + TMP_FontAsset MonoBehaviour JSON)
      hbrFontsStatus: () => Promise<{
        ok: boolean;
        error?: string;
        root?: string;
        atlasDir?: string;
        monoDir?: string;
        atlasCount?: number;
        monoCount?: number;
        bundlePath?: string | null;
        bundleOk?: boolean;
      }>;
      hbrFontsAtlasExport: () => Promise<{
        ok: boolean;
        error?: string;
        outDir?: string;
        summary?: {
          ok: boolean;
          outDir: string;
          bundle: string;
          total: number;
          skipped: number;
          exported: Array<{
            name: string;
            pathId: number;
            width: number;
            height: number;
            format: number;
            file: string;
            size: number;
            assetsFile: string;
          }>;
        } | null;
        log?: string;
      }>;
      hbrFontsMonoExport: () => Promise<{
        ok: boolean;
        error?: string;
        outDir?: string;
        summary?: {
          ok: boolean;
          outDir: string;
          bundle: string;
          total: number;
          scannedMono: number;
          exported: Array<{ pathId: number; name: string; file: string; assetsFile: string }>;
          failed: Array<{ pathId: number; name?: string; error: string }>;
        } | null;
        log?: string;
      }>;
      onHbrFontsAtlasProgress: (cb: (line: string) => void) => () => void;
      onHbrFontsMonoProgress: (cb: (line: string) => void) => () => void;

      hbrFontsImport: () => Promise<{
        ok: boolean;
        error?: string;
        summary?: {
          ok: boolean;
          bundle: string;
          size: number;
          bakSize: number;
          monoApplied: number;
          atlasApplied: number;
          failed: Array<{ file: string; reason: string }>;
        } | null;
        log?: string;
      }>;
      onHbrFontsImportProgress: (cb: (line: string) => void) => () => void;

      // HBR Textures — bundle in-place patch via UABEA / AssetsTools.NET.
      hbrTexturesStatus: () => Promise<{
        ok: boolean;
        error?: string;
        unpackDir?: string;
        count?: number;
        bundlePath?: string | null;
        bundleOk?: boolean;
      }>;
      hbrTexturesExport: (payload?: {
        pathIds?: string[];
      }) => Promise<{
        success: boolean;
        outDir?: string;
        summary?: {
          ok: boolean;
          outDir: string;
          bundle: string;
          total: number;
          skipped: number;
          missing: string[] | number[];
          exported: Array<{
            name: string;
            pathId: number | string;
            width: number;
            height: number;
            format: number;
            file: string;
            size: number;
            assetsFile: string;
          }>;
        } | null;
        error?: string;
        log?: string;
      }>;
      hbrTexturesReplace: (payload: {
        items: Array<{ pathId: string; pngPath: string }>;
      }) => Promise<{
        success: boolean;
        bundle?: string;
        size?: number;
        bakSize?: number;
        bakCreated?: boolean;
        applied?: number;
        failed?: Array<{ pathId: number | string; reason: string }>;
        error?: string;
        log?: string;
      }>;
      hbrTexturesList: () => Promise<{ dir: string | null; files: Array<{ name: string; path: string }> }>;
      hbrTexturesReadBase64: (filePath: string) => Promise<string | null>;
      onHbrTexturesExportProgress: (cb: (line: string) => void) => () => void;
      onHbrTexturesReplaceProgress: (cb: (line: string) => void) => () => void;

      // TGL Fonts
      tglFontsList: () => Promise<{
        items: Array<{
          jsonPath: string;
          atlasPath: string | null;
          name: string;
          fontSize: number;
          lineSpacing: number;
          charCount: number;
          texPathId: string | null;
          baseDir: string;
        }>;
        baseFolder: string | null;
        error?: string;
      }>;
      tglFontsExtract: (payload: { cabPath: string }) => Promise<{
        ok: boolean;
        outDir?: string;
        exported?: Array<{ name: string; pathId: number; texPathId: number | null; json: string; png: string | null }>;
        error?: string;
        log?: string;
      }>;
      tglFontsImportToCab: (payload: {
        cabPath: string; jsonPath: string; pngPath: string;
      }) => Promise<{
        ok: boolean;
        output?: string;
        size?: number;
        glyphs?: number;
        error?: string;
        log?: string;
      }>;
      tglFontsReadJson: (path: string) => Promise<{
        ok: boolean;
        content?: string;
        raw?: string;
        data?: unknown;
        charsSection?: { start: number; end: number } | null;
        error?: string;
      }>;
      tglFontsWriteJson: (payload: { jsonPath: string; content: string }) => Promise<{ ok: boolean; bakPath?: string; error?: string }>;
      tglFontsReadAtlasBase64: (path: string) => Promise<{ ok: boolean; base64?: string; error?: string }>;
      tglFontsWriteAtlasBase64: (payload: { pngPath: string; base64: string }) => Promise<{ ok: boolean; bakPath?: string; error?: string }>;

      // TGL (The Good Life)
      tglLoad: (binPath: string) => Promise<{
        ok?: boolean;
        error?: string;
        records?: Array<{ i: number; key: string; en: string }>;
        ua?: string[];
        originalSize?: number;
        workPath?: string;
        workfileMismatch?: { binLines: number; txtLines: number };
      }>;
      tglSaveWorkfile: (payload: { binPath: string; ua: string[] }) => Promise<{
        ok?: boolean;
        error?: string;
        workPath?: string;
      }>;
      // TGL Monaco-editor: окрема директорія TRANSLATION/<name>.txt
      // дзеркалиться у <binPath>.txt workfile (для pack).
      tglTextPrep: (payload: { binPath: string }) => Promise<{
        ok: boolean;
        error?: string;
        binName?: string;
        translationPath?: string;
        originalPath?: string;
        originalContent?: string;
        translationContent?: string;
        lineCount?: number;
      }>;
      tglTextWrite: (payload: { binPath: string; content: string }) => Promise<{
        ok: boolean;
        error?: string;
        translationPath?: string;
      }>;
      tglPack: (payload: { binPath: string; ua: string[] }) => Promise<{
        ok?: boolean;
        error?: string;
        outputPath?: string;
        bakPath?: string;
        translated?: number;
        fallback?: number;
        size?: number;
        originalSize?: number;
      }>;
    };
  }
}

export interface Dp1Record {
  Id1: number;
  Id2: number;
  Flag1: number;
  Flag2: number;
  FirstSegmentLenght: number;
  Text: string;
  EmptyRecord: boolean;
}

export interface Dp1Meta {
  sourceMes?: string;
  sourceMesMtime?: number;
  extractedAt?: number;
  recordCount?: number;
  visibleCount?: number;
  lastSavedAt?: number;
  translatedCount?: number;
}

export interface CorpusStats {
  files: number;
  totalEntries: number;
  translatedEntries: number;
  /** «Готовність редагування» — рядки явно затверджені через ПКМ → Затвердити.
   *  Опційне поле — присутнє у DP2 corpus-stats; у MISSING/HBR/DP1 — undefined. */
  approvedEntries?: number;
  approvedPercent?: number;
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
    approved?: number;
    approvedPercent?: number;
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
  // DP1
  dp1EngPath?: string;
  dp1ToolPath?: string;
  dp1GameDir?: string;
  // TGL (The Good Life)
  tglBinPath?: string;
  // Update check
  lastUpdateCheck?: number;
  lastUpdateCache?: {
    ok: boolean; available?: boolean; current?: string; latest?: string;
    htmlUrl?: string; publishedAt?: string; name?: string; body?: string;
  };
  dismissedUpdateVersion?: string;
  // Cache для "What's new" — 5 останніх релізів, TTL 6h.
  lastReleasesCheck?: number;
  lastReleasesCache?: {
    ok: boolean;
    items?: Array<{
      tag: string; name: string; htmlUrl: string;
      publishedAt: string; prerelease: boolean;
    }>;
  };
  // HBR fonts guide — показуємо повноекранну інструкцію один раз після
  // успішного extract'у шрифтів. Прапор стає true, коли користувач натиснув
  // "Зрозуміло". Кнопка "Інструкція" у Step 3 завжди дозволяє відкрити її.
  hbrFontsGuideSeen?: boolean;
  // Користувач натиснув «Очистити» на блоці «Нещодавно відкриті» — секція
  // ховається на Home, шляхи у settings лишаються (карти ігор працюють).
  recentItemsDismissed?: boolean;
  // Autosave (crash-recovery)
  autosaveDir?: string;       // якщо задано — всі .autosave.json пишуться сюди
  autosaveIntervalMin?: number; // debounce у хвилинах (мін 0.25, дефолт 1)
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
  /** Fallback-рядок (українською); якщо `i18nKey` є — renderer перекладе через t(). */
  message?: string;
  i18nKey?: string;
  i18nParams?: Record<string, string | number>;
  total?: number;
  downloaded?: number;
  percent?: number | null;
}

export {};
