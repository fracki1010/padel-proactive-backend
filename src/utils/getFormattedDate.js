function getFormattedDate(fechaStr) {
    // Ajustamos la fecha para evitar problemas de zona horaria (UTC vs Local)
    const [year, month, day] = fechaStr.split('-').map(Number);
    const fechaInput = new Date(year, month - 1, day);

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const manana = new Date(hoy);
    manana.setDate(hoy.getDate() + 1);

    // Comparar si es mañana
    if (fechaInput.getTime() === manana.getTime()) {
        return "mañana";
    }

    // Formato por defecto: "6 de febrero"
    return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long' }).format(fechaInput);
}

module.exports = { getFormattedDate };