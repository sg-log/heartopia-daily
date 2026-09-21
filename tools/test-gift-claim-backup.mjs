import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../apps-script/gift-claim-backup.gs", import.meta.url), "utf8");

function makeHarness() {
  const rows = [];
  let sheet = null;

  function ensureSheet() {
    if (sheet) return sheet;
    sheet = {
      getLastRow() { return rows.length; },
      getMaxRows() { return Math.max(1000, rows.length); },
      appendRow(row) { rows.push(row.slice()); },
      getDataRange() {
        return { getValues: () => rows.map(row => row.slice()) };
      },
      getRange(rowIndex, columnIndex, rowCount = 1, columnCount = 1) {
        return {
          getValues() {
            const out = [];
            for (let r = 0; r < rowCount; r++) {
              const row = [];
              for (let c = 0; c < columnCount; c++) {
                row.push(rows[rowIndex - 1 + r]?.[columnIndex - 1 + c] ?? "");
              }
              out.push(row);
            }
            return out;
          },
          setValues(values) {
            for (let r = 0; r < values.length; r++) {
              while (rows.length < rowIndex + r) rows.push([]);
              const target = rows[rowIndex - 1 + r];
              for (let c = 0; c < values[r].length; c++) target[columnIndex - 1 + c] = values[r][c];
            }
          },
          setNumberFormat() {}
        };
      }
    };
    return sheet;
  }

  const spreadsheet = {
    getSheetByName() { return sheet; },
    insertSheet() { return ensureSheet(); }
  };

  const context = {
    console,
    TEXT_LIMITS: { code: 100 },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest(_algorithm, value) {
        return [...crypto.createHash("sha256").update(String(value), "utf8").digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      }
    },
    withScriptLock_: callback => callback(),
    json_: value => value
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, rows, ensureSheet };
}

const backupId = "0123456789abcdef0123456789abcdef";

test("sync creates a hashed backup without storing the raw recovery code", () => {
  const h = makeHarness();
  const result = h.context.syncGiftClaims_({
    backupId,
    claims: ["oceanguardians", "Cherish180"]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.claims), ["oceanguardians", "Cherish180"]);
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[0][0], "backupHash");
  assert.equal(h.rows[1][0].length, 64);
  assert.notEqual(h.rows[1][0], backupId);
  assert.equal(JSON.stringify(h.rows).includes(backupId), false);
});

test("sync merges existing server claims with current browser claims", () => {
  const h = makeHarness();
  h.context.syncGiftClaims_({ backupId, claims: ["codeA", "codeB"] });
  const result = h.context.syncGiftClaims_({ backupId, claims: ["codeB", "codeC"] });

  assert.deepEqual(Array.from(result.claims), ["codeA", "codeB", "codeC"]);
  assert.deepEqual(JSON.parse(h.rows[1][1]), ["codeA", "codeB", "codeC"]);
});

test("claim state endpoint adds and removes one code without deleting the rest", () => {
  const h = makeHarness();
  h.context.syncGiftClaims_({ backupId, claims: ["codeA", "codeB"] });

  let result = h.context.setGiftClaimState_({ backupId, code: "codeC", claimed: true });
  assert.deepEqual(Array.from(result.claims), ["codeA", "codeB", "codeC"]);

  result = h.context.setGiftClaimState_({ backupId, code: "codeB", claimed: false });
  assert.deepEqual(Array.from(result.claims), ["codeA", "codeC"]);
});

test("formatted HGD recovery code resolves to the same backup", () => {
  const h = makeHarness();
  h.context.syncGiftClaims_({ backupId, claims: ["codeA"] });
  const formatted = "HGD-0123-4567-89ab-cdef-0123-4567-89ab-cdef";
  const result = h.context.syncGiftClaims_({ backupId: formatted, claims: [] });
  assert.deepEqual(Array.from(result.claims), ["codeA"]);
  assert.equal(h.rows.length, 2);
});

test("invalid recovery codes are rejected", () => {
  const h = makeHarness();
  assert.throws(
    () => h.context.syncGiftClaims_({ backupId: "not-a-valid-code", claims: ["codeA"] }),
    /復元コード/
  );
});
