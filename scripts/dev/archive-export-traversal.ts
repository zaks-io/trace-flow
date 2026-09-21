export interface ExportManifestNode<T> {
  elements?: T[];
  pages?: { page_key: string }[];
  previous_page_key?: string;
}

export async function collectExportManifestGraph<T>(
  rootKey: string,
  load: (objectKey: string) => Promise<ExportManifestNode<T>>,
  record: (elements: T[]) => void,
): Promise<void> {
  const stack = [rootKey];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const objectKey = stack.pop()!;
    if (seen.has(objectKey)) continue;
    const manifest = await load(objectKey);
    seen.add(objectKey);
    if (manifest.elements) record(manifest.elements);
    for (const page of manifest.pages ?? []) stack.push(page.page_key);
    if (manifest.previous_page_key) stack.push(manifest.previous_page_key);
  }
}
