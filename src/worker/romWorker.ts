import JSZip from 'jszip';

self.onmessage = async (e: MessageEvent) => {
  const { buffer, type } = e.data;

  try {
    if (type === 'PROCESS_ZIP') {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
      
      const ROM_EXTS = ['.z64', '.v64', '.n64', '.rom'];
      let match: { data: Uint8Array; name: string } | null = null;

      // Busca por extensão
      for (const [filename, entry] of entries) {
        if (ROM_EXTS.some(ext => filename.toLowerCase().endsWith(ext))) {
          const data = await entry.async('uint8array');
          match = { data, name: filename };
          break;
        }
      }

      // Se não achou, pega o maior arquivo (provavelmente a ROM)
      if (!match) {
        let largestSize = 0;
        let largestEntry: any = null;
        let largestName = '';

        for (const [filename, entry] of entries) {
          const data = await entry.async('uint8array');
          if (data.length > largestSize) {
            largestSize = data.length;
            largestEntry = data;
            largestName = filename;
          }
        }
        if (largestEntry) match = { data: largestEntry, name: largestName };
      }

      if (!match) throw new Error('Nenhuma ROM válida encontrada no ZIP.');

      // Envia de volta usando Transferable para performance (zero cópia)
      self.postMessage({ 
        type: 'SUCCESS', 
        romData: match.data, 
        name: match.name 
      }, [match.data.buffer] as any);
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', message: err.message });
  }
};
