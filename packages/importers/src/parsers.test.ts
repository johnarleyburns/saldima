// SPDX-License-Identifier: AGPL-3.0-only
import { formatMoney } from "@saldima/gnucash";
import { describe, expect, it } from "vitest";
import { detectCsvMap, parseCsv, parseCsvTable } from "./csv.ts";
import { detectImportSource, parseImportFile } from "./detect.ts";
import { parseOfx } from "./ofx.ts";
import { parseQif } from "./qif.ts";
import { ImportFormatError } from "./types.ts";

function amounts(values: ReadonlyArray<{ amount: { num: bigint; denom: bigint } }>) {
  return values.map((row) => formatMoney(row.amount, 100n));
}

const QIF = `!Type:Bank
D01/15/2024
T-45.67
PGrocery Mart
MGroceries
LFood:Groceries
N1234
^
D01/16/2024
T1,500.00
PEmployer
LSalary
^
D01/17/2024
T-100.00
PTransfer
L[Savings]
^
D03/01/2024
T-60.00
PStore
SGroceries
$-40.00
SHousehold
$-20.00
^
`;

describe("QIF", () => {
  it("reads dates, exact amounts, categories, references and splits", () => {
    const result = parseQif(QIF);
    expect(result.source).toBe("qif");
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      date: "2024-01-15",
      payee: "Grocery Mart",
      memo: "Groceries",
      category: "Food:Groceries",
      reference: "1234",
    });
    expect(amounts(result.rows)).toEqual(["-45.67", "1500.00", "-100.00", "-60.00"]);
    expect(result.rows[2]?.category).toBe("[Savings]");
    expect(result.rows[3]?.splits.map((split) => split.category)).toEqual([
      "Groceries",
      "Household",
    ]);
    expect(amounts(result.rows[3]?.splits ?? [])).toEqual(["-40.00", "-20.00"]);
  });

  it("skips records without a date or amount with a warning", () => {
    const result = parseQif(`!Type:Bank
D01/01/2024
^
T10.00
^
D01/02/2024
PGood
T1.00
^
`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.payee).toBe("Good");
    expect(result.warnings.length).toBe(2);
  });

  it("rejects a file with no usable rows", () => {
    expect(() => parseQif("not a qif file")).toThrow(ImportFormatError);
  });

  it("keeps the last record without a terminator and warns about odd splits", () => {
    const result = parseQif(`!Type:Bank
!Option:AutoSwitch
D01/01/2024
T0.00
^
D01/02/2024
T5.00
PGift
SFood
^
D01/03/2024
T6.00
PFinal
$9.00
`);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.payee).toBe("Final");
    expect(result.warnings).toHaveLength(3);
  });
});

describe("CSV", () => {
  it("detects headers, quoted fields and exact amounts", () => {
    const result = parseCsv(`Date,Description,Amount,Category,Reference
2024-01-05,"Coffee, shop",-4.50,Meals,1001
2024-01-06,Paycheck,"2,000.00",Salary,
`);
    expect(result.source).toBe("csv");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: "2024-01-05",
      payee: "Coffee, shop",
      category: "Meals",
      reference: "1001",
    });
    expect(amounts(result.rows)).toEqual(["-4.50", "2000.00"]);
  });

  it("uses debit and credit columns and a semicolon delimiter", () => {
    const table = parseCsvTable(`Date;Description;Debit;Credit
01/05/2024;Rent;1,200.00;
01/06/2024;Refund;;25.00
`);
    expect(table.delimiter).toBe(";");
    const map = detectCsvMap(table.header);
    expect(map.valueIndex).toBeNull();
    expect(map.outflowIndex).not.toBeNull();
    expect(map.inflowIndex).not.toBeNull();
    const result = parseCsv(
      `Date;Description;Debit;Credit
01/05/2024;Rent;1,200.00;
01/06/2024;Refund;;25.00
`,
      map,
    );
    expect(amounts(result.rows)).toEqual(["-1200.00", "25.00"]);
  });

  it("warns about rows it cannot read but keeps the rest", () => {
    const result = parseCsv(`Posted,Payee,Debit,Credit
2024-01-01,Good,10.00,
not-a-date,Bad,5.00,
2024-01-03,Also good,,7.00
`);
    expect(result.rows).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects a table without a date or amount column", () => {
    expect(() => detectCsvMap(["Name", "Note"])).toThrow(ImportFormatError);
  });

  it("handles BOM, pipes, escaped quotes and CRLF", () => {
    const result = parseCsv(
      '\uFEFFDate|Description|Amount\r\n2024-01-01|"A ""quoted"" shop"|-1.00\r\n',
    );
    expect(result.rows[0]?.payee).toBe('A "quoted" shop');
    expect(amounts(result.rows)).toEqual(["-1.00"]);
  });

  it("skips bad debit, credit, empty and zero rows", () => {
    const result = parseCsv(`Date,Description,Debit,Credit
2024-01-01,Bad debit,xx,
2024-01-02,Bad credit,,yy
2024-01-03,None,,
2024-01-04,Zero,0.00,
,
2024-01-05,Good,3.00,
`);
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toHaveLength(4);
  });

  it("uses the first unclaimed column for the description and value headers", () => {
    const result = parseCsv(`Date,Merchant,Value,Type,Check Number
2024-01-01,Bar,5.00,Income,42
`);
    expect(result.rows[0]).toMatchObject({
      payee: "Bar",
      category: "Income",
      reference: "42",
    });
  });

  it("throws when every row is unusable", () => {
    expect(() => parseCsv("Date,Amount\nnot-a-date,5.00")).toThrow(ImportFormatError);
  });
});

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240115120000<TRNAMT>-45.67<FITID>abc123<NAME>Grocery Mart<MEMO>Card</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240116<TRNAMT>1500.00<FITID>def456<NAME>Employer</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const OFX_XML = `<?xml version="1.0"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240115</DTPOSTED><TRNAMT>-45.67</TRNAMT><FITID>abc123</FITID><NAME>Grocery Mart</NAME><MEMO>Card</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("OFX", () => {
  it("reads SGML bank transactions", () => {
    const result = parseOfx(OFX_SGML);
    expect(result.source).toBe("ofx");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: "2024-01-15",
      payee: "Grocery Mart",
      memo: "Card",
      reference: "abc123",
    });
    expect(amounts(result.rows)).toEqual(["-45.67", "1500.00"]);
  });

  it("reads XML bank transactions", () => {
    const result = parseOfx(OFX_XML);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.payee).toBe("Grocery Mart");
  });

  it("keeps usable rows and falls back to payee and check number", () => {
    const result = parseOfx(`<OFX>
<STMTTRN><DTPOSTED>bad<TRNAMT>1.00</STMTTRN>
<STMTTRN><DTPOSTED>20240101<TRNAMT>bad</STMTTRN>
<STMTTRN><DTPOSTED>20240101<TRNAMT>0.00</STMTTRN>
<STMTTRN><DTPOSTED>20240102<TRNAMT>2.00<PAYEE>Payee Co<CHECKNUM>77</STMTTRN>
</OFX>`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      payee: "Payee Co",
      reference: "77",
    });
    expect(result.warnings).toHaveLength(3);
  });

  it("rejects files without transactions", () => {
    expect(() => parseOfx("<OFX></OFX>")).toThrow(ImportFormatError);
  });
});

describe("format detection", () => {
  it("sniffs QIF, OFX and CSV regardless of extension", () => {
    expect(detectImportSource("statement.txt", QIF)).toBe("qif");
    expect(detectImportSource("statement.csv", OFX_SGML)).toBe("ofx");
    expect(detectImportSource("statement.qif", "Date,Amount\n2024-01-01,5.00")).toBe(
      "csv",
    );
    expect(detectImportSource("statement.qfx", "no markers here")).toBe("ofx");
    expect(detectImportSource("statement.txt", "^ only\nsomething")).toBe("csv");
  });

  it("routes a parsed file through the right parser", () => {
    const result = parseImportFile("statement.qif", QIF);
    expect(result.source).toBe("qif");
    expect(result.rows).toHaveLength(4);
    expect(() => parseImportFile("empty.csv", "Name,Note\n")).toThrow(
      ImportFormatError,
    );
  });
});
