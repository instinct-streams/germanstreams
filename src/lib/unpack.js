// Unpacker for Dean Edwards' P.A.C.K.E.R obfuscation (eval(function(p,a,c,k,e,d|r){...})).
// Standard algorithm re-implemented from scratch: the payload string has dictionary
// placeholders which are replaced by words from the pipe-separated word list.

const parseJsString = (source, quoteIndex) => {
  // source[quoteIndex] must be the opening single quote.
  let out = '';
  let i = quoteIndex + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      out += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === "'") return [out, i + 1];
    out += ch;
    i += 1;
  }
  throw new Error('unterminated string in packed payload');
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const unpackPackedScript = (script) => {
  const start = script.indexOf("return p}('");
  if (start < 0) throw new Error('packed payload start not found');
  const [payload, afterPayload] = parseJsString(script, start + "return p}(".length);

  const header = script.slice(afterPayload);
  const counts = header.match(/^,(\d+),(\d+),/);
  if (!counts) throw new Error('packed counts not found');
  const radix = parseInt(counts[1], 10);
  const count = parseInt(counts[2], 10);

  const [wordListRaw] = parseJsString(script, afterPayload + counts[0].length);
  const words = wordListRaw.split('|');

  const encode = (n) => n.toString(radix > 36 ? 36 : radix);

  let result = payload;
  for (let i = count - 1; i >= 0; i--) {
    const word = words[i];
    if (word) {
      result = result.replace(new RegExp(`\\b${escapeRegExp(encode(i))}\\b`, 'g'), word);
    }
  }
  return result;
};

// Returns the concatenation of every successfully unpacked eval block in the HTML.
export const unpackAllFromHtml = (html) => {
  const out = [];
  let searchFrom = 0;
  const marker = 'eval(function(p,a,c,k,e,';
  while (true) {
    const idx = html.indexOf(marker, searchFrom);
    if (idx < 0) break;
    // eval block ends at the closing '</script>' at the latest; bound the slice for safety.
    const end = html.indexOf('</script>', idx);
    const block = html.slice(idx, end > idx ? end : idx + 200_000);
    try {
      out.push(unpackPackedScript(block));
    } catch {
      // not a standard packed block; ignore
    }
    searchFrom = idx + marker.length;
  }
  return out.join('\n');
};
