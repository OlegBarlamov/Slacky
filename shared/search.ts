// Search query language and tokenizer, shared by the search index (to build and query it)
// and the client (to highlight matches and show filter chips exactly as the index sees them).
//
//   deploy plan              words, prefix-matched ("depl" finds "deploy"), all must match
//   "rolled back"            exact phrase
//   from:@ben  in:#design    filters (`#design` alone is shorthand for `in:#design`)

const STOPWORDS = new Set(
  'a an and are as at be but by for if in into is it its of on or so that the their then there these they this to was we will with you'.split(' '),
);

/** Lowercase, strip accents, and fold simple plurals so "Deploys" matches "deploy". */
export function normalizeWord(word: string) {
  let w = word.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

export const WORD = /[\p{L}\p{N}_]+/gu;

export const tokenize = (text: string) => (text.match(WORD) ?? []).map(normalizeWord).filter((t) => !STOPWORDS.has(t));

export interface ParsedQuery {
  terms: string[]; // normalized words, including those inside phrases
  phrases: string[]; // lowercased exact phrases
  from: string | null; // user name
  in: string | null; // channel name
}

export function parseQuery(q: string): ParsedQuery {
  const phrases: string[] = [];
  let from: string | null = null;
  let channel: string | null = null;
  const words = q
    .replace(/"([^"]*)"/g, (_, p: string) => {
      if (p.trim()) phrases.push(p.trim().toLowerCase());
      return ' ';
    })
    .split(/\s+/)
    .filter((token) => {
      const t = token.toLowerCase();
      if (t.startsWith('from:')) from = t.slice(5).replace(/^@/, '') || null;
      else if (t.startsWith('in:')) channel = t.slice(3).replace(/^#/, '') || null;
      else if (t.startsWith('#') && t.length > 1) channel = t.slice(1);
      else return true;
      return false;
    });
  const terms = [...new Set([...tokenize(words.join(' ')), ...phrases.flatMap(tokenize)])];
  return { terms, phrases, from, in: channel };
}

export const isEmptyQuery = (p: ParsedQuery) => !p.terms.length && !p.phrases.length && !p.from && !p.in;

/** Rebuilds the query string without one filter, for "remove chip". */
export const withoutFilter = (q: string, filter: 'from' | 'in') =>
  q
    .split(/\s+/)
    .filter((t) => !t.toLowerCase().startsWith(`${filter}:`) && !(filter === 'in' && t.startsWith('#')))
    .join(' ')
    .trim();
