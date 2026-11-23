// SPDX-License-Identifier: AGPL-3.0-only

export type AccountType =
  | "ASSET"
  | "BANK"
  | "CASH"
  | "CREDIT"
  | "LIABILITY"
  | "INCOME"
  | "EXPENSE"
  | "EQUITY"
  | "RECEIVABLE"
  | "PAYABLE";

export interface TemplateAccount {
  readonly name: string;
  readonly type: AccountType;
  readonly code?: string;
  readonly placeholder?: boolean;
  readonly hidden?: boolean;
  readonly children?: readonly TemplateAccount[];
}

export interface BookTemplate {
  readonly id: TemplateId;
  readonly name: string;
  readonly description: string;
  readonly roots: readonly TemplateAccount[];
}

export const ACCOUNT_TYPES: readonly AccountType[] = [
  "ASSET",
  "BANK",
  "CASH",
  "CREDIT",
  "LIABILITY",
  "INCOME",
  "EXPENSE",
  "EQUITY",
  "RECEIVABLE",
  "PAYABLE",
];

export const TEMPLATE_IDS = ["personal", "small-business", "insurance-agency"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface FlatTemplateAccount {
  readonly path: string;
  readonly parentPath: string | null;
  readonly name: string;
  readonly type: AccountType;
  readonly code: string | null;
  readonly placeholder: boolean;
  readonly hidden: boolean;
}

const PERSONAL: BookTemplate = {
  id: "personal",
  name: "Personal",
  description: "Everyday household accounts.",
  roots: [
    {
      name: "Assets",
      type: "ASSET",
      children: [
        {
          name: "Bank",
          type: "BANK",
          children: [
            { name: "Checking", type: "BANK" },
            { name: "Savings", type: "BANK" },
          ],
        },
        { name: "Investments", type: "ASSET", placeholder: true },
      ],
    },
    {
      name: "Liabilities",
      type: "LIABILITY",
      children: [{ name: "Credit Card", type: "CREDIT" }],
    },
    {
      name: "Equity",
      type: "EQUITY",
      children: [{ name: "Opening Balances", type: "EQUITY" }],
    },
    {
      name: "Income",
      type: "INCOME",
      children: [
        { name: "Salary", type: "INCOME" },
        { name: "Interest", type: "INCOME" },
      ],
    },
    {
      name: "Expenses",
      type: "EXPENSE",
      children: [
        { name: "Rent", type: "EXPENSE" },
        { name: "Groceries", type: "EXPENSE" },
        { name: "Utilities", type: "EXPENSE" },
      ],
    },
  ],
};

const SMALL_BUSINESS: BookTemplate = {
  id: "small-business",
  name: "Small business",
  description: "Sole trader and small-team accounts.",
  roots: [
    {
      name: "Assets",
      type: "ASSET",
      children: [
        { name: "Business Checking", type: "BANK" },
        { name: "Accounts Receivable", type: "RECEIVABLE" },
      ],
    },
    {
      name: "Liabilities",
      type: "LIABILITY",
      children: [
        { name: "Accounts Payable", type: "PAYABLE" },
        { name: "Sales Tax Payable", type: "LIABILITY" },
      ],
    },
    {
      name: "Equity",
      type: "EQUITY",
      children: [{ name: "Owner's Equity", type: "EQUITY" }],
    },
    {
      name: "Income",
      type: "INCOME",
      children: [
        { name: "Sales", type: "INCOME" },
        { name: "Services", type: "INCOME" },
      ],
    },
    {
      name: "Expenses",
      type: "EXPENSE",
      children: [
        { name: "Payroll", type: "EXPENSE" },
        { name: "Rent", type: "EXPENSE" },
        { name: "Supplies", type: "EXPENSE" },
        { name: "Software", type: "EXPENSE" },
      ],
    },
  ],
};

const INSURANCE_AGENCY: BookTemplate = {
  id: "insurance-agency",
  name: "Insurance agency",
  description: "Premium trust, commissions and agency overhead.",
  roots: [
    {
      name: "Assets",
      type: "ASSET",
      children: [
        {
          name: "Trust",
          type: "BANK",
          children: [
            { name: "Premium Trust", type: "BANK" },
            { name: "Operating", type: "BANK" },
          ],
        },
        { name: "Commissions Receivable", type: "RECEIVABLE" },
      ],
    },
    {
      name: "Liabilities",
      type: "LIABILITY",
      children: [
        { name: "Commissions Payable", type: "PAYABLE" },
        { name: "Premiums Payable", type: "PAYABLE" },
      ],
    },
    {
      name: "Equity",
      type: "EQUITY",
      children: [{ name: "Owner's Equity", type: "EQUITY" }],
    },
    {
      name: "Income",
      type: "INCOME",
      children: [
        { name: "Commissions", type: "INCOME" },
        { name: "Policy Fees", type: "INCOME" },
      ],
    },
    {
      name: "Expenses",
      type: "EXPENSE",
      children: [
        { name: "E&O Insurance", type: "EXPENSE" },
        { name: "Licensing", type: "EXPENSE" },
        { name: "Office", type: "EXPENSE" },
        { name: "Marketing", type: "EXPENSE" },
      ],
    },
  ],
};

const TEMPLATES: Record<TemplateId, BookTemplate> = {
  personal: PERSONAL,
  "small-business": SMALL_BUSINESS,
  "insurance-agency": INSURANCE_AGENCY,
};

export function isTemplateId(value: string): value is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(value);
}

export function templateById(id: string | undefined): BookTemplate {
  return id && isTemplateId(id) ? TEMPLATES[id] : PERSONAL;
}

export function flattenTemplate(template: BookTemplate): FlatTemplateAccount[] {
  const rows: FlatTemplateAccount[] = [];
  const visit = (account: TemplateAccount, parentPath: string | null): void => {
    const path = parentPath ? `${parentPath}/${account.name}` : account.name;
    rows.push({
      path,
      parentPath,
      name: account.name,
      type: account.type,
      code: account.code ?? null,
      placeholder: account.placeholder ?? false,
      hidden: account.hidden ?? false,
    });
    for (const child of account.children ?? []) visit(child, path);
  };
  for (const root of template.roots) visit(root, null);
  return rows;
}
