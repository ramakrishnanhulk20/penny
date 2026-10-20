// Balances arrive as exact decimal strings such as "-12.00". Reading the sign and the digits as text keeps every
// amount out of a binary float.
export function balanceLine(name: string, amount: string, base: string): string {
  if (!/[1-9]/.test(amount)) return `${name} is settled up`;
  if (amount.startsWith("-")) return `${name} owes ${amount.slice(1)} ${base}`;
  return `${name} is owed ${amount} ${base}`;
}

export function proofLine(payments: number, expenses: number): string {
  const paymentWords = payments === 1 ? "1 payment" : `${payments} payments`;
  const expenseWords = expenses === 1 ? "1 expense" : `${expenses} expenses`;
  return `${paymentWords} ${payments === 1 ? "settles" : "settle"} ${expenseWords}.`;
}
