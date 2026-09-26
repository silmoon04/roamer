export function excludedStayNames(receipts: { payload: Record<string, unknown> }[], extra = '') {
  const names = [...receipts.map(row => row.payload.excludeStay), extra].filter((name): name is string => typeof name === 'string' && Boolean(name.trim()));
  return [...new Map(names.map(name => [name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(), name.trim()])).values()];
}
