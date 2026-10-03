// Invented test books for the spike: a small US household. Never real data.

export const SEED_JOURNAL = `; Test books for the M1 spike. Invented data.
commodity 1,000.00 USD

account Assets:Bank:Checking
account Assets:Cash:Wallet
account Liabilities:CreditCard:Visa
account Income:Salary
account Expenses:Food:Groceries
account Expenses:Food:Coffee
account Expenses:Housing:Rent
account Expenses:Transport:Gas
account Equity:Opening Balances

2026-09-01 * Opening Balance
    Assets:Bank:Checking          4,200.00 USD
    Assets:Cash:Wallet              120.00 USD
    Equity:Opening Balances

2026-09-01 * Maple Street Apartments | September rent
    Expenses:Housing:Rent         1,850.00 USD
    Assets:Bank:Checking

2026-09-05 * Trader Joe's | weekly groceries
    Expenses:Food:Groceries          86.40 USD
    Liabilities:CreditCard:Visa

2026-09-12 * Shell | gas
    Expenses:Transport:Gas           48.10 USD
    Liabilities:CreditCard:Visa

2026-09-15 * Acme Corp | salary
    Assets:Bank:Checking          3,100.00 USD
    Income:Salary
`;

export const SEED_MEMORY = `- Default currency: USD.
- Card purchases go to Liabilities:CreditCard:Visa unless the user says otherwise.
`;
