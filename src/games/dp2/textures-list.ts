// Список текстур DP2 для редагування. Додавай нові записи сюди — UI
// автоматично підхопить. assetsRelPath шукається у тій самій теці, що й
// settings.assetsPath (зазвичай …\DeadlyPremonition2_Data\).
//
// Формат запису:
//   id           — стабільний id для іконки/збереження прев'ю
//   name         — m_Name з Unity-ассета (буде проставлено у PNG-імені)
//   pathId       — PathID у відповідному .assets
//   assetsFile   — ім'я .assets файла, в якому лежить текстура (без шляху)
//   group        — категорія для UI (англомовний короткий лейбл)

export interface TextureEntry {
  id: string;
  name: string;
  pathId: number;
  assetsFile: string;
  group?: string;
}

export const DP2_TEXTURES: TextureEntry[] = [
  // Дві стартові текстури від користувача
  {
    id: "francis-zach-morgan",
    name: "FrancisZachMorgan",
    pathId: 4175,
    assetsFile: "resources.assets",
    group: "Characters",
  },
  {
    id: "francis-york-morgan",
    name: "FrancisYorkMorgan",
    pathId: 4352,
    assetsFile: "resources.assets",
    group: "Characters",
  },
  { id: "aaliyah-davis", name: "AaliyahDavis", pathId: 4990, assetsFile: "resources.assets", group: "Characters" },
  { id: "professor-r", name: "ProfessorR", pathId: 2366, assetsFile: "resources.assets", group: "Characters" },
  { id: "simon-jones", name: "SimonJones", pathId: 5157, assetsFile: "resources.assets", group: "Characters" },
  { id: "melvin-woods", name: "MelvinWoods", pathId: 3515, assetsFile: "resources.assets", group: "Characters" },
  { id: "david-jawara-concierge", name: "DavidJawara_Concierge", pathId: 4671, assetsFile: "resources.assets", group: "Characters" },
  { id: "david-jawara-chef", name: "DavidJawara_Chef", pathId: 5412, assetsFile: "resources.assets", group: "Characters" },
  { id: "david-jawara-bellboy", name: "DavidJawara_Bellboy", pathId: 5452, assetsFile: "resources.assets", group: "Characters" },
  { id: "alexus-jawara", name: "AlexusJawara", pathId: 4091, assetsFile: "resources.assets", group: "Characters" },
  { id: "patricia-woods", name: "PatriciaWoods", pathId: 4225, assetsFile: "resources.assets", group: "Characters" },
  { id: "raven-yahoo", name: "RavenYahoo", pathId: 3047, assetsFile: "resources.assets", group: "Characters" },
  { id: "mrs-carpenter", name: "MrsCarpenter", pathId: 5381, assetsFile: "resources.assets", group: "Characters" },
  { id: "galena-clarkson", name: "GalenaClarkson", pathId: 2948, assetsFile: "resources.assets", group: "Characters" },
  { id: "danie-clarkson", name: "DanieClarkson", pathId: 3032, assetsFile: "resources.assets", group: "Characters" },
  { id: "lewis-gravekeeper", name: "Lewis_the_Gravekeeper", pathId: 3876, assetsFile: "resources.assets", group: "Characters" },
  { id: "emma-sanders", name: "EmmaSanders", pathId: 2603, assetsFile: "resources.assets", group: "Characters" },
  { id: "tyrone-sanders", name: "TyroneSanders", pathId: 5497, assetsFile: "resources.assets", group: "Characters" },
  { id: "pj-clarkson-psd", name: "PJClarksonpsd", pathId: 5539, assetsFile: "resources.assets", group: "Characters" },
  { id: "the-mirror", name: "TheMirror", pathId: 3167, assetsFile: "resources.assets", group: "Characters" },
];

/** Зручний пошук за pathId. */
export function findTextureByPathId(pathId: number): TextureEntry | undefined {
  return DP2_TEXTURES.find((t) => t.pathId === pathId);
}
