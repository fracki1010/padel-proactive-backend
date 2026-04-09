const formatBookingDateShort = (value) => {
  if (!value) return "";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  // La reserva se guarda en UTC medianoche; formatear en UTC evita corrimiento de día.
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
};

module.exports = { formatBookingDateShort };
