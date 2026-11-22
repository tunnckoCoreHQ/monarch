// SPDX-License-Identifier: Apache-2.0

import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { implement, zagora } from "../src/index";
import type { Implemented } from "../src/types";

const planet = z.object({ id: z.number(), name: z.string() });

const contract = {
  planet: {
    list: zagora()
      .input(z.tuple([z.number(), z.number()]))
      .output(z.array(planet)),
    find: zagora().input(z.number()).output(planet),
    create: zagora().input(planet).output(planet),
  },
};

const list = contract.planet.list
  .handler((_, limit, offset) => [{ id: limit + offset, name: "Earth" }])
  .callable();

const find = contract.planet.find.handler((_, id) => ({ id, name: "Mars" })).callable();

const create = contract.planet.create.handler((_, input) => input).callable();

const listByName = zagora()
  .input(z.tuple([z.string(), z.string()]))
  .output(z.array(planet))
  .handler((_, first, second) => [{ id: 1, name: first + second }])
  .callable();

const findByName = zagora()
  .input(z.string())
  .output(planet)
  .handler((_, name) => ({ id: 1, name }))
  .callable();

const createFromTitle = zagora()
  .input(z.object({ title: z.string() }))
  .output(planet)
  .handler((_, { title }) => ({ id: 1, name: title }))
  .callable();

test("implement returns the router with each procedure's exact type", () => {
  const router = implement(contract, { planet: { list, find, create } });

  expect(router.planet.find).toBe(find);
  expectTypeOf(router.planet.list).toEqualTypeOf<typeof list>();
  expectTypeOf(router.planet.find).toEqualTypeOf<typeof find>();
  expectTypeOf(router.planet.create).toEqualTypeOf<typeof create>();

  const found = router.planet.find(4);
  expect(found).toMatchObject({ ok: true, data: { id: 4, name: "Mars" } });
  if (found.ok) {
    expectTypeOf(found.data).toEqualTypeOf<{ id: number; name: string }>();
  }

  const listed = router.planet.list(1, 2);
  expect(listed).toMatchObject({ ok: true, data: [{ id: 3, name: "Earth" }] });
  if (listed.ok) {
    expectTypeOf(listed.data).toEqualTypeOf<Array<{ id: number; name: string }>>();
  }
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

test("a procedure whose input differs from the contract does not compile", () => {
  // @ts-expect-error - list takes two numbers, not two strings
  implement(contract, { planet: { list: listByName, find, create } });
  // @ts-expect-error - find takes a number, not a string
  implement(contract, { planet: { list, find: findByName, create } });
  // @ts-expect-error - create takes a planet, not a title
  implement(contract, { planet: { list, find, create: createFromTitle } });

  const wrongList = {
    // @ts-expect-error - list takes two numbers, not two strings
    planet: { list: listByName, find, create },
  } satisfies Implemented<typeof contract>;
  const wrongFind = {
    // @ts-expect-error - find takes a number, not a string
    planet: { list, find: findByName, create },
  } satisfies Implemented<typeof contract>;
  const wrongCreate = {
    // @ts-expect-error - create takes a planet, not a title
    planet: { list, find, create: createFromTitle },
  } satisfies Implemented<typeof contract>;

  expect(wrongList.planet.list).toBe(listByName);
  expect(wrongFind.planet.find).toBe(findByName);
  expect(wrongCreate.planet.create).toBe(createFromTitle);
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
