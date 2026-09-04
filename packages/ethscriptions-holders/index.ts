// Collects unique holder addresses of ethscriptions collections from the
// Blockscout instance at explorer.ethscriptions.com, per collection and
// combined. Run with: bun run index.ts

const API = "https://explorer.ethscriptions.com/api/v2";

// slug -> Blockscout token address (resolved via /api/v2/tokens?q=...)
const COLLECTIONS = {
  "0xneko-cats": "0xd76cdF03dC30CC67a4000410f57e1db14D75E4a3",
  mfpurrs: "0xBCaC1c9C9848a47F6a49E886eC66E81A859b47Fa",
  moonbirds: "0xDdc91052d6AcD9f35f2301dC347Ed66f7585d83a",
  nakamingos: "0x531483D65EB7B75B5AdfC3331f301A836A0Eb3Bb",
  ittybits: "0x3dd192167111C7f5668C887519d7Ea8B000C8a50",
  "ethereum-phunks": "0x8D919A0f3BF23a38a2679E4735390d883436c7Bb",
  "call-data-comrades": "0xBB41E24dA83DcAb001bd085879c66cFCB4eED522",
  "comrades-of-the-dead": "0x4C276E1b53C34E2fC659d76b091e54a8501F4c96",
  "the-darwins": "0x4b3172108616C439ef1Ba9B1A18d0AB4b9844362",
  "indelible-apes": "0x82F2511A38F44B3C8286F616407aEAf4d1fFb1fE",
} as const;

// Marketplace escrow contracts. They show up as "holders" but the real owner
// is the seller who deposited the item — resolved from transfer history below.
const MARKETS: Record<string, string> = {
  "mfpurrs-market": "0xe6A0939270D6998f74C23DD355AfAa679A974e9F",
  "etherphunks-market": "0xD3418772623Be1a3cc6B6D45CB46420CEdD9154a",
  "ethscriptions-market-v3": "0xD729A94d6366a4fEac4A6869C8b3573cEe4701A9",
  "ittybits-market": "0xa8Ee53258865c55a521727127D8a64c414163D36",
};

// Ordex and Etch escrows — defunct, items are effectively burned. Dropped, not resolved.
const BURNED = [
  "0xC33F8610941bE56fB0d84E25894C0d928CC97ddE", // Ordex
  "0x57b8792c775D34Aa96092400983c3e112fCbC296", // Etch
].map((a) => a.toLowerCase());

const MARKET_ADDRS = new Set([...BURNED, ...Object.values(MARKETS).map((a) => a.toLowerCase())]);

type Page<T> = {
  items: T[];
  next_page_params: Record<string, string | number> | null;
};

type Holder = { address: { hash: string } };
type Transfer = {
  from: { hash: string };
  to: { hash: string };
  total: { token_id: string | null };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<Page<T>> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      return res.json();
    }
    if (attempt >= 8) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    await sleep(retryAfter || (res.status === 429 ? 5000 : attempt * 1000));
  }
}

async function* paginate<T>(path: string, init: Record<string, string> = {}): AsyncGenerator<T> {
  let params: Record<string, string | number> | null = init;

  while (params) {
    const qs = new URLSearchParams(
      Object.entries({ ...init, ...params }).map(([k, v]) => [k, String(v)]),
    );
    const page = await getJson<T>(`${API}${path}?${qs}`);
    yield* page.items;
    params = page.next_page_params;
    await sleep(300);
  }
}

async function collectHolders(token: string): Promise<Set<string>> {
  const holders = new Set<string>();
  for await (const { address } of paginate<Holder>(`/tokens/${token}/holders`)) {
    holders.add(address.hash.toLowerCase());
  }
  return holders;
}

// Walks the market's transfer history for one collection, newest first. The
// first sighting of a token_id is its current state: an inbound transfer means
// the item is still escrowed and `from` is the seller (real owner).
async function collectSellers(market: string, token: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const sellers = new Set<string>();

  for await (const t of paginate<Transfer>(`/addresses/${market}/token-transfers`, { token })) {
    const id = t.total.token_id;
    if (id == null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (t.to.hash.toLowerCase() === market.toLowerCase()) {
      sellers.add(t.from.hash.toLowerCase());
    }
  }

  return sellers;
}

const outDir = new URL(`./data/${new Date().toISOString().slice(0, 10)}/`, import.meta.url)
  .pathname;
const all = new Set<string>();

function writeList(name: string, addrs: Set<string>) {
  return Bun.write(`${outDir}${name}.txt`, [...addrs].join("\n") + "\n");
}

for (const [slug, token] of Object.entries(COLLECTIONS)) {
  const holders = await collectHolders(token);
  for (const addr of BURNED) {
    holders.delete(addr);
  }

  for (const [marketName, market] of Object.entries(MARKETS)) {
    if (!holders.delete(market.toLowerCase())) {
      continue;
    }
    const sellers = await collectSellers(market, token);
    for (const addr of sellers) {
      if (!MARKET_ADDRS.has(addr)) {
        holders.add(addr);
      }
    }
    console.log(`  ${slug} via ${marketName}: ${sellers.size} sellers`);
  }

  for (const addr of holders) {
    all.add(addr);
  }
  await writeList(slug, holders);
  console.log(`${slug}: ${holders.size} holders`);
}

await writeList("all", all);
console.log(`total unique across collections: ${all.size}`);
