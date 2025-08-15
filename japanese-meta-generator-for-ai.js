// Rough but effective: CJK = 1 unit, ASCII/half-width kana = 0.5
function zenkakuUnits(str) {
  let units = 0;
  for (const ch of str) {
    const isWide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF01-\uFF60]/u.test(ch);
    units += isWide ? 1 : 0.5;
  }
  return units;
}

function clampMeta(text, softTarget, hardCap) {
  if (zenkakuUnits(text) <= hardCap) return text;
  // Try cutting at punctuation boundaries first
  const cuts = ['｜', '、', '。', ' - ', ' | '];
  for (const c of cuts) {
    while (text.includes(c) && zenkakuUnits(text) > hardCap) {
      // drop the last chunk
      const parts = text.split(c);
      parts.pop();
      text = parts.join(c);
    }
  }
  // Fallback: hard trim by units
  let out = '';
  for (const ch of text) {
    if (zenkakuUnits(out + ch) > hardCap) break;
    out += ch;
  }
  return out;
}

// Usage
const title = clampMeta(generatedTitle, 30, 36);
const description = clampMeta(generatedDescription, 80, 100);
