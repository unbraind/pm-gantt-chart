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

test("the derived gantt export command registers every documented flag", () => {
  const commandFlags = harness.activation.registrations.flags.find(
    (registration) => registration.target_command === "gantt",
  );
  const exporterFlags = harness.activation.registrations.flags.find(
    (registration) => registration.target_command === "gantt export",
  );
  assert.ok(commandFlags, "gantt must register its shaping flags");
  assert.ok(exporterFlags, "gantt export must register its own flag contract");
  assert.deepEqual(
    exporterFlags.flags.map((flag) => flag.long).sort(),
    [
      ...commandFlags.flags.map((flag) => flag.long),
      "--format",
      "--output",
    ].sort(),
    "the exporter must inherit every shared shaping flag and add its artifact flags",
  );
});

test("preflight override is scoped to pm-gantt-chart's owned command paths", async () => {
  // The override MUST register as a scoped object (commands + run), not a bare
  // function: a global (unscoped) override collides pairwise with every other
  // installed package's preflight override (pm health reports
  // extension_preflight_override_collision). The runtime matches a command
  // against `commands` by exact normalized path, so the array lists every
  // command path pm-gantt-chart owns (`gantt` plus the `gantt export` alias
  // the runtime derives from the exporter registration).
  const override = harness.assertPreflightOverride();
  assert.deepEqual(
    override.commands,
    ["gantt", "gantt export"],
    "preflight override must be scoped to exactly pm-gantt-chart's owned command paths",
  );
  assert.equal(
    typeof override.run,
    "function",
    "scoped preflight override must expose a run function",
  );
  // Bind the scope to the commands pm-gantt-chart actually registers, in BOTH
  // directions. This override is advertisement-only (empty delta; the real
  // data-sanity gate is runDataSanityGate, called directly by the handlers),
  // so a command drifting in or out of the scope changes no enforcement today —
  // which is exactly why nothing would notice. These assertions make the drift
  // visible: registering a command without a scope entry (or a scope entry
  // without a command) fails here and forces a conscious decision.
  const registeredCommands = harness.activation.registrations.commands
    .map((command) => command.command)
    .sort();
  assert.deepEqual(
    [...(override.commands ?? [])].sort(),
    registeredCommands,
    "preflight scope must list exactly the commands pm-gantt-chart registers",
  );
  for (const command of override.commands ?? []) {
    harness.assertCommandContract({ command });
  }
  // The exporter alias `gantt export` is IN the scope on purpose: the runtime
  // derives it as a registered command from the exporter registration, and the
  // previously-global override covered it by accident. Its data-sanity gate is
  // the direct runDataSanityGate call in the exporter handler (pinned by the
  // exporter data-sanity handler tests); the scope entry keeps the alias inside
  // the override the moment it ever gains enforcement.
  harness.assertExporter({ exporter: "gantt" });
  assert.ok(
    (override.commands ?? []).includes("gantt export"),
    "the gantt export alias must stay inside the preflight scope",
  );
  // The advertisement stays honest: invoked for the scoped command the
  // override is a pure pass-through — applied, empty delta, zero warnings.
  const res = await harness.runPreflightOverride({
    command: "gantt",
    args: [],
    options: {},
    global: {},
    pm_root: process.cwd(),
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  });
  assert.equal(res.overridden, true, "override was applied for the owned command");
  assert.deepEqual(res.warnings, [], "no warnings from empty delta");
});
