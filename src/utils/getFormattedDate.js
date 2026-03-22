function getFormattedDate(fechaStr) {
    const [year, month, day] = String(fechaStr).split("-").map(Number);
    if (!year || !month || !day) return String(fechaStr);

    // Usamos UTC para evitar corrimientos por zona horaria.
    const fechaInput = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    // Ej: "domingo, 22 de marzo" -> "domingo 22 de marzo"
    const texto = new Intl.DateTimeFormat("es-AR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
    }).format(fechaInput);

    return texto.replace(",", "");
}

module.exports = { getFormattedDate };
