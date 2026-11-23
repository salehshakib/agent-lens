/** Strip terminal escape sequences and control characters from provider text before it is displayed. */
const esc = 0x1b;
const bel = 0x07;

/** Remove terminal escape sequences (CSI, OSC and two-character forms) and control characters except tab and newline. */
export function clean(value: string | undefined): string {
  if (value === undefined) return '';
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === esc) {
      const next = value.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI: parameters, intermediates, then a final byte in 0x40-0x7e.
        i += 2;
        while (i < value.length && value.charCodeAt(i) < 0x40) i++;
      } else if (next === 0x5d) {
        // OSC: up to BEL or ESC followed by a backslash.
        i += 2;
        while (i < value.length && value.charCodeAt(i) !== bel && value.charCodeAt(i) !== esc) i++;
        if (value.charCodeAt(i) === esc) i++;
      } else {
        i++;
      }
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) continue;
    out += value[i];
  }
  return out;
}
