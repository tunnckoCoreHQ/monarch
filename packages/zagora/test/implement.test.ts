// SPDX-License-Identifier: Apache-2.0

import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { implement, zagora } from "../src/index";
import type { Implemented } from "../src/types";

const planet = z.object({ id: z.number(), name: z.string() });

const contract = {
  planet: {
    list: zagora().input(z.tuple([z.number(), z.number()])),
    find: zagora().input(z.number()),
    create: zagora().input(planet),
  },
};

const list = zagora()
  .input(z.tuple([z.number(), z.number()]))
  .output(z.array(planet))
  .handler((_, limit, offset) => [{ id: limit + offset, name: "Earth" }])
  .callable();

const find = zagora()
  .input(z.number())
  .output(planet)
  .handler((_, id) => ({ id, name: "Mars" }))
  .callable();

const create = zagora()
  .input(planet)
  .output(planet)
  .handler((_, input) => input)
  .callable();

test("implement returns the router with each procedure's exact type", () => {
  const router = implement(contract, { planet: { list, find, create } });

  expect(router.planet.find).toBe(find);
  expectTypeOf(router.planet.list).toEqualTypeOf<typeof list>();
  expectTypeOf(router.planet.find).toEqualTypeOf<typeof find>();
  expectTypeOf(router.planet.create).toEqualTypeOf<typeof create>();
});

test("a router with a missing procedure does not compile", () => {
  // @ts-expect-error - create is missing
  implement(contract, { planet: { list, find } });

  const router = {
    // @ts-expect-error - create is missing
    planet: { list, find },
  } satisfies Implemented<typeof contract>;

  expect(router.planet.find).toBe(find);
});

test("a procedure with mismatched parameters does not compile", () => {
  // @ts-expect-error - find takes a number, not a planet
  implement(contract, { planet: { list, find: create, create } });

  const router = {
    // @ts-expect-error - find takes a number, not a planet
    planet: { list, find: create, create },
  } satisfies Implemented<typeof contract>;

  expect(router.planet.find).toBe(create);
});

test("an extra key at the top level does not compile", () => {
  // @ts-expect-error - star is not in the contract
  implement(contract, { planet: { list, find, create }, star: find });

  const router = {
    planet: { list, find, create },
    // @ts-expect-error - star is not in the contract
    star: find,
  } satisfies Implemented<typeof contract>;

  expect(router.star).toBe(find);
});

test("an extra procedure inside a nested group does not compile", () => {
  // @ts-expect-error - remove is not in the contract
  implement(contract, { planet: { list, find, create, remove: find } });

  const router = {
    // @ts-expect-error - remove is not in the contract
    planet: { list, find, create, remove: find },
  } satisfies Implemented<typeof contract>;

  expect(router.planet.remove).toBe(find);
});
