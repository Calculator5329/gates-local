import type { SampleDatabase } from "@gates-local/contracts";

/** `notice` is written beside the downloaded copy: this sample's own licence, never another's. */
export type PinnedSample = SampleDatabase & { readonly sha256: string; readonly notice: string };

const MIT_TEXT = `The MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const CC_BY_SA_TEXT = `Licensed under the Creative Commons Attribution-ShareAlike 4.0
International License (CC BY-SA 4.0):
https://creativecommons.org/licenses/by-sa/4.0/
`;

/** The head every notice shares: what it is, where it came from, where its licence is stated. */
const head = (label: string, repo: string, licenseUrl: string, copyright: string) =>
  `${label} sample database, downloaded unchanged from its source.
Source: ${repo}
Licence: ${licenseUrl}

${copyright}

`;

type Entry = Omit<PinnedSample, "notice"> & { readonly repo: string; readonly copyright: string; readonly text: string };
const pinned = ({ repo, copyright, text, ...sample }: Entry): PinnedSample => ({ ...sample, notice: head(sample.label, repo, sample.licenseUrl, copyright) + text });

/**
 * No network at module load. Every URL and digest is pinned to the reviewed
 * upstream commit, on GitHub's raw host, which serves it without a redirect.
 * Table counts are the pinned file's. The four questions are the shown ones;
 * all five with their SQL and answers are in sample-questions.json.
 */
export const SAMPLES: readonly PinnedSample[] = [
  pinned({
    id: "chinook", label: "Chinook", description: "Music store: artists, albums and invoices", sizeBytes: 1_007_616,
    url: "https://raw.githubusercontent.com/lerocha/chinook-database/7f67772503d71ba90f19283c38e93923addb43fa/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite",
    sha256: "7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15",
    license: "MIT · Copyright 2008–2024 Luis Rocha",
    licenseUrl: "https://github.com/lerocha/chinook-database/blob/7f67772503d71ba90f19283c38e93923addb43fa/LICENSE.md",
    repo: "https://github.com/lerocha/chinook-database/tree/7f67772503d71ba90f19283c38e93923addb43fa",
    copyright: "Copyright (c) 2008-2024 Luis Rocha", text: MIT_TEXT,
    tables: [
      { name: "Album", rows: 347 }, { name: "Artist", rows: 275 }, { name: "Customer", rows: 59 }, { name: "Employee", rows: 8 },
      { name: "Genre", rows: 25 }, { name: "Invoice", rows: 412 }, { name: "InvoiceLine", rows: 2240 }, { name: "MediaType", rows: 5 },
      { name: "Playlist", rows: 18 }, { name: "PlaylistTrack", rows: 8715 }, { name: "Track", rows: 3503 },
    ],
    questions: [
      "What is the longest track in the store?",
      "Which countries spend the most money with us?",
      "How did sales change from year to year?",
      "Which five artists have earned the most from sales?",
    ],
  }),
  pinned({
    id: "northwind", label: "Northwind", description: "Orders, customers, products and suppliers", sizeBytes: 24_702_976,
    url: "https://raw.githubusercontent.com/jpwhite3/northwind-SQLite3/4f56e7f5906dfd23b25244c5bfe8fb5da6402efd/dist/northwind.db",
    sha256: "2f4f5c68dfcd33ba27373eae48c7a4869800c68095ee0f9f0da494f83382a877",
    license: "MIT · Copyright 2016 JP White",
    licenseUrl: "https://github.com/jpwhite3/northwind-SQLite3/blob/4f56e7f5906dfd23b25244c5bfe8fb5da6402efd/LICENSE",
    repo: "https://github.com/jpwhite3/northwind-SQLite3/tree/4f56e7f5906dfd23b25244c5bfe8fb5da6402efd",
    copyright: "Copyright (c) 2016 JP White", text: MIT_TEXT,
    tables: [
      { name: "Categories", rows: 8 }, { name: "CustomerCustomerDemo", rows: 0 }, { name: "CustomerDemographics", rows: 0 }, { name: "Customers", rows: 93 },
      { name: "EmployeeTerritories", rows: 49 }, { name: "Employees", rows: 9 }, { name: "Order Details", rows: 609_283 }, { name: "Orders", rows: 16_282 },
      { name: "Products", rows: 77 }, { name: "Regions", rows: 4 }, { name: "Shippers", rows: 3 }, { name: "Suppliers", rows: 29 }, { name: "Territories", rows: 53 },
    ],
    questions: [
      "What is our most expensive product?",
      "Who are our five biggest customers by spending?",
      "How has revenue changed from year to year?",
      "Which product category brings in the most revenue?",
    ],
  }),
  pinned({
    id: "worldcup", label: "World Cup", description: "Every FIFA World Cup: matches, goals and players", sizeBytes: 7_917_568,
    url: "https://raw.githubusercontent.com/jfjelstul/worldcup/35a8667f518b07469182ae16d35574dd0e7a00fb/data-sqlite/worldcup.db",
    sha256: "080f60bec8fde7f85f8b11d3f7a231e0af9122619a1b00920233eb9c63b0ab70",
    license: "CC BY-SA 4.0 · © 2023 Joshua C. Fjelstul, Ph.D.",
    // The repository states its licence in the README; it has no LICENSE file.
    licenseUrl: "https://github.com/jfjelstul/worldcup/blob/35a8667f518b07469182ae16d35574dd0e7a00fb/README.md#the-license",
    repo: "https://github.com/jfjelstul/worldcup/tree/35a8667f518b07469182ae16d35574dd0e7a00fb",
    copyright: "© 2023 Joshua C. Fjelstul, Ph.D.", text: CC_BY_SA_TEXT,
    tables: [
      { name: "award_winners", rows: 200 }, { name: "awards", rows: 8 }, { name: "bookings", rows: 3178 }, { name: "confederations", rows: 6 },
      { name: "goals", rows: 3637 }, { name: "group_standings", rows: 626 }, { name: "groups", rows: 159 }, { name: "host_countries", rows: 31 },
      { name: "manager_appearances", rows: 2538 }, { name: "manager_appointments", rows: 637 }, { name: "managers", rows: 475 }, { name: "matches", rows: 1248 },
      { name: "penalty_kicks", rows: 396 }, { name: "player_appearances", rows: 27_432 }, { name: "players", rows: 10_401 }, { name: "qualified_teams", rows: 625 },
      { name: "referee_appearances", rows: 1248 }, { name: "referee_appointments", rows: 668 }, { name: "referees", rows: 493 }, { name: "squads", rows: 13_843 },
      { name: "stadiums", rows: 240 }, { name: "substitutions", rows: 10_222 }, { name: "team_appearances", rows: 2496 }, { name: "teams", rows: 88 },
      { name: "tournament_stages", rows: 155 }, { name: "tournament_standings", rows: 120 }, { name: "tournaments", rows: 30 },
    ],
    questions: [
      "What was the score in the 2014 men's World Cup final?",
      "Which countries have won the men's World Cup most often?",
      "Have men's World Cups got lower scoring over the years?",
      "Which managers have won the most World Cup matches?",
    ],
  }),
  pinned({
    id: "elements", label: "Periodic table", description: "All 118 elements with isotopes and properties", sizeBytes: 3_149_824,
    url: "https://raw.githubusercontent.com/lmmentel/mendeleev/bd4716bff94c7acf22210d6ffb75dbd1fcc4f9bc/mendeleev/elements.db",
    sha256: "8a6312b57603e22c58ab28005bb8cacfbff721bc859eea8ddc2b784c17ffd717",
    license: "MIT · Copyright 2015 Lukasz Mentel",
    licenseUrl: "https://github.com/lmmentel/mendeleev/blob/bd4716bff94c7acf22210d6ffb75dbd1fcc4f9bc/LICENSE",
    repo: "https://github.com/lmmentel/mendeleev/tree/bd4716bff94c7acf22210d6ffb75dbd1fcc4f9bc",
    copyright: "Copyright (c) 2015 Lukasz Mentel", text: MIT_TEXT,
    tables: [
      { name: "alembic_version", rows: 1 }, { name: "elements", rows: 118 }, { name: "groups", rows: 18 }, { name: "ionicradii", rows: 507 },
      { name: "ionizationenergies", rows: 5847 }, { name: "isotopedecaymodes", rows: 5783 }, { name: "isotopes", rows: 3557 }, { name: "oxidationstates", rows: 601 },
      { name: "phasetransitions", rows: 107 }, { name: "propertymetadata", rows: 182 }, { name: "scattering_factors", rows: 50_038 }, { name: "screeningconstants", rows: 811 },
      { name: "series", rows: 10 },
    ],
    questions: [
      "What is the melting point of tungsten?",
      "Which elements cost the most per kilogram?",
      "How many elements were discovered in each century?",
      "Which family of elements has the most known isotopes?",
    ],
  }),
];
