// SPDX-License-Identifier: AGPL-3.0-only

import type { BookSnapshot, SnapshotAccount, SnapshotTransaction } from "./book-file";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function accountXml(account: SnapshotAccount): string {
  const parent = account.parentGuid
    ? `\n  <act:parent type="guid">${escapeXml(account.parentGuid)}</act:parent>`
    : "";
  const commodity = account.commodityCode
    ? `\n  <act:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>${escapeXml(account.commodityCode)}</cmdty:id></act:commodity>\n  <act:commodity-scu>100</act:commodity-scu>`
    : "";
  return `<gnc:account version="2.0.0">
  <act:name>${escapeXml(account.name)}</act:name>
  <act:id type="guid">${escapeXml(account.guid)}</act:id>
  <act:type>${escapeXml(account.type)}</act:type>${commodity}${parent}
  <act:code>${escapeXml(account.code)}</act:code>
  <act:description>${escapeXml(account.description)}</act:description>
</gnc:account>`;
}

function splitXml(split: {
  accountGuid: string;
  value: { num: bigint; denom: bigint };
}): string {
  const value = `${split.value.num}/${split.value.denom}`;
  return `<trn:split>
  <split:id type="guid">${escapeXml(split.accountGuid)}-${value.replace("/", "-")}</split:id>
  <split:account>${escapeXml(split.accountGuid)}</split:account>
  <split:value>${value}</split:value>
  <split:quantity>${value}</split:quantity>
</trn:split>`;
}

function transactionXml(transaction: SnapshotTransaction): string {
  return `<gnc:transaction version="2.0.0">
  <trn:id type="guid">${escapeXml(transaction.guid)}</trn:id>
  <trn:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>${escapeXml(transaction.currencyCode ?? "USD")}</cmdty:id></trn:currency>
  <trn:date-posted><ts:date>${escapeXml(transaction.date)} 00:00:00 +0000</ts:date></trn:date-posted>
  <trn:description>${escapeXml(transaction.description)}</trn:description>
  <trn:splits>${transaction.splits.map(splitXml).join("")}</trn:splits>
</gnc:transaction>`;
}

/** Writes a GnuCash 5.x XML book (uncompressed; callers gzip it). */
export function writeGnuCashXml(snapshot: BookSnapshot): string {
  const currency = snapshot.currencyCode ?? "USD";
  return `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2
     xmlns:gnc="http://www.gnucash.org/XML/gnc"
     xmlns:act="http://www.gnucash.org/XML/act"
     xmlns:book="http://www.gnucash.org/XML/book"
     xmlns:cd="http://www.gnucash.org/XML/cd"
     xmlns:cmdty="http://www.gnucash.org/XML/cmdty"
     xmlns:split="http://www.gnucash.org/XML/split"
     xmlns:trn="http://www.gnucash.org/XML/trn"
     xmlns:ts="http://www.gnucash.org/XML/ts">
<gnc:count-data cd:type="book">1</gnc:count-data>
<gnc:book version="2.0.0">
<book:id type="guid">${escapeXml(snapshot.bookGuid)}</book:id>
<gnc:commodity version="2.0.0">
  <cmdty:space>CURRENCY</cmdty:space>
  <cmdty:id>${escapeXml(currency)}</cmdty:id>
  <cmdty:fraction>${snapshot.fraction ?? 100}</cmdty:fraction>
</gnc:commodity>
${snapshot.accounts.map(accountXml).join("\n")}
${snapshot.transactions.map(transactionXml).join("\n")}
</gnc:book>
</gnc-v2>
`;
}
