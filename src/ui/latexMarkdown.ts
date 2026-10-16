export const normalizeLatexForMarkdown = (input: string): string =>
  input
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => {
      const body = expr.trim();
      if (body.length === 0) {
        return '';
      }
      return `\n\`\`\`latex\n${body}\n\`\`\`\n`;
    })
    .replace(/(^|[^\$])\$([^\$\n]+)\$/g, (_m, prefix: string, expr: string) => {
      const body = expr.trim();
      if (body.length === 0) {
        return prefix;
      }
      return `${prefix}\`${body}\``;
    });
