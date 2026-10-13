import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

const localCalls = {
  "parameter.cjs":
    'function run(require) { return require("./ghost.cjs"); } console.log(run(() => "local"));',
  "catch.cjs":
    'try { throw () => "local"; } catch (require) { console.log(require?.("./ghost.cjs")); }',
  "function.cjs":
    'function require() { return "local"; } console.log(require("./ghost.cjs"));',
  "block.cjs":
    '{ const require = () => "local"; console.log(require("./ghost.cjs")); }',
  "lexical.mjs":
    'let require = () => "local"; console.log(require("./ghost.cjs"));',
  "opaque.mjs":
    'function configure() { return () => "local"; } const require = configure(); console.log(require("./ghost.cjs"));',
};
const loaderCalls = {
  "ordinary.cjs": 'console.log(require("./loaded.cjs"));',
  "optional.cjs": 'console.log(require?.("./loaded.cjs"));',
  "wrapper-var.cjs": 'var require; console.log(require("./loaded.cjs"));',
  "before-write.cjs":
    'console.log(require?.("./loaded.cjs")); require = () => "local";',
  "computed-object.cjs":
    'const value = { [require?.("./loaded.cjs")](require) {} }; require = () => "local"; console.log(Object.keys(value)[0]);',
  "computed-class.cjs":
    'class Example { [require?.("./loaded.cjs")](require) {} } require = () => "local"; console.log(Object.getOwnPropertyNames(Example.prototype)[1]);',
  "factory.mjs":
    'import {createRequire} from "node:module"; const require = createRequire(import.meta.url); console.log(require("./loaded.cjs"));',
  "typed-factory.mts":
    'import {createRequire as make} from "node:module"; const require = make(import.meta.url) as NodeRequire; console.log(require("./loaded.cjs"));',
  "namespace.mts":
    'import * as modules from "node:module"; const require = modules.createRequire(import.meta.url) satisfies NodeRequire; console.log(require("./loaded.cjs"));',
  "factory-alias.mjs":
    'import modules from "node:module"; const make = modules.createRequire; const require = make(import.meta.url); console.log(require("./loaded.cjs"));',
};
const uncertainLoaders = {
  "caller-loader.cjs":
    'function run(require) { return require("./loaded.cjs"); } console.log(run(require));',
  "dynamic-factory.mjs":
    'import * as modules from "node:module"; const key = "createRequire"; const require = modules[key](import.meta.url); console.log(require("./loaded.cjs"));',
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains require-call evidence without inventing bound dependencies through %s",
  { timeout: 60_000 },
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-require-evidence-");
    const files = {
      ...localCalls,
      ...loaderCalls,
      ...uncertainLoaders,
      "loaded.cjs": 'module.exports = "loaded";',
      "ghost.cjs": 'throw new Error("Local calls must not load this file");',
    };
    await Promise.all(
      Object.entries(files).map(([path, text]) =>
        writeFile(join(root, path), text),
      ),
    );
    for (const [cases, value] of [
      [localCalls, "local"],
      [loaderCalls, "loaded"],
      [uncertainLoaders, "loaded"],
    ] as const)
      for (const path of Object.keys(cases)) {
        const result = await promisify(execFile)(
          process.execPath,
          [join(root, path)],
          { timeout: 5000 },
        );
        expect(result.stdout).toBe(`${value}\n`);
      }
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    const calls = result.graph.edges.filter(
      ({ properties }) => properties.kind === "require",
    );
    const sourceOf = (edge: (typeof calls)[number]) => {
      const location = edge.evidence.location;
      return location.available && location.value.kind === "source-range"
        ? location.value.source
        : null;
    };
    expect(
      calls
        .filter(({ properties }) => properties.resolved_path === "ghost.cjs")
        .map(sourceOf),
    ).toEqual([]);
    expect(
      calls
        .filter(({ properties }) => properties.resolved_path === "loaded.cjs")
        .map(sourceOf)
        .sort(),
    ).toEqual(Object.keys(loaderCalls).sort());
    const unresolved = calls.filter(
      ({ properties }) => properties.specifier === null,
    );
    expect(unresolved.map(sourceOf).sort()).toEqual(
      [...Object.keys(localCalls), ...Object.keys(uncertainLoaders)].sort(),
    );
    for (const edge of unresolved) {
      expect(edge.properties.expression).toContain(
        Object.hasOwn(uncertainLoaders, sourceOf(edge) ?? "")
          ? '"./loaded.cjs"'
          : '"./ghost.cjs"',
      );
      expect(edge.properties.resolved_path).toBeNull();
      expect(
        result.graph.nodes.find(
          ({ node_id }) => node_id === edge.target_node_id,
        )?.observations[0],
      ).toMatchObject({
        properties: { resolution: "unresolved" },
        evidence: { confidence: "low" },
      });
    }
  },
);
