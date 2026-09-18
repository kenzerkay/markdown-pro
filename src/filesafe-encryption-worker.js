/* global importScripts */
importScripts('../standard-file-js/sfjs.umd.js');

const { SFItem, SFItemParams, SFJS } = self.StandardFileJs;

async function uploadFile(outputFileName, fileItem, integration) {
  const relayUrl = integration.content.relayUrl
    .replace('filesafe.standardnotes.org', 'filesafe.standardnotes.com');
  const response = await fetch(`${relayUrl}/integrations/save-item`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      file: {
        name: outputFileName,
        item: fileItem
      },
      source: integration.content.source,
      authorization: integration.content.authorization
    })
  });

  const result = await response.json();

  if (!response.ok || result.error) {
    throw result.error || new Error('FileSafe upload failed.');
  }

  return result.metadata;
}

self.addEventListener('message', async (event) => {
  const data = event.data;

  try {
    if (data.operation === 'encrypt') {
      const fileItem = new SFItem({
        content_type: data.contentType,
        content: {
          rawData: data.fileData,
          fileName: data.fileName,
          fileType: data.fileType
        }
      });
      const params = await new SFItemParams(
        fileItem,
        data.keys,
        data.authParams
      ).paramsForSync();

      self.postMessage({ fileItem: params });
    } else if (data.operation === 'decrypt') {
      await SFJS.itemTransformer.decryptItem(data.item, data.keys);
      const decryptedItem = new SFItem(data.item);

      if (decryptedItem.errorDecrypting) {
        throw new Error('Error decrypting Standard Notes file.');
      }

      self.postMessage({
        decryptedData: decryptedItem.content.rawData,
        decryptedItem
      });
    } else if (data.operation === 'upload') {
      const metadata = await uploadFile(
        data.outputFileName,
        data.fileItem,
        data.integration
      );

      self.postMessage({ metadata });
    }
  } catch (error) {
    self.postMessage({
      error: {
        name: error.name,
        message: error.message || String(error),
        stack: error.stack
      }
    });
  }
});
