import {arrayBufferToBase64} from '../scope/base64';
import {encodeUtf8} from '../sdk/utf8';
import type {ConversationMessageRole} from '../types';

export type ExportableChatMessage = {
  role: ConversationMessageRole;
  text: string;
};

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const wrap = (text: string, width: number): string[] => {
  if (text.length <= width) {
    return [text];
  }
  const out: string[] = [];
  const words = text.split(/\s+/);
  let line = '';
  for (const w of words) {
    if (line.length === 0) {
      line = w;
      continue;
    }
    if ((line + ' ' + w).length <= width) {
      line += ` ${w}`;
      continue;
    }
    out.push(line);
    line = w;
  }
  if (line.length > 0) {
    out.push(line);
  }
  return out;
};

export const buildChatSvgBase64 = (
  messages: ExportableChatMessage[],
  opts: {providerLabel: string; width?: number} = {providerLabel: 'DeepSeek'},
): string => {
  const width = opts.width ?? 1200;
  const margin = 40;
  const lineHeight = 28;
  const maxChars = 56;
  const rows: Array<{text: string; role: ConversationMessageRole}> = [];
  for (const m of messages) {
    const prefix = m.role === 'user' ? 'User: ' : 'AI: ';
    const lines = wrap(`${prefix}${m.text.replace(/\s+/g, ' ').trim()}`, maxChars);
    for (const l of lines) {
      rows.push({text: l, role: m.role});
    }
    rows.push({text: '', role: m.role});
  }
  const height = Math.max(300, margin * 2 + (rows.length + 3) * lineHeight);
  const title = `SnCopilot · ${opts.providerLabel} · ${new Date().toISOString()}`;
  const texts = rows
    .map((row, i) => {
      const y = margin + 70 + i * lineHeight;
      const color = row.role === 'user' ? '#111111' : '#003366';
      return `<text x="${margin}" y="${y}" font-size="22" fill="${color}" font-family="monospace">${escapeXml(row.text)}</text>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="${margin}" y="${margin + 20}" font-size="30" font-family="sans-serif" fill="#000000">SnCopilot Chat Export</text>
<text x="${margin}" y="${margin + 52}" font-size="18" font-family="monospace" fill="#444444">${escapeXml(title)}</text>
${texts}
</svg>`;
  const bytes = encodeUtf8(svg);
  return arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
