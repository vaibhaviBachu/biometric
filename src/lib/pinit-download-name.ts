/**
 * temple.jpg → temple.pinit.jpg
 * The extension is unchanged. A name that already ends in .pinit is left alone.
 */
export function pinitDownloadName(filename: string): string {
  const name = filename.trim() || 'file';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const hasExt = ext.length > 0 && ext.length <= 8 && !/[\s/\\]/.test(ext);
  if (!hasExt) {
    return name.toLowerCase().endsWith('.pinit') ? name : `${name}.pinit`;
  }
  const base = name.slice(0, dot);
  if (base.toLowerCase().endsWith('.pinit')) return name;
  return `${base}.pinit.${ext}`;
}
