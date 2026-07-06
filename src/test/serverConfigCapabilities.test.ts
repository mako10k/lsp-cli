import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getServerProfile } from "../servers";

test("server profile deeply merges configured clientCapabilities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-config-caps-"));
  const cfgPath = path.join(root, "lsp-cli.config.json");

  await fs.writeFile(
    cfgPath,
    JSON.stringify({
      presets: {
        base: {
          command: process.execPath,
          args: [],
          clientCapabilities: {
            workspace: {
              workspaceEdit: {
                documentChanges: true
              }
            },
            textDocument: {
              hover: {
                contentFormat: ["markdown", "plaintext"]
              },
              semanticTokens: {
                requests: {
                  range: true,
                  full: { delta: true }
                }
              }
            }
          }
        }
      },
      augment: {
        mock: {
          preset: "base",
          clientCapabilities: {
            textDocument: {
              semanticTokens: {
                requests: {
                  full: false
                }
              }
            }
          }
        }
      },
      servers: {
        mock: {
          clientCapabilities: {
            workspace: {
              workspaceEdit: {
                resourceOperations: ["create"]
              }
            },
            textDocument: {
              hover: {
                contentFormat: ["plaintext"]
              }
            }
          }
        }
      }
    }),
    "utf8"
  );

  const profile = getServerProfile("mock", root, "lsp-cli.config.json");
  const capabilities = profile.clientCapabilities as any;

  assert.equal(profile.command, process.execPath);
  assert.equal(capabilities.workspace.workspaceEdit.documentChanges, true);
  assert.deepEqual(capabilities.workspace.workspaceEdit.resourceOperations, ["create"]);
  assert.deepEqual(capabilities.textDocument.hover.contentFormat, ["plaintext"]);
  assert.equal(capabilities.textDocument.semanticTokens.requests.range, true);
  assert.equal(capabilities.textDocument.semanticTokens.requests.full, false);
});
