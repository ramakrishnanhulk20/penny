const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
] as const;

export function numberWord(n: number): string {
  const word = WORDS[n];
  if (!Number.isInteger(n) || word === undefined) throw new Error("number_word_out_of_range");
  return word;
}

export function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
