import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

// ---------------------------------------------------------------------------
// Activation proof: drive the extension through pm's REAL registration
// validation and activation engine via createExtensionTestHarness, so a host
// rejection (e.g. a host-owned flag collision that aborts command registration)
// fails this suite instead of staying green against a hand-rolled api double.
// ---------------------------------------------------------------------------

let harness: ExtensionTestHarness;

test("extension activates cleanly and registers the gantt command, exporter, and preflight gate", async () => {
  harness = await createExtensionTestHarness(extension, {
    name: "pm-gantt-chart",
    capabilities: ["commands", "schema", "importers", "preflight"],
  });
  assert.deepEqual(harness.activation.failed, [], "activation must not fail");
  harness.assertCommandContract({ command: "gantt" });
  harness.assertExporter({ exporter: "gantt" });
  harness.assertPreflightOverride();
});