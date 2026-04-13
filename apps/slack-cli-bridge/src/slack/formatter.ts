/**
 * Convert Markdown to Slack mrkdwn format.
 */
export const formatSlackMessage = (text: string): string => {
  let result = text;

  // Protect code blocks from other transformations
  const codeBlocks: string[] = [];
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push('```\n' + code + '```');
    return `\x00CODE${idx}\x00`;
  });

  // Protect inline code
  const inlineCode: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = inlineCode.length;
    inlineCode.push('`' + code + '`');
    return `\x00INLINE${idx}\x00`;
  });

  // Headings: # Heading → *Heading*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Restore inline code
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_match, idx: string) => inlineCode[parseInt(idx)]);

  // Restore code blocks
  result = result.replace(/\x00CODE(\d+)\x00/g, (_match, idx: string) => codeBlocks[parseInt(idx)]);

  return result;
};
