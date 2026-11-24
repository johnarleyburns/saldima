// SPDX-License-Identifier: AGPL-3.0-only

import type { BookSnapshot, SnapshotAccount } from "./book-file";

const GUID = /^[0-9a-f]{32}$/;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function hash32(value: string, seed: number): string {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Deterministic 32-hex ids for exports that lack a stored split id. */
function derivedGuid(value: string): string {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hash32(value, seed))
    .join("");
}

function accountXml(
  account: SnapshotAccount,
  currency: string,
  fraction: number,
): string {
  const commodity =
    account.type === "ROOT"
      ? ""
      : `\n  <act:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>${escapeXml(account.commodityCode ?? currency)}</cmdty:id></act:commodity>\n  <act:commodity-scu>${fraction}</act:commodity-scu>`;
  const parent = account.parentGuid
    ? `\n  <act:parent type="guid">${escapeXml(account.parentGuid)}</act:parent>`
    : "";
  const slots: string[] = [];
  if (account.placeholder) slots.push(slot("placeholder"));
  if (account.hidden) slots.push(slot("hidden"));
  const slotBlock =
    slots.length > 0 ? `\n  <act:slots>${slots.join("")}</act:slots>` : "";
  return `<gnc:account version="2.0.0">
  <act:name>${escapeXml(account.name)}</act:name>
  <act:id type="guid">${escapeXml(account.guid)}</act:id>
  <act:type>${escapeXml(account.type)}</act:type>${commodity}${parent}${slotBlock}
  <act:code>${escapeXml(account.code)}</act:code>
  <act:description>${escapeXml(account.description)}</act:description>
</gnc:account>`;
}

function slot(key: string): string {
  return `<slot><slot:key>${key}</slot:key><slot:value type="string">true</slot:value></slot>`;
}

function transactionXml(
  transaction: BookSnapshot["transactions"][number],
  currency: string,
): string {
  const splits = transaction.splits.map((split, index) => {
    const id =
      split.guid && GUID.test(split.guid)
        ? split.guid
        : derivedGuid(`${transaction.guid}/${index}`);
    const value = `${split.value.num}/${split.value.denom}`;
    return `<trn:split>
  <split:id type="guid">${escapeXml(id)}</split:id>
  <split:reconciled-state>n</split:reconciled-state>
  <split:value>${value}</split:value>
  <split:quantity>${value}</split:quantity>
  <split:account type="guid">${escapeXml(split.accountGuid)}</split:account>
</trn:split>`;
  });
  const date = escapeXml(transaction.date.slice(0, 10));
  return `<gnc:transaction version="2.0.0">
  <trn:id type="guid">${escapeXml(transaction.guid)}</trn:id>
  <trn:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>${escapeXml(transaction.currencyCode ?? currency)}</cmdty:id></trn:currency>
  <trn:date-posted><ts:date>${date} 00:00:00 +0000</ts:date></trn:date-posted>
  <trn:date-entered><ts:date>${date} 00:00:00 +0000</ts:date></trn:date-entered>
  <trn:description>${escapeXml(transaction.description)}</trn:description>
  <trn:splits>${splits.join("")}</trn:splits>
</gnc:transaction>`;
}

function templateRoot(snapshot: BookSnapshot): string | null {
  if (snapshot.templateRootGuid) return snapshot.templateRootGuid;
  return (
    snapshot.accounts.find(
      (account) => account.type === "ROOT" && account.name === "Template Root",
    )?.guid ?? null
  );
}

/**
 * GnuCash needs a structural ROOT and resolves parents while reading, so the
 * export adds a synthetic root when the book has none, reparents top-level
 * accounts, drops the template subtree and writes parents before children.
 */
function exportAccounts(snapshot: BookSnapshot): {
  accounts: SnapshotAccount[];
  rootGuid: string;
} {
  const template = templateRoot(snapshot);
  const excluded = new Set<string>();
  if (template) {
    const children = new Map<string, string[]>();
    for (const account of snapshot.accounts) {
      if (!account.parentGuid) continue;
      const list = children.get(account.parentGuid) ?? [];
      list.push(account.guid);
      children.set(account.parentGuid, list);
    }
    const mark = (guid: string): void => {
      if (excluded.has(guid)) return;
      excluded.add(guid);
      for (const child of children.get(guid) ?? []) mark(child);
    };
    mark(template);
  }

  const existingRoot = snapshot.accounts.find(
    (account) =>
      account.type === "ROOT" &&
      account.guid !== template &&
      account.guid !== snapshot.bookGuid,
  );
  const rootGuid = existingRoot?.guid ?? derivedGuid(`${snapshot.bookGuid}/root`);
  const known = new Set(snapshot.accounts.map((account) => account.guid));
  const accounts = snapshot.accounts
    .filter((account) => !excluded.has(account.guid))
    .map((account): SnapshotAccount => {
      if (account.type === "ROOT") return { ...account, parentGuid: null };
      const parent =
        account.parentGuid &&
        !excluded.has(account.parentGuid) &&
        known.has(account.parentGuid) &&
        account.parentGuid !== account.guid
          ? account.parentGuid
          : rootGuid;
      return { ...account, parentGuid: parent };
    });

  if (!accounts.some((account) => account.guid === rootGuid)) {
    accounts.unshift({
      guid: rootGuid,
      name: "Root Account",
      type: "ROOT",
      parentGuid: null,
      commodityCode: null,
      code: "",
      description: "",
    });
  }

  const byParent = new Map<string, SnapshotAccount[]>();
  for (const account of accounts) {
    if (!account.parentGuid) continue;
    const list = byParent.get(account.parentGuid) ?? [];
    list.push(account);
    byParent.set(account.parentGuid, list);
  }
  for (const list of byParent.values()) {
    list.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  }
  const ordered: SnapshotAccount[] = [];
  const visited = new Set<string>();
  const visit = (account: SnapshotAccount): void => {
    if (visited.has(account.guid)) return;
    visited.add(account.guid);
    ordered.push(account);
    for (const child of byParent.get(account.guid) ?? []) visit(child);
  };
  const root = accounts.find((account) => account.guid === rootGuid);
  if (root) visit(root);
  for (const account of accounts) visit(account);
  return { accounts: ordered, rootGuid };
}

/** Writes a GnuCash 5.x XML book (uncompressed; callers gzip it). */
export function writeGnuCashXml(snapshot: BookSnapshot): string {
  const currency = snapshot.currencyCode ?? "USD";
  const fraction = snapshot.fraction ?? 100;
  const { accounts } = exportAccounts(snapshot);
  return `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2
     xmlns:gnc="http://www.gnucash.org/XML/gnc"
     xmlns:act="http://www.gnucash.org/XML/act"
     xmlns:book="http://www.gnucash.org/XML/book"
     xmlns:cd="http://www.gnucash.org/XML/cd"
     xmlns:cmdty="http://www.gnucash.org/XML/cmdty"
     xmlns:slot="http://www.gnucash.org/XML/slot"
     xmlns:split="http://www.gnucash.org/XML/split"
     xmlns:trn="http://www.gnucash.org/XML/trn"
     xmlns:ts="http://www.gnucash.org/XML/ts">
<gnc:count-data cd:type="book">1</gnc:count-data>
<gnc:book version="2.0.0">
<book:id type="guid">${escapeXml(snapshot.bookGuid)}</book:id>
<gnc:count-data cd:type="commodity">2</gnc:count-data>
<gnc:count-data cd:type="account">${accounts.length}</gnc:count-data>
<gnc:count-data cd:type="transaction">${snapshot.transactions.length}</gnc:count-data>
<gnc:commodity version="2.0.0">
  <cmdty:space>CURRENCY</cmdty:space>
  <cmdty:id>${escapeXml(currency)}</cmdty:id>
  <cmdty:get_quotes/>
  <cmdty:quote_source>currency</cmdty:quote_source>
  <cmdty:quote_tz/>
  <cmdty:fraction>${fraction}</cmdty:fraction>
</gnc:commodity>
<gnc:commodity version="2.0.0">
  <cmdty:space>template</cmdty:space>
  <cmdty:id>template</cmdty:id>
  <cmdty:name>template</cmdty:name>
  <cmdty:xcode>template</cmdty:xcode>
  <cmdty:fraction>1</cmdty:fraction>
</gnc:commodity>
${accounts.map((account) => accountXml(account, currency, fraction)).join("\n")}
${snapshot.transactions.map((transaction) => transactionXml(transaction, currency)).join("\n")}
</gnc:book>
</gnc-v2>
`;
}
