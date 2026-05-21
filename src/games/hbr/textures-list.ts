// Hotel Barcelona — Список текстур для редагування.
//
// Усі 24 текстури живуть у тому ж самому bundle, що й текст:
//   StreamingAssets/aa/StandaloneWindows64/_resources_assets_all_0d63e41486d027f2e31ca9d62cbfb661.bundle
// усередині assets-файла CAB-89c332e3a37c28aedc3cf762487a736e.
//
// УВАГА: pathId у HBR — це int64 (19 цифр, негативні значення). JS Number
// втрачає точність на 16+ цифрах (`-5904940313933730409` округлюється). Тому
// зберігаємо як string і конвертимо у BigInt / [int64] тільки на point-of-use
// (передача у скрипт, порівняння). Не використовуй parseInt/Number — втратиш
// точність і скрипт не знайде PathID.

export interface HbrTextureEntry {
  id: string;       // стабільний id (kebab-case), використовується для статусу/превью
  name: string;     // m_Name з Unity (рівно те, що пише UABEA Next)
  pathId: string;   // int64 як string — НЕ конвертувати в Number
  group?: string;   // префікс імені (до останнього "_NN") — для UI-фільтра
}

// Спільний CAB усього файла, до якого належать ВСІ записи нижче. Утиліта для
// hbr-textures-* скриптів, які парсять імена `<name>-<CAB-…>-<pathId>.png`.
export const HBR_TEXTURES_CAB = "CAB-89c332e3a37c28aedc3cf762487a736e";

export const HBR_TEXTURES: HbrTextureEntry[] = [
  { id: "allmap-00",            name: "allmap_00",            pathId: "8010679797385409155",  group: "allmap" },
  { id: "allmap-bg-00",         name: "allmap_bg_00",         pathId: "4752420786427529784",  group: "allmap_bg" },
  { id: "allmap-bg-01",         name: "allmap_bg_01",         pathId: "2613241822774233425",  group: "allmap_bg" },
  { id: "allmap-bg-02",         name: "allmap_bg_02",         pathId: "-2272359077771585983", group: "allmap_bg" },
  { id: "allmap-poster-00",     name: "allmap_poster_00",     pathId: "-5730553896977017545", group: "allmap_poster" },
  { id: "allmap-poster-01",     name: "allmap_poster_01",     pathId: "7346080506832229111",  group: "allmap_poster" },
  { id: "allmap-poster-02",     name: "allmap_poster_02",     pathId: "648383681900224428",   group: "allmap_poster" },
  { id: "allmap-poster-03",     name: "allmap_poster_03",     pathId: "-5904940313933730409", group: "allmap_poster" },
  { id: "allmap-poster-04",     name: "allmap_poster_04",     pathId: "2162640275009050121",  group: "allmap_poster" },
  { id: "allmap-poster-05",     name: "allmap_poster_05",     pathId: "2576055844238333366",  group: "allmap_poster" },
  { id: "allmap-poster-06",     name: "allmap_poster_06",     pathId: "2927789306244234209",  group: "allmap_poster" },
  { id: "allmap-poster-07",     name: "allmap_poster_07",     pathId: "-638345237137986373",  group: "allmap_poster" },
  { id: "allmap-poster-08",     name: "allmap_poster_08",     pathId: "5588456749834150658",  group: "allmap_poster" },
  { id: "allmap-poster-09",     name: "allmap_poster_09",     pathId: "7131439147957637527",  group: "allmap_poster" },
  { id: "allmap-trans-00",      name: "allmap_trans_00",      pathId: "-7104443787803178711", group: "allmap_trans" },
  { id: "comm-shop-icon-00",    name: "comm_shop_icon_00",    pathId: "-1804205062039693110", group: "comm_shop_icon" },
  { id: "hud-stage-00",         name: "hud_stage_00",         pathId: "-5543391192913254448", group: "hud_stage" },
  { id: "online-stage-icon-b-00", name: "online_stage_icon_b_00", pathId: "-8358818004715855530", group: "online_stage_icon_b" },
  { id: "pause-00",             name: "pause_00",             pathId: "7522214252743560409",  group: "pause" },
  { id: "result-00",            name: "result_00",            pathId: "8614660938377937639",  group: "result" },
  { id: "result-bg-00",         name: "result_bg_00",         pathId: "6172660657506005552",  group: "result_bg" },
  { id: "result-death-00",      name: "result_death_00",      pathId: "-235934533290433027",  group: "result_death" },
  { id: "shop-01",              name: "shop_01",              pathId: "-6432808294272665426", group: "shop" },
  { id: "title-00",             name: "title_00",             pathId: "569692563839820714",   group: "title" },
];

export function findHbrTextureByPathId(pathId: string): HbrTextureEntry | undefined {
  return HBR_TEXTURES.find((t) => t.pathId === pathId);
}

export function findHbrTextureByName(name: string): HbrTextureEntry | undefined {
  return HBR_TEXTURES.find((t) => t.name === name);
}
