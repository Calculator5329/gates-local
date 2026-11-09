import type { SampleDatabase } from "@gates-local/contracts";

export type PinnedSample = SampleDatabase & { readonly sha256: string };
export const SAMPLE_LICENSE = `Chinook: Copyright (c) 2008-2024 Luis Rocha
Northwind: Copyright (c) 2016 JP White

The MIT License

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
/** No network at module load. Every URL and digest is pinned to the reviewed upstream commit. */
export const SAMPLES: readonly PinnedSample[] = [
  {
    id: "chinook", label: "Chinook", description: "Music store: artists, albums and invoices", sizeBytes: 1_007_616,
    url: "https://raw.githubusercontent.com/lerocha/chinook-database/7f67772503d71ba90f19283c38e93923addb43fa/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite",
    sha256: "7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15",
    license: "MIT · Copyright 2008–2024 Luis Rocha",
    licenseUrl: "https://github.com/lerocha/chinook-database/blob/7f67772503d71ba90f19283c38e93923addb43fa/LICENSE.md",
  },
  {
    id: "northwind", label: "Northwind", description: "Orders, customers, products and suppliers", sizeBytes: 24_702_976,
    url: "https://raw.githubusercontent.com/jpwhite3/northwind-SQLite3/4f56e7f5906dfd23b25244c5bfe8fb5da6402efd/dist/northwind.db",
    sha256: "2f4f5c68dfcd33ba27373eae48c7a4869800c68095ee0f9f0da494f83382a877",
    license: "MIT · Copyright 2016 JP White",
    licenseUrl: "https://github.com/jpwhite3/northwind-SQLite3/blob/4f56e7f5906dfd23b25244c5bfe8fb5da6402efd/LICENSE",
  },
];
