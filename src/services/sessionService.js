// Almacén en memoria (temporal)
const sessions = {};
const sessionMeta = {};

const getHistory = (chatId) => {
    return sessions[chatId] || [];
};

const addMessage = (chatId, role, content) => {
    if (!sessions[chatId]) {
        sessions[chatId] = [];
    }
    sessions[chatId].push({ role, content });

    // Mantener solo los últimos 8 mensajes para bajar consumo de tokens
    if (sessions[chatId].length > 8) {
        sessions[chatId] = sessions[chatId].slice(-8);
    }
};

const clearHistory = (chatId) => {
    delete sessions[chatId];
    delete sessionMeta[chatId];
};

const getMeta = (chatId) => {
    return sessionMeta[chatId] || {};
};

const updateMeta = (chatId, partialMeta = {}) => {
    sessionMeta[chatId] = {
        ...getMeta(chatId),
        ...partialMeta,
    };
    return sessionMeta[chatId];
};

const clearMeta = (chatId) => {
    delete sessionMeta[chatId];
};

module.exports = { getHistory, addMessage, clearHistory, getMeta, updateMeta, clearMeta };
