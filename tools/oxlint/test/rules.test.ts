import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vite-plus/test";
import antiSlop from "../anti-slop/index";
import antiSlopEffect from "../anti-slop/effect/index";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const examples = [
  [
    "no-chained-type-assertions",
    "const value = 'ok' as const;",
    "const value = input as unknown as string;",
  ],
  [
    "no-conditional-empty-object-spread",
    "const value = { ...input };",
    "const value = { ...(ok ? { id: 1 } : {}) };",
  ],
  [
    "no-known-value-widening",
    "const value = { id: 1 };",
    "const value: Record<string, unknown> = { id: 1 };",
  ],
  [
    "no-module-mocking",
    "vi.spyOn(store, 'save');",
    "import { vi } from 'vite-plus/test'; vi.mock('./store');",
  ],
  [
    "no-object-parameters",
    "function save(value: { id: string }) {}",
    "type Input = object; function save(value: Input) {}",
  ],
  ["no-reflect-apply", "save(value);", "Reflect.apply(save, null, [value]);"],
  ["no-reflect-get", "value.id;", "Reflect.get(value, 'id');"],
  ["no-runtime-typeof", "typeof missing === 'undefined';", "typeof value === 'string';"],
  ["no-shape-in-symbol-names", "const payload = 1;", "const reshape = 1;"],
  ["no-unknown-parameters", "function save(value: string) {}", "function save(value: unknown) {}"],
  [
    "no-unknown-returns",
    "function load(): string { return 'ok'; }",
    "type Result = unknown; function load(): Promise<Result> { return Promise.resolve(null); }",
  ],
  ["no-unknown-type-aliases", "type Id = string;", "type Id = unknown;"],
  [
    "no-unsafe-dictionary-type",
    "type Values = Record<string, string>;",
    "type Values = Record<string, unknown>;",
  ],
  [
    "no-widen-then-assert",
    "const source = { id: 'a' }; const widened: unknown = source;",
    "const source = { id: 'a' }; const widened: unknown = source; const parsed = widened as { id: string };",
  ],
  [
    "require-safety-comment-for-type-assertion",
    "// SAFETY: The caller checked the string.\nconst value = input as string;",
    "const value = input as string;",
  ],
] as const;

for (const [name, valid, invalid] of examples) {
  tester.run(`anti-slop/${name}`, antiSlop.rules[name], {
    valid: [valid],
    invalid: [{ code: invalid, errors: 1 }],
  });
}

tester.run("anti-slop/no-module-mocking imports", antiSlop.rules["no-module-mocking"], {
  valid: [
    "const vi = { mock() {} }; vi.mock();",
    "import { vi } from './helper'; vi.mock();",
    "import { vi } from 'vite-plus/test'; vi.spyOn(store, 'save');",
  ],
  invalid: [
    {
      code: "import { vi as testing } from 'vite-plus/test'; testing['doMock']('./store');",
      errors: 1,
    },
    { code: "import { vi } from 'vitest'; vi.mock('./store');", errors: 1 },
    {
      code: "import { jest } from '@jest/globals'; jest.unstable_mockModule('./store');",
      errors: 1,
    },
  ],
});

tester.run("anti-slop/no-runtime-typeof options", antiSlop.rules["no-runtime-typeof"], {
  valid: [
    {
      code: "function isString(value: unknown): value is string { return typeof value === 'string'; }",
      options: [{ allowInTypeGuards: true }],
    },
  ],
  invalid: [
    {
      code: "function isString(value: unknown): value is string { return typeof value === 'string'; }",
      errors: 1,
    },
  ],
});

tester.run(
  "anti-slop-effect/no-service-constructor-imports",
  antiSlopEffect.rules["no-service-constructor-imports"],
  {
    valid: [
      { filename: "service.test.ts", code: "import { makeStore } from './store';" },
      { filename: "service.spec.ts", code: "import { makeStore } from './store';" },
      { filename: "service.ts", code: "import { StoreLive } from './store';" },
      { filename: "service.ts", code: "import { makeStore } from '@app/store';" },
    ],
    invalid: [
      { filename: "service.ts", code: "import { makeStore as create } from './store';", errors: 1 },
    ],
  },
);
