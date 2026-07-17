(() => {
  'use strict';

  const STORAGE_KEY = 'videoia-ultimate-projects-v2';
  const SETTINGS_KEY = 'videoia-ultimate-settings-v2';
  const MAX_FILES_PER_TYPE = 10;
  const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
  const MAX_VIDEO_SIZE = 200 * 1024 * 1024;
  const RESPONSE_DELAY = 500;

  const byId = id => document.getElementById(id);
  const requiredIds = [
    'menuButton', 'sidebar', 'pageOverlay', 'closeSidebarButton', 'newProjectButton',
    'clearHistoryButton', 'historyList', 'historyEmpty', 'main', 'welcomeCard',
    'conversation', 'generationStatus', 'plusFab', 'settingsButton', 'filesPanel',
    'settingsPanel', 'photoTile', 'videoTile', 'photoInput', 'videoInput', 'fileInfo',
    'selectedFiles', 'attachmentStrip', 'messageInput', 'characterCount', 'sendButton',
    'qualidadeSelect', 'velocidadeSelect', 'temaSelect', 'tempoSelect', 'toastRegion'
  ];

  const elements = Object.fromEntries(requiredIds.map(id => [id, byId(id)]));
  const missingIds = requiredIds.filter(id => !elements[id]);

  if (missingIds.length) {
    throw new Error(`Elementos obrigatórios ausentes: ${missingIds.join(', ')}`);
  }

  const state = {
    projects: readJson(STORAGE_KEY, []),
    currentProjectId: null,
    photos: [],
    videos: [],
    responseTimer: null
  };

  if (!Array.isArray(state.projects)) state.projects = [];

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      console.warn(`Não foi possível ler ${key}.`, error);
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn(`Não foi possível salvar ${key}.`, error);
      showToast('O navegador não permitiu salvar o histórico.', 'error');
      return false;
    }
  }

  function createId(prefix = 'item') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatDate(timestamp) {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      }).format(new Date(timestamp));
    } catch {
      return 'agora';
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 3400);
  }

  function setSidebar(open) {
    elements.sidebar.classList.toggle('open', open);
    elements.sidebar.setAttribute('aria-hidden', String(!open));
    elements.menuButton.setAttribute('aria-expanded', String(open));
    elements.menuButton.setAttribute('aria-label', open ? 'Fechar histórico' : 'Abrir histórico');
    elements.pageOverlay.hidden = !open;
    if (open) elements.closeSidebarButton.focus();
  }

  function setPanel(panelName, open) {
    const target = panelName === 'files' ? elements.filesPanel : elements.settingsPanel;
    const button = panelName === 'files' ? elements.plusFab : elements.settingsButton;
    const otherPanel = panelName === 'files' ? elements.settingsPanel : elements.filesPanel;
    const otherButton = panelName === 'files' ? elements.settingsButton : elements.plusFab;

    if (open) {
      otherPanel.hidden = true;
      otherPanel.setAttribute('aria-hidden', 'true');
      otherButton.setAttribute('aria-expanded', 'false');
    }

    target.hidden = !open;
    target.setAttribute('aria-hidden', String(!open));
    button.setAttribute('aria-expanded', String(open));
  }

  function closePanels() {
    setPanel('files', false);
    setPanel('settings', false);
  }

  function getSettings() {
    return {
      quality: elements.qualidadeSelect.value,
      speed: elements.velocidadeSelect.value,
      theme: elements.temaSelect.value,
      duration: elements.tempoSelect.value
    };
  }

  function saveSettings() {
    writeJson(SETTINGS_KEY, getSettings());
  }

  function loadSettings() {
    const saved = readJson(SETTINGS_KEY, null);
    if (!saved || typeof saved !== 'object') return;

    const mapping = {
      qualidadeSelect: saved.quality,
      velocidadeSelect: saved.speed,
      temaSelect: saved.theme,
      tempoSelect: saved.duration
    };

    Object.entries(mapping).forEach(([id, value]) => {
      const select = elements[id];
      if ([...select.options].some(option => option.value === String(value))) {
        select.value = String(value);
      }
    });
  }

  function fileKey(file) {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  function revokeEntry(entry) {
    if (entry?.url?.startsWith('blob:')) URL.revokeObjectURL(entry.url);
  }

  function revokeProjectFiles(project) {
    project?.messages?.forEach(message => (message.attachments || []).forEach(revokeEntry));
  }

  function clearAttachments() {
    [...state.photos, ...state.videos].forEach(revokeEntry);
    state.photos = [];
    state.videos = [];
    elements.photoInput.value = '';
    elements.videoInput.value = '';
    renderSelectedFiles();
    updateSendButton();
  }

  function addFiles(kind, fileList) {
    const isPhoto = kind === 'photo';
    const target = isPhoto ? state.photos : state.videos;
    const expectedPrefix = isPhoto ? 'image/' : 'video/';
    const maxSize = isPhoto ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
    const label = isPhoto ? 'foto' : 'vídeo';
    const existingKeys = new Set(target.map(entry => entry.key));
    let rejected = 0;

    for (const file of Array.from(fileList)) {
      if (target.length >= MAX_FILES_PER_TYPE) {
        rejected += 1;
        continue;
      }

      const key = fileKey(file);
      const validType = file.type.startsWith(expectedPrefix);
      const validSize = file.size > 0 && file.size <= maxSize;

      if (!validType || !validSize || existingKeys.has(key)) {
        rejected += 1;
        continue;
      }

      const entry = {
        id: createId('file'),
        key,
        kind,
        file,
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        type: file.type
      };
      target.push(entry);
      existingKeys.add(key);
    }

    if (rejected) {
      showToast(`Alguns arquivos foram ignorados. Use até 10 ${label}s e respeite o formato e o tamanho permitidos.`, 'error');
    }

    renderSelectedFiles();
    updateSendButton();
  }

  function allAttachments() {
    return [...state.photos, ...state.videos];
  }

  function removeAttachment(id) {
    const entry = allAttachments().find(item => item.id === id);
    if (!entry) return;
    revokeEntry(entry);
    state.photos = state.photos.filter(item => item.id !== id);
    state.videos = state.videos.filter(item => item.id !== id);
    renderSelectedFiles();
    updateSendButton();
  }

  function createPreview(entry, compact = false) {
    if (!entry.url) {
      const icon = document.createElement('span');
      icon.className = 'file-type-icon';
      icon.textContent = entry.kind === 'photo' ? '▧' : '▶';
      return icon;
    }

    if (entry.kind === 'photo') {
      const image = document.createElement('img');
      image.src = entry.url;
      image.alt = compact ? '' : `Prévia de ${entry.name}`;
      return image;
    }

    const video = document.createElement('video');
    video.src = entry.url;
    video.muted = true;
    video.preload = 'metadata';
    if (!compact) video.controls = true;
    video.setAttribute('playsinline', '');
    return video;
  }

  function renderSelectedFiles() {
    const attachments = allAttachments();
    elements.selectedFiles.replaceChildren();
    elements.attachmentStrip.replaceChildren();

    elements.fileInfo.textContent = attachments.length
      ? `${state.photos.length}/10 fotos • ${state.videos.length}/10 vídeos`
      : 'Nenhum arquivo selecionado.';

    for (const entry of attachments) {
      const row = document.createElement('div');
      row.className = 'selected-file-row';
      row.append(createPreview(entry, true));

      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const size = document.createElement('small');
      size.textContent = formatBytes(entry.size);
      details.append(name, size);

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'remove-file';
      removeButton.dataset.removeFile = entry.id;
      removeButton.setAttribute('aria-label', `Remover ${entry.name}`);
      removeButton.textContent = '×';
      row.append(details, removeButton);
      elements.selectedFiles.append(row);

      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      const chipName = document.createElement('span');
      chipName.textContent = entry.name;
      const chipRemove = document.createElement('button');
      chipRemove.type = 'button';
      chipRemove.dataset.removeFile = entry.id;
      chipRemove.setAttribute('aria-label', `Remover ${entry.name}`);
      chipRemove.textContent = '×';
      chip.append(chipName, chipRemove);
      elements.attachmentStrip.append(chip);
    }

    elements.attachmentStrip.hidden = attachments.length === 0;
  }

  function serializableAttachment(entry) {
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      size: entry.size,
      type: entry.type
    };
  }

  function persistProjects() {
    const cleanProjects = state.projects.map(project => ({
      ...project,
      messages: project.messages.map(message => ({
        ...message,
        attachments: (message.attachments || []).map(serializableAttachment)
      }))
    }));
    writeJson(STORAGE_KEY, cleanProjects);
  }

  function currentProject() {
    return state.projects.find(project => project.id === state.currentProjectId) || null;
  }

  function createProject(title) {
    const project = {
      id: createId('project'),
      title: title.slice(0, 46) || 'Projeto sem título',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    state.projects.unshift(project);
    state.currentProjectId = project.id;
    return project;
  }

  function newProject() {
    if (state.responseTimer) window.clearTimeout(state.responseTimer);
    state.responseTimer = null;
    state.currentProjectId = null;
    elements.conversation.replaceChildren();
    elements.welcomeCard.hidden = false;
    elements.generationStatus.hidden = true;
    elements.messageInput.value = '';
    autoResizeTextarea();
    clearAttachments();
    renderHistory();
    setSidebar(false);
    closePanels();
    elements.messageInput.focus();
  }

  function deleteProject(projectId) {
    const removedProject = state.projects.find(project => project.id === projectId);
    revokeProjectFiles(removedProject);
    state.projects = state.projects.filter(project => project.id !== projectId);
    if (state.currentProjectId === projectId) newProject();
    persistProjects();
    renderHistory();
    showToast('Projeto removido.');
  }

  function clearHistory() {
    if (!state.projects.length) {
      showToast('O histórico já está vazio.');
      return;
    }
    if (!window.confirm('Apagar todo o histórico salvo neste aparelho?')) return;
    state.projects.forEach(revokeProjectFiles);
    state.projects = [];
    persistProjects();
    newProject();
    showToast('Histórico apagado.');
  }

  function openProject(projectId) {
    const project = state.projects.find(item => item.id === projectId);
    if (!project) return;
    state.currentProjectId = projectId;
    elements.generationStatus.hidden = true;
    elements.welcomeCard.hidden = true;
    renderConversation();
    renderHistory();
    setSidebar(false);
    window.setTimeout(scrollToBottom, 0);
  }

  function renderHistory() {
    elements.historyList.replaceChildren();
    elements.historyEmpty.hidden = state.projects.length > 0;

    for (const project of state.projects) {
      const item = document.createElement('div');
      item.className = `history-item${project.id === state.currentProjectId ? ' active' : ''}`;

      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'history-open';
      openButton.dataset.openProject = project.id;
      const title = document.createElement('strong');
      title.textContent = project.title;
      const date = document.createElement('span');
      date.textContent = formatDate(project.updatedAt);
      openButton.append(title, date);

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'history-delete';
      deleteButton.dataset.deleteProject = project.id;
      deleteButton.setAttribute('aria-label', `Excluir ${project.title}`);
      deleteButton.textContent = '×';

      item.append(openButton, deleteButton);
      elements.historyList.append(item);
    }
  }

  function createActionButton(label, action, messageId, selected = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `message-action${selected ? ' selected' : ''}`;
    button.dataset.action = action;
    button.dataset.messageId = messageId;
    button.textContent = label;
    return button;
  }

  function renderMessage(message) {
    const article = document.createElement('article');
    article.className = `message ${message.role}`;
    article.dataset.messageId = message.id;

    const role = document.createElement('div');
    role.className = 'message-role';
    role.textContent = message.role === 'user' ? 'Você' : 'Assistente local';

    const text = document.createElement('p');
    text.className = 'message-text';
    text.textContent = message.text;
    article.append(role, text);

    if (message.settings) {
      const summary = document.createElement('div');
      summary.className = 'settings-summary';
      const labels = [
        message.settings.quality,
        `${message.settings.speed}x`,
        message.settings.theme,
        `${message.settings.duration}s`
      ];
      labels.forEach(value => {
        const tag = document.createElement('span');
        tag.textContent = value;
        summary.append(tag);
      });
      article.append(summary);
    }

    if (message.attachments?.length) {
      const grid = document.createElement('div');
      grid.className = 'message-attachments';
      message.attachments.forEach(entry => {
        const card = document.createElement('div');
        card.className = 'message-attachment';
        card.append(createPreview(entry));
        const name = document.createElement('span');
        name.className = 'attachment-name';
        name.textContent = entry.url ? entry.name : `${entry.name} — prévia disponível somente na sessão em que foi anexado`;
        card.append(name);

        if (entry.url) {
          const download = document.createElement('button');
          download.type = 'button';
          download.className = 'download-attachment';
          download.dataset.downloadFile = entry.id;
          download.dataset.messageId = message.id;
          download.textContent = 'Baixar arquivo';
          card.append(download);
        }
        grid.append(card);
      });
      article.append(grid);
    }

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.append(
      createActionButton('Copiar', 'copy', message.id),
      createActionButton('Compartilhar', 'share', message.id)
    );

    if (message.role === 'assistant') {
      actions.append(
        createActionButton('👍 Útil', 'like', message.id, message.feedback === 'like'),
        createActionButton('👎 Não útil', 'dislike', message.id, message.feedback === 'dislike')
      );
    }
    article.append(actions);
    return article;
  }

  function renderConversation() {
    const project = currentProject();
    elements.conversation.replaceChildren();
    if (!project) return;
    project.messages.forEach(message => elements.conversation.append(renderMessage(message)));
  }

  function findMessage(messageId) {
    const project = currentProject();
    return project?.messages.find(message => message.id === messageId) || null;
  }

  function buildLocalResponse(settings, attachments) {
    const attachmentText = attachments.length
      ? `${attachments.length} referência(s) anexada(s)`
      : 'nenhuma referência anexada';
    return [
      'Pedido organizado com sucesso.',
      '',
      `Configuração: ${settings.theme}, ${settings.duration}s, ${settings.quality}, velocidade ${settings.speed}x e ${attachmentText}.`,
      '',
      'Esta versão salva o projeto e prepara as informações localmente. Ela ainda não gera um vídeo real. Para receber um MP4, conecte o site a um backend com uma API de geração ou edição de vídeo.'
    ].join('\n');
  }

  function submitRequest() {
    if (state.responseTimer) {
      showToast('Aguarde o resumo do pedido atual.');
      return;
    }
    const text = elements.messageInput.value.trim();
    const attachments = allAttachments();
    if (!text && !attachments.length) return;

    const settings = getSettings();
    let project = currentProject();
    if (!project) project = createProject(text || attachments[0]?.name || 'Novo projeto');

    const runtimeAttachments = attachments.map(entry => ({ ...entry }));
    project.messages.push({
      id: createId('message'),
      role: 'user',
      text: text || 'Arquivos de referência enviados.',
      settings,
      attachments: runtimeAttachments,
      createdAt: Date.now()
    });
    project.updatedAt = Date.now();

    state.photos = [];
    state.videos = [];
    elements.photoInput.value = '';
    elements.videoInput.value = '';
    elements.messageInput.value = '';
    autoResizeTextarea();
    renderSelectedFiles();
    updateSendButton();
    closePanels();
    elements.welcomeCard.hidden = true;
    renderConversation();
    renderHistory();
    persistProjects();
    elements.generationStatus.hidden = false;
    updateSendButton();
    scrollToBottom();

    const projectId = project.id;
    state.responseTimer = window.setTimeout(() => {
      const targetProject = state.projects.find(item => item.id === projectId);
      state.responseTimer = null;
      if (!targetProject) {
        elements.generationStatus.hidden = true;
        updateSendButton();
        return;
      }
      targetProject.messages.push({
        id: createId('message'),
        role: 'assistant',
        text: buildLocalResponse(settings, runtimeAttachments),
        feedback: null,
        attachments: [],
        createdAt: Date.now()
      });
      targetProject.updatedAt = Date.now();
      if (state.currentProjectId === projectId) {
        elements.generationStatus.hidden = true;
        renderConversation();
        scrollToBottom();
      }
      renderHistory();
      persistProjects();
      updateSendButton();
    }, RESPONSE_DELAY);
  }

  function autoResizeTextarea() {
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 160)}px`;
    elements.characterCount.textContent = `${elements.messageInput.value.length}/2000`;
    updateSendButton();
  }

  function updateSendButton() {
    const hasContent = Boolean(elements.messageInput.value.trim()) || allAttachments().length > 0;
    elements.sendButton.disabled = !hasContent || Boolean(state.responseTimer);
  }

  function scrollToBottom() {
    elements.main.scrollTo({ top: elements.main.scrollHeight, behavior: 'smooth' });
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.setAttribute('readonly', '');
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand('copy');
    temporary.remove();
    if (!copied) throw new Error('Falha ao copiar');
  }

  async function shareMessage(message) {
    const shareData = {
      title: 'VideoIA Ultimate',
      text: message.text,
      url: window.location.href
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
    }

    await copyText(`${message.text}\n\n${window.location.href}`);
    showToast('Conteúdo copiado para compartilhar.');
  }

  function downloadAttachment(messageId, attachmentId) {
    const message = findMessage(messageId);
    const attachment = message?.attachments?.find(item => item.id === attachmentId);
    if (!attachment?.url) {
      showToast('Este arquivo não está mais disponível nesta sessão.', 'error');
      return;
    }
    const link = document.createElement('a');
    link.href = attachment.url;
    link.download = attachment.name || 'arquivo';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function handleMessageAction(button) {
    const message = findMessage(button.dataset.messageId);
    if (!message) return;

    try {
      if (button.dataset.action === 'copy') {
        await copyText(message.text);
        showToast('Texto copiado.');
      } else if (button.dataset.action === 'share') {
        await shareMessage(message);
      } else if (button.dataset.action === 'like' || button.dataset.action === 'dislike') {
        message.feedback = message.feedback === button.dataset.action ? null : button.dataset.action;
        persistProjects();
        renderConversation();
        showToast(message.feedback ? 'Feedback salvo.' : 'Feedback removido.');
      }
    } catch (error) {
      console.warn('Ação não concluída.', error);
      showToast('Não foi possível concluir essa ação.', 'error');
    }
  }

  elements.menuButton.addEventListener('click', () => {
    setSidebar(!elements.sidebar.classList.contains('open'));
  });
  elements.closeSidebarButton.addEventListener('click', () => setSidebar(false));
  elements.pageOverlay.addEventListener('click', () => setSidebar(false));
  elements.newProjectButton.addEventListener('click', newProject);
  elements.clearHistoryButton.addEventListener('click', clearHistory);

  elements.plusFab.addEventListener('click', event => {
    event.stopPropagation();
    setPanel('files', elements.filesPanel.hidden);
  });
  elements.settingsButton.addEventListener('click', event => {
    event.stopPropagation();
    setPanel('settings', elements.settingsPanel.hidden);
  });

  document.querySelectorAll('[data-close-panel]').forEach(button => {
    button.addEventListener('click', closePanels);
  });

  elements.photoTile.addEventListener('click', () => elements.photoInput.click());
  elements.videoTile.addEventListener('click', () => elements.videoInput.click());
  elements.photoInput.addEventListener('change', event => {
    addFiles('photo', event.target.files);
    event.target.value = '';
  });
  elements.videoInput.addEventListener('change', event => {
    addFiles('video', event.target.files);
    event.target.value = '';
  });

  elements.selectedFiles.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-file]');
    if (button) removeAttachment(button.dataset.removeFile);
  });
  elements.attachmentStrip.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-file]');
    if (button) removeAttachment(button.dataset.removeFile);
  });

  elements.messageInput.addEventListener('input', autoResizeTextarea);
  elements.messageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitRequest();
    }
  });
  elements.sendButton.addEventListener('click', submitRequest);

  [elements.qualidadeSelect, elements.velocidadeSelect, elements.temaSelect, elements.tempoSelect]
    .forEach(select => select.addEventListener('change', saveSettings));

  elements.historyList.addEventListener('click', event => {
    const openButton = event.target.closest('[data-open-project]');
    const deleteButton = event.target.closest('[data-delete-project]');
    if (openButton) openProject(openButton.dataset.openProject);
    if (deleteButton) deleteProject(deleteButton.dataset.deleteProject);
  });

  elements.conversation.addEventListener('click', event => {
    const actionButton = event.target.closest('[data-action]');
    const downloadButton = event.target.closest('[data-download-file]');
    if (actionButton) handleMessageAction(actionButton);
    if (downloadButton) {
      downloadAttachment(downloadButton.dataset.messageId, downloadButton.dataset.downloadFile);
    }
  });

  document.addEventListener('click', event => {
    const insidePanel = event.target.closest('.floating-panel');
    const panelButton = event.target.closest('#plusFab, #settingsButton');
    if (!insidePanel && !panelButton) closePanels();
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    setSidebar(false);
    closePanels();
  });

  window.addEventListener('beforeunload', () => {
    allAttachments().forEach(revokeEntry);
    state.projects.forEach(revokeProjectFiles);
  });

  loadSettings();
  renderHistory();
  renderSelectedFiles();
  autoResizeTextarea();
})();
