// Almacén en memoria (temporal)
const sessions = {};

const getHistory = (chatId) => {
    return sessions[chatId] || [];
};

const addMessage = (chatId, role, content) => {
    if (!sessions[chatId]) {
        sessions[chatId] = [];
    }
    sessions[chatId].push({ role, content });

    // Mantener solo los últimos 12 mensajes para no saturar a la IA
    if (sessions[chatId].length > 12) {
        sessions[chatId] = sessions[chatId].slice(-12);
    }
};

const clearHistory = (chatId) => {
    delete sessions[chatId];
};

module.exports = { getHistory, addMessage, clearHistory };