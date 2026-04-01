// src/services/courtService.js
const Court = require('../models/court.model');

const getCourtSummary = async (companyId = null) => {
    try {
        const courts = await Court.find({
            isActive: true,
            companyId: companyId || null,
        });
        
        
        if (courts.length === 0) return { info: "No hay canchas.", areDifferent: false };

        // Extraemos tipos únicos de superficie y techado
        const types = courts.map(c => `${c.surface}-${c.isIndoor ? 'Techada' : 'Descubierta'}`);
        const uniqueTypes = [...new Set(types)]; // Elimina duplicados

        const areDifferent = uniqueTypes.length > 1;
        
        let instructions = "";

        if (areDifferent) {
            instructions = `
            [SITUACIÓN: CANCHAS DIFERENTES]
            - Tenemos variedad de canchas: ${uniqueTypes.join(', ')}.
            - SI EL USUARIO NO ESPECIFICA, DEBES PREGUNTAR: "¿Prefieres techada, descubierta o alguna superficie en especial?".
            - Solo asigna una si el usuario elige.
            `;
        } else {
            instructions = `
            [SITUACIÓN: CANCHAS IGUALES]
            - Todas las canchas son iguales (${uniqueTypes[0]}).
            - NO PREGUNTES "¿Qué cancha querés?". ES MOLESTO.
            - Si el usuario pide turno, asume que le da igual.
            - En el JSON, manda "courtName": "INDIFERENTE".
            `;
        }

        return { instructions, areDifferent };

    } catch (error) {
        console.error(error);
        return { instructions: "", areDifferent: false };
    }
};

module.exports = { getCourtSummary };
