// ============================================
// STORAGE.JS — Persistance localStorage
// Réactions emoji + Statuts de lecture
// Clé de namespace : xmpp_{userJid}_{type}
// ============================================

const Storage = (() => {

    let _userJid = null;

    // ---- INIT ----
    function init(userJid) {
        _userJid = userJid;
        console.log(`💾 Storage initialisé pour ${userJid}`);
    }

    function key(type) {
        return `xmpp_${_userJid}_${type}`;
    }

    function readJSON(k, fallback) {
        try {
            const raw = localStorage.getItem(k);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            console.warn('Storage read error:', e);
            return fallback;
        }
    }

    function writeJSON(k, value) {
        try {
            localStorage.setItem(k, JSON.stringify(value));
        } catch (e) {
            // localStorage plein (quota) — nettoyer les anciennes entrées
            console.warn('Storage write error (quota?), cleaning old data...', e);
            cleanOldData();
            try { localStorage.setItem(k, JSON.stringify(value)); } catch(e2) {}
        }
    }

    // ============================================
    // RÉACTIONS EMOJI
    // Structure stockée :
    // { msgId: { emoji: [jid1, jid2, ...], ... }, ... }
    // ============================================

    function loadReactions() {
        const raw = readJSON(key('reactions'), {});
        // Reconvertir les arrays en Sets
        const map = new Map();
        for (const [msgId, emojiMap] of Object.entries(raw)) {
            const inner = new Map();
            for (const [emoji, jids] of Object.entries(emojiMap)) {
                inner.set(emoji, new Set(jids));
            }
            map.set(msgId, inner);
        }
        return map;
    }

    function saveReactions(reactionsMap) {
        // Convertir les Sets en arrays pour JSON
        const obj = {};
        for (const [msgId, emojiMap] of reactionsMap.entries()) {
            obj[msgId] = {};
            for (const [emoji, jids] of emojiMap.entries()) {
                obj[msgId][emoji] = Array.from(jids);
            }
        }
        writeJSON(key('reactions'), obj);
    }

    function addReaction(reactionsMap, msgId, emoji, fromJid) {
        if (!reactionsMap.has(msgId)) reactionsMap.set(msgId, new Map());
        const emojiMap = reactionsMap.get(msgId);
        if (!emojiMap.has(emoji)) emojiMap.set(emoji, new Set());
        emojiMap.get(emoji).add(fromJid);
        saveReactions(reactionsMap); // persister immédiatement
        return reactionsMap;
    }

    // ============================================
    // STATUTS DE LECTURE (accusés de réception)
    // Structure stockée :
    // { msgId: 'sent' | 'received' | 'read', ... }
    // ============================================

    function loadReadStatuses() {
        return readJSON(key('read_statuses'), {});
    }

    function saveReadStatus(msgId, status) {
        const statuses = loadReadStatuses();

        // On ne rétrograde jamais un statut (read > received > sent)
        const order = { sent: 1, received: 2, read: 3 };
        const current = statuses[msgId];
        if (current && (order[current] || 0) >= (order[status] || 0)) return;

        statuses[msgId] = status;
        writeJSON(key('read_statuses'), statuses);
    }

    function getReadStatus(msgId) {
        const statuses = loadReadStatuses();
        return statuses[msgId] || 'sent';
    }

    // ============================================
    // NETTOYAGE — garder seulement les 30 derniers jours
    // ============================================

    function cleanOldData() {
        // Supprimer les clés xmpp_ qui ont plus de 30j
        // (on ne peut pas dater les entrées individuellement sans overhead,
        //  donc on supprime les statuts de messages qui ne sont plus dans le cache)
        console.log('🧹 Nettoyage localStorage...');
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('xmpp_') && k.includes('_read_statuses')) {
                // Garder seulement les 500 derniers statuts
                try {
                    const data = JSON.parse(localStorage.getItem(k) || '{}');
                    const entries = Object.entries(data);
                    if (entries.length > 500) {
                        const trimmed = Object.fromEntries(entries.slice(-500));
                        localStorage.setItem(k, JSON.stringify(trimmed));
                    }
                } catch(e) {}
            }
        }
    }

    // ============================================
    // EXPORT PUBLIC
    // ============================================

    return {
        init,
        // Réactions
        loadReactions,
        saveReactions,
        addReaction,
        // Statuts de lecture
        loadReadStatuses,
        saveReadStatus,
        getReadStatus,
    };

})();