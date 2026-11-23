// SPDX-License-Identifier: AGPL-3.0-only
//
// AST gates for rules that a formatter cannot express. Keep this dependency
// free of product imports so it can run in CI before any build.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const MONEY_TOKENS = new Set([
  "amount",
  "balance",
  "cents",
  "credit",
  "debit",
  "denom",
  "denominator",
  "money",
  "num",
  "numerator",
  "price",
  "quantity",
  "rate",
  "subtotal",
  "sum",
]);

/** @param {string} name */
function moneyName(name) {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  return tokens.some((token) => MONEY_TOKENS.has(token));
}

/** @param {ts.Node} node */
function isNumberType(node) {
  return node != null && node.kind === ts.SyntaxKind.NumberKeyword;
}

/** @param {ts.Node} node */
function hasNumberLiteralInit(node) {
  return node != null && ts.isNumericLiteral(node);
}

/**
 * @param {string} filename
 * @param {string} source
 * @returns {Array<{ rule: string, file: string, line: number, message: string }>}
 */
export function scanSource(filename, source) {
  const normalized = filename.split("\\").join("/");
  if (
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.tsx") ||
    normalized.endsWith(".spec.ts")
  ) {
    return [];
  }

  const isClockAdapter = /(^|\/)(system-clock|clock\/|time\/)/.test(normalized);
  const isDataAccess = normalized.includes("/data-access/");

  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ES2023,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  /** @type {Array<{ rule: string, file: string, line: number, message: string }>} */
  const findings = [];

  /** @param {ts.Node} node @param {string} rule @param {string} message */
  const report = (node, rule, message) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    findings.push({ rule, file: normalized, line: line + 1, message });
  };

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (name && moneyName(name)) {
        if (isNumberType(node.type)) {
          report(node, "money-number", `money variable "${name}" is a number`);
        } else if (hasNumberLiteralInit(node.initializer)) {
          report(node, "money-number", `money variable "${name}" starts numeric`);
        }
      }
    }

    if (
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node)
    ) {
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (name && moneyName(name) && isNumberType(node.type)) {
        report(node, "money-number", `money field "${name}" is a number`);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === "Math" &&
      node.expression.name.text === "random"
    ) {
      report(node, "math-random", "use the injected Random port, not Math.random");
    }

    if (!isClockAdapter) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === "Date" &&
        node.expression.name.text === "now"
      ) {
        report(node, "direct-clock", "use the injected Clock port, not Date.now");
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Date"
      ) {
        report(node, "direct-clock", "use the injected Clock port, not new Date");
      }
    }

    if (
      !isDataAccess &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /\bdelete\s+from\b/i.test(node.text)
    ) {
      report(node, "raw-delete", "raw DELETE FROM outside /data-access/");
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}
