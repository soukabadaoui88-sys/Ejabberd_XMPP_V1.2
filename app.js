const { client, xml, jid } = window.XMPP;

// ============================================
// DOM ELEMENTS
// ============================================
const loginScreen        = document.getElementById('login-screen');
const mainInterface      = document.getElementById('main-interface');
const connectBtn         = document.getElementById('connect-btn');
const logoutBtn          = document.getElementById('logout-btn');
const sendBtn            = document.getElementById('send-btn');
const connectionStatus   = document.getElementById('connection-status');
const messagesDiv        = document.getElementById('messages');
const jidInput           = document.getElementById('jid');
const passwordInput      = document.getElementById('password');
const messageInput       = document.getElementById('message-input');
const currentUserSpan    = document.getElementById('current-user');
const conversationItems  = document.getElementById('conversation-items');
const contactItems       = document.getElementById('contact-items');
const currentContactName = document.getElementById('current-contact-name');
const contactStatusEl    = document.getElementById('contact-status');
const typingIndicator    = document.getElementById('typing-indicator');
const typingText         = document.getElementById('typing-text');
const attachBtn          = document.getElementById('attach-btn');
const fileInput          = document.getElementById('file-input');
const emojiPopup         = document.getElementById('emoji-popup');

// ============================================
// STATE
// ============================================
let xmppClient          = null;
let myBareJid           = null;
let currentConversation = null;
let conversations       = new Map();
let contacts            = new Map();
let messagesCache       = new Map();
let presenceQueue       = [];
let mamLoadedFor        = new Set();

// ---- NOUVELLES VARIABLES D'ÉTAT ----
let typingTimers        = new Map(); // jid → timer pour masquer l'indicateur
let typingTimeout       = null;      // timer pour arrêter d'envoyer "composing"
let isTyping            = false;     // est-ce qu'on est en train de taper ?
let messageReactions    = new Map(); // msgId → { emoji: Set(jids) } — chargé depuis localStorage
let activeEmojiMsgId    = null;      // msgId ciblé par le popup réaction
let readStatuses        = {};        // msgId → statut — chargé depuis localStorage

// ============================================
// CONFIGURATION
// ============================================
const SERVER_DOMAIN  = '192.168.11.125';
const API_URL        = `http://${SERVER_DOMAIN}:5280/api`;
const UPLOAD_URL     = `http://${SERVER_DOMAIN}:5280/upload`; // mod_http_upload

// ============================================
// UTILITIES
// ============================================

function formatTime(date) {
    return new Date(date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return formatTime(d);
    if (d.toDateString() === yesterday.toDateString()) return 'Hier';
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function bareJid(fullOrBare) {
    return fullOrBare ? fullOrBare.split('/')[0] : '';
}

function localPart(jidStr) {
    return jidStr ? jidStr.split('@')[0] : jidStr;
}

function getAvatarUrl(name, seed) {
    const colors = ['4CAF50','2196F3','9C27B0','FF5722','00BCD4','FF9800','E91E63','3F51B5'];
    let hash = 0;
    const str = seed || name;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const color = colors[Math.abs(hash) % colors.length];
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${color}&color=fff&size=64`;
}

function isImageUrl(url) {
    return /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(url);
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' o';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
    return (bytes / 1048576).toFixed(1) + ' Mo';
}

// ============================================
// SCROLL MANAGEMENT
// ============================================

function scrollToBottom(force = false) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    const isScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 50;
    if (force || isScrolledToBottom) container.scrollTop = container.scrollHeight;
}

let userHasScrolled = false;

function setupScrollDetection() {
    const container = document.getElementById('messages-container');
    if (!container) return;
    container.addEventListener('scroll', () => {
        const isAtBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 50;
        userHasScrolled = !isAtBottom;
    });
}

// ============================================
// PRESENCE HELPERS
// ============================================

function getPresenceDot(presence) {
    const color = presence === 'online' ? '#4CAF50' :
                  presence === 'away'   ? '#FF9800' :
                  presence === 'dnd'    ? '#f44336' :
                  presence === 'xa'     ? '#9C27B0' : '#9e9e9e';
    return `<i class="fas fa-circle" style="color:${color}; font-size:8px;"></i>`;
}

function getPresenceText(presence) {
    const map = { online:'En ligne', away:'Absent', xa:'Très absent', dnd:'Ne pas déranger', offline:'Hors ligne' };
    return map[presence] || 'Hors ligne';
}

// ============================================
// ★ FONCTIONNALITÉ 1 : INDICATEUR DE FRAPPE (XEP-0085)
// ============================================

// Envoyer stanza "composing" ou "paused"
function sendTypingState(state) {
    if (!xmppClient || !currentConversation) return;
    xmppClient.send(xml('message',
        { to: currentConversation, type: 'chat' },
        xml('composing' in { composing: 1, paused: 1 } ? state : 'paused',
            { xmlns: 'http://jabber.org/protocol/chatstates' })
    ));
}

// Quand l'utilisateur tape dans l'input
function handleTypingInput() {
    if (!isTyping) {
        isTyping = true;
        sendTypingState('composing');
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        isTyping = false;
        sendTypingState('paused');
    }, 3000);
}

// Afficher l'indicateur "X est en train d'écrire..."
function showTypingIndicator(fromJid) {
    const contact = contacts.get(fromJid);
    const name = contact ? contact.name : localPart(fromJid);
    typingText.textContent = `${name} est en train d'écrire`;
    typingIndicator.classList.remove('hidden');
    scrollToBottom();

    // Masquer après 5s si pas de nouveau signal
    if (typingTimers.has(fromJid)) clearTimeout(typingTimers.get(fromJid));
    const t = setTimeout(() => hideTypingIndicator(fromJid), 5000);
    typingTimers.set(fromJid, t);
}

function hideTypingIndicator(fromJid) {
    if (typingTimers.has(fromJid)) {
        clearTimeout(typingTimers.get(fromJid));
        typingTimers.delete(fromJid);
    }
    typingIndicator.classList.add('hidden');
}

// ============================================
// ★ FONCTIONNALITÉ 2 : ACCUSÉS DE RÉCEPTION (XEP-0184)
// ============================================

// Envoyer un accusé de réception quand on reçoit un message
function sendMessageReceipt(toJid, msgId) {
    if (!xmppClient || !msgId) return;
    xmppClient.send(xml('message',
        { to: toJid, id: 'receipt_' + Date.now() },
        xml('received', { xmlns: 'urn:xmpp:receipts', id: msgId })
    ));
}

// Mettre à jour le statut visuel d'un message envoyé + persister dans localStorage
function updateMessageStatus(msgId, status) {
    // Persister dans localStorage (ne rétrograde jamais : read > received > sent)
    Storage.saveReadStatus(msgId, status);
    readStatuses[msgId] = status;

    // Mettre à jour le DOM si le message est visible
    const el = document.querySelector(`[data-msg-id="${msgId}"] .msg-status`);
    if (!el) return;
    renderStatusIcon(el, status);
}

function renderStatusIcon(el, status) {
    if (status === 'sent')     el.innerHTML = '<i class="fas fa-check" title="Envoyé"></i>';
    if (status === 'received') el.innerHTML = '<i class="fas fa-check-double" title="Reçu"></i>';
    if (status === 'read')     el.innerHTML = '<i class="fas fa-check-double" style="color:#4CAF50" title="Lu"></i>';
}

// ============================================
// ★ FONCTIONNALITÉ 3 : ENVOI DE FICHIERS (XEP-0363)
// ============================================

async function requestUploadSlot(filename, filesize, contentType) {
    return new Promise((resolve, reject) => {
        if (!xmppClient) return reject(new Error('Non connecté'));

        const iqId = 'upload_' + Date.now();
        const timer = setTimeout(() => {
            xmppClient.removeListener('stanza', handler);
            reject(new Error('Upload slot timeout'));
        }, 10000);

        function handler(stanza) {
            if (stanza.is('iq') && stanza.attrs.id === iqId) {
                clearTimeout(timer);
                xmppClient.removeListener('stanza', handler);

                if (stanza.attrs.type === 'result') {
                    const slot = stanza.getChild('slot', 'urn:xmpp:http:upload:0');
                    if (slot) {
                        const putUrl = slot.getChild('put')?.attrs.url;
                        const getUrl = slot.getChild('get')?.attrs.url;
                        resolve({ putUrl, getUrl });
                    } else {
                        reject(new Error('Pas de slot dans la réponse'));
                    }
                } else {
                    const errText = stanza.getChild('error')?.getChildText('text') || 'Erreur upload';
                    reject(new Error(errText));
                }
            }
        }

        xmppClient.on('stanza', handler);
        xmppClient.send(xml('iq',
            { type: 'get', id: iqId, to: `upload.${SERVER_DOMAIN}` },
            // type: 'get', id: iqId, to: SERVER_DOMAIN },
            xml('request', { xmlns: 'urn:xmpp:http:upload:0', filename, size: String(filesize), 'content-type': contentType })
        ));
    });
}

async function uploadFile(file) {
    if (!currentConversation) {
        alert('Sélectionnez une conversation');
        return;
    }

    const maxSize = 20 * 1024 * 1024; // 20 Mo
    if (file.size > maxSize) {
        alert('Fichier trop volumineux (max 20 Mo)');
        return;
    }

    // Afficher un message "envoi en cours"
    const loadingId = 'upload_loading_' + Date.now();
    const loadingEl = document.createElement('div');
    loadingEl.id = loadingId;
    loadingEl.className = 'message outgoing';
    loadingEl.innerHTML = `
        <div class="meta">Moi</div>
        <div class="message-body file-uploading">
            <i class="fas fa-spinner fa-spin"></i> Envoi de <b>${file.name}</b>...
        </div>`;
    messagesDiv.appendChild(loadingEl);
    scrollToBottom(true);

    try {
        // 1. Demander un slot d'upload à ejabberd
        const { putUrl, getUrl } = await requestUploadSlot(file.name, file.size, file.type);

        // 2. Uploader le fichier via HTTP PUT
        const uploadResponse = await fetch(putUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type },
            body: file
        });

        if (!uploadResponse.ok) throw new Error(`Erreur HTTP upload: ${uploadResponse.status}`);

        // 3. Supprimer le message "en cours"
        loadingEl.remove();

        // 4. Envoyer le lien dans le chat
        const msgId = 'msg_' + Date.now();
        await xmppClient.send(xml('message',
            { to: currentConversation, type: 'chat', id: msgId },
            xml('body', {}, getUrl),
            xml('request', { xmlns: 'urn:xmpp:receipts' }),
            xml('x', { xmlns: 'jabber:x:oob' },
                xml('url', {}, getUrl),
                xml('desc', {}, file.name)
            )
        ));

        const msgObj = {
            id: msgId,
            from: myBareJid,
            body: getUrl,
            outgoing: true,
            archive: false,
            timestamp: new Date(),
            fileName: file.name,
            fileSize: file.size
        };

        cacheMessage(currentConversation, msgObj);
        renderMessage(msgObj);
        upsertConversation(currentConversation, `📎 ${file.name}`, new Date(), 0);
        renderConversations();

    } catch (err) {
        loadingEl.remove();
        console.error(' Erreur upload:', err);
        alert('Erreur envoi fichier: ' + err.message + '\n\nVérifiez que mod_http_upload est activé sur ejabberd.');
    }
}

// ============================================
// ★ FONCTIONNALITÉ 4 : RÉACTIONS EMOJI
// ============================================

function showEmojiPopup(msgEl, msgId) {
    activeEmojiMsgId = msgId;

    msgEl.appendChild(emojiPopup);
    emojiPopup.classList.remove('hidden');
}

function hideEmojiPopup() {
    emojiPopup.classList.add('hidden');
    // Remettre le popup dans le body pour éviter les conflits
    document.body.appendChild(emojiPopup);
    activeEmojiMsgId = null;
}

function sendReaction(emoji) {
    if (!activeEmojiMsgId || !currentConversation || !xmppClient) return;

    // Envoyer la réaction via XMPP (message avec body spécial)
    xmppClient.send(xml('message',
        { to: currentConversation, type: 'chat', id: 'reaction_' + Date.now() },
        xml('reaction', { xmlns: 'urn:xmpp:reactions:0', id: activeEmojiMsgId },
            xml('emoji', {}, emoji)
        ),
        xml('store', { xmlns: 'urn:xmpp:hints' })
    ));

    // Appliquer localement
    addReactionToMessage(activeEmojiMsgId, emoji, myBareJid);
    hideEmojiPopup();
}

function addReactionToMessage(msgId, emoji, fromJid) {
    // Mettre à jour la Map en mémoire ET persister dans localStorage
    messageReactions = Storage.addReaction(messageReactions, msgId, emoji, fromJid);
    renderReactionsForMessage(msgId);
}

function renderReactionsForMessage(msgId) {
    const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!msgEl) return;

    let reactionsBar = msgEl.querySelector('.reactions-bar');
    if (!reactionsBar) {
        reactionsBar = document.createElement('div');
        reactionsBar.className = 'reactions-bar';
        msgEl.appendChild(reactionsBar);
    }

    const reactions = messageReactions.get(msgId);
    if (!reactions || reactions.size === 0) {
        reactionsBar.innerHTML = '';
        return;
    }

    reactionsBar.innerHTML = Array.from(reactions.entries())
        .map(([emoji, jids]) => `
            <span class="reaction-pill" title="${Array.from(jids).map(localPart).join(', ')}">
                ${emoji} <span class="reaction-count">${jids.size}</span>
            </span>`)
        .join('');
}

// ============================================
// MESSAGES MANAGEMENT
// ============================================

function renderMessage({ id, from, body, outgoing, archive, timestamp, fileName, fileSize }) {
    const el = document.createElement('div');
    el.className = `message ${outgoing ? 'outgoing' : 'incoming'}${archive ? ' archive' : ''}`;
    if (id) el.setAttribute('data-msg-id', id);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = outgoing ? 'Moi' : localPart(from);

    const content = document.createElement('div');
    content.className = 'message-body';

    // Rendu selon le type de contenu
    if (isImageUrl(body)) {
        // Image
        const img = document.createElement('img');
        img.src = body;
        img.className = 'msg-image';
        img.alt = fileName || 'image';
        img.onclick = () => window.open(body, '_blank');
        content.appendChild(img);
    } else if (fileName) {
        // Fichier non-image
        content.innerHTML = `
            <div class="file-attachment">
                <i class="fas fa-file"></i>
                <div class="file-info">
                    <a href="${body}" target="_blank" class="file-name">${fileName}</a>
                    ${fileSize ? `<span class="file-size">${formatFileSize(fileSize)}</span>` : ''}
                </div>
                <a href="${body}" download="${fileName}" class="file-download">
                    <i class="fas fa-download"></i>
                </a>
            </div>`;
    } else if (body.startsWith('http://') || body.startsWith('https://')) {
        // Lien générique (fichier reçu sans métadonnées)
        if (isImageUrl(body)) {
            const img = document.createElement('img');
            img.src = body;
            img.className = 'msg-image';
            img.onclick = () => window.open(body, '_blank');
            content.appendChild(img);
        } else {
            content.innerHTML = `
                <div class="file-attachment">
                    <i class="fas fa-file"></i>
                    <div class="file-info">
                        <a href="${body}" target="_blank" class="file-name">${body.split('/').pop() || 'Fichier'}</a>
                    </div>
                    <a href="${body}" target="_blank" class="file-download">
                        <i class="fas fa-external-link-alt"></i>
                    </a>
                </div>`;
        }
    } else {
        content.textContent = body;
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'time';

    // Accusé de réception pour messages sortants — restaurer depuis localStorage
    if (outgoing && id) {
        const savedStatus = Storage.getReadStatus(id);
        const statusEl = document.createElement('span');
        statusEl.className = 'msg-status';
        renderStatusIcon(statusEl, savedStatus);
        timeEl.innerHTML = formatTime(timestamp || new Date());
        timeEl.appendChild(statusEl);
    } else {
        timeEl.innerHTML = formatTime(timestamp || new Date());
    }

    el.appendChild(meta);
    el.appendChild(content);
    el.appendChild(timeEl);

    // Bouton réaction (apparaît au hover)
    const reactBtn = document.createElement('button');
    reactBtn.className = 'react-btn';
    reactBtn.innerHTML = '<i class="far fa-smile-beam"></i>';
    reactBtn.title = 'Réagir';
    reactBtn.onclick = (e) => {
        e.stopPropagation();
        const msgId = el.getAttribute('data-msg-id');
        if (msgId) showEmojiPopup(el, msgId);
    };
    el.appendChild(reactBtn);

    messagesDiv.appendChild(el);

    // Rendu des réactions existantes
    if (id && messageReactions.has(id)) renderReactionsForMessage(id);

    const isRecent = Math.abs(new Date() - new Date(timestamp)) < 5000;
    if (isRecent || (!archive && !userHasScrolled)) scrollToBottom(true);
}

function clearMessages() {
    messagesDiv.innerHTML = '';
}

function cacheMessage(peerJid, msgObj) {
    if (!messagesCache.has(peerJid)) messagesCache.set(peerJid, []);
    messagesCache.get(peerJid).push(msgObj);
}

// ============================================
// CONTACTS MANAGEMENT
// ============================================

async function loadAllEjabberdUsers() {
    try {
        const response = await fetch(`${API_URL}/registered_users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: SERVER_DOMAIN })
        });

        if (!response.ok) throw new Error(`API erreur: ${response.status}`);

        const users = await response.json();
        const allJids = users.map(u => `${u}@${SERVER_DOMAIN}`).filter(j => j !== myBareJid);

        contacts.clear();
        allJids.forEach(j => {
            const name = localPart(j);
            contacts.set(j, { jid: j, name, presence: 'offline', avatar: getAvatarUrl(name, j), lastSeen: null });
        });

        try { await loadRoster(); } catch(e) { console.warn('Roster non disponible'); }

        presenceQueue.forEach(({ from, presence }) => {
            const c = contacts.get(from);
            if (c) c.presence = presence;
        });
        presenceQueue = [];

        renderContacts();
        renderConversations();
    } catch (error) {
        console.error(' Erreur chargement utilisateurs:', error);
        if (contactItems) contactItems.innerHTML = '<div class="loading">Impossible de charger les contacts.</div>';
    }
}

function updateContactPresence(jid, presence) {
    const contact = contacts.get(jid);
    if (contact) { contact.presence = presence; contact.lastSeen = new Date(); }
    renderContacts();
    if (currentConversation === jid) updateChatHeader(jid);
    renderConversations();
}

function renderContacts() {
    if (!contactItems) return;
    const sorted = Array.from(contacts.values()).sort((a, b) => {
        const order = { online:0, away:1, dnd:2, xa:3, offline:4 };
        const pa = order[a.presence] ?? 4, pb = order[b.presence] ?? 4;
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
    });

    if (sorted.length === 0) { contactItems.innerHTML = '<div class="loading">Aucun utilisateur trouvé</div>'; return; }

    contactItems.innerHTML = sorted.map(c => `
        <div class="conversation-item${currentConversation === c.jid ? ' active' : ''}" data-jid="${c.jid}">
            <div class="conversation-avatar" style="position:relative">
                <img src="${c.avatar}" alt="${c.name}">
                <span class="presence-dot ${c.presence !== 'offline' ? 'online' : 'offline'}"></span>
            </div>
            <div class="conversation-info">
                <span class="conversation-name">${c.name}</span>
                <span class="conversation-last-message" style="display:flex;align-items:center;gap:4px">
                    ${getPresenceDot(c.presence)} ${getPresenceText(c.presence)}
                </span>
            </div>
        </div>`).join('');

    contactItems.querySelectorAll('.conversation-item').forEach(el => {
        el.addEventListener('click', () => selectConversation(el.dataset.jid));
    });
}

// ============================================
// ROSTER MANAGEMENT
// ============================================

function loadRoster() {
    return new Promise((resolve, reject) => {
        const rqId = 'roster_' + Date.now();
        const timer = setTimeout(() => { xmppClient.removeListener('stanza', handler); reject(new Error('Roster timeout')); }, 6000);

        function handler(stanza) {
            if (stanza.is('iq') && stanza.attrs.id === rqId) {
                clearTimeout(timer);
                xmppClient.removeListener('stanza', handler);
                if (stanza.attrs.type === 'result') {
                    const query = stanza.getChild('query', 'jabber:iq:roster');
                    if (query) {
                        query.getChildren('item').forEach(item => {
                            const j = item.attrs.jid;
                            if (!contacts.has(j) && j !== myBareJid) {
                                const name = item.attrs.name || localPart(j);
                                contacts.set(j, { jid:j, name, presence:'offline', avatar:getAvatarUrl(name,j), lastSeen:null });
                            }
                        });
                    }
                    resolve();
                } else { reject(new Error('Roster error')); }
            }
        }

        xmppClient.on('stanza', handler);
        xmppClient.send(xml('iq', { type:'get', id:rqId }, xml('query', { xmlns:'jabber:iq:roster' })));
    });
}

// ============================================
// CONVERSATIONS MANAGEMENT
// ============================================

function upsertConversation(jid, lastMessage, lastTime, unreadDelta = 0) {
    const contact = contacts.get(jid);
    const name = contact?.name || localPart(jid);
    const avatar = contact?.avatar || getAvatarUrl(name, jid);
    const existing = conversations.get(jid);
    const newUnread = existing ? existing.unread + (unreadDelta || 0) : (unreadDelta || 0);
    conversations.set(jid, {
        jid, name, avatar,
        lastMessage: lastMessage !== undefined ? lastMessage : (existing?.lastMessage || ''),
        lastTime: lastTime || existing?.lastTime || new Date(),
        unread: newUnread > 0 ? newUnread : 0
    });
}

function renderConversations() {
    if (!conversationItems) return;
    const sorted = Array.from(conversations.values()).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));

    if (sorted.length === 0) {
        conversationItems.innerHTML = '<div class="loading" style="color:rgba(255,255,255,0.5)">Aucune conversation</div>';
        return;
    }

    conversationItems.innerHTML = sorted.map(c => {
        const contact = contacts.get(c.jid);
        const presence = contact?.presence || 'offline';
        return `
        <div class="conversation-item${currentConversation === c.jid ? ' active' : ''}" data-jid="${c.jid}">
            <div class="conversation-avatar" style="position:relative">
                <img src="${c.avatar}" alt="${c.name}">
                <span class="presence-dot ${presence !== 'offline' ? 'online' : 'offline'}"></span>
            </div>
            <div class="conversation-info">
                <span class="conversation-name">${c.name}</span>
                <span class="conversation-last-message">${c.lastMessage || '...'}</span>
            </div>
            <div class="conversation-meta">
                <span class="conversation-time">${formatDate(c.lastTime)}</span>
                ${c.unread > 0 ? `<span class="unread-badge">${c.unread}</span>` : ''}
            </div>
        </div>`;
    }).join('');

    conversationItems.querySelectorAll('.conversation-item').forEach(el => {
        el.addEventListener('click', () => selectConversation(el.dataset.jid));
    });
}

// ============================================
// SELECT CONVERSATION
// ============================================

async function selectConversation(jid) {
    if (!jid) return;
    currentConversation = jid;
    userHasScrolled = false;
    hideTypingIndicator(jid);

    const conv = conversations.get(jid);
    if (conv) conv.unread = 0;

    updateChatHeader(jid);
    renderConversations();
    renderContacts();
    clearMessages();

    const loadingEl = document.createElement('div');
    loadingEl.className = 'message incoming archive';
    loadingEl.innerHTML = '<div class="message-body"> Chargement de l\'historique...</div>';
    messagesDiv.appendChild(loadingEl);

    if (!mamLoadedFor.has(jid)) {
        try { await loadChatHistory(jid, 100); mamLoadedFor.add(jid); }
        catch (error) { console.warn('MAM indisponible:', error.message); }
    }

    loadingEl.remove();

    const cached = (messagesCache.get(jid) || []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (cached.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'empty-conv';
        emptyEl.textContent = 'Aucun message. Commencez la conversation !';
        messagesDiv.appendChild(emptyEl);
    } else {
        cached.forEach(msg => renderMessage(msg));
    }

    setTimeout(() => scrollToBottom(true), 100);
}

function updateChatHeader(jid) {
    const contact = contacts.get(jid);
    if (!contact) return;
    currentContactName.textContent = contact.name;
    contactStatusEl.innerHTML = `${getPresenceDot(contact.presence)} ${getPresenceText(contact.presence)}`;
    const headerAvatar = document.querySelector('.contact-avatar img');
    if (headerAvatar) headerAvatar.src = contact.avatar;
}

// ============================================
// MAM (historique)
// ============================================

async function loadChatHistory(withUser, limit = 50) {
    return new Promise((resolve, reject) => {
        if (!xmppClient) return reject(new Error('Non connecté'));

        const queryId = 'mam_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const queryEl = xml('query', { xmlns:'urn:xmpp:mam:2', queryid:queryId });
        const xEl = xml('x', { xmlns:'jabber:x:data', type:'submit' });
        xEl.append(xml('field', { var:'FORM_TYPE' }, xml('value', {}, 'urn:xmpp:mam:2')));
        xEl.append(xml('field', { var:'with' }, xml('value', {}, withUser)));
        queryEl.append(xEl);
        const setEl = xml('set', { xmlns:'http://jabber.org/protocol/rsm' });
        setEl.append(xml('max', {}, String(limit)));
        setEl.append(xml('before', {}));
        queryEl.append(setEl);

        const timer = setTimeout(() => { xmppClient.removeListener('stanza', handler); resolve(); }, 8000);

        function handler(stanza) {
            if (stanza.is('iq') && stanza.attrs.id === queryId) {
                clearTimeout(timer);
                xmppClient.removeListener('stanza', handler);
                stanza.attrs.type === 'result' ? resolve() : reject(new Error('MAM error'));
            }
        }

        xmppClient.on('stanza', handler);
        xmppClient.send(xml('iq', { type:'set', id:queryId }, queryEl));
    });
}

// ============================================
// SEND MESSAGE
// ============================================

async function sendMessage() {
    if (!currentConversation) { alert('Sélectionnez une conversation'); return; }
    const text = messageInput.value.trim();
    if (!text) return;

    // Arrêter l'indicateur de frappe
    isTyping = false;
    clearTimeout(typingTimeout);
    sendTypingState('paused');

    try {
        const msgId = 'msg_' + Date.now();

        // Inclure XEP-0184 request dans chaque message envoyé
        await xmppClient.send(xml('message',
            { to: currentConversation, type: 'chat', id: msgId },
            xml('body', {}, text),
            xml('request', { xmlns: 'urn:xmpp:receipts' })
        ));

        const msgObj = { id: msgId, from: myBareJid, body: text, outgoing: true, archive: false, timestamp: new Date() };
        cacheMessage(currentConversation, msgObj);
        renderMessage(msgObj);
        upsertConversation(currentConversation, text, new Date(), 0);
        const conv = conversations.get(currentConversation);
        if (conv) { conv.lastMessage = text; conv.lastTime = new Date(); }
        renderConversations();
        messageInput.value = '';
        userHasScrolled = false;

    } catch (err) {
        console.error('Erreur envoi:', err);
        alert('Erreur envoi: ' + err.message);
    }
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });

// Écouter la frappe dans l'input (XEP-0085)
messageInput.addEventListener('input', handleTypingInput);

// ============================================
// GESTION FICHIERS
// ============================================

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fileInput.value = ''; // reset pour permettre re-sélection du même fichier
    await uploadFile(file);
});

// Drag & drop sur la zone de messages
document.getElementById('messages-container')?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
});

document.getElementById('messages-container')?.addEventListener('dragleave', (e) => {
    e.currentTarget.classList.remove('drag-over');
});

document.getElementById('messages-container')?.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) await uploadFile(file);
});

// ============================================
// POPUP RÉACTIONS
// ============================================

emojiPopup.querySelectorAll('.emoji-reaction').forEach(btn => {
    btn.addEventListener('click', () => sendReaction(btn.dataset.emoji));
});

document.addEventListener('click', (e) => {
    if (!emojiPopup.contains(e.target) && !e.target.closest('.react-btn')) {
        hideEmojiPopup();
    }
});

// ============================================
// STANZA HANDLER
// ============================================

function handleStanza(stanza) {

    // ---- MESSAGES ----
    if (stanza.is('message')) {
        const from = bareJid(stanza.attrs.from || '');
        const type = stanza.attrs.type;
        const msgId = stanza.attrs.id;

        // MAM
        const result = stanza.getChild('result', 'urn:xmpp:mam:2');
        if (result) { handleMAMMessage(result, from); return; }

        // ★ XEP-0184 : accusé de réception reçu (notre message a été reçu)
        const received = stanza.getChild('received', 'urn:xmpp:receipts');
        if (received) {
            updateMessageStatus(received.attrs.id, 'received');
            return;
        }

        // ★ XEP-0085 : indicateur de frappe
        const composing = stanza.getChild('composing', 'http://jabber.org/protocol/chatstates');
        const paused    = stanza.getChild('paused',    'http://jabber.org/protocol/chatstates');
        const active    = stanza.getChild('active',    'http://jabber.org/protocol/chatstates');
        const inactive  = stanza.getChild('inactive',  'http://jabber.org/protocol/chatstates');
        const gone      = stanza.getChild('gone',      'http://jabber.org/protocol/chatstates');

        if (composing && from !== myBareJid && currentConversation === from) {
            showTypingIndicator(from);
            return;
        }
        if ((paused || active || inactive || gone) && from !== myBareJid) {
            hideTypingIndicator(from);
            // ne pas return — active peut accompagner un vrai message
            if (paused || inactive || gone) return;
        }

        // ★ Réactions emoji
        const reaction = stanza.getChild('reaction', 'urn:xmpp:reactions:0');
        if (reaction) {
            const targetId = reaction.attrs.id;
            const emoji = reaction.getChildText('emoji');
            if (targetId && emoji && from !== myBareJid) {
                addReactionToMessage(targetId, emoji, from);
            }
            return;
        }

        const body = stanza.getChildText('body');
        if (!body || type === 'error' || !from || from === myBareJid) return;

        // Dédup
        const cached = messagesCache.get(from) || [];
        if (cached.some(m => m.body === body && !m.outgoing && Math.abs(new Date(m.timestamp) - Date.now()) < 3000)) return;

        // ★ XEP-0184 : envoyer accusé de réception
        if (msgId) sendMessageReceipt(from, msgId);

        // Masquer l'indicateur de frappe quand le message arrive
        hideTypingIndicator(from);

        // Détecter si c'est un fichier (OOB)
        const oob = stanza.getChild('x', 'jabber:x:oob');
        const msgObj = {
            id: msgId,
            from,
            body,
            outgoing: false,
            archive: false,
            timestamp: new Date(),
            fileName: oob ? oob.getChildText('desc') : null
        };

        cacheMessage(from, msgObj);

        if (!contacts.has(from)) {
            const name = localPart(from);
            contacts.set(from, { jid:from, name, presence:'online', avatar:getAvatarUrl(name,from), lastSeen:new Date() });
        }

        const isActive = currentConversation === from;
        const displayBody = oob ? `📎 ${oob.getChildText('desc') || 'Fichier'}` : body;

        upsertConversation(from, displayBody, new Date(), isActive ? 0 : 1);
        const conv = conversations.get(from);
        if (conv) { conv.lastMessage = displayBody; conv.lastTime = new Date(); }
        renderConversations();

        if (isActive) renderMessage(msgObj);
        else notifyNewMessage(from);
    }

    // ---- PRESENCE ----
    if (stanza.is('presence')) {
        const from = bareJid(stanza.attrs.from || '');
        const type = stanza.attrs.type || 'available';
        const show = stanza.getChildText('show') || '';

        if (!from || from === myBareJid) return;

        if (type === 'subscribe') {
            xmppClient.send(xml('presence', { to: from, type: 'subscribed' }));
            xmppClient.send(xml('presence', { to: from, type: 'subscribe' }));
            return;
        }

        let presence;
        if (type === 'unavailable') {
            presence = 'offline';
            hideTypingIndicator(from); // cacher l'indicateur si contact déconnecté
        } else if (type === 'available') {
            presence = show || 'online';
        } else { return; }

        presenceQueue = presenceQueue.filter(p => p.from !== from);

        if (contacts.has(from)) updateContactPresence(from, presence);
        else presenceQueue.push({ from, presence });
    }

    // ---- ROSTER UPDATES ----
    if (stanza.is('iq') && stanza.attrs.type === 'set') {
        const query = stanza.getChild('query', 'jabber:iq:roster');
        if (query) {
            query.getChildren('item').forEach(item => {
                const j = item.attrs.jid;
                if (item.attrs.subscription === 'remove') {
                    contacts.delete(j);
                } else if (!contacts.has(j) && j !== myBareJid) {
                    const name = item.attrs.name || localPart(j);
                    contacts.set(j, { jid:j, name, presence:'offline', avatar:getAvatarUrl(name,j), lastSeen:null });
                }
            });
            renderContacts();
            xmppClient.send(xml('iq', { type:'result', id:stanza.attrs.id }));
        }
    }
}

function handleMAMMessage(result, from) {
    const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
    if (!forwarded) return;
    const innerMsg = forwarded.getChild('message');
    if (!innerMsg) return;
    const body = innerMsg.getChildText('body');
    if (!body) return;

    const delay = forwarded.getChild('delay', 'urn:xmpp:delay');
    const timestamp = delay ? new Date(delay.attrs.stamp) : new Date();
    const msgFrom = bareJid(innerMsg.attrs.from || '');
    const msgTo   = bareJid(innerMsg.attrs.to || '');
    const outgoing = msgFrom === myBareJid;
    const peer = outgoing ? msgTo : msgFrom;
    if (!peer || peer === myBareJid) return;

    const cached = messagesCache.get(peer) || [];
    if (cached.some(m => m.body === body && m.outgoing === outgoing && Math.abs(new Date(m.timestamp) - timestamp) < 2000)) return;

    const oob = innerMsg.getChild('x', 'jabber:x:oob');
    const msgObj = {
        id: innerMsg.attrs.id,
        from: msgFrom, body, outgoing, archive: true, timestamp,
        fileName: oob ? oob.getChildText('desc') : null
    };
    cacheMessage(peer, msgObj);

    const displayBody = oob ? `📎 ${oob.getChildText('desc') || 'Fichier'}` : body;
    upsertConversation(peer, displayBody, timestamp, 0);
    const conv = conversations.get(peer);
    if (conv) { conv.lastMessage = displayBody; conv.lastTime = timestamp; }
    renderConversations();
    if (currentConversation === peer) renderMessage(msgObj);
}

function notifyNewMessage(fromJid) {
    const original = document.title;
    let flashing = true;
    const interval = setInterval(() => {
        document.title = flashing ? '💬 Nouveau message !' : original;
        flashing = !flashing;
    }, 800);
    window.addEventListener('focus', () => { clearInterval(interval); document.title = original; }, { once: true });
}

// ============================================
// ADD CONTACT
// ============================================

document.querySelector('.btn-add-contact')?.addEventListener('click', () => {
    if (!xmppClient) return alert('Non connecté');
    const jidStr = prompt('JID du contact (ex: nom@192.168.11.125)');
    if (!jidStr || !jidStr.includes('@')) return;
    xmppClient.send(xml('presence', { to: jidStr, type: 'subscribe' }));
    const name = localPart(jidStr);
    contacts.set(jidStr, { jid:jidStr, name, presence:'offline', avatar:getAvatarUrl(name,jidStr), lastSeen:null });
    renderContacts();
    alert(`Demande d'abonnement envoyée à ${name}`);
});

// ============================================
// SEARCH FILTER
// ============================================

document.querySelectorAll('.search-input').forEach(input => {
    input.addEventListener('input', () => {
        const q = input.value.toLowerCase();
        const list = input.closest('.conversations-list, .contacts-list');
        if (!list) return;
        list.querySelectorAll('.conversation-item').forEach(el => {
            const name = el.querySelector('.conversation-name')?.textContent.toLowerCase() || '';
            el.style.display = name.includes(q) ? '' : 'none';
        });
    });
});

// ============================================
// TAB MANAGEMENT
// ============================================

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.querySelectorAll('.conversations-list, .contacts-list').forEach(el => el.classList.remove('active'));
        document.getElementById(`${tab}-list`).classList.add('active');
    });
});

// ============================================
// POLLING PRÉSENCE
// ============================================

let presencePollingInterval = null;

function startPresencePolling() {
    stopPresencePolling();
    presencePollingInterval = setInterval(() => {
        if (xmppClient) xmppClient.send(xml('presence'));
    }, 30000);
}

function stopPresencePolling() {
    if (presencePollingInterval) { clearInterval(presencePollingInterval); presencePollingInterval = null; }
}

// ============================================
// CONNECTION
// ============================================

connectBtn.addEventListener('click', async () => {
    const fullJid = jidInput.value.trim();
    const password = passwordInput.value.trim();
    if (!fullJid || !password) { alert('Veuillez remplir tous les champs'); return; }

    connectionStatus.textContent = 'Connexion en cours...';
    connectionStatus.style.color = '#4CAF50';
    connectBtn.disabled = true;

    try {
        const jidParts = jid(fullJid);
        myBareJid = `${jidParts.local}@${jidParts.domain}`;

        xmppClient = client({
            service: 'ws://localhost:5443/ws',
            domain: jidParts.domain,
            resource: 'web-client',
            username: jidParts.local,
            password: password,
            mechanisms: ['PLAIN', 'SCRAM-SHA-1']
        });

        xmppClient.reconnect.stop();

        xmppClient.on('status', (status) => {
            connectionStatus.textContent = `Status: ${status}`;
        });

        xmppClient.on('error', async (err) => {
            connectionStatus.textContent = `Erreur: ${err.message}`;
            connectionStatus.style.color = '#f44336';
            try { await xmppClient.stop(); } catch(e) {}
            connectBtn.disabled = false;
        });

        xmppClient.on('online', async (address) => {
            myBareJid = bareJid(address.toString());

            loginScreen.classList.add('hidden');
            mainInterface.classList.remove('hidden');
            currentUserSpan.textContent = localPart(myBareJid);

            const avatarImg = document.querySelector('.user-profile .avatar img');
            if (avatarImg) avatarImg.src = getAvatarUrl(localPart(myBareJid), myBareJid);

            xmppClient.send(xml('iq', { type:'set', id:'carbons1' },
                xml('enable', { xmlns:'urn:xmpp:carbons:2' })
            ));

            // ★ Initialiser le storage et charger les données persistées
            Storage.init(myBareJid);
            messageReactions = Storage.loadReactions();
            readStatuses     = Storage.loadReadStatuses();
            console.log(`💾 ${Object.keys(readStatuses).length} statuts et ${messageReactions.size} réactions restaurés`);

            setupScrollDetection();
            await loadAllEjabberdUsers();
            await xmppClient.send(xml('presence'));
            startPresencePolling();
            // Découvrir le service upload au démarrage
            window._uploadService = await discoverUploadService();
            console.log('📤 Upload service:', window._uploadService);
        });

        xmppClient.on('offline', () => {
            stopPresencePolling();
            loginScreen.classList.remove('hidden');
            mainInterface.classList.add('hidden');
            connectBtn.disabled = false;
            conversations.clear(); contacts.clear(); messagesCache.clear();
            mamLoadedFor.clear(); presenceQueue = []; currentConversation = null;
            typingTimers.clear(); isTyping = false;
        });

        xmppClient.on('stanza', handleStanza);
        await xmppClient.start();

    } catch (err) {
        connectionStatus.textContent = `Erreur: ${err.message}`;
        connectionStatus.style.color = '#f44336';
        connectBtn.disabled = false;
        if (xmppClient) { try { await xmppClient.stop(); } catch(e) {} }
    }
});

// ============================================
// LOGOUT
// ============================================

logoutBtn.addEventListener('click', async () => {
    stopPresencePolling();
    isTyping = false;
    clearTimeout(typingTimeout);

    if (xmppClient) {
        try {
            await xmppClient.send(xml('presence', { type: 'unavailable' }));
            await xmppClient.stop();
        } catch(e) {}
    }

    conversations.clear(); contacts.clear(); messagesCache.clear();
    mamLoadedFor.clear(); presenceQueue = []; currentConversation = null;
    typingTimers.clear();
    connectBtn.disabled = false;
});

window.selectConversation = selectConversation;











async function discoverUploadService() {
    return new Promise((resolve) => {
        if (!xmppClient) return resolve(SERVER_DOMAIN);

        const iqId = 'disco_' + Date.now();
        const timer = setTimeout(() => {
            xmppClient.removeListener('stanza', handler);
            resolve(SERVER_DOMAIN); // fallback
        }, 5000);

        function handler(stanza) {
            if (stanza.is('iq') && stanza.attrs.id === iqId) {
                clearTimeout(timer);
                xmppClient.removeListener('stanza', handler);

                const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#items');
                if (query) {
                    const items = query.getChildren('item');
                    for (const item of items) {
                        const jidVal = item.attrs.jid || '';
                        if (jidVal.startsWith('upload.')) {
                            console.log(' Service upload trouvé:', jidVal);
                            resolve(jidVal);
                            return;
                        }
                    }
                }
                resolve(SERVER_DOMAIN); // fallback si pas trouvé
            }
        }

        xmppClient.on('stanza', handler);
        xmppClient.send(xml('iq',
            { type: 'get', id: iqId, to: SERVER_DOMAIN },
            xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' })
        ));
    });
}
