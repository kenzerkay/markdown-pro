const ComponentRelay = require('@standardnotes/component-relay');
const EasyMDE = require('easymde');
const Filesafe = require('filesafe-js');
const katex = require('katex');

document.addEventListener('DOMContentLoaded', function () {

  let workingNote;
  let ignoreTextChange = false;
  let initialLoad = true;
  let lastValue, lastUUID, clientData;
  let renderNote = false;
  let showingUnsafeContentAlert = false;
  const fileUrls = new Map();
  const loadingFiles = new Set();

  const componentRelay = new ComponentRelay({
    targetWindow: window,
    onReady: () => {
      document.body.classList.add(componentRelay.platform);
      document.body.classList.add(componentRelay.environment);

      initializeEditor();
    }
  });

  const filesafe = new Filesafe({
    componentManager: componentRelay
  });

  componentRelay.streamContextItem(async (note) => {
    if (showingUnsafeContentAlert) {
      return;
    }

    if (note.uuid !== lastUUID) {
      lastValue = null;
      initialLoad = true;
      lastUUID = note.uuid;
      clientData = note.clientData;
    }

    workingNote = note;
    filesafe.setCurrentNote(note);

    if (note.isMetadataUpdate || !window.easymde) {
      return;
    }

    document.getElementsByClassName('CodeMirror-code')[0].setAttribute(
      'spellcheck',
      JSON.stringify(note.content.spellcheck)
    );

    const isUnsafeContent = checkIfUnsafeContent(note.content.text);

    if (isUnsafeContent) {
      const trustUnsafeContent = clientData['trustUnsafeContent'] ?? false;

      if (!trustUnsafeContent) {
        const result = await showUnsafeContentAlert();

        if (result) {
          setTrustUnsafeContent(workingNote);
        }

        renderNote = result;
      } else {
        renderNote = true;
      }
    } else {
      renderNote = true;
    }

    if (!renderNote) {
      window.easymde.value('');

      if (!window.easymde.isPreviewActive()) {
        window.easymde.togglePreview();
      }

      return;
    }

    if (note.content.text !== lastValue) {
      ignoreTextChange = true;
      window.easymde.value(note.content.text);
      ignoreTextChange = false;
    }

    if (initialLoad) {
      initialLoad = false;
      window.easymde.codemirror.getDoc().clearHistory();

      const mode = clientData && clientData.mode;

      if (mode === 'preview') {
        if (!window.easymde.isPreviewActive()) {
          window.easymde.togglePreview();
        }
      } else if (mode === 'split') {
        if (!window.easymde.isSideBySideActive()) {
          window.easymde.toggleSideBySide();
        }
      } else if (window.easymde.isPreviewActive()) {
        window.easymde.togglePreview();
      }
    }
  });

  /**
   * Render LaTeX math using KaTeX.
   *
   * Supports:
   *   $inline$
   *   $$display$$
   *
   * Math inside <code> or <pre> elements is ignored.
   */
  function renderMath(html) {
    const container = document.createElement('div');
    container.innerHTML = html;

    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT
    );

    const textNodes = [];
    let node;

    while ((node = walker.nextNode())) {
      if (
        node.parentElement &&
        !node.parentElement.closest('code, pre')
      ) {
        textNodes.push(node);
      }
    }

    textNodes.forEach((textNode) => {
      const text = textNode.nodeValue;

      const mathRegex = /(\$\$([\s\S]*?)\$\$)|(\$([^$\n]+?)\$)/g;

      if (!mathRegex.test(text)) {
        return;
      }

      mathRegex.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;

      while ((match = mathRegex.exec(text)) !== null) {
        fragment.appendChild(
          document.createTextNode(
            text.substring(lastIndex, match.index)
          )
        );

        const isDisplayMath = Boolean(match[1]);
        const math = isDisplayMath ? match[2] : match[4];

        const mathElement = document.createElement(
          isDisplayMath ? 'div' : 'span'
        );

        try {
          katex.render(math, mathElement, {
            displayMode: isDisplayMath,
            throwOnError: false
          });

          fragment.appendChild(mathElement);
        } catch (error) {
          fragment.appendChild(
            document.createTextNode(match[0])
          );
        }

        lastIndex = mathRegex.lastIndex;
      }

      fragment.appendChild(
        document.createTextNode(
          text.substring(lastIndex)
        )
      );

      textNode.parentNode.replaceChild(fragment, textNode);
    });

    return container.innerHTML;
  }

  function normaliseFileReferences(markdown) {
    return markdown.replace(
      /!\[([^\]]*)\]\(sn-file:([^)]+)\)/g,
      '![$1](https://standardnotes.invalid/files/$2)'
    );
  }

  function renderFileReferences(html) {
    const container = document.createElement('div');
    container.innerHTML = html;

    container.querySelectorAll(
      'img[src^="https://standardnotes.invalid/files/"]'
    ).forEach((image) => {
      const descriptorUUID = image.src.split('/').pop();
      const fileUrl = fileUrls.get(descriptorUUID);

      if (fileUrl) {
        image.src = fileUrl;
      } else {
        image.removeAttribute('src');
      }
    });

    return container.innerHTML;
  }

  async function loadFileReference(descriptorUUID) {
    if (fileUrls.has(descriptorUUID) || loadingFiles.has(descriptorUUID)) {
      return;
    }

    const descriptor = filesafe.findFileDescriptor(descriptorUUID);

    if (!descriptor) {
      return;
    }

    loadingFiles.add(descriptorUUID);

    try {
      const encryptedFile = await filesafe.downloadFileFromDescriptor(descriptor);
      const decryptedFile = await filesafe.decryptFile({
        fileDescriptor: descriptor,
        fileItem: encryptedFile
      });
      const binary = atob(decryptedFile.decryptedData);
      const bytes = Uint8Array.from(
        binary,
        (character) => character.charCodeAt(0)
      );
      const fileType = descriptor.content.fileType || 'application/octet-stream';

      fileUrls.set(
        descriptorUUID,
        URL.createObjectURL(new Blob([bytes], { type: fileType }))
      );

      refreshPreview();
    } catch (error) {
      console.error('Unable to load Standard Notes file:', error);
    } finally {
      loadingFiles.delete(descriptorUUID);
    }
  }

  function resolveFileReferences(markdown) {
    const references = markdown.matchAll(
      /!\[[^\]]*\]\(sn-file:([^)]+)\)/g
    );

    for (const reference of references) {
      loadFileReference(reference[1]);
    }
  }

  function refreshPreview() {
    if (!window.easymde || !window.easymde.isPreviewActive()) {
      return;
    }

    const preview = window.easymde.codemirror.getWrapperElement().lastChild;
    preview.innerHTML = window.easymde.options.previewRender(
      window.easymde.value()
    );
  }

  function initializeEditor() {
    window.easymde = new EasyMDE({
      element: document.getElementById('editor'),
      autoDownloadFontAwesome: false,
      spellChecker: false,
      nativeSpellcheck: true,
      inputStyle: getInputStyleForEnvironment(),
      status: false,

      previewRender: function (plainText) {
        const marked = require('marked');

        resolveFileReferences(plainText);

        const html = marked(normaliseFileReferences(plainText), {
          headerIds: false,
          smartypants: true
        });

        return renderMath(renderFileReferences(html));
      },

      shortcuts: {
        toggleSideBySide: 'Cmd-Alt-P'
      },

      toolbar: [
        {
          className: 'fa fa-eye',
          default: true,
          name: 'preview',
          noDisable: true,
          title: 'Toggle Preview',
          action: function () {
            window.easymde.togglePreview();
            saveMetadata();
          }
        },
        {
          className: 'fa fa-columns',
          default: true,
          name: 'side-by-side',
          noDisable: true,
          noMobile: true,
          title: 'Toggle Side by Side',
          action: function () {
            window.easymde.toggleSideBySide();
            saveMetadata();
          }
        },
        '|',
        'heading', 'bold', 'italic', 'strikethrough',
        '|', 'quote', 'code',
        '|', 'unordered-list', 'ordered-list',
        '|', 'clean-block',
        '|', 'link', 'image',
        '|', 'table'
      ],
    });

    window.easymde.codemirror.setOption('viewportMargin', 100);

    const uploadImage = (file) => new Promise((resolve, reject) => {
      const credential = filesafe.getDefaultCredentials();

      if (!credential || !filesafe.getDefaultIntegration()) {
        reject(new Error('Configure Standard Notes FileSafe before pasting images.'));
        return;
      }

      const reader = new FileReader();

      reader.onload = async () => {
        try {
          const binary = new Uint8Array(reader.result);
          let binaryString = '';

          binary.forEach((byte) => {
            binaryString += String.fromCharCode(byte);
          });

          const base64Data = btoa(binaryString);
          const fileItem = await filesafe.encryptFile({
            data: base64Data,
            inputFileName: file.name || 'pasted-image',
            fileType: file.type,
            credential
          });
          const descriptor = await filesafe.uploadFile({
            fileItem,
            inputFileName: file.name || 'pasted-image',
            fileType: file.type,
            credential,
            note: workingNote
          });

          resolve(`![${file.name || 'pasted-image'}](sn-file:${descriptor.uuid})`);
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });

    window.easymde.codemirror.getInputField().addEventListener(
      'paste',
      function (event) {
        const imageFiles = Array.from(
          event.clipboardData?.files || []
        ).filter((file) => file.type.startsWith('image/'));

        if (imageFiles.length === 0) {
          return;
        }

        event.preventDefault();

        Promise.all(imageFiles.map(uploadImage)).then((references) => {
          window.easymde.codemirror.replaceSelection(references.join('\n'));
        }).catch((error) => {
          console.error('Unable to paste image to Standard Notes Files:', error);

          const message = error.message || String(error);

          if (message.includes('Configure Standard Notes FileSafe')) {
            window.alert(
              'Image upload is unavailable because Standard Notes FileSafe is not configured.'
            );
          } else {
            window.alert(`Unable to upload image to Standard Notes Files: ${message}`);
          }
        });
      }
    );

    window.easymde.codemirror.on('change', function () {
      const strip = (html) => {
        const tmp = document.implementation.createHTMLDocument('New').body;
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
      };

      const truncateString = (string, limit = 90) => {
        if (string.length <= limit) {
          return string;
        } else {
          return string.substring(0, limit) + '...';
        }
      };

      if (!ignoreTextChange && renderNote) {
        if (workingNote) {
          const note = workingNote;
          const editorValue = window.easymde.value();

          lastValue = editorValue;

          componentRelay.saveItemWithPresave(note, () => {
            let html = window.easymde.options.previewRender(
              editorValue
            );

            let strippedHtml = truncateString(strip(html));

            note.content.preview_plain = strippedHtml;
            note.content.preview_html = null;
            note.content.text = editorValue;
          });
        }
      }
    });

    const scrollCursorIntoView = (editor) => {
      setTimeout(() => editor.scrollIntoView(), 200);
    };

    window.easymde.codemirror.on('cursorActivity', function (editor) {
      if (componentRelay.environment !== 'mobile') {
        return;
      }

      scrollCursorIntoView(editor);
    });

    try {
      window.easymde.toggleFullScreen();
    } catch (e) {
      console.log('Error:', e);
    }
  }

  function saveMetadata() {
    if (!renderNote) {
      return;
    }

    const getEditorMode = () => {
      const editor = window.easymde;

      if (editor) {
        if (editor.isPreviewActive()) return 'preview';
        if (editor.isSideBySideActive()) return 'split';
      }

      return 'edit';
    };

    const note = workingNote;

    componentRelay.saveItemWithPresave(note, () => {
      note.clientData = {
        ...note.clientData,
        mode: getEditorMode()
      };
    });
  }

  function setTrustUnsafeContent(note) {
    componentRelay.saveItemWithPresave(note, () => {
      note.clientData = {
        ...note.clientData,
        trustUnsafeContent: true
      };
    });
  }

  /**
   * Checks if a markdown text is safe to render.
   */
  function checkIfUnsafeContent(markdownText) {
    const marked = require('marked');
    const DOMPurify = require('dompurify');

    const renderedHtml = marked(normaliseFileReferences(markdownText), {
      headerIds: false,
      smartypants: true
    });

    const sanitizedHtml = DOMPurify.sanitize(renderedHtml, {
      FORBID_TAGS: ['script', 'style'],

      FORBID_ATTR: [
        'onerror',
        'onload',
        'onunload',
        'onclick',
        'ondblclick',
        'onmousedown',
        'onmouseup',
        'onmouseover',
        'onmousemove',
        'onmouseout',
        'onfocus',
        'onblur',
        'onkeypress',
        'onkeydown',
        'onkeyup',
        'onsubmit',
        'onreset',
        'onselect',
        'onchange'
      ]
    });

    const renderedDom = new DOMParser().parseFromString(
      renderedHtml,
      'text/html'
    );

    const sanitizedDom = new DOMParser().parseFromString(
      sanitizedHtml,
      'text/html'
    );

    return !renderedDom.isEqualNode(sanitizedDom);
  }

  function showUnsafeContentAlert() {
    if (showingUnsafeContentAlert) {
      return;
    }

    showingUnsafeContentAlert = true;

    const text = 'We’ve detected that this note contains a script or code snippet which may be unsafe to execute. ' +
      'Scripts executed in the editor have the ability to impersonate as the editor to Standard Notes. ' +
      'Press Continue to mark this script as safe and proceed, or Cancel to avoid rendering this note.';

    return new Promise((resolve) => {
      const Stylekit = require('sn-stylekit');

      const alert = new Stylekit.SKAlert({
        title: null,
        text,
        buttons: [
          {
            text: 'Cancel',
            style: 'neutral',
            action: function () {
              showingUnsafeContentAlert = false;
              resolve(false);
            },
          },
          {
            text: 'Continue',
            style: 'danger',
            action: function () {
              showingUnsafeContentAlert = false;
              resolve(true);
            },
          },
        ]
      });

      alert.present();
    });
  }

  function getInputStyleForEnvironment() {
    const environment = componentRelay.environment ?? 'web';
    return environment === 'mobile' ? 'textarea' : 'contenteditable';
  }
});