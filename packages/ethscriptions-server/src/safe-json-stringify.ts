const originalStringify = JSON.stringify.bind(JSON);

type Replacer = (this: unknown, key: string, value: unknown) => unknown;

function bigIntToNumber(value: unknown): unknown {
  if (typeof value !== "bigint") {
    return value;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    console.warn("BigInt too large for safe Number; precision may be lost");
  }

  return Number(value);
}

function stringify(
  value: unknown,
  replacer?: Replacer | Array<string | number> | null,
  space?: string | number,
): string {
  if (typeof replacer === "function") {
    return originalStringify(
      value,
      function combined(this: unknown, key: string, item: unknown) {
        return bigIntToNumber(replacer.call(this, key, item));
      },
      space,
    );
  }

  if (Array.isArray(replacer)) {
    // The root value has the empty key and is always kept, as the spec says.
    const allowed = new Set(replacer.map(String));
    return originalStringify(
      value,
      (key, item) => (key === "" || allowed.has(key) ? bigIntToNumber(item) : undefined),
      space,
    );
  }

  return originalStringify(value, (_key, item) => bigIntToNumber(item), space);
}

// A JSON.stringify that writes BigInt values as numbers instead of throwing.
export function createBigIntToNumberStringify(): typeof JSON.stringify {
  return stringify;
}
